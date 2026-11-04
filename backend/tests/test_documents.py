import asyncio
import gzip
import hashlib
import json
import sqlite3
import threading
import time

import pytest
from PIL import Image
from starlette.requests import Request

from app.config import Settings
from app.routes.documents import IMMUTABLE
from app.storage import receive_upload
from tests import pdf_samples as samples


@pytest.fixture
def doc(open_mode, tmp_path):
    return open_mode.ingest(samples.novel_pdf(tmp_path / 'The Long Road.pdf'), name='The Long Road.pdf')


def file_url(document):
    return f'/api/documents/{document["id"]}/file'


# --- upload -----------------------------------------------------------------------------------


def test_upload_contract(open_mode, tmp_path):
    response = open_mode.upload(samples.novel_pdf(tmp_path / 'x.pdf'), name='[Grp] My Series v02 (2020).pdf')
    assert response.status_code == 201
    body = response.json()
    assert body['duplicate'] is False
    document = body['document']
    assert set(document) == {
        'id', 'title', 'series', 'volume', 'author', 'kind', 'direction', 'suggested_mode', 'filename', 'size',
        'page_count', 'has_text', 'status', 'error', 'cover_version', 'shared', 'editable', 'created_at',
        'updated_at', 'state',
    }
    assert set(document['state']) == {
        'page', 'offset', 'max_page', 'finished', 'favorite', 'seconds_read', 'overrides', 'last_read_at', 'client_ts',
    }
    assert document['status'] == 'processing'
    assert (document['series'], document['volume']) == ('My Series', 2)
    assert document['filename'] == '[Grp] My Series v02 (2020).pdf'
    assert document['created_at'].endswith('Z')
    assert document['shared'] is True and document['editable'] is True


def test_detail_contract(open_mode, doc):
    assert doc['status'] == 'ready'
    assert doc['page_count'] == len(doc['page_sizes']) > 1
    assert doc['outline'] == []
    assert doc['bookmarks'] == []
    assert doc['author'] == 'Jane Author'
    assert doc['cover_version']


def test_library_has_no_detail_fields(open_mode, doc):
    listing = open_mode.client.get('/api/library').json()
    assert [entry['id'] for entry in listing] == [doc['id']]
    assert not {'page_sizes', 'outline', 'bookmarks'} & set(listing[0])


def test_upload_over_limit_in_content_length(open_mode, tmp_path):
    big = tmp_path / 'big.pdf'
    big.write_bytes(b'%PDF-1.7\n' + b'0' * (3 * 1024 * 1024))
    assert open_mode.upload(big).status_code == 413
    assert list(open_mode.settings.tmp_dir.iterdir()) == []


def stream_request(chunks, headers, app, disconnect_after=False):
    messages = [{'type': 'http.request', 'body': chunk, 'more_body': True} for chunk in chunks]
    messages.append({'type': 'http.disconnect'} if disconnect_after else {'type': 'http.request', 'body': b'', 'more_body': False})
    iterator = iter(messages)

    async def receive():
        return next(iterator)

    scope = {'type': 'http', 'method': 'POST', 'path': '/api/documents', 'headers': headers, 'query_string': b'', 'app': app}
    return Request(scope, receive)


MULTIPART_HEAD = (
    b'--BOUND\r\nContent-Disposition: form-data; name="file"; filename="x.pdf"\r\n'
    b'Content-Type: application/pdf\r\n\r\n'
)
MULTIPART_HEADERS = [(b'content-type', b'multipart/form-data; boundary=BOUND')]


def test_limit_enforced_while_streaming_without_content_length(open_mode):
    """Chunked: no Content-Length to reject up front."""
    from app.storage import UploadRejected

    settings = open_mode.settings
    chunks = [MULTIPART_HEAD + b'%PDF-1.7\n'] + [b'0' * 1024 * 1024] * 3
    request = stream_request(chunks, MULTIPART_HEADERS, open_mode.app)
    with pytest.raises(UploadRejected) as rejected:
        asyncio.run(receive_upload(request, settings))
    assert rejected.value.status == 413
    assert list(settings.tmp_dir.iterdir()) == []


def test_client_abort_leaves_no_temp_file(open_mode):
    from starlette.requests import ClientDisconnect

    settings = open_mode.settings
    chunks = [MULTIPART_HEAD + b'%PDF-1.7\n', b'0' * 1024]
    request = stream_request(chunks, MULTIPART_HEADERS, open_mode.app, disconnect_after=True)
    with pytest.raises(ClientDisconnect):
        asyncio.run(receive_upload(request, settings))
    assert list(settings.tmp_dir.iterdir()) == []


def test_upload_is_spooled_to_data_tmp_not_memory(open_mode):
    settings = open_mode.settings
    seen = []

    chunks = [MULTIPART_HEAD + b'%PDF-1.7\n', b'0' * 1024, b'\r\n--BOUND--\r\n']
    request = stream_request(chunks, MULTIPART_HEADERS, open_mode.app)
    received = asyncio.run(receive_upload(request, settings))
    seen.append(received.path)
    assert received.path.parent == settings.tmp_dir
    assert received.size == 9 + 1024
    received.path.unlink()


@pytest.mark.parametrize('content', [b'<html>not a pdf</html>' * 100, b'plain', b'\x00' * 2000])
def test_upload_rejects_non_pdf(open_mode, tmp_path, content):
    path = tmp_path / 'fake.pdf'
    path.write_bytes(content)
    response = open_mode.upload(path)
    assert response.status_code == 415
    assert 'error' in response.json()
    assert list(open_mode.settings.tmp_dir.iterdir()) == []


def test_upload_accepts_magic_after_junk(open_mode, tmp_path):
    path = tmp_path / 'junk.pdf'
    path.write_bytes(b'\n' * 500 + samples.script_pdf(tmp_path / 's.pdf').read_bytes())
    assert open_mode.upload(path).status_code == 201


def test_upload_without_file(open_mode):
    response = open_mode.client.post('/api/documents', files={'other': ('a.txt', b'x')})
    assert response.status_code == 400
    assert open_mode.client.post('/api/documents', json={}).status_code == 400


def test_dedupe_same_owner(open_mode, sample_pdf):
    first = open_mode.upload(sample_pdf).json()
    second = open_mode.upload(sample_pdf, name='other.pdf')
    assert second.status_code == 200
    assert second.json()['duplicate'] is True
    assert second.json()['document']['id'] == first['document']['id']
    assert len(open_mode.client.get('/api/library').json()) == 1
    assert len(list(open_mode.settings.pdf_dir.iterdir())) == 1
    assert list(open_mode.settings.tmp_dir.glob('upload-*')) == []


def test_dedupe_is_per_owner(scoped, sample_pdf):
    alice, bob = scoped.as_user('alice'), scoped.as_user('bob')
    first = scoped.upload(sample_pdf, headers=alice)
    second = scoped.upload(sample_pdf, headers=bob)
    assert (first.status_code, second.status_code) == (201, 201)
    assert first.json()['document']['id'] != second.json()['document']['id']


def test_dedupe_race(open_mode, sample_pdf):
    results = []

    def send():
        results.append(open_mode.upload(sample_pdf).status_code)

    threads = [threading.Thread(target=send) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == [200] * 5 + [201]
    assert len(open_mode.client.get('/api/library').json()) == 1


def test_many_concurrent_writers_do_not_hit_sqlite_busy(open_mode, doc):
    errors = []

    def write(index):
        for step in range(10):
            response = open_mode.client.put(
                f'/api/documents/{doc["id"]}/progress',
                json={'page': 1, 'seconds': 1, 'client_ts': index * 100 + step},
            )
            if response.status_code != 200:
                errors.append(response.text)

    threads = [threading.Thread(target=write, args=(i,)) for i in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    state = open_mode.client.get(f'/api/documents/{doc["id"]}').json()['state']
    assert state['seconds_read'] == 80


# --- ingest failure modes -----------------------------------------------------------------------


def test_encrypted_upload_fails_cleanly(open_mode, tmp_path):
    document = open_mode.ingest(samples.encrypted_pdf(tmp_path / 'locked.pdf'))
    assert document['status'] == 'failed'
    assert 'password' in document['error']
    assert open_mode.client.get(f'/api/documents/{document["id"]}/cover').status_code == 404
    assert open_mode.client.get(f'/api/documents/{document["id"]}/text').status_code == 404


def test_corrupt_upload_fails_cleanly(open_mode, tmp_path):
    document = open_mode.ingest(samples.corrupt_pdf(tmp_path / 'bad.pdf'))
    assert document['status'] == 'failed'
    assert 'damaged' in document['error']


def test_crashing_subprocess_marks_failed(open_mode, sample_pdf):
    open_mode.app.state.worker.command = ('python3', '-c', 'import os; os.abort()')
    document = open_mode.ingest(sample_pdf)
    assert document['status'] == 'failed'
    assert 'crashed' in document['error']


def test_hanging_subprocess_times_out(make_harness, sample_pdf):
    h = make_harness(users_api_url='', ingest_open_timeout=0.3)
    h.app.state.worker.command = ('python3', '-c', 'import time; time.sleep(60)')
    started = time.monotonic()
    document = h.ingest(sample_pdf)
    assert document['status'] == 'failed'
    assert 'too long' in document['error']
    assert time.monotonic() - started < 10


def test_timeout_scales_with_page_count(make_harness):
    h = make_harness(users_api_url='', ingest_open_timeout=10, ingest_page_timeout=2, ingest_max_timeout=100)
    worker = h.app.state.worker
    now = time.monotonic()
    assert worker._page_deadline(10) - now == pytest.approx(30, abs=1)
    assert worker._page_deadline(1000) - now == pytest.approx(100, abs=1)


SLOW_INGEST = 'import json, time; print(json.dumps({"pages": 1}), flush=True); time.sleep(60)'


def test_delete_while_ingest_runs(open_mode, sample_pdf):
    open_mode.app.state.worker.command = ('python3', '-c', SLOW_INGEST)
    document = open_mode.upload(sample_pdf).json()['document']
    deadline = time.monotonic() + 5
    while open_mode.app.state.worker._current != document['id'] and time.monotonic() < deadline:
        time.sleep(0.02)
    assert open_mode.client.delete(f'/api/documents/{document["id"]}').status_code == 204
    while open_mode.app.state.worker._current is not None and time.monotonic() < deadline:
        time.sleep(0.02)
    assert open_mode.app.state.worker._current is None
    assert open_mode.client.get(f'/api/documents/{document["id"]}').status_code == 404
    assert list(open_mode.settings.pdf_dir.iterdir()) == []
    assert list(open_mode.settings.derived_dir.iterdir()) == []
    assert list(open_mode.settings.tmp_dir.iterdir()) == []


def test_publish_after_delete_cleans_up(open_mode, tmp_path):
    """The other interleaving: the subprocess finished just as the row went away."""
    doc_id = 'f' * 32
    worker = open_mode.app.state.worker
    out = tmp_path / 'out'
    out.mkdir()
    (out / 'meta.json').write_text('{}')
    with gzip.open(out / 'pages.json.gz', 'wt') as handle:
        json.dump([], handle)
    worker._publish(doc_id, tmp_path / 'gone.pdf', out)
    assert not (open_mode.settings.derived_dir / doc_id).exists()


def test_pending_documents_requeue_on_boot(make_harness, sample_pdf):
    first = make_harness(users_api_url='')
    first.app.state.worker.stop()
    document = first.upload(sample_pdf).json()['document']
    assert document['status'] == 'processing'
    first.client.__exit__(None, None, None)

    second = make_harness(users_api_url='')
    assert second.wait_ready(document['id'])['status'] == 'ready'


def test_boot_clears_stale_temp_files(make_harness):
    def plant(settings: Settings):
        (settings.tmp_dir / 'upload-stale.pdf').write_bytes(b'x')
        (settings.tmp_dir / 'ingest-stale').mkdir()

    h = make_harness(users_api_url='', prepare=plant)
    assert list(h.settings.tmp_dir.iterdir()) == []


# --- file: range requests ---------------------------------------------------------------------


@pytest.fixture
def pdf_bytes(open_mode, doc):
    return open_mode.client.get(file_url(doc)).content


def test_file_full(open_mode, doc, pdf_bytes):
    response = open_mode.client.get(file_url(doc))
    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/pdf'
    assert response.headers['accept-ranges'] == 'bytes'
    assert response.headers['cache-control'] == IMMUTABLE == 'private, max-age=31536000, immutable'
    assert response.headers['etag'] == f'"{hashlib.sha256(pdf_bytes).hexdigest()}"'
    assert response.headers['content-disposition'].startswith('inline')


def test_file_download(open_mode, doc):
    response = open_mode.client.get(file_url(doc), params={'download': 1})
    disposition = response.headers['content-disposition']
    assert disposition.startswith('attachment')
    assert 'The%20Long%20Road.pdf' in disposition or 'The Long Road.pdf' in disposition


def test_single_range(open_mode, doc, pdf_bytes):
    response = open_mode.client.get(file_url(doc), headers={'Range': 'bytes=0-99'})
    assert response.status_code == 206
    assert response.content == pdf_bytes[:100]
    assert response.headers['content-range'] == f'bytes 0-99/{len(pdf_bytes)}'
    assert response.headers['content-length'] == '100'
    assert response.headers['etag']
    assert response.headers['cache-control'] == IMMUTABLE


def test_suffix_range(open_mode, doc, pdf_bytes):
    response = open_mode.client.get(file_url(doc), headers={'Range': 'bytes=-500'})
    assert response.status_code == 206
    assert response.content == pdf_bytes[-500:]
    total = len(pdf_bytes)
    assert response.headers['content-range'] == f'bytes {total - 500}-{total - 1}/{total}'


def test_open_ended_range(open_mode, doc, pdf_bytes):
    """What an offline download resuming, or a service worker, sends."""
    response = open_mode.client.get(file_url(doc), headers={'Range': 'bytes=1000-'})
    assert response.status_code == 206
    assert response.content == pdf_bytes[1000:]


def test_open_ended_from_zero(open_mode, doc, pdf_bytes):
    response = open_mode.client.get(file_url(doc), headers={'Range': 'bytes=0-'})
    assert response.status_code == 206
    assert response.content == pdf_bytes


def test_range_past_end_is_clamped(open_mode, doc, pdf_bytes):
    total = len(pdf_bytes)
    response = open_mode.client.get(file_url(doc), headers={'Range': f'bytes={total - 10}-{total + 1000}'})
    assert response.status_code == 206
    assert response.content == pdf_bytes[-10:]


def test_unsatisfiable_range_is_416(open_mode, doc, pdf_bytes):
    response = open_mode.client.get(file_url(doc), headers={'Range': f'bytes={len(pdf_bytes) + 10}-'})
    assert response.status_code == 416
    assert response.headers['content-range'] == f'bytes */{len(pdf_bytes)}'


def test_malformed_range_is_refused(open_mode, doc, pdf_bytes):
    response = open_mode.client.get(file_url(doc), headers={'Range': 'pages=1-2'})
    assert response.status_code == 400


def test_if_range_with_matching_etag(open_mode, doc, pdf_bytes):
    etag = open_mode.client.get(file_url(doc)).headers['etag']
    response = open_mode.client.get(file_url(doc), headers={'Range': 'bytes=0-9', 'If-Range': etag})
    assert response.status_code == 206
    assert response.content == pdf_bytes[:10]


def test_if_range_with_stale_etag_sends_whole_file(open_mode, doc, pdf_bytes):
    response = open_mode.client.get(file_url(doc), headers={'Range': 'bytes=0-9', 'If-Range': '"stale"'})
    assert response.status_code == 200
    assert response.content == pdf_bytes


def test_if_none_match(open_mode, doc):
    etag = open_mode.client.get(file_url(doc)).headers['etag']
    response = open_mode.client.get(file_url(doc), headers={'If-None-Match': etag})
    assert response.status_code == 304
    assert response.content == b''
    assert response.headers['etag'] == etag


def test_head_file(open_mode, doc, pdf_bytes):
    response = open_mode.client.head(file_url(doc))
    assert response.status_code == 200
    assert response.content == b''
    assert response.headers['content-length'] == str(len(pdf_bytes))
    assert response.headers['accept-ranges'] == 'bytes'
    assert response.headers['etag']


def test_head_with_range(open_mode, doc):
    response = open_mode.client.head(file_url(doc), headers={'Range': 'bytes=0-9'})
    assert response.status_code == 206
    assert response.headers['content-length'] == '10'


def test_file_route_releases_its_db_connection(open_mode, doc):
    pool = open_mode.app.state.db.engine.pool
    open_mode.client.get(file_url(doc), headers={'Range': 'bytes=0-9'})
    assert pool.checkedout() == 0


# --- cover and text -----------------------------------------------------------------------------


def test_cover(open_mode, doc, tmp_path):
    response = open_mode.client.get(f'/api/documents/{doc["id"]}/cover', params={'v': doc['cover_version']})
    assert response.status_code == 200
    assert response.headers['content-type'] == 'image/webp'
    assert response.headers['cache-control'] == IMMUTABLE
    image = tmp_path / 'cover.webp'
    image.write_bytes(response.content)
    with Image.open(image) as cover:
        assert cover.format == 'WEBP'


def test_cover_404_until_ready(open_mode, sample_pdf):
    open_mode.app.state.worker.stop()
    document = open_mode.upload(sample_pdf).json()['document']
    assert open_mode.client.get(f'/api/documents/{document["id"]}/cover').status_code == 404


def test_text_gzip_and_identity(open_mode, doc):
    url = f'/api/documents/{doc["id"]}/text'
    response = open_mode.client.get(url, headers={'Accept-Encoding': 'gzip'})
    assert response.status_code == 200
    assert response.headers['content-encoding'] == 'gzip'
    assert response.headers['vary'] == 'Accept-Encoding'
    assert response.json()['version'] == 1  # httpx decodes it

    response = open_mode.client.get(url, headers={'Accept-Encoding': 'identity'})
    assert 'content-encoding' not in response.headers
    body = response.json()
    assert body['blocks'][0]['t'] == 'p'
    assert body['blocks'][0]['page'] == 1


def test_text_404_when_none(open_mode, tmp_path):
    document = open_mode.ingest(samples.manga_pdf(tmp_path / 'm.pdf', pages=1))
    assert document['has_text'] is False
    assert open_mode.client.get(f'/api/documents/{document["id"]}/text').status_code == 404


# --- patch, delete, reprocess -------------------------------------------------------------------


def test_patch(open_mode, doc):
    response = open_mode.client.patch(f'/api/documents/{doc["id"]}', json={
        'title': 'New', 'series': 'S', 'volume': 2.5, 'kind': 'manga', 'direction': 'rtl', 'author': None,
    })
    assert response.status_code == 200
    body = response.json()
    assert (body['title'], body['series'], body['volume'], body['kind'], body['direction'], body['author']) == (
        'New', 'S', 2.5, 'manga', 'rtl', None,
    )


def test_patch_partial_leaves_the_rest(open_mode, doc):
    body = open_mode.client.patch(f'/api/documents/{doc["id"]}', json={'title': 'T'}).json()
    assert body['author'] == 'Jane Author'


@pytest.mark.parametrize('patch', [{'title': None}, {'title': ''}, {'kind': 'comic'}, {'direction': 'up'}, {'volume': -1}])
def test_patch_validation(open_mode, doc, patch):
    response = open_mode.client.patch(f'/api/documents/{doc["id"]}', json=patch)
    assert response.status_code == 422
    assert 'error' in response.json()


def test_reprocess_keeps_user_edits(open_mode, doc):
    url = f'/api/documents/{doc["id"]}'
    open_mode.client.patch(url, json={'title': 'Mine', 'author': 'Me', 'kind': 'manga'})
    response = open_mode.client.post(f'{url}/reprocess')
    assert response.status_code == 200
    assert response.json()['status'] == 'processing'
    done = open_mode.wait_ready(doc['id'])
    assert done['status'] == 'ready'
    assert (done['title'], done['author'], done['kind']) == ('Mine', 'Me', 'manga')


def test_reprocess_does_not_duplicate_search_rows(open_mode, doc):
    search = lambda: open_mode.client.get('/api/search', params={'q': 'mantelpiece'}).json()
    before = len(search())
    assert before >= 1
    open_mode.client.post(f'/api/documents/{doc["id"]}/reprocess')
    open_mode.wait_ready(doc['id'])
    assert len(search()) == before


def test_delete_removes_everything(open_mode, doc):
    settings = open_mode.settings
    url = f'/api/documents/{doc["id"]}'
    open_mode.client.post(f'{url}/bookmarks', json={'page': 1})
    open_mode.client.put(f'{url}/progress', json={'page': 2, 'client_ts': 1})
    assert open_mode.client.delete(url).status_code == 204

    assert open_mode.client.get(url).status_code == 404
    assert open_mode.client.get(f'{url}/file').status_code == 404
    assert list(settings.pdf_dir.iterdir()) == []
    assert list(settings.derived_dir.iterdir()) == []
    assert open_mode.client.get('/api/search', params={'q': 'mantelpiece'}).json() == []
    connection = sqlite3.connect(settings.data_dir / 'library.sqlite3')
    for table in ('page_text', 'reading_states', 'bookmarks'):
        assert connection.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == 0
    # The index itself is clean, not merely unreachable through the join.
    assert connection.execute("SELECT count(*) FROM page_fts WHERE page_fts MATCH 'mantelpiece'").fetchone()[0] == 0
    connection.close()


def test_upload_after_delete_is_not_a_duplicate(open_mode, sample_pdf):
    first = open_mode.upload(sample_pdf).json()['document']
    open_mode.client.delete(f'/api/documents/{first["id"]}')
    assert open_mode.upload(sample_pdf).status_code == 201


# --- isolation between users --------------------------------------------------------------------


@pytest.fixture
def two_users(scoped, tmp_path):
    alice, bob = scoped.as_user('alice'), scoped.as_user('bob')
    private = scoped.ingest(samples.script_pdf(tmp_path / 'private.pdf'), headers=alice)
    return scoped, alice, bob, private


def test_owner_sees_private_doc(two_users):
    h, alice, _, private = two_users
    assert [d['id'] for d in h.client.get('/api/library', headers=alice).json()] == [private['id']]
    assert private['editable'] is True and private['shared'] is False


@pytest.mark.parametrize('method, suffix, body', [
    ('GET', '', None),
    ('GET', '/file', None),
    ('HEAD', '/file', None),
    ('GET', '/cover', None),
    ('GET', '/text', None),
    ('GET', '/bookmarks', None),
    ('POST', '/bookmarks', {'page': 1}),
    ('PATCH', '', {'title': 'stolen'}),
    ('PATCH', '/state', {'favorite': True}),
    ('PUT', '/progress', {'page': 1, 'client_ts': 1}),
    ('POST', '/reprocess', None),
    ('DELETE', '', None),
])
def test_private_doc_is_404_for_others(two_users, method, suffix, body):
    h, _, bob, private = two_users
    response = h.client.request(method, f'/api/documents/{private["id"]}{suffix}', headers=bob, json=body)
    assert response.status_code == 404


def test_private_doc_absent_from_listing_search_and_stats(two_users):
    h, _, bob, _ = two_users
    assert h.client.get('/api/library', headers=bob).json() == []
    assert h.client.get('/api/search', params={'q': 'villain'}, headers=bob).json() == []
    assert h.client.get('/api/stats', headers=bob).json()['documents'] == 0


def test_shared_doc_is_visible_and_editable_by_all(two_users):
    h, alice, bob, private = two_users
    url = f'/api/documents/{private["id"]}'
    assert h.client.patch(url, json={'shared': True}, headers=alice).json()['shared'] is True
    seen = h.client.get(url, headers=bob).json()
    assert (seen['shared'], seen['editable']) == (True, True)
    assert h.client.patch(url, json={'title': 'Renamed'}, headers=bob).status_code == 200


def test_shared_doc_cannot_be_taken_private(two_users):
    h, alice, bob, private = two_users
    url = f'/api/documents/{private["id"]}'
    h.client.patch(url, json={'shared': True}, headers=alice)
    assert h.client.patch(url, json={'shared': False}, headers=bob).status_code == 403


def test_reading_state_is_per_user_on_shared_docs(two_users):
    h, alice, bob, private = two_users
    url = f'/api/documents/{private["id"]}'
    h.client.patch(url, json={'shared': True}, headers=alice)
    h.client.patch(f'{url}/state', json={'favorite': True}, headers=alice)
    h.client.post(f'{url}/bookmarks', json={'page': 1}, headers=alice)
    other = h.client.get(url, headers=bob).json()
    assert other['state']['favorite'] is False
    assert other['bookmarks'] == []


def test_bookmark_of_another_user_cannot_be_deleted(two_users):
    h, alice, bob, private = two_users
    bookmark = h.client.post(f'/api/documents/{private["id"]}/bookmarks', json={'page': 1}, headers=alice).json()
    assert h.client.delete(f'/api/bookmarks/{bookmark["id"]}', headers=bob).status_code == 404
    assert h.client.delete(f'/api/bookmarks/{bookmark["id"]}', headers=alice).status_code == 204


def test_upload_as_shared_clears_owner(scoped, tmp_path):
    alice = scoped.as_user('alice')
    with samples.script_pdf(tmp_path / 's.pdf').open('rb') as handle:
        response = scoped.client.post(
            '/api/documents', files={'file': ('s.pdf', handle)}, data={'shared': 'true'}, headers=alice
        )
    assert response.json()['document']['shared'] is True


def test_global_mode_sees_private_docs_as_shared(make_harness, tmp_path):
    h = make_harness()
    alice = h.as_user('alice')
    private = h.ingest(samples.script_pdf(tmp_path / 'p.pdf'), headers=alice)
    h.users.mode = 'down'
    h.refresh_status()
    listing = h.client.get('/api/library').json()
    assert [d['id'] for d in listing] == [private['id']]
    assert listing[0]['shared'] is True and listing[0]['editable'] is True


def test_global_uploads_are_shared_with_everyone_later(make_harness, sample_pdf):
    h = make_harness()
    h.users.mode = 'down'
    document = h.upload(sample_pdf).json()['document']
    h.users.mode = 'ok'
    h.refresh_status()
    alice = h.as_user('alice')
    assert [d['id'] for d in h.client.get('/api/library', headers=alice).json()] == [document['id']]
