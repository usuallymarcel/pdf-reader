from datetime import datetime, timedelta, timezone

import pytest

from app.routes.library import _streak
from app.routes.search import escape_snippet, fts_terms, like_pattern
from tests import pdf_samples as samples


@pytest.fixture
def doc(open_mode, tmp_path):
    return open_mode.ingest(samples.novel_pdf(tmp_path / 'novel.pdf'))


def put(h, doc, **body):
    return h.client.put(f'/api/documents/{doc["id"]}/progress', json=body)


# --- progress -----------------------------------------------------------------------------------


def test_progress_saved(open_mode, doc):
    state = put(open_mode, doc, page=3, offset=0.25, seconds=12, client_ts=1000).json()
    assert (state['page'], state['offset'], state['max_page'], state['seconds_read']) == (3, 0.25, 3, 12)
    assert state['client_ts'] == 1000
    assert state['last_read_at'].endswith('Z')
    assert open_mode.client.get('/api/library').json()[0]['state']['page'] == 3


def test_last_write_wins_on_client_ts(open_mode, doc):
    put(open_mode, doc, page=4, client_ts=2000)
    state = put(open_mode, doc, page=2, client_ts=1000).json()
    assert (state['page'], state['client_ts']) == (4, 2000)
    state = put(open_mode, doc, page=2, client_ts=3000).json()
    assert (state['page'], state['client_ts']) == (2, 3000)


def test_seconds_accumulate_even_when_a_write_loses(open_mode, doc):
    put(open_mode, doc, page=4, seconds=10, client_ts=2000)
    state = put(open_mode, doc, page=2, seconds=5, client_ts=1000).json()
    assert state['page'] == 4
    assert state['seconds_read'] == 15


def test_seconds_keep_fractions(open_mode, doc):
    for ts in range(10):
        state = put(open_mode, doc, page=1, seconds=0.5, client_ts=ts).json()
    assert state['seconds_read'] == 5


def test_max_page_never_shrinks_and_takes_losing_writes(open_mode, doc):
    put(open_mode, doc, page=3, client_ts=2000)
    assert put(open_mode, doc, page=1, client_ts=3000).json()['max_page'] == 3
    state = put(open_mode, doc, page=5, client_ts=1000).json()
    assert (state['page'], state['max_page']) == (1, 5)


def test_finished_at_last_page(open_mode, doc):
    last = doc['page_count']
    assert put(open_mode, doc, page=last - 1, client_ts=1).json()['finished'] is False
    assert put(open_mode, doc, page=last, client_ts=2).json()['finished'] is True
    assert put(open_mode, doc, page=1, client_ts=3).json()['finished'] is True


def test_page_clamped_to_document(open_mode, doc):
    state = put(open_mode, doc, page=99999, client_ts=1).json()
    assert state['page'] == doc['page_count']


@pytest.mark.parametrize('body', [
    {'page': 0, 'client_ts': 1},
    {'page': 1, 'offset': 1.5, 'client_ts': 1},
    {'page': 1, 'seconds': -1, 'client_ts': 1},
    {'page': 1},
])
def test_progress_validation(open_mode, doc, body):
    assert open_mode.client.put(f'/api/documents/{doc["id"]}/progress', json=body).status_code == 422


# --- state --------------------------------------------------------------------------------------


def test_state_patch(open_mode, doc):
    url = f'/api/documents/{doc["id"]}/state'
    state = open_mode.client.patch(url, json={'favorite': True, 'overrides': {'fit': 'width'}}).json()
    assert state['favorite'] is True
    assert state['overrides'] == {'fit': 'width'}
    state = open_mode.client.patch(url, json={'finished': True}).json()
    assert state['finished'] is True
    assert state['favorite'] is True


def test_reset_progress(open_mode, doc):
    put(open_mode, doc, page=doc['page_count'], seconds=9, offset=0.5, client_ts=1000)
    state = open_mode.client.patch(f'/api/documents/{doc["id"]}/state', json={'reset_progress': True}).json()
    assert (state['page'], state['offset'], state['max_page'], state['finished']) == (1, 0, 1, False)
    assert state['seconds_read'] == 9


def test_reset_beats_older_queued_writes(open_mode, doc):
    put(open_mode, doc, page=3, client_ts=1000)
    open_mode.client.patch(f'/api/documents/{doc["id"]}/state', json={'reset_progress': True})
    assert put(open_mode, doc, page=3, client_ts=2000).json()['page'] == 1


# --- bookmarks ------------------------------------------------------------------------------------


def test_bookmarks(open_mode, doc):
    url = f'/api/documents/{doc["id"]}/bookmarks'
    created = open_mode.client.post(url, json={'page': 2, 'note': 'here', 'locator': 7})
    assert created.status_code == 201
    bookmark = created.json()
    assert set(bookmark) == {'id', 'document_id', 'page', 'note', 'locator', 'created_at'}
    assert (bookmark['page'], bookmark['note'], bookmark['locator']) == (2, 'here', 7)
    assert open_mode.client.post(url, json={'page': 1}).json()['note'] is None

    assert [b['page'] for b in open_mode.client.get(url).json()] == [1, 2]
    assert [b['page'] for b in open_mode.client.get(f'/api/documents/{doc["id"]}').json()['bookmarks']] == [1, 2]
    assert open_mode.client.delete(f'/api/bookmarks/{bookmark["id"]}').status_code == 204
    assert open_mode.client.delete(f'/api/bookmarks/{bookmark["id"]}').status_code == 404


# --- preferences --------------------------------------------------------------------------------


def test_preferences_round_trip(open_mode):
    assert open_mode.client.get('/api/preferences').json() == {'data': None, 'updated_at': None}
    body = open_mode.client.put('/api/preferences', json={'data': {'theme': 'dark'}}).json()
    assert body['data'] == {'theme': 'dark'}
    assert body['updated_at'].endswith('Z')
    open_mode.client.put('/api/preferences', json={'data': {'theme': 'sepia'}})
    assert open_mode.client.get('/api/preferences').json()['data'] == {'theme': 'sepia'}


def test_preferences_are_per_user(scoped):
    alice, bob = scoped.as_user('alice'), scoped.as_user('bob')
    scoped.client.put('/api/preferences', json={'data': {'a': 1}}, headers=alice)
    assert scoped.client.get('/api/preferences', headers=bob).json()['data'] is None


# --- stats -----------------------------------------------------------------------------------------


def test_stats(open_mode, doc, tmp_path):
    open_mode.ingest(samples.script_pdf(tmp_path / 'other.pdf'))
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    yesterday = now_ms - 86_400_000
    put(open_mode, doc, page=doc['page_count'], seconds=60, client_ts=yesterday)
    put(open_mode, doc, page=doc['page_count'], seconds=30, client_ts=now_ms)

    stats = open_mode.client.get('/api/stats').json()
    assert set(stats) == {'documents', 'finished', 'pages_read', 'seconds_read', 'daily_seconds', 'streak_days'}
    assert stats['documents'] == 2
    assert stats['finished'] == 1
    assert stats['pages_read'] == doc['page_count']
    assert stats['seconds_read'] == 90
    days = stats['daily_seconds']
    assert len(days) == 30
    assert days == sorted(days, key=lambda day: day['date'])
    assert days[-1] == {'date': datetime.now(timezone.utc).date().isoformat(), 'seconds': 30}
    assert days[-2]['seconds'] == 60
    assert stats['streak_days'] == 2


def test_stats_empty(open_mode):
    stats = open_mode.client.get('/api/stats').json()
    assert (stats['documents'], stats['finished'], stats['pages_read'], stats['streak_days']) == (0, 0, 0, 0)


def test_future_client_clock_is_not_booked_in_the_future(open_mode, doc):
    put(open_mode, doc, page=1, seconds=5, client_ts=int(datetime(2099, 1, 1, tzinfo=timezone.utc).timestamp() * 1000))
    assert open_mode.client.get('/api/stats').json()['daily_seconds'][-1]['seconds'] == 5


def test_streak():
    today = datetime(2026, 3, 10).date()
    day = lambda back: (today - timedelta(days=back)).isoformat()
    assert _streak(set(), today) == 0
    assert _streak({day(0)}, today) == 1
    assert _streak({day(1), day(2)}, today) == 2  # today not read yet
    assert _streak({day(0), day(1), day(3)}, today) == 2
    assert _streak({day(2)}, today) == 0


# --- search --------------------------------------------------------------------------------------


def search(h, q, **params):
    return h.client.get('/api/search', params={'q': q, **params})


def test_search_finds_page_and_marks_match(open_mode, doc):
    hits = search(open_mode, 'mantelpiece').json()
    assert hits
    hit = hits[0]
    assert set(hit) == {'document_id', 'title', 'page', 'snippet'}
    assert hit['document_id'] == doc['id']
    assert '<mark>' in hit['snippet'] and '</mark>' in hit['snippet']


def test_search_is_case_insensitive(open_mode, doc):
    assert search(open_mode, 'MANTELPIECE').json()


def test_search_multiple_words_and_order(open_mode, doc):
    assert search(open_mode, 'iron key').json()
    assert search(open_mode, 'key iron').json()
    assert search(open_mode, 'iron zebra').json() == []


def test_search_within_doc(open_mode, doc, tmp_path):
    other = open_mode.ingest(samples.novel_pdf(tmp_path / 'other.pdf', samples.PARAGRAPHS[:12], title='Other'))
    assert {hit['document_id'] for hit in search(open_mode, 'mantelpiece').json()} == {doc['id'], other['id']}
    hits = search(open_mode, 'mantelpiece', doc=other['id']).json()
    assert {hit['document_id'] for hit in hits} == {other['id']}
    pages = [hit['page'] for hit in hits]
    assert pages == sorted(pages)


def test_search_limit(open_mode, doc):
    assert len(search(open_mode, 'mantelpiece', limit=1).json()) == 1
    assert search(open_mode, 'mantelpiece', limit=0).status_code == 422


def test_search_empty_query(open_mode, doc):
    assert search(open_mode, '   ').json() == []


def test_search_cjk(open_mode, tmp_path):
    open_mode.ingest(samples.cjk_pdf(tmp_path / 'jp.pdf', [
        '吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。',
    ]))
    assert '<mark>見当が</mark>' in search(open_mode, '見当が').json()[0]['snippet'].replace('</mark><mark>', '')


def test_search_cjk_two_characters_uses_like(open_mode, tmp_path):
    open_mode.ingest(samples.cjk_pdf(tmp_path / 'jp.pdf', ['吾輩は猫である。名前はまだ無い。']))
    hits = search(open_mode, '名前').json()
    assert len(hits) == 1
    assert '<mark>名前</mark>' in hits[0]['snippet']


def test_search_short_latin_uses_like(open_mode, doc):
    hits = search(open_mode, 'of').json()
    assert hits
    assert '<mark>of</mark>' in hits[0]['snippet'].lower()


def test_like_wildcards_are_literal(open_mode, doc):
    assert search(open_mode, '%').json() == []
    assert search(open_mode, '_').json() == []


@pytest.mark.parametrize('query', [
    '"', '""', 'a"b', 'NEAR(', 'col:mn', '*', '^abc', 'AND', 'OR NOT', "it's", '(((', "'; DROP TABLE documents; --",
])
def test_fts_syntax_in_queries_is_harmless(open_mode, doc, query):
    assert search(open_mode, query).status_code == 200
    assert open_mode.client.get('/api/library').status_code == 200


def test_pdf_content_comes_back_escaped(open_mode, tmp_path):
    open_mode.ingest(samples.script_pdf(tmp_path / 's.pdf'))
    snippet = search(open_mode, 'script').json()[0]['snippet']
    assert '<script' not in snippet
    assert '&lt;' in snippet and '&gt;' in snippet
    assert '<mark>' in snippet
    without_marks = snippet.replace('<mark>', '').replace('</mark>', '')
    assert '<' not in without_marks and '>' not in without_marks


def test_like_snippet_is_escaped_too(open_mode, tmp_path):
    open_mode.ingest(samples.script_pdf(tmp_path / 's.pdf'))
    snippet = search(open_mode, '<s').json()[0]['snippet']
    assert '<mark>&lt;s</mark>' in snippet
    assert '<script' not in snippet


def test_escape_snippet():
    assert escape_snippet('a<b>\x01c&d\x02') == 'a&lt;b&gt;<mark>c&amp;d</mark>'


def test_fts_terms_quote_everything():
    assert fts_terms('foo "bar') == '"foo" """bar"'
    assert fts_terms('ab cd') == ''
    assert fts_terms('ab cde') == '"cde"'


def test_like_pattern_escapes():
    assert like_pattern('50%_a\\') == '%50\\%\\_a\\\\%'
