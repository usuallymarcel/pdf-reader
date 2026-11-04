"""Generates real PDFs. Novels are typeset by a small greedy line breaker, so a test can compare
what extraction recovers with the exact paragraphs that went in."""
from pathlib import Path

from PIL import Image
from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A5
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

pdfmetrics.registerFont(UnicodeCIDFont('HeiseiMin-W3'))
_vertical = UnicodeCIDFont('HeiseiMin-W3', isVertical=True)
_vertical.name = _vertical.fontName = 'HeiseiMin-W3-Vertical'
pdfmetrics.registerFont(_vertical)

FONT = 'Times-Roman'
JP_FONT = 'HeiseiMin-W3'

PARAGRAPHS = [
    'The morning came slowly over the long valley, and with it the first thin light that the '
    'villagers had seen in several weeks of unbroken and extraordinarily miserable weather. Nobody '
    'spoke of it at first. They stood at their doors and looked at the sky as though it might '
    'change its mind.',
    '“You should go,” said the old woman, without looking up from the fire.',
    '“I know.”',
    'He stayed where he was for a while longer, turning the small iron key over and over in his '
    'fingers, considering the unfortunate circumstances that had brought him back to this house. '
    'It had been eleven years, and everything in the room was smaller than he remembered, the '
    'table and the chairs and the woman herself, who had once seemed enormous and immovable and '
    'who now barely reached the mantelpiece when she stood to stir the pot.',
    'She did not ask him where he was going. She had never asked, not in all the years he had '
    'lived there, and he had come to understand that this was a kind of respect, or a kind of '
    'fear, and that perhaps those two things had always been the same thing in this family.',
    '“Take the coat,” she said at last. “The one by the door. It was your father’s.”',
    'The road out of the village climbed for three miles before it reached the pass, and by the '
    'time he had walked half of it the sun was properly up and the frost had begun to lift from '
    'the fields. He could see the whole valley from there: the river, the mill, the church with '
    'its absurd little tower, and the thread of smoke from her chimney, which he watched until '
    'the road turned and took it away from him. He did not feel what he had expected to feel. '
    'He felt, more than anything else, hungry, and a little ashamed of being hungry at such a '
    'moment, as if the occasion had deserved a more distinguished sort of appetite.',
] * 6


def _wrap(text: str, font: str, size: float, first_width: float, width: float, hyphenate: bool) -> list[str]:
    """Greedy line breaking. With hyphenate, long words split at the margin like in print."""
    lines, current = [], ''
    available = first_width
    fits = lambda s: pdfmetrics.stringWidth(s, font, size) <= available
    for word in text.split(' '):
        candidate = f'{current} {word}' if current else word
        if fits(candidate):
            current = candidate
            continue
        if hyphenate and len(word) >= 8 and word.isalpha():
            for cut in range(len(word) - 3, 2, -1):
                head = f'{current} {word[:cut]}-' if current else f'{word[:cut]}-'
                if fits(head):
                    lines.append(head)
                    available = width
                    current = word[cut:]
                    break
            else:
                lines.append(current)
                available = width
                current = word
            continue
        lines.append(current)
        available = width
        current = word
    if current:
        lines.append(current)
    return lines


def novel_pdf(
    path: Path,
    paragraphs: list[str] = PARAGRAPHS,
    *,
    indent: float = 14,
    paragraph_gap: float = 0,
    hyphenate: bool = True,
    furniture: bool = True,
    title: str = 'The Long Road',
    font: str = FONT,
    size: float = 10.5,
    leading: float = 14,
) -> Path:
    width, height = A5
    margin_x, top, bottom = 54, height - 66, 66
    text_width = width - 2 * margin_x
    pdf = canvas.Canvas(str(path), pagesize=A5)
    pdf.setTitle(title)
    pdf.setAuthor('Jane Author')
    page = 1

    def start_page() -> None:
        pdf.setFont(FONT, 8.5)
        if furniture:
            if page % 2:
                pdf.drawCentredString(width / 2, height - 40, title)
            else:
                pdf.drawCentredString(width / 2, height - 40, 'JANE AUTHOR')
            pdf.drawCentredString(width / 2, 34, str(page))
        pdf.setFont(font, size)

    start_page()
    y = top
    for paragraph in paragraphs:
        for index, line in enumerate(_wrap(paragraph, font, size, text_width - indent, text_width, hyphenate)):
            if y < bottom:
                pdf.showPage()
                page += 1
                start_page()
                y = top
            pdf.drawString(margin_x + (indent if index == 0 else 0), y, line)
            y -= leading
        y -= paragraph_gap
    pdf.showPage()
    pdf.save()
    return path


def scaled_font_pdf(path: Path, lines: list[str]) -> Path:
    """Text set with `1 Tf` and a scaling text matrix, as InDesign-style generators do."""
    pdf = canvas.Canvas(str(path), pagesize=A5)
    text = pdf.beginText()
    text.setFont(FONT, 1)
    y = 500
    for line in lines:
        text.setTextTransform(10.5, 0, 0, 10.5, 54, y)
        text.textOut(line)
        y -= 14
    pdf.drawText(text)
    pdf.showPage()
    pdf.save()
    return path


def cjk_pdf(path: Path, paragraphs: list[str], vertical: bool = False, pages: int = 1) -> Path:
    """Japanese body text, one em first-line indent; vertical is tategaki, right to left."""
    width, height = A5
    pdf = canvas.Canvas(str(path), pagesize=A5)
    em = 12
    per_line = 24
    for _ in range(pages):
        pdf.setFont(_vertical.name if vertical else JP_FONT, em)
        position = 0
        for paragraph in paragraphs:
            chars = list(paragraph)
            lines, line = [], []
            line_room = per_line - 1
            for char in chars:
                line.append(char)
                if len(line) == line_room:
                    lines.append(''.join(line))
                    line, line_room = [], per_line
            if line:
                lines.append(''.join(line))
            for index, text in enumerate(lines):
                indent = em if index == 0 else 0
                if vertical:
                    pdf.drawString(width - 60 - position * 20, height - 60 - indent, text)
                else:
                    pdf.drawString(60 + indent, height - 70 - position * 18, text)
                position += 1
        pdf.showPage()
    pdf.save()
    return path


def _bitmap(width: int = 300, height: int = 420) -> ImageReader:
    return ImageReader(Image.effect_noise((width, height), 60).convert('RGB'))


def manga_pdf(path: Path, pages: int = 3, *, width: float = 420, height: float = 595) -> Path:
    pdf = canvas.Canvas(str(path), pagesize=(width, height))
    for number in range(pages):
        pdf.drawImage(_bitmap(), 0, 0, width, height)
        pdf.showPage()
    pdf.save()
    return path


def illustrated_novel_pdf(path: Path) -> Path:
    """Text, a full-page illustration, then more text."""
    novel = novel_pdf(path.with_suffix('.text.pdf'), PARAGRAPHS[:21], furniture=False)
    art = manga_pdf(path.with_suffix('.art.pdf'), pages=1, width=A5[0], height=A5[1])
    writer = PdfWriter()
    reader = PdfReader(novel)
    pages = list(reader.pages)
    writer.add_page(pages[0])
    writer.add_page(PdfReader(art).pages[0])
    for page in pages[1:]:
        writer.add_page(page)
    with path.open('wb') as handle:
        writer.write(handle)
    return path


def rotated_pdf(path: Path, degrees: int = 90) -> Path:
    source = novel_pdf(path.with_suffix('.src.pdf'), PARAGRAPHS[:6], furniture=False)
    writer = PdfWriter(clone_from=source)
    for page in writer.pages:
        page.rotate(degrees)
    with path.open('wb') as handle:
        writer.write(handle)
    return path


def rotated_content_pdf(path: Path) -> Path:
    """A landscape scan-style page: /Rotate 90 with content turned so that it displays upright."""
    width, height = A5
    pdf = canvas.Canvas(str(path), pagesize=(height, width))
    pdf.setPageRotation(90)
    pdf.translate(height, 0)
    pdf.rotate(90)
    pdf.setFont(FONT, 11)
    y = 400
    for line in ('The first line of the sideways page', 'runs on into the second line of it', 'and ends on the third.'):
        pdf.drawString(50, y, line)
        y -= 15
    pdf.showPage()
    pdf.save()
    return path


def two_column_pdf(path: Path) -> Path:
    width, height = A5
    pdf = canvas.Canvas(str(path), pagesize=A5)
    pdf.setFont(FONT, 9)
    y = height - 60
    for index in range(30):
        pdf.drawString(40, y, f'left column line {index} of the text')
        pdf.drawString(230, y, f'right column line {index} of it')
        y -= 12
    pdf.showPage()
    pdf.save()
    return path


def encrypted_pdf(path: Path, password: str = 'hunter2') -> Path:
    source = novel_pdf(path.with_suffix('.src.pdf'), PARAGRAPHS[:3])
    writer = PdfWriter(clone_from=source)
    writer.encrypt(password)
    with path.open('wb') as handle:
        writer.write(handle)
    return path


def owner_locked_pdf(path: Path) -> Path:
    """Readable without a password; only editing is restricted."""
    source = novel_pdf(path.with_suffix('.src.pdf'), PARAGRAPHS[:3])
    writer = PdfWriter(clone_from=source)
    writer.encrypt(user_password='', owner_password='owner')
    with path.open('wb') as handle:
        writer.write(handle)
    return path


def corrupt_pdf(path: Path) -> Path:
    path.write_bytes(b'%PDF-1.7\n' + b'this is not really a pdf\n' * 200)
    return path


def script_pdf(path: Path) -> Path:
    width, height = A5
    pdf = canvas.Canvas(str(path), pagesize=A5)
    pdf.setFont(FONT, 11)
    pdf.drawString(54, height - 80, 'The villain typed <script>alert(1)</script> into the unfiltered box & laughed.')
    pdf.showPage()
    pdf.save()
    return path


def outline_pdf(path: Path) -> Path:
    source = novel_pdf(path.with_suffix('.src.pdf'), PARAGRAPHS[:21], furniture=False)
    writer = PdfWriter(clone_from=source)
    parent = writer.add_outline_item('Part One', 0)
    writer.add_outline_item('Chapter 1', 1, parent=parent)
    with path.open('wb') as handle:
        writer.write(handle)
    return path


def chapter_pdf(path: Path) -> Path:
    """A heading in a larger font mid-document, and a drop cap."""
    width, height = A5
    pdf = canvas.Canvas(str(path), pagesize=A5)
    pdf.setFont(FONT, 18)
    pdf.drawString(54, height - 90, 'Chapter 1')
    pdf.setFont(FONT, 36)
    pdf.drawString(54, height - 146, 'T')
    pdf.setFont(FONT, 10.5)
    pdf.drawString(82, height - 132, 'he rain had stopped by the time they reached the bridge and')
    pdf.drawString(82, height - 146, 'nobody there seemed to remember anything of the old road or')
    pdf.drawString(54, height - 160, 'of the people who had once walked along it to the market.')
    pdf.setFont(FONT, 18)
    pdf.drawString(54, height - 220, 'Chapter 2')
    pdf.setFont(FONT, 10.5)
    pdf.drawString(68, height - 250, 'A second chapter begins here.')
    pdf.showPage()
    pdf.save()
    return path
