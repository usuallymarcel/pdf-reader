import sqlite3

import pytest

from app.config import Settings
from tests import pdf_samples as samples


def legacy_db(settings: Settings, rows: list[tuple]) -> None:
    connection = sqlite3.connect(settings.legacy_db)
    connection.execute("""
        CREATE TABLE documents (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            stored_name TEXT NOT NULL,
            uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_page INTEGER NOT NULL DEFAULT 1
        )
    """)
    connection.executemany(
        'INSERT INTO documents (id, filename, stored_name, uploaded_at, last_page) VALUES (?, ?, ?, ?, ?)', rows
    )
    connection.commit()
    connection.close()


@pytest.fixture
def prepared(tmp_path):
    def prepare(settings: Settings) -> None:
        samples.novel_pdf(settings.pdf_dir / 'aaa.pdf', samples.PARAGRAPHS[:14])
        samples.script_pdf(settings.pdf_dir / 'bbb.pdf')
        legacy_db(settings, [
            ('aaa', 'My Series v02.pdf', 'aaa.pdf', '2024-05-01 10:00:00', 2),
            ('bbb', 'loose.pdf', 'bbb.pdf', '2024-05-02 10:00:00', 1),
            ('ccc', 'missing.pdf', 'ccc.pdf', '2024-05-03 10:00:00', 7),
        ])
    return prepare


def test_import(make_harness, prepared):
    h = make_harness(users_api_url='', prepare=prepared)
    assert not h.settings.legacy_db.exists()
    assert h.settings.legacy_db.with_name('reader.sqlite3.migrated').exists()

    listing = {doc['id']: doc for doc in h.client.get('/api/library').json()}
    assert set(listing) == {'aaa', 'bbb'}  # the row with no file is tolerated and skipped
    doc = listing['aaa']
    assert doc['filename'] == 'My Series v02.pdf'
    assert (doc['series'], doc['volume']) == ('My Series', 2)
    assert doc['created_at'] == '2024-05-01T10:00:00Z'
    assert doc['state']['page'] == 2

    done = h.wait_ready('aaa')
    assert done['status'] == 'ready'
    assert done['page_count'] >= 2
    assert done['state']['page'] == 2
    assert h.client.get('/api/documents/aaa/file').status_code == 200
    assert (h.settings.pdf_dir / 'aaa.pdf').exists()


def test_import_is_idempotent(make_harness, prepared, tmp_path):
    first = make_harness(users_api_url='', prepare=prepared)
    first.wait_ready('aaa')
    first.client.put('/api/documents/aaa/progress', json={'page': 2, 'offset': 0.5, 'client_ts': 5})
    first.client.__exit__(None, None, None)

    # A crash before the rename, or a restored backup, puts the old database back.
    def restore(settings: Settings) -> None:
        settings.legacy_db.with_name('reader.sqlite3.migrated').replace(settings.legacy_db)

    second = make_harness(users_api_url='', prepare=restore)
    listing = second.client.get('/api/library').json()
    assert sorted(doc['id'] for doc in listing) == ['aaa', 'bbb']
    state = next(doc for doc in listing if doc['id'] == 'aaa')['state']
    assert state['offset'] == 0.5  # untouched by the second import


def test_second_boot_without_legacy_is_a_no_op(make_harness, prepared):
    first = make_harness(users_api_url='', prepare=prepared)
    first.client.__exit__(None, None, None)
    second = make_harness(users_api_url='')
    assert len(second.client.get('/api/library').json()) == 2


def test_no_legacy_database(make_harness):
    h = make_harness(users_api_url='')
    assert h.client.get('/api/library').json() == []


def test_unreadable_legacy_database_stays_in_place(make_harness):
    def prepare(settings: Settings) -> None:
        settings.legacy_db.write_bytes(b'this is not sqlite' * 100)

    h = make_harness(users_api_url='', prepare=prepare)
    assert h.settings.legacy_db.exists()
    assert h.client.get('/api/library').status_code == 200


def test_legacy_rows_with_the_same_file(make_harness):
    """The old app never deduplicated. Both rows stay; the unique index must not break ingest."""
    def prepare(settings: Settings) -> None:
        samples.script_pdf(settings.pdf_dir / 'one.pdf')
        (settings.pdf_dir / 'two.pdf').write_bytes((settings.pdf_dir / 'one.pdf').read_bytes())
        legacy_db(settings, [
            ('one', 'a.pdf', 'one.pdf', '2024-05-01 10:00:00', 1),
            ('two', 'b.pdf', 'two.pdf', '2024-05-02 10:00:00', 1),
        ])

    h = make_harness(users_api_url='', prepare=prepare)
    assert h.wait_ready('one')['status'] == 'ready'
    assert h.wait_ready('two')['status'] == 'ready'


def test_legacy_docs_become_shared_in_scoped_mode(make_harness, prepared):
    h = make_harness(prepare=prepared)
    alice = h.as_user('alice')
    assert len(h.client.get('/api/library', headers=alice).json()) == 2
