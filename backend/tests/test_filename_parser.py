import pytest

from app.filename_parser import is_generic_name, parse_filename


@pytest.mark.parametrize('filename, title, series, volume', [
    ('[Group] Series v01 (2020) (Digital).pdf', 'Series Vol. 1', 'Series', 1),
    ('[Yen Press] Sword Art Online v03 (2014) (Digital) (LuCaZ).pdf', 'Sword Art Online Vol. 3', 'Sword Art Online', 3),
    ('(Digital) [Group] Long Series Name v12.pdf', 'Long Series Name Vol. 12', 'Long Series Name', 12),
    ('Series Vol. 3.pdf', 'Series Vol. 3', 'Series', 3),
    ('Series vol 3.pdf', 'Series Vol. 3', 'Series', 3),
    ('Series Volume 7.PDF', 'Series Vol. 7', 'Series', 7),
    ('Series, Vol. 4.pdf', 'Series Vol. 4', 'Series', 4),
    ('Series - Chapter 12.pdf', 'Series Ch. 12', 'Series', 12),
    ('Series Ch. 12.5.pdf', 'Series Ch. 12.5', 'Series', 12.5),
    ('Series c.pdf', 'Series c', None, None),
    ('Series 03.pdf', 'Series Vol. 3', 'Series', 3),
    ('Series - 03.pdf', 'Series Vol. 3', 'Series', 3),
    ('Series_Name_v02.pdf', 'Series Name Vol. 2', 'Series Name', 2),
    ('Series_Name_Vol_2.pdf', 'Series Name Vol. 2', 'Series Name', 2),
    ('Series_Name_03.pdf', 'Series Name Vol. 3', 'Series Name', 3),
    ('My.Book.v02.pdf', 'My Book Vol. 2', 'My Book', 2),
    ('Series v1.5.pdf', 'Series Vol. 1.5', 'Series', 1.5),
    ('Series v01-03.pdf', 'Series Vol. 1', 'Series', 1),
    ('Series Book 2 - The Second One.pdf', 'Series Vol. 2 - The Second One', 'Series', 2),
    ('Series v2 - Subtitle Here (2021).pdf', 'Series Vol. 2 - Subtitle Here', 'Series', 2),
    ('魔法少女 第3巻.pdf', '魔法少女 Vol. 3', '魔法少女', 3),
    ('A Standalone Novel.pdf', 'A Standalone Novel', None, None),
    ('Blade Runner 2049.pdf', 'Blade Runner 2049', None, None),
    ('Nineteen 1984.pdf', 'Nineteen 1984', None, None),
    ('2001.pdf', '2001', None, None),
    ('v01.pdf', 'v01', None, None),
    ('[Group] Only Tags (2020).pdf', 'Only Tags', None, None),
    ('[2020] (Digital).pdf', '[2020] (Digital)', None, None),
    ('C:\\books\\Series v02.pdf', 'Series Vol. 2', 'Series', 2),
    ('some/dir/Series v02.pdf', 'Series Vol. 2', 'Series', 2),
    ('no_extension_v3', 'no extension Vol. 3', 'no extension', 3),
])
def test_parse_filename(filename, title, series, volume):
    parsed = parse_filename(filename)
    assert (parsed.title, parsed.series, parsed.volume) == (title, series, volume)


@pytest.mark.parametrize('filename, generic', [
    ('scan.pdf', True),
    ('document (1).pdf'.replace(' (1)', ' 1'), True),
    ('Untitled.pdf', True),
    ('20240301.pdf', True),
    ('0123456789abcdef0123456789abcdef.pdf', True),
    ('Sword Art Online v03.pdf', False),
    ('The Long Road.pdf', False),
])
def test_is_generic_name(filename, generic):
    assert is_generic_name(filename) is generic
