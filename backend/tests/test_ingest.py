"""Extraction quality on real generated PDFs, run through the real subprocess entry point."""
import gzip
import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

from app.reflow import Counter, Glyph, Line, Page, build_reflow, join, lines_from_glyphs
from tests import pdf_samples as samples
from tests.conftest import BACKEND

JAPANESE = [
    '吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。',
    '吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。',
]


def run_ingest(pdf: Path, tmp_path: Path) -> tuple[subprocess.CompletedProcess, Path]:
    out = tmp_path / f'out-{pdf.stem}'
    out.mkdir()
    process = subprocess.run(
        [sys.executable, '-m', 'app.ingest', str(pdf), str(out)],
        cwd=BACKEND, capture_output=True, text=True, timeout=120,
    )
    return process, out


def ingested(pdf: Path, tmp_path: Path) -> tuple[dict, list[dict]]:
    process, out = run_ingest(pdf, tmp_path)
    assert process.returncode == 0, process.stderr
    meta = json.loads((out / 'meta.json').read_text())
    reflow = out / 'reflow.json.gz'
    blocks = json.load(gzip.open(reflow, 'rt'))['blocks'] if reflow.exists() else []
    return meta, blocks


def page_texts(pdf: Path, tmp_path: Path) -> dict[int, str]:
    process, out = run_ingest(pdf, tmp_path)
    assert process.returncode == 0
    return {page: text for page, text in json.load(gzip.open(out / 'pages.json.gz', 'rt'))}


def texts(blocks: list[dict]) -> list[str]:
    return [block['text'] for block in blocks if block['t'] == 'p']


# --- full paragraphs recovered ----------------------------------------------------------------


def test_indented_body_round_trips_exactly(tmp_path):
    """Wrapped lines, first-line indent, hyphenation, headers, page numbers, page spans."""
    meta, blocks = ingested(samples.novel_pdf(tmp_path / 'novel.pdf'), tmp_path)
    assert texts(blocks) == samples.PARAGRAPHS
    assert meta['page_count'] > 3
    assert (meta['kind'], meta['suggested_mode'], meta['has_text']) == ('novel', 'reflow', True)


def test_paragraphs_separated_by_gaps(tmp_path):
    pdf = samples.novel_pdf(tmp_path / 'gap.pdf', indent=0, paragraph_gap=8)
    _, blocks = ingested(pdf, tmp_path)
    assert texts(blocks) == samples.PARAGRAPHS


def test_no_indent_no_gap_still_splits(tmp_path):
    pdf = samples.novel_pdf(tmp_path / 'flat.pdf', indent=0)
    _, blocks = ingested(pdf, tmp_path)
    assert texts(blocks) == samples.PARAGRAPHS


def test_running_headers_and_page_numbers_are_gone(tmp_path):
    _, blocks = ingested(samples.novel_pdf(tmp_path / 'novel.pdf'), tmp_path)
    body = ' '.join(texts(blocks))
    assert 'The Long Road' not in body
    assert 'JANE AUTHOR' not in body
    assert not any(text.strip().isdigit() for text in texts(blocks))


def test_headers_are_kept_out_of_search_text_too(tmp_path):
    pages = page_texts(samples.novel_pdf(tmp_path / 'novel.pdf'), tmp_path)
    assert all('JANE AUTHOR' not in text for text in pages.values())


def test_paragraph_spanning_pages_keeps_start_page(tmp_path):
    long_paragraphs = [' '.join([samples.PARAGRAPHS[0]] * 30), samples.PARAGRAPHS[1]]
    meta, blocks = ingested(samples.novel_pdf(tmp_path / 'span.pdf', long_paragraphs), tmp_path)
    assert meta['page_count'] >= 3
    assert texts(blocks) == long_paragraphs
    assert blocks[0]['page'] == 1


def test_real_compounds_keep_their_hyphen():
    vocabulary = Counter({'well-known': 2, 'present': 1, 'self': 3, 'aware': 2})
    assert join('a well-', 'known fact', vocabulary) == 'a well-known fact'
    assert join('at pre-', 'sent time', vocabulary) == 'at present time'
    assert join('a self-', 'aware robot', vocabulary) == 'a self-aware robot'
    assert join('some unfor-', 'tunate soul', Counter()) == 'some unfortunate soul'
    assert join('see Anne-', 'Marie today', Counter()) == 'see Anne-Marie today'
    assert join("the year 1914-", "1918", Counter()) == "the year 1914-1918"


def test_pdfium_hyphen_marker_and_soft_hyphen():
    assert join('unfor\x02', 'tunate', Counter()) == 'unfortunate'
    assert join('unfor\xad', 'tunate', Counter()) == 'unfortunate'


def test_uppercase_hyphen_line_is_not_joined_silently():
    assert join('non-', 'English', Counter()) == 'non-English'


def test_font_size_read_through_text_matrix(tmp_path):
    pdf = samples.scaled_font_pdf(tmp_path / 'scaled.pdf', [
        'A body of text set with a one point font and a scaling matrix that',
        'continues on to the next line of the paragraph as it should.',
    ])
    _, blocks = ingested(pdf, tmp_path)
    assert len(texts(blocks)) == 1


def test_two_columns_are_read_column_by_column(tmp_path):
    _, blocks = ingested(samples.two_column_pdf(tmp_path / 'cols.pdf'), tmp_path)
    body = ' '.join(texts(blocks))
    assert body.index('left column line 29 of the text') < body.index('right column line 0 of it')


def test_heading_and_drop_cap(tmp_path):
    _, blocks = ingested(samples.chapter_pdf(tmp_path / 'chapter.pdf'), tmp_path)
    assert [(block['t'], block['text']) for block in blocks] == [
        ('h', 'Chapter 1'),
        ('p', 'The rain had stopped by the time they reached the bridge and nobody there seemed to '
              'remember anything of the old road or of the people who had once walked along it to the market.'),
        ('h', 'Chapter 2'),
        ('p', 'A second chapter begins here.'),
    ]


# --- CJK --------------------------------------------------------------------------------------


def test_cjk_joins_without_spaces(tmp_path):
    _, blocks = ingested(samples.cjk_pdf(tmp_path / 'cjk.pdf', JAPANESE), tmp_path)
    assert texts(blocks) == JAPANESE


def test_vertical_japanese_reads_right_to_left(tmp_path):
    # The fixture font is not embedded and this system has no CJK fonts, so pdfium sees zero-size
    # glyphs and skips text objects made only of them. Punctuation has metrics regardless, which
    # is why every column of this text contains some. Real books embed their fonts.
    paragraphs = [
        JAPANESE[0],
        '吾輩はここで始めて人間というものを見た。しかもあとで聞いた。それは書生という人間中で一番獰悪な種族であったそうだ。',
    ]
    _, blocks = ingested(samples.cjk_pdf(tmp_path / 'tategaki.pdf', paragraphs, vertical=True), tmp_path)
    assert texts(blocks) == paragraphs


def test_cjk_novel_is_a_novel(tmp_path):
    pdf = samples.cjk_pdf(tmp_path / 'cjk-long.pdf', JAPANESE * 3, pages=3)
    meta, blocks = ingested(pdf, tmp_path)
    assert (meta['kind'], meta['suggested_mode']) == ('novel', 'reflow')
    assert blocks[0]['page'] == 1


def test_furigana_is_dropped():
    def line(text, y, size=12.0):
        return Line(text, 50, 50 + size * len(text), y, size, 600 - y, y)

    pages = [Page(number=1, lines=[
        line('かん', 515, 6), line('漢字の本文はここにあります。', 500), line('二行目の本文もここにあります。', 482),
    ])]
    blocks = build_reflow(pages).blocks
    assert 'かん' not in blocks[0]['text']


# --- images, rotation -------------------------------------------------------------------------


def test_manga_has_no_text(tmp_path):
    meta, blocks = ingested(samples.manga_pdf(tmp_path / 'manga.pdf'), tmp_path)
    assert (meta['kind'], meta['suggested_mode'], meta['has_text']) == ('manga', 'paged', False)
    assert blocks == []


def test_webtoon(tmp_path):
    meta, _ = ingested(samples.manga_pdf(tmp_path / 'toon.pdf', width=300, height=1500), tmp_path)
    assert (meta['kind'], meta['suggested_mode']) == ('manga', 'scroll')


def test_illustration_page_becomes_image_block(tmp_path):
    meta, blocks = ingested(samples.illustrated_novel_pdf(tmp_path / 'art.pdf'), tmp_path)
    assert {'t': 'img', 'page': 2} in blocks
    assert meta['kind'] == 'novel'
    # The paragraph interrupted by the illustration still comes out whole.
    assert texts(blocks) == samples.PARAGRAPHS[:21]


def test_rotated_page_size_and_text(tmp_path):
    meta, blocks = ingested(samples.rotated_pdf(tmp_path / 'rot.pdf'), tmp_path)
    width, height = meta['page_sizes'][0]
    assert width > height
    assert texts(blocks)[:3] == samples.PARAGRAPHS[:3]


def test_content_turned_to_display_upright(tmp_path):
    _, blocks = ingested(samples.rotated_content_pdf(tmp_path / 'rot2.pdf'), tmp_path)
    assert texts(blocks) == [
        'The first line of the sideways page runs on into the second line of it and ends on the third.'
    ]


def test_rotation_180_lines_in_order():
    glyphs = []
    for row, text in enumerate(['first line', 'second line']):
        for column, char in enumerate(text):
            x, y = 400 - column * 6, 100 + row * 14
            glyphs.append(Glyph(char, x, y, x - 6, x, y - 8, y, 10))
    assert [line.text for line in lines_from_glyphs(glyphs, 420, 600)] == ['first line', 'second line']


# --- metadata and cover -----------------------------------------------------------------------


def test_metadata_and_page_sizes(tmp_path):
    meta, _ = ingested(samples.novel_pdf(tmp_path / 'novel.pdf'), tmp_path)
    assert meta['title'] == 'The Long Road'
    assert meta['author'] == 'Jane Author'
    assert len(meta['page_sizes']) == meta['page_count']
    assert meta['page_sizes'][0] == pytest.approx([419.53, 595.28], abs=0.01)


def test_junk_metadata_is_ignored(tmp_path):
    meta, _ = ingested(samples.novel_pdf(tmp_path / 'junk.pdf', title='Microsoft Word - draft7.docx'), tmp_path)
    assert meta['title'] is None


def test_outline(tmp_path):
    meta, _ = ingested(samples.outline_pdf(tmp_path / 'toc.pdf'), tmp_path)
    assert meta['outline'] == [
        {'title': 'Part One', 'page': 1, 'level': 0},
        {'title': 'Chapter 1', 'page': 2, 'level': 1},
    ]


def test_cover_is_400px_webp(tmp_path):
    process, out = run_ingest(samples.novel_pdf(tmp_path / 'novel.pdf'), tmp_path)
    assert process.returncode == 0
    with Image.open(out / 'cover.webp') as cover:
        assert cover.format == 'WEBP'
        assert abs(cover.width - 400) <= 1


def test_tall_cover_is_bounded(tmp_path):
    process, out = run_ingest(samples.manga_pdf(tmp_path / 'toon.pdf', pages=1, width=100, height=5000), tmp_path)
    assert process.returncode == 0
    with Image.open(out / 'cover.webp') as cover:
        assert cover.height <= 1601


# --- refusals ---------------------------------------------------------------------------------


def test_encrypted_pdf_is_refused(tmp_path):
    process, _ = run_ingest(samples.encrypted_pdf(tmp_path / 'locked.pdf'), tmp_path)
    assert process.returncode == 3
    assert 'password' in json.loads(process.stdout.splitlines()[-1])['error']


def test_owner_password_only_pdf_opens(tmp_path):
    meta, blocks = ingested(samples.owner_locked_pdf(tmp_path / 'owner.pdf'), tmp_path)
    assert meta['page_count'] == 1
    assert blocks


def test_corrupt_pdf_is_refused(tmp_path):
    process, _ = run_ingest(samples.corrupt_pdf(tmp_path / 'bad.pdf'), tmp_path)
    assert process.returncode == 3
    assert 'damaged' in json.loads(process.stdout.splitlines()[-1])['error']


def test_truncated_pdf_does_not_crash_the_caller(tmp_path):
    novel = samples.novel_pdf(tmp_path / 'novel.pdf')
    cut = tmp_path / 'cut.pdf'
    cut.write_bytes(novel.read_bytes()[:len(novel.read_bytes()) // 2])
    process, out = run_ingest(cut, tmp_path)
    # pdfium may repair what is left; what matters is a clean verdict.
    assert process.returncode in (0, 3)
    if process.returncode == 0:
        assert (out / 'meta.json').exists()


def test_page_count_is_reported_first(tmp_path):
    process, _ = run_ingest(samples.manga_pdf(tmp_path / 'm.pdf', pages=2), tmp_path)
    assert json.loads(process.stdout.splitlines()[0]) == {'pages': 2}
