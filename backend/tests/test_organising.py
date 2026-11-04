"""Series moves, collections, and re-reading the text of books an older extractor processed."""
import sqlite3
import time

import pytest
from alembic import command
from alembic.config import Config

from app.reflow import TEXT_VERSION
from tests import pdf_samples as samples
from tests.conftest import BACKEND


def add(harness, tmp_path, name, headers=None, pages=1):
    return harness.ingest(samples.manga_pdf(tmp_path / name, pages=pages), name=name, headers=headers)


@pytest.fixture
def books(open_mode, tmp_path):
    # Distinct page counts make distinct files, so the duplicate check stays out of the way.
    return [add(open_mode, tmp_path, f'{name}.pdf', pages=pages) for pages, name in enumerate(
        ('Ascendance v01', 'Ascendence v02', 'Ascendence v03', 'Loose'), start=1
    )]


def bulk(client, ids, headers=None, **changes):
    return client.post('/api/documents/bulk-update', json={'ids': ids, 'changes': changes}, headers=headers or {})


# --- moving books between series --------------------------------------------------------------


def test_two_spellings_merge_into_one_series(open_mode, books):
    assert [b['series'] for b in books[:2]] == ['Ascendance', 'Ascendence']
    response = bulk(open_mode.client, [books[1]['id'], books[2]['id']], series='Ascendance')
    assert response.status_code == 200
    assert {d['series'] for d in response.json()} == {'Ascendance'}
    library = open_mode.client.get('/api/library').json()
    assert sorted(d['volume'] for d in library if d['series'] == 'Ascendance') == [1, 2, 3]


def test_series_can_be_cleared_and_other_fields_stay(open_mode, books):
    doc = books[0]
    updated = bulk(open_mode.client, [doc['id']], series=None).json()[0]
    assert updated['series'] is None
    assert (updated['volume'], updated['title']) == (doc['volume'], doc['title'])


def test_bulk_sets_only_what_was_sent(open_mode, books):
    open_mode.client.patch(f'/api/documents/{books[0]["id"]}', json={'author': 'Kept'})
    updated = {d['id']: d for d in bulk(open_mode.client, [books[0]['id'], books[3]['id']], kind='novel').json()}
    assert updated[books[0]['id']]['kind'] == updated[books[3]['id']]['kind'] == 'novel'
    assert updated[books[0]['id']]['author'] == 'Kept'
    assert updated[books[0]['id']]['series'] == books[0]['series']


def test_bulk_is_all_or_nothing(open_mode, books):
    response = bulk(open_mode.client, [books[0]['id'], 'nope'], series='Elsewhere')
    assert response.status_code == 404
    assert open_mode.client.get(f'/api/documents/{books[0]["id"]}').json()['series'] == books[0]['series']


@pytest.mark.parametrize('body', [
    {'ids': [], 'changes': {'series': 'X'}},
    {'ids': ['a'] * 5001, 'changes': {'series': 'X'}},
    {'ids': ['a'], 'changes': {'series': ''}},
    {'ids': ['a'], 'changes': {'kind': 'poem'}},
])
def test_bulk_rejects_bad_input(open_mode, body):
    assert open_mode.client.post('/api/documents/bulk-update', json=body).status_code == 422


def test_moved_series_survives_a_reprocess(open_mode, books):
    doc = books[1]
    bulk(open_mode.client, [doc['id']], series='Ascendance', kind='novel')
    open_mode.client.post(f'/api/documents/{doc["id"]}/reprocess')
    done = open_mode.wait_ready(doc['id'])
    assert (done['series'], done['kind']) == ('Ascendance', 'novel')


def test_bulk_cannot_touch_another_users_book(scoped, tmp_path):
    alice, bob = scoped.as_user('alice'), scoped.as_user('bob')
    private = add(scoped, tmp_path, 'Alice Only.pdf', alice)
    assert bulk(scoped.client, [private['id']], bob, series='Mine now').status_code == 404
    assert scoped.client.get(f'/api/documents/{private["id"]}', headers=alice).json()['series'] != 'Mine now'


# --- collections ------------------------------------------------------------------------------


def make(client, name, headers=None):
    response = client.post('/api/collections', json={'name': name}, headers=headers or {})
    assert response.status_code == 201, response.text
    return response.json()


def items(client, collection, headers=None, **body):
    return client.post(f'/api/collections/{collection["id"]}/items', json=body, headers=headers or {})


def test_collection_lifecycle(open_mode, books):
    client = open_mode.client
    assert client.get('/api/collections').json() == []
    zebra, isekai = make(client, '  zebra picks '), make(client, 'Isekai')
    assert zebra['name'] == 'zebra picks'
    assert [c['name'] for c in client.get('/api/collections').json()] == ['Isekai', 'zebra picks']

    renamed = client.patch(f'/api/collections/{isekai["id"]}', json={'name': 'Fantasy'})
    assert renamed.json() == {'id': isekai['id'], 'name': 'Fantasy'}
    assert client.delete(f'/api/collections/{zebra["id"]}').status_code == 204
    assert [c['name'] for c in client.get('/api/collections').json()] == ['Fantasy']


def test_a_book_can_be_in_several_collections(open_mode, books):
    client = open_mode.client
    one, two = make(client, 'One'), make(client, 'Two')
    doc_id = books[0]['id']
    assert items(client, one, add=[doc_id]).status_code == 204
    assert items(client, two, add=[doc_id]).status_code == 204
    assert client.get(f'/api/documents/{doc_id}').json()['collections'] == [one['id'], two['id']]
    listed = {d['id']: d['collections'] for d in client.get('/api/library').json()}
    assert listed[doc_id] == [one['id'], two['id']]
    assert listed[books[1]['id']] == []


def test_adding_twice_and_removing_absent_are_harmless(open_mode, books):
    client = open_mode.client
    collection = make(client, 'Shelf')
    doc_id = books[0]['id']
    assert items(client, collection, add=[doc_id]).status_code == 204
    assert items(client, collection, add=[doc_id]).status_code == 204
    assert items(client, collection, remove=[doc_id, books[1]['id']]).status_code == 204
    assert client.get(f'/api/documents/{doc_id}').json()['collections'] == []


def test_patch_responses_keep_collections(open_mode, books):
    client = open_mode.client
    collection = make(client, 'Shelf')
    items(client, collection, add=[books[0]['id']])
    assert client.patch(f'/api/documents/{books[0]["id"]}', json={'title': 'New'}).json()['collections'] == [collection['id']]
    assert bulk(client, [books[0]['id']], series='S').json()[0]['collections'] == [collection['id']]


def test_duplicate_names_conflict(open_mode):
    client = open_mode.client
    make(client, 'Same')
    other = make(client, 'Other')
    assert client.post('/api/collections', json={'name': 'Same'}).status_code == 409
    assert client.patch(f'/api/collections/{other["id"]}', json={'name': 'Same'}).status_code == 409
    assert [c['name'] for c in client.get('/api/collections').json()] == ['Other', 'Same']


@pytest.mark.parametrize('name', ['', '   ', 'x' * 201])
def test_bad_names_are_rejected(open_mode, name):
    assert open_mode.client.post('/api/collections', json={'name': name}).status_code == 422


def test_deleting_a_collection_keeps_its_books(open_mode, books):
    client = open_mode.client
    collection = make(client, 'Going away')
    items(client, collection, add=[books[0]['id']])
    client.delete(f'/api/collections/{collection["id"]}')
    assert client.get(f'/api/documents/{books[0]["id"]}').json()['collections'] == []
    assert len(client.get('/api/library').json()) == len(books)


def test_deleting_a_book_leaves_its_collection(open_mode, books):
    client = open_mode.client
    collection = make(client, 'Stays')
    items(client, collection, add=[books[0]['id']])
    assert client.delete(f'/api/documents/{books[0]["id"]}').status_code == 204
    assert [c['id'] for c in client.get('/api/collections').json()] == [collection['id']]
    with sqlite3.connect(open_mode.settings.data_dir / 'library.sqlite3') as db:
        assert db.execute('SELECT count(*) FROM collection_items').fetchone() == (0,)


def test_adding_an_unknown_book_changes_nothing(open_mode, books):
    client = open_mode.client
    collection = make(client, 'Shelf')
    assert items(client, collection, add=[books[0]['id'], 'nope']).status_code == 404
    assert client.get(f'/api/documents/{books[0]["id"]}').json()['collections'] == []


def test_collections_are_private_to_each_user(scoped, tmp_path):
    alice, bob = scoped.as_user('alice'), scoped.as_user('bob')
    client = scoped.client
    own = add(scoped, tmp_path, 'Alice Private.pdf', alice)
    mine = make(client, 'Alice list', alice)
    items(client, mine, alice, add=[own['id']])

    assert client.get('/api/collections', headers=bob).json() == []
    assert client.patch(f'/api/collections/{mine["id"]}', json={'name': 'Hacked'}, headers=bob).status_code == 404
    assert client.delete(f'/api/collections/{mine["id"]}', headers=bob).status_code == 404
    assert items(client, mine, bob, remove=[own['id']]).status_code == 404
    assert client.get(f'/api/documents/{own["id"]}', headers=alice).json()['collections'] == [mine['id']]

    # Two users can use the same name, and neither can put the other's private book in a list.
    theirs = make(client, 'Alice list', bob)
    assert items(client, theirs, bob, add=[own['id']]).status_code == 404


def test_shared_book_shows_only_the_callers_own_collections(scoped, tmp_path):
    alice, bob = scoped.as_user('alice'), scoped.as_user('bob')
    client = scoped.client
    book = add(scoped, tmp_path, 'Shared.pdf', alice)
    client.patch(f'/api/documents/{book["id"]}', json={'shared': True}, headers=alice)
    theirs = make(client, 'Bob reads', bob)
    items(client, theirs, bob, add=[book['id']])
    assert client.get(f'/api/documents/{book["id"]}', headers=alice).json()['collections'] == []
    assert client.get(f'/api/documents/{book["id"]}', headers=bob).json()['collections'] == [theirs['id']]


def test_collections_need_a_login_when_scoped(scoped):
    assert scoped.client.get('/api/collections').status_code == 401


# --- re-reading old text ----------------------------------------------------------------------


def age_text(harness, doc_id):
    with sqlite3.connect(harness.settings.data_dir / 'library.sqlite3') as db:
        db.execute('UPDATE documents SET text_version = 0 WHERE id = ?', (doc_id,))


def text_version(harness, doc_id):
    with sqlite3.connect(harness.settings.data_dir / 'library.sqlite3') as db:
        return db.execute('SELECT text_version FROM documents WHERE id = ?', (doc_id,)).fetchone()[0]


def wait_gave_up(harness, doc_id, timeout=30):
    deadline = time.monotonic() + timeout
    while doc_id not in harness.app.state.worker._refresh_failed:
        assert time.monotonic() < deadline, 'worker never tried'
        time.sleep(0.01)


def wait_refreshed(harness, doc_id, timeout=30):
    deadline = time.monotonic() + timeout
    statuses = set()
    while time.monotonic() < deadline:
        statuses.add(harness.client.get(f'/api/documents/{doc_id}').json()['status'])
        if text_version(harness, doc_id) == TEXT_VERSION:
            return statuses
        time.sleep(0.01)
    raise AssertionError('text was not refreshed')


def test_new_books_are_current(open_mode, tmp_path):
    doc = open_mode.ingest(samples.novel_pdf(tmp_path / 'n.pdf'))
    assert text_version(open_mode, doc['id']) == TEXT_VERSION


def test_old_text_is_redone_while_the_book_stays_readable(open_mode, tmp_path):
    doc = open_mode.ingest(samples.novel_pdf(tmp_path / 'n.pdf'))
    url = f'/api/documents/{doc["id"]}'
    open_mode.client.post(f'{url}/bookmarks', json={'page': 2, 'locator': 7})
    open_mode.client.put(f'{url}/progress', json={'page': 2, 'client_ts': 1})
    age_text(open_mode, doc['id'])
    etag = open_mode.client.get(f'{url}/text').headers['etag']

    open_mode.app.state.worker.notify()
    statuses = wait_refreshed(open_mode, doc['id'])

    assert statuses == {'ready'}
    after = open_mode.client.get(url).json()
    assert after['cover_version'] == doc['cover_version']
    assert after['state']['page'] == 2
    # The blocks may have moved, so the bookmark falls back to its page.
    assert [(b['page'], b['locator']) for b in after['bookmarks']] == [(2, None)]
    assert open_mode.client.get(f'{url}/text').headers['etag'] != etag
    assert open_mode.client.get(f'{url}/text', headers={'If-None-Match': etag}).status_code == 200
    assert open_mode.client.get('/api/search', params={'q': 'mantelpiece'}).json()


def test_refresh_keeps_a_users_edits(open_mode, tmp_path):
    doc = open_mode.ingest(samples.novel_pdf(tmp_path / 'n.pdf'))
    url = f'/api/documents/{doc["id"]}'
    open_mode.client.patch(url, json={'title': 'Mine', 'series': 'My Series', 'kind': 'manga', 'volume': 4})
    age_text(open_mode, doc['id'])
    open_mode.app.state.worker.notify()
    wait_refreshed(open_mode, doc['id'])
    after = open_mode.client.get(url).json()
    assert (after['title'], after['series'], after['kind'], after['volume']) == ('Mine', 'My Series', 'manga', 4)


def test_failed_refresh_leaves_the_book_alone(open_mode, tmp_path):
    doc = open_mode.ingest(samples.novel_pdf(tmp_path / 'n.pdf'))
    url = f'/api/documents/{doc["id"]}'
    before = open_mode.client.get(f'{url}/text').content
    pdf = next(open_mode.settings.pdf_dir.glob('*.pdf'))
    moved = pdf.with_suffix('.away')
    pdf.rename(moved)
    age_text(open_mode, doc['id'])
    open_mode.app.state.worker.notify()
    wait_gave_up(open_mode, doc['id'])
    moved.rename(pdf)
    after = open_mode.client.get(url).json()
    assert (after['status'], after['error']) == ('ready', None)
    assert open_mode.client.get(f'{url}/text').content == before
    # Not marked as done, so a restart tries again.
    assert text_version(open_mode, doc['id']) == 0
    open_mode.app.state.worker._refresh_failed.clear()
    open_mode.app.state.worker.notify()
    wait_refreshed(open_mode, doc['id'])


def test_books_without_text_are_not_redone(open_mode, tmp_path):
    doc = add(open_mode, tmp_path, 'Picture Book.pdf')
    age_text(open_mode, doc['id'])
    open_mode.app.state.worker.notify()
    time.sleep(0.5)
    assert text_version(open_mode, doc['id']) == 0


# --- upgrading a live database ----------------------------------------------------------------


def alembic_config(url):
    config = Config(str(BACKEND / 'alembic.ini'))
    config.set_main_option('script_location', str(BACKEND / 'app' / 'migrations'))
    config.attributes['database_url'] = url
    config.attributes['configure_logging'] = False
    return config


def test_migration_keeps_existing_rows(tmp_path):
    path = tmp_path / 'old.sqlite3'
    config = alembic_config(f'sqlite:///{path}')
    command.upgrade(config, '0001')
    with sqlite3.connect(path) as db:
        db.execute(
            "INSERT INTO documents (id, filename, stored_name, size, title, kind, suggested_mode, edited_fields,"
            " page_count, page_sizes, outline, has_text, status, created_at, updated_at) VALUES"
            " ('d1', 'a.pdf', 'd1.pdf', 1, 'Old Book', 'novel', 'reflow', '[]', 1, '[]', '[]', 1, 'ready',"
            " '2026-01-01', '2026-01-01')"
        )
        db.execute(
            "INSERT INTO reading_states (user_id, document_id, page, offset, max_page, finished, favorite,"
            " seconds_read, overrides, client_ts) VALUES (0, 'd1', 9, 0, 9, 0, 1, 0, '{}', 5)"
        )
        db.execute("INSERT INTO page_text (document_id, page, text) VALUES ('d1', 1, 'searchable words')")

    command.upgrade(config, 'head')
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT title, text_version FROM documents').fetchall() == [('Old Book', 0)]
        assert db.execute('SELECT page, favorite FROM reading_states').fetchall() == [(9, 1)]
        assert db.execute('SELECT count(*) FROM collections').fetchone() == (0,)
        assert db.execute("SELECT rowid FROM page_fts WHERE page_fts MATCH 'searchable'").fetchall() != []
        # Everything hanging off the documents table has to survive a batch rebuild of it.
        names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'index'")]
        assert {'uq_documents_owner_sha', 'ix_documents_owner_id', 'ix_documents_status'} <= set(names)

    command.downgrade(config, '0001')
    command.upgrade(config, 'head')
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT title FROM documents').fetchall() == [('Old Book',)]
