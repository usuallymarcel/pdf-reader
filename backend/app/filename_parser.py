"""Turns release-style file names into a title, series and volume."""
import re
from dataclasses import dataclass
from pathlib import PurePosixPath

_BRACKETS = re.compile(r'\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|【[^】]*】')
_NUMBER = r'(\d{1,4}(?:\.\d{1,2})?)'
_RANGE_TAIL = r'(?:\s*-\s*\d{1,4}(?:\.\d{1,2})?)?'

# Explicit markers, strongest first. The series is whatever precedes the marker.
_MARKERS = [
    re.compile(rf'^(?P<series>.+?)[\s,:_-]+(?:v|vol|vols|volume|tome|book|bk)\.?\s*{_NUMBER}{_RANGE_TAIL}(?P<rest>(?:\s*[-:–—]\s*.+)?)$', re.I),
    re.compile(rf'^(?P<series>.+?)[\s,:_-]+(?:ch|chap|chapter|ep|episode|part|pt|#)\.?\s*{_NUMBER}{_RANGE_TAIL}(?P<rest>(?:\s*[-:–—]\s*.+)?)$', re.I),
    re.compile(rf'^(?P<series>.+?)\s*第\s*{_NUMBER}\s*[巻话話章集](?P<rest>.*)$'),
]
# `Series 03`, `Series - 03`. Bare numbers must not look like a year.
_BARE = re.compile(rf'^(?P<series>.*\D)[\s_-]+{_NUMBER}{_RANGE_TAIL}$')

_GENERIC = re.compile(r'^(?:scan|document|untitled|book|file|download|new|pdf|\d+|[0-9a-f-]{16,})[\s\d_-]*$', re.I)


@dataclass(frozen=True)
class ParsedName:
    title: str
    series: str | None = None
    volume: float | None = None


def _number(text: str) -> float:
    return float(text)


def _clean(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip(' -_–—:,.')


def _normalise(stem: str) -> str:
    if ' ' not in stem:
        stem = stem.replace('_', ' ')
        if ' ' not in stem:
            # `My.Book.v02` uses dots as spaces, but keep the dot in `v01.5`.
            stem = re.sub(r'\.(?!\d)', ' ', stem)
    else:
        stem = stem.replace('_', ' ')
    stem = _BRACKETS.sub(' ', stem)
    return re.sub(r'\s+', ' ', stem).strip()


def _format_volume(volume: float) -> str:
    return str(int(volume)) if volume == int(volume) else str(volume)


def parse_filename(filename: str) -> ParsedName:
    stem = PurePosixPath(filename.replace('\\', '/')).name
    stem = re.sub(r'\.pdf$', '', stem, flags=re.I)
    name = _normalise(stem)
    if not _clean(name):
        return ParsedName(title=_clean(stem.replace('_', ' ')) or filename or 'Untitled')

    for index, marker in enumerate(_MARKERS):
        match = marker.match(name)
        series = _clean(match.group('series')) if match else ''
        if not series:
            continue
        volume = _number(match.group(2))
        rest = _clean(match.group('rest'))
        label = 'Vol.' if index != 1 else 'Ch.'
        title = f'{series} {label} {_format_volume(volume)}'
        return ParsedName(f'{title} - {rest}' if rest else title, series, volume)

    match = _BARE.match(name)
    if match:
        series = _clean(match.group('series'))
        volume = _number(match.group(2))
        is_year = 1900 <= volume <= 2099 and volume == int(volume)
        if series and not is_year and volume < 1000:
            return ParsedName(f'{series} Vol. {_format_volume(volume)}', series, volume)

    return ParsedName(_clean(name))


def is_generic_name(filename: str) -> bool:
    """True when a file name says nothing, so that PDF metadata makes a better title."""
    stem = re.sub(r'\.pdf$', '', PurePosixPath(filename.replace('\\', '/')).name, flags=re.I)
    return bool(_GENERIC.match(stem.strip()))
