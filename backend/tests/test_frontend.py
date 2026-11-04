import pytest


@pytest.fixture
def site(open_mode):
    dist = open_mode.settings.frontend_dist
    (dist / 'assets').mkdir(parents=True)
    (dist / 'index.html').write_text('<!doctype html><title>Shelf</title>')
    (dist / 'assets' / 'app-abc123.js').write_text('console.log(1)')
    (dist / 'sw.js').write_text('// sw')
    (dist / 'manifest.webmanifest').write_text('{}')
    (dist / 'icon.png').write_bytes(b'png')
    return open_mode


def test_root_serves_index(site):
    response = site.client.get('/')
    assert response.status_code == 200
    assert 'Shelf' in response.text
    assert response.headers['cache-control'] == 'no-cache'
    assert response.headers['content-security-policy']


@pytest.mark.parametrize('path', ['/read/abc123', '/series/Some%20Name', '/settings'])
def test_client_routes_fall_back_to_index(site, path):
    response = site.client.get(path)
    assert response.status_code == 200
    assert 'Shelf' in response.text
    assert response.headers['content-type'].startswith('text/html')
    assert response.headers['cache-control'] == 'no-cache'


def test_assets_are_immutable(site):
    response = site.client.get('/assets/app-abc123.js')
    assert response.status_code == 200
    assert 'immutable' in response.headers['cache-control']


@pytest.mark.parametrize('path', ['/sw.js', '/manifest.webmanifest'])
def test_entry_files_are_not_cached(site, path):
    assert site.client.get(path).headers['cache-control'] == 'no-cache'


def test_missing_asset_is_404_not_html(site):
    assert site.client.get('/assets/app-old.js').status_code == 404
    assert site.client.get('/old-icon.png').status_code == 404


def test_unknown_api_is_json_404(site):
    response = site.client.get('/api/whatever')
    assert response.status_code == 404
    assert response.json() == {'error': 'Not found.'}


@pytest.mark.parametrize('path', ['/..%2f..%2fetc/passwd', '/assets/..%2f..%2f..%2fetc%2fpasswd'])
def test_no_path_traversal(site, path):
    response = site.client.get(path)
    assert 'root:' not in response.text


def test_head_on_frontend(site):
    assert site.client.head('/').status_code == 200


def test_without_a_build(open_mode):
    assert open_mode.client.get('/').status_code == 404
    assert open_mode.client.get('/api/healthz').status_code == 200
