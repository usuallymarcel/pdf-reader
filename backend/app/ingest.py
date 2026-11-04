"""PDF ingest: `python -m app.ingest <pdf> <outdir>`.

PDFs are hostile input for a C library, so this always runs as a throwaway subprocess under the
worker's timeout. Nothing here touches the database. Output in <outdir>:
  meta.json, pages.json.gz, reflow.json.gz, cover.webp (the last when the first page renders)

Progress goes to stdout as JSON lines: {"pages": N} once the page count is known, which is what
scales the worker's timeout, and {"error": msg} before a non-zero exit.
"""
import ctypes
import gzip
import json
import math
import re
import statistics
import sys
from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from app.reflow import Glyph, Line, Page, build_reflow, lines_from_glyphs

EXIT_REFUSED = 3
ENCRYPTED_ERROR = 'This PDF is password protected.'
CORRUPT_ERROR = 'This file is damaged or is not a valid PDF.'

MEMORY_LIMIT = 4 * 1024 ** 3
MAX_CHARS_PER_PAGE = 200_000
MAX_IMAGE_OBJECTS = 2000
MAX_OUTLINE_ITEMS = 10_000

COVER_WIDTH = 400
COVER_MAX_HEIGHT = 1600

MANGA_CHARS_PER_PAGE = 150
WEBTOON_RATIO = 2.2
IMAGE_PAGE_CHARS = 40  # below this, any bitmap makes it an illustration page
FULL_IMAGE_COVERAGE = 0.8
# A full-page image with this much text on it is a scan with an OCR layer, not an illustration.
OCR_PAGE_CHARS = 200

JUNK_METADATA = re.compile(
    r'^(?:untitled|unknown|anonymous|none|null|microsoft word\b.*|.*\.(?:docx?|indd|pdf|qxd|tex|odt))$', re.I
)


def emit(message: dict) -> None:
    print(json.dumps(message), flush=True)


def limit_resources() -> None:
    try:
        import resource
    except ImportError:  # Windows
        return
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def read_glyphs(textpage) -> list[Glyph]:
    raw = textpage.raw
    count = min(pdfium_c.FPDFText_CountChars(raw), MAX_CHARS_PER_PAGE)
    x, y = ctypes.c_double(), ctypes.c_double()
    left, right, bottom, top = ctypes.c_double(), ctypes.c_double(), ctypes.c_double(), ctypes.c_double()
    matrix = pdfium_c.FS_MATRIX()
    glyphs = []
    for index in range(count):
        code = pdfium_c.FPDFText_GetUnicode(raw, index)
        if code == 0 or code > 0x10FFFF or 0xD800 <= code <= 0xDFFF:
            continue
        if not pdfium_c.FPDFText_GetCharOrigin(raw, index, x, y):
            continue
        pdfium_c.FPDFText_GetCharBox(raw, index, left, right, bottom, top)
        size = abs(pdfium_c.FPDFText_GetFontSize(raw, index))
        # Generators like `/F1 1 Tf` with a scaling text matrix: the font size alone says little.
        if pdfium_c.FPDFText_GetMatrix(raw, index, matrix):
            scale = math.hypot(matrix.a, matrix.b)
            if scale > 0:
                size *= scale
        glyphs.append(Glyph(chr(code), x.value, y.value, left.value, right.value, bottom.value, top.value, size))
    return glyphs


def has_image(page, full_page_only: bool, area: float) -> bool:
    """Whether the page has a bitmap at all, or with full_page_only one covering the page."""
    objects = page.get_objects(filter=(pdfium_c.FPDF_PAGEOBJ_IMAGE,), max_depth=3)
    for index, obj in enumerate(objects):
        if index >= MAX_IMAGE_OBJECTS:
            break
        if not full_page_only:
            return True
        left, bottom, right, top = obj.get_bounds()
        if (right - left) * (top - bottom) >= FULL_IMAGE_COVERAGE * area:
            return True
    return False


def read_page(document, index: int) -> tuple[Page, tuple[float, float]]:
    page = document[index]
    try:
        width, height = page.get_size()  # rotation already applied
        # Glyph coordinates ignore /Rotate, so use the unrotated page for them.
        rotated = page.get_rotation() in (90, 270)
        frame = (height, width) if rotated else (width, height)
        textpage = page.get_textpage()
        try:
            glyphs = read_glyphs(textpage)
        finally:
            textpage.close()
        result = Page(number=index + 1)
        result.lines = lines_from_glyphs(glyphs, *frame)
        result.chars = sum(1 for g in glyphs if not g.char.isspace())
        area = width * height
        result.is_image = (result.chars < IMAGE_PAGE_CHARS and has_image(page, False, area)) or (
            result.chars < OCR_PAGE_CHARS and has_image(page, True, area)
        )
        return result, (round(width, 2), round(height, 2))
    finally:
        page.close()


def read_outline(document, page_count: int) -> list[dict]:
    outline = []
    for item in document.get_toc(max_depth=16):
        if len(outline) >= MAX_OUTLINE_ITEMS:
            break
        destination = item.get_dest()
        index = destination.get_index() if destination else None
        if index is None or not 0 <= index < page_count:
            continue
        title = re.sub(r'\s+', ' ', item.get_title() or '').strip()
        if title:
            outline.append({'title': title[:500], 'page': index + 1, 'level': item.level})
    return outline


def read_metadata(document, key: str) -> str | None:
    value = re.sub(r'\s+', ' ', document.get_metadata_value(key) or '').strip()
    return value[:500] if value and not JUNK_METADATA.match(value) else None


def render_cover(document, destination: Path) -> bool:
    page = document[0]
    try:
        width, height = page.get_size()
        if width <= 0 or height <= 0:
            return False
        scale = min(COVER_WIDTH / width, COVER_MAX_HEIGHT / height)
        bitmap = page.render(scale=scale, rev_byteorder=True)
        try:
            bitmap.to_pil().convert('RGB').save(destination, 'WEBP', quality=80, method=4)
        finally:
            bitmap.close()
        return True
    finally:
        page.close()


def classify(chars_per_page: list[int], sizes: list[tuple[float, float]], decent_text: bool) -> tuple[str, str]:
    """(kind, suggested_mode)"""
    if statistics.median(h / w if w else 1 for w, h in sizes) > WEBTOON_RATIO:
        return 'manga', 'scroll'
    if statistics.median(chars_per_page) < MANGA_CHARS_PER_PAGE:
        return 'manga', 'paged'
    return 'novel', 'reflow' if decent_text else 'paged'


def write_gzip_json(path: Path, value) -> None:
    with gzip.open(path, 'wt', encoding='utf-8', compresslevel=6) as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(',', ':'))


def ingest(pdf: Path, out: Path) -> None:
    document = pdfium.PdfDocument(pdf)
    try:
        page_count = len(document)
        if page_count < 1:
            raise pdfium.PdfiumError('document has no pages')
        emit({'pages': page_count})

        pages: list[Page] = []
        sizes: list[tuple[float, float]] = []
        for index in range(page_count):
            try:
                page, size = read_page(document, index)
            except pdfium.PdfiumError:
                # One broken page should not cost the whole book.
                page, size = Page(number=index + 1), sizes[-1] if sizes else (595.0, 842.0)
            pages.append(page)
            sizes.append(size)

        chars_per_page = [page.chars for page in pages]
        reflow = build_reflow(pages)
        kind, mode = classify(chars_per_page, sizes, reflow.decent)
        has_text = any(block['t'] != 'img' for block in reflow.blocks)
        if has_text:
            write_gzip_json(out / 'reflow.json.gz', {'version': 1, 'blocks': reflow.blocks})
        write_gzip_json(out / 'pages.json.gz', [[n, t] for n, t in reflow.page_texts.items()])

        try:
            has_cover = render_cover(document, out / 'cover.webp')
        except (pdfium.PdfiumError, OSError, ValueError):
            has_cover = False

        (out / 'meta.json').write_text(json.dumps({
            'page_count': page_count,
            'page_sizes': sizes,
            'outline': read_outline(document, page_count),
            'title': read_metadata(document, 'Title'),
            'author': read_metadata(document, 'Author'),
            'kind': kind,
            'suggested_mode': mode,
            'has_text': has_text,
            'has_cover': has_cover,
        }), encoding='utf-8')
    finally:
        document.close()


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print('usage: python -m app.ingest <pdf> <outdir>', file=sys.stderr)
        return 2
    limit_resources()
    try:
        ingest(Path(argv[1]), Path(argv[2]))
    except pdfium.PdfiumError as error:
        emit({'error': ENCRYPTED_ERROR if 'password' in str(error).lower() else CORRUPT_ERROR})
        return EXIT_REFUSED
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
