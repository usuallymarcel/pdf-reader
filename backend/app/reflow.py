"""Turns positioned glyphs into reflowable paragraphs. Pure Python, no PDF library involved.

PDF text has no paragraphs: only glyphs at coordinates. The steps are
  1. glyphs -> lines, in a "reading frame" where text always runs along +x and lines step down,
     so rotated pages and vertical CJK need no special cases afterwards;
  2. drop running headers, footers and page numbers;
  3. lines -> paragraphs, from indentation, vertical gaps and whether a line ended early;
  4. join across lines and pages, undoing hyphenation.
"""
import math
import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field

LINE_HYPHEN = '\x02'  # pdfium's marker for a hyphen it recognised at a line end
HYPHENS = ('-', '‐', LINE_HYPHEN)
SOFT_HYPHEN = '\xad'
LIGATURES = {'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st'}
SENTENCE_END = tuple('.!?…。！？」』”’"\'»)）】')
OPENING_QUOTES = ('“', '‘', '"', "'", '「', '『', '«')
PARAGRAPH_GAP = 1.25  # in line heights: more than this between lines is white space, not leading
# Raise when extraction improves: books processed by an older version get re-read in the background.
TEXT_VERSION = 2

PAGE_NUMBER = re.compile(
    r'^[\s\-–—·•.(\[]*(?:(?:page|p\.?)\s*)?(?:\d{1,4}|[ivxlc]{1,7})(?:\s*(?:/|of)\s*\d{1,4})?[\s\-–—·•.)\]]*$', re.I
)
_COUNT = r'(?:\d{1,4}|[ivxlc]{1,7}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)'
# "Part of me wanted to go home." is a sentence, so numbered words need their number.
CHAPTER = re.compile(
    rf'^(?:(?:chapter|part|volume|letter|episode|act|book)\s+{_COUNT}\b.{{0,50}}'
    r'|(?:prologue|epilogue|interlude|intermission|afterword|foreword|preface|side story)\b.{0,50}'
    r'|第[0-9０-９一二三四五六七八九十百千]{1,6}[章話话節节巻幕部]\s*.{0,30}'
    r'|序章|終章|あとがき)$',
    re.I,
)
NUMBERED_CHAPTER = re.compile(rf'^(?:chapter|part|volume|letter|episode|act|book)\s+{_COUNT}$', re.I)
# Second halves of split words that also happen to be words: `home-less` is not a compound.
WORD_ENDINGS = frozenset({'able', 'fully', 'less', 'ness', 'ment', 'ship', 'some', 'tion', 'ward', 'wards', 'wise'})
WORD_STARTS = frozenset({'fore', 'over', 'under', 'with'})


@dataclass(slots=True)
class Glyph:
    char: str
    x: float  # origin
    y: float
    left: float  # box
    right: float
    bottom: float
    top: float
    size: float


@dataclass(slots=True)
class Line:
    text: str
    x0: float
    x1: float
    y: float  # baseline in the reading frame, growing upwards
    size: float
    top: float  # distance from the top of the page
    bottom: float  # distance from the bottom of the page


@dataclass
class Page:
    number: int
    lines: list[Line] = field(default_factory=list)
    is_image: bool = False
    chars: int = 0


@dataclass
class Metrics:
    size: float
    leading: float
    # Books marking paragraphs by first-line indent, as opposed to by nothing at all.
    uses_indents: bool = True
    # Books marking paragraphs by a blank space between them, as Word and EPUB exports do.
    uses_gaps: bool = False


@dataclass
class PageBox:
    left: float
    right: float


def is_cjk(char: str) -> bool:
    """Scripts written without spaces. Hangul is excluded on purpose: Korean uses spaces."""
    code = ord(char)
    return (
        0x3000 <= code <= 0x30FF
        or 0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
        or 0xFF00 <= code <= 0xFFEF
        or 0x20000 <= code <= 0x2FFFF
    )


def clean_char(char: str) -> str:
    if char in LIGATURES:
        return LIGATURES[char]
    code = ord(char)
    if char == '\xa0':
        return ' '
    if char == '￾':
        return LINE_HYPHEN
    if code == 2 or code >= 32 and code != 0x7f and not 0x80 <= code < 0xa0 and not 0xE000 <= code <= 0xF8FF:
        return char
    return ''


# --- glyphs to lines --------------------------------------------------------------------


def reading_rotation(glyphs: list[Glyph]) -> int:
    """Quarter turns (0..3, counter-clockwise) that make the page's text run along +x."""
    votes = Counter()
    previous = None
    for glyph in glyphs:
        if glyph.char.isspace():
            continue
        if previous is not None:
            dx, dy = glyph.x - previous.x, glyph.y - previous.y
            if 0 < math.hypot(dx, dy) < 3 * max(glyph.size, 1):
                if abs(dx) >= abs(dy):
                    votes[0 if dx > 0 else 2] += 1
                else:
                    votes[1 if dy < 0 else 3] += 1
        previous = glyph
    return votes.most_common(1)[0][0] if votes else 0


def _turn(x: float, y: float, turns: int, width: float, height: float) -> tuple[float, float]:
    if turns == 1:
        return height - y, x
    if turns == 2:
        return width - x, height - y
    if turns == 3:
        return y, width - x
    return x, y


def lines_from_glyphs(glyphs: list[Glyph], width: float, height: float) -> list[Line]:
    """width and height are those of the coordinate system the glyphs use."""
    turns = reading_rotation(glyphs)
    frame_height = width if turns in (1, 3) else height
    lines: list[Line] = []
    run: list[tuple[str, float, float, float]] = []  # char, x0, x1, size
    baseline = 0.0

    def flush() -> None:
        while run and run[0][0].isspace():
            run.pop(0)
        while run and run[-1][0].isspace():
            run.pop()
        if run:
            text = re.sub(r'[ \t\xa0]+', ' ', ''.join(c for c, *_ in run))
            lines.append(Line(
                text=text,
                x0=run[0][1],
                x1=max(g[2] for g in run),
                y=baseline,
                size=statistics.median(g[3] for g in run),
                top=frame_height - baseline,
                bottom=baseline,
            ))
        run.clear()

    for glyph in glyphs:
        char = clean_char(glyph.char)
        if char in ('', '\r', '\n'):
            continue
        x, y = _turn(glyph.x, glyph.y, turns, width, height)
        corners = (_turn(glyph.left, glyph.bottom, turns, width, height), _turn(glyph.right, glyph.top, turns, width, height))
        left, right = min(c[0] for c in corners), max(c[0] for c in corners)
        if right - left < 0.1 and not char.isspace():  # fonts without metrics report empty boxes
            left, right = x, x + 0.9 * glyph.size
        if run:
            size = max(glyph.size, run[-1][3], 1)
            leaving_drop_cap = len(run) == 1 and run[0][3] >= 1.6 * glyph.size and abs(y - baseline) > 0.45 * glyph.size
            same_line = (
                not leaving_drop_cap
                and abs(y - baseline) <= 0.45 * size
                and left >= run[-1][2] - size
                and left - run[-1][2] <= 3 * size
            )
            if not same_line:
                flush()
        if not run:
            baseline = y
        run.append((char, left, right, glyph.size))
    flush()
    return _reading_order(lines)


def _reading_order(lines: list[Line]) -> list[Line]:
    """Top to bottom. pdfium's own order is unreliable, on rotated pages especially. Pages where
    lines share baselines with a wide gap between them are read column by column."""
    ordered = sorted(lines, key=lambda line: (-round(line.y, 1), line.x0))
    merged: list[Line] = []
    for line in ordered:
        last = merged[-1] if merged else None
        similar = last and max(last.size, line.size) < 1.6 * min(last.size, line.size)
        if similar and abs(last.y - line.y) < 1 and 0 <= line.x0 - last.x1 <= 3 * line.size:
            last.text = f'{last.text} {line.text}'
            last.x1 = line.x1
        else:
            merged.append(line)

    gutters = [
        (a.x1 + b.x0) / 2
        for a, b in zip(merged, merged[1:])
        if abs(a.y - b.y) < 1 and b.x0 > a.x1
    ]
    if len(gutters) < 3 or len(gutters) * 2 < len(merged) * 0.6:
        return merged
    gutter = statistics.median(gutters)
    return [line for line in merged if line.x0 < gutter] + [line for line in merged if line.x0 >= gutter]


# --- document-wide measurements -----------------------------------------------------------


def body_size(pages: list[Page]) -> float:
    weights = Counter()
    for page in pages:
        for line in page.lines:
            weights[round(line.size * 2) / 2] += len(line.text)
    return weights.most_common(1)[0][0] if weights else 10.0


def body_leading(pages: list[Page], size: float) -> float:
    gaps = []
    for page in pages:
        for a, b in zip(page.lines, page.lines[1:]):
            gap = a.y - b.y
            if 0.8 * size <= gap <= 2.5 * size and _is_body(a, size) and _is_body(b, size):
                gaps.append(gap)
    return statistics.median(gaps) if gaps else 1.25 * size


def _is_body(line: Line, size: float) -> bool:
    return abs(line.size - size) <= 0.15 * size


def _page_boxes(pages: list[Page], size: float) -> dict[int, PageBox]:
    """Text block edges per page. Odd and even pages often mirror their margins, and a page of
    short lines says little by itself, so each page borrows from its parity group."""
    per_page: dict[int, tuple[float, float, int]] = {}
    lefts: dict[int, Counter] = defaultdict(Counter)
    rights: dict[int, list[float]] = defaultdict(list)
    for page in pages:
        body = [line for line in page.lines if _is_body(line, size)]
        if not body:
            continue
        left = Counter(round(line.x0) for line in body).most_common(1)[0][0]
        right = sorted(line.x1 for line in body)[int(len(body) * 0.9)]
        per_page[page.number] = (left, right, len(body))
        lefts[page.number % 2].update(round(line.x0) for line in body)
        rights[page.number % 2].extend(line.x1 for line in body)

    group_left = {k: v.most_common(1)[0][0] for k, v in lefts.items()}
    group_right = {k: sorted(v)[int(len(v) * 0.9)] for k, v in rights.items()}
    boxes = {}
    for number, (left, right, count) in per_page.items():
        parity = number % 2
        same_margins = abs(left - group_left[parity]) < 3 * size
        boxes[number] = PageBox(
            left=min(left, group_left[parity]) if same_margins else left,
            right=max(right, group_right[parity]) if same_margins or count < 8 else right,
        )
    return boxes


# --- running headers and footers ------------------------------------------------------------


def _mask(text: str) -> str:
    return re.sub(r'\s+', ' ', re.sub(r'\d+', '#', text.lower())).strip()


def _detached(page: Page, index: int, leading: float) -> bool:
    """A header stands apart from the text block. A lone line on a page proves nothing."""
    neighbour = index + 1 if index < len(page.lines) / 2 else index - 1
    if not 0 <= neighbour < len(page.lines):
        return True
    return abs(page.lines[index].y - page.lines[neighbour].y) >= 1.3 * leading


def strip_furniture(pages: list[Page], size: float, leading: float) -> None:
    """Removes running headers, footers and page numbers in place."""
    text_pages = [page for page in pages if page.lines]
    if not text_pages:
        return
    repeats: Counter = Counter()
    wording = Counter(line.text.strip().lower() for page in text_pages for line in page.lines)

    def opens_chapter(line: Line) -> bool:
        """`Chapter 3` repeats once digits are masked, but only a running head repeats word for word.
        A head that carries its page number is unique on every page too, hence the digit check."""
        text = line.text.strip()
        if wording[text.lower()] > 1 or not any(c.isalpha() for c in text):
            return False
        if line.size >= 1.15 * size:
            return True
        return bool(NUMBERED_CHAPTER.match(text) or (CHAPTER.match(text) and not re.search(r'\d', text)))

    def margin_lines(page: Page):
        count = len(page.lines)
        for index in range(min(2, count)):
            yield 'top', index
        for index in range(max(count - 2, 2 if count > 2 else 0), count):
            yield 'bottom', index

    def distance(page: Page, zone: str, index: int) -> float:
        line = page.lines[index]
        return line.top if zone == 'top' else line.bottom

    for page in text_pages:
        for zone, index in margin_lines(page):
            band = round(distance(page, zone, index) / 4)
            repeats[zone, _mask(page.lines[index].text), band] += 1

    def count_of(zone: str, mask: str, position: float) -> int:
        band = round(position / 4)
        return sum(repeats[zone, mask, b] for b in (band - 1, band, band + 1))

    # A detached line needs little repetition to be furniture: two pages can be a whole document
    # with alternating heads. Lines inside the text block need a lot more.
    minimum = max(2, math.ceil(0.04 * len(text_pages)))
    frequent = max(3, math.ceil(0.35 * len(text_pages)))

    # First pass: what clearly repeats. Its positions define the header and footer bands.
    doomed: dict[int, set[int]] = defaultdict(set)
    bands: dict[str, list[float]] = defaultdict(list)
    for page in text_pages:
        for zone, index in margin_lines(page):
            line = page.lines[index]
            if opens_chapter(line):
                continue
            position = distance(page, zone, index)
            times = count_of(zone, _mask(line.text), position)
            if times >= frequent or (times >= minimum and _detached(page, index, leading)):
                doomed[page.number].add(index)
                bands[zone].append(position)

    # Second pass: one-off text in those bands (a chapter's running head on a short chapter).
    for page in text_pages:
        for zone, index in margin_lines(page):
            line = page.lines[index]
            if opens_chapter(line):
                continue
            position = distance(page, zone, index)
            in_band = any(abs(position - p) <= 2 for p in bands[zone][:200])
            looks_numeric = PAGE_NUMBER.match(line.text) and line.size <= 1.15 * size
            if _detached(page, index, leading) and (in_band or looks_numeric):
                doomed[page.number].add(index)

    for page in text_pages:
        if page.number in doomed:
            page.lines = [line for i, line in enumerate(page.lines) if i not in doomed[page.number]]


def strip_ruby(pages: list[Page], size: float) -> None:
    """Furigana sits in its own small lines above the text it glosses."""
    total = sum(len(line.text) for page in pages for line in page.lines)
    cjk = sum(is_cjk(c) for page in pages for line in page.lines for c in line.text)
    if total == 0 or cjk / total < 0.3:
        return
    for page in pages:
        page.lines = [
            line for line in page.lines
            if not (line.size <= 0.65 * size and all(0x3040 <= ord(c) <= 0x30FF or c.isspace() for c in line.text))
        ]


def attach_drop_caps(pages: list[Page], size: float) -> None:
    """A drop cap is one huge letter whose baseline sits two or three lines down. It belongs in
    front of the topmost line beside it, wherever line sorting put it."""
    for page in pages:
        for cap in [line for line in page.lines if len(line.text) == 1 and line.text.isalpha() and line.size >= 1.8 * size]:
            beside = [
                line for line in page.lines
                if line is not cap and line.x0 >= cap.x0 and cap.y - 0.2 * size <= line.y <= cap.y + 0.9 * cap.size
            ]
            if beside:
                first = max(beside, key=lambda line: line.y)
                first.text = cap.text + first.text
                page.lines.remove(cap)


# --- joining --------------------------------------------------------------------------------


def build_vocabulary(pages: list[Page]) -> Counter:
    """Word counts for telling hyphenation from compounds. The halves of a word split across
    lines are left out: `extraor-` must not make `extraor` a word."""
    words: Counter = Counter()
    for page in pages:
        split_before = False
        for line in page.lines:
            found = re.findall(r"[^\W\d_]+(?:-[^\W\d_]+)*", line.text.lower())
            split_after = line.text[-1] in HYPHENS or line.text[-1] == SOFT_HYPHEN
            words.update(found[int(split_before): len(found) - int(split_after)])
            split_before = split_after
    return words


def _keeps_hyphen(head: str, tail: str, vocabulary: Counter) -> bool:
    joined, compound = (head + tail).lower(), f'{head}-{tail}'.lower()
    if vocabulary[joined]:
        return False
    if vocabulary[compound]:
        return True
    if tail.lower() in WORD_ENDINGS or head.lower() in WORD_STARTS:
        return False
    return len(head) >= 4 and len(tail) >= 4 and bool(vocabulary[head.lower()]) and bool(vocabulary[tail.lower()])


def join(text: str, following: str, vocabulary: Counter) -> str:
    if not text:
        return following
    if not following:
        return text
    last, first = text[-1], following[0]
    if last == SOFT_HYPHEN:
        return text[:-1] + following
    if last in HYPHENS and len(text) > 1 and text[-2].isalpha() and not is_cjk(text[-2]):
        head = re.search(r'[^\W\d_]+$', text[:-1])
        tail = re.match(r'[^\W\d_]+', following)
        if head and tail and first.islower():
            mark = '-' if _keeps_hyphen(head.group(), tail.group(), vocabulary) else ''
            return text[:-1] + mark + following
        return text[:-1] + '-' + following
    if last in HYPHENS and len(text) > 1 and not text[-2].isspace():
        return text[:-1] + '-' + following  # 1914-1918
    if is_cjk(last) or is_cjk(first):
        return text + following
    return f'{text} {following}'


def _first_word_width(line: Line) -> float:
    match = re.match(r'\S+', line.text)
    word = match.group() if match else ''
    if word and is_cjk(word[0]):
        return line.size
    span = max(line.x1 - line.x0, 1)
    return span * len(word) / max(len(line.text), 1)


def _ended_early(a: Line, b: Line, right: float) -> bool:
    """A line stops short of the margin although the next word would have fitted there."""
    if a.text[-1] in HYPHENS or a.text[-1] == SOFT_HYPHEN:
        return False
    return right - a.x1 > _first_word_width(b) + 0.3 * a.size


def _splits(a: Line, b: Line, box: PageBox, metrics: Metrics) -> bool:
    """Does b start a new paragraph, given a directly above it on the same page?"""
    em = metrics.size
    scale = max(a.size / em, 1.0)
    gap = a.y - b.y
    if gap <= 0 or gap > (PARAGRAPH_GAP if metrics.uses_gaps else 1.5) * metrics.leading * scale:
        return True
    if abs(a.size - b.size) > 0.15 * em:
        return True
    if metrics.uses_gaps:
        return False  # a ragged line ending short means nothing here: only the gap ends a paragraph
    if not metrics.uses_indents and a.text.endswith(SENTENCE_END) and b.text[0] in OPENING_QUOTES:
        return True  # nothing else separates dialogue when lines happen to fill the measure

    b_indent = b.x0 - box.left
    a_indent = a.x0 - box.left
    if b_indent > 0.4 * em:
        if a_indent < b_indent - 0.3 * em:
            return True
        # Same indent as the line above: a block quote keeps going, dialogue lines do not.
        if a.text.endswith(SENTENCE_END):
            return True
        return _ended_early(a, b, max(a.x1, b.x1))
    return _ended_early(a, b, box.right)


def _continues_on_next_page(a: Line, b: Line, box_a: PageBox, box_b: PageBox, metrics: Metrics) -> bool:
    if abs(a.size - b.size) > 0.15 * metrics.size or b.x0 - box_b.left > 0.4 * metrics.size:
        return False
    if metrics.uses_gaps:
        return b.text[0].islower() or not a.text.endswith(SENTENCE_END)
    if not metrics.uses_indents and a.text.endswith(SENTENCE_END) and b.text[0] in OPENING_QUOTES:
        return False
    return not _ended_early(a, b, box_a.right)


def is_heading(line: Line, metrics: Metrics) -> bool:
    text = line.text
    if not any(c.isalpha() for c in text):
        return False
    if line.size >= 1.2 * metrics.size and len(text) <= 150:
        return True
    return len(text) <= 60 and bool(CHAPTER.match(text)) and text[-1] not in ',;:'


def _indented_lines(pages: list[Page], boxes: dict[int, PageBox], size: float) -> tuple[int, int]:
    lines = indented = 0
    for page in pages:
        box = boxes.get(page.number)
        for line in page.lines if box else ():
            lines += 1
            indented += 0.4 * size < line.x0 - box.left < 4 * size
    return indented, lines


def _gapped_lines(pages: list[Page], metrics: Metrics) -> int:
    return sum(
        PARAGRAPH_GAP * metrics.leading < a.y - b.y <= 4 * metrics.leading
        for page in pages
        for a, b in zip(page.lines, page.lines[1:])
        if _is_body(a, metrics.size) and _is_body(b, metrics.size)
    )


def blocks_from_pages(pages: list[Page], metrics: Metrics, vocabulary: Counter) -> list[dict]:
    boxes = _page_boxes(pages, metrics.size)
    indented, lines = _indented_lines(pages, boxes, metrics.size)
    gapped = _gapped_lines(pages, metrics)
    metrics.uses_indents = indented >= 0.03 * lines
    metrics.uses_gaps = gapped >= 0.03 * lines and gapped >= indented
    blocks: list[dict] = []
    current: dict | None = None
    previous: Line | None = None
    previous_page = 0

    for page in pages:
        if page.is_image:
            blocks.append({'t': 'img', 'page': page.number})
            continue
        box = boxes.get(page.number)
        for line in page.lines:
            kind = 'h' if is_heading(line, metrics) else 'p'
            if box is None:
                box = PageBox(line.x0, line.x1)
            if current is None or current['t'] != kind or previous is None:
                split = True
            elif previous_page == page.number:
                split = _splits(previous, line, box, metrics)
            else:
                split = kind == 'h' or not _continues_on_next_page(
                    previous, line, boxes.get(previous_page, box), box, metrics
                )
            if split:
                current = {'t': kind, 'text': line.text, 'page': page.number}
                blocks.append(current)
            else:
                current['text'] = join(current['text'], line.text, vocabulary)
            previous, previous_page = line, page.number

    for block in blocks:
        if 'text' in block:
            block['text'] = _tidy(block['text'])
    return [block for block in blocks if block['t'] == 'img' or block['text']]


def _tidy(text: str) -> str:
    if text.endswith(SOFT_HYPHEN):
        text = text[:-1]
    return text.replace(LINE_HYPHEN, '-').replace(SOFT_HYPHEN, '').strip()


def page_text(page: Page, vocabulary: Counter) -> str:
    text = ''
    for line in page.lines:
        text = join(text, line.text, vocabulary)
    return _tidy(text)


@dataclass
class Reflow:
    blocks: list[dict]
    page_texts: dict[int, str]
    decent: bool


def build_reflow(pages: list[Page]) -> Reflow:
    """pages: every page of the document in order. Their line lists are modified."""
    size = body_size(pages)
    raw_chars = sum(len(line.text) for page in pages for line in page.lines if not page.is_image)
    strip_ruby(pages, size)
    leading = body_leading(pages, size)
    strip_furniture(pages, size, leading)
    attach_drop_caps(pages, size)
    vocabulary = build_vocabulary(pages)
    blocks = blocks_from_pages(pages, Metrics(size, leading), vocabulary)
    page_texts = {page.number: text for page in pages if (text := page_text(page, vocabulary))}
    return Reflow(blocks, page_texts, _is_decent(blocks, raw_chars))


def _is_decent(blocks: list[dict], raw_chars: int) -> bool:
    """Text worth reading in place of the page images: enough of it, and not font gibberish."""
    text = ''.join(block.get('text', '') for block in blocks)
    if not text or len(text) < 0.5 * raw_chars:
        return False
    visible = [c for c in text if not c.isspace()]
    readable = sum(c.isalnum() or c in '.,!?;:\'"“”‘’-—…、。！？「」『』（）' for c in visible)
    broken = text.count('�')
    return readable >= 0.8 * len(visible) and broken <= 0.01 * len(visible)
