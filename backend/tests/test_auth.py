import asyncio
import time

import httpx
import pytest

from app.auth import COOKIE_NAME, AuthGateway, RateLimiter, parse_session_cookie
from app.config import Settings
from tests import pdf_samples


def session(h, headers=None):
    return h.client.get('/api/session', headers=headers or {}).json()


def library(h, headers=None):
    return h.client.get('/api/library', headers=headers or {})


# --- truth table ----------------------------------------------------------------------------


def test_unconfigured_is_global_and_disabled(open_mode):
    assert session(open_mode) == {
        'mode': 'global', 'auth_status': 'disabled', 'user': None, 'allow_signup': True, 'max_upload_mb': 2,
    }
    assert library(open_mode).status_code == 200


@pytest.mark.parametrize('mode', ['down', 'error', 'no_caps', 'old'])
def test_unhealthy_users_api_is_global(make_harness, mode):
    h = make_harness()
    h.users.mode = mode
    s = session(h)
    assert (s['mode'], s['auth_status'], s['user']) == ('global', 'unavailable', None)
    assert library(h).status_code == 200


def test_healthy_without_session_is_scoped_and_401(scoped):
    s = session(scoped)
    assert (s['mode'], s['auth_status'], s['user']) == ('scoped', 'ok', None)
    response = library(scoped)
    assert response.status_code == 401
    assert 'error' in response.json()


def test_healthy_with_bad_session_is_scoped_and_401(scoped):
    headers = {'Cookie': f'{COOKIE_NAME}=forged'}
    assert session(scoped, headers)['user'] is None
    assert library(scoped, headers).status_code == 401


def test_healthy_with_valid_session(scoped):
    headers = scoped.as_user('alice')
    s = session(scoped, headers)
    assert (s['mode'], s['user']) == ('scoped', {'id': 1, 'name': 'alice'})
    assert library(scoped, headers).status_code == 200


@pytest.mark.parametrize('path', [
    '/api/library', '/api/stats', '/api/preferences', '/api/search?q=abc', '/api/documents/x',
    '/api/documents/x/file', '/api/documents/x/cover', '/api/documents/x/text', '/api/documents/x/bookmarks',
])
def test_every_data_endpoint_requires_a_session(scoped, path):
    assert scoped.client.get(path).status_code == 401


def test_session_and_healthz_never_401(scoped):
    assert scoped.client.get('/api/session').status_code == 200
    assert scoped.client.get('/api/healthz').json() == {'status': 'ok'}


# --- transitions ----------------------------------------------------------------------------


def test_down_up_down(make_harness):
    h = make_harness()
    h.users.mode = 'down'
    assert session(h)['mode'] == 'global'

    h.users.mode = 'ok'
    h.refresh_status()
    s = session(h)
    assert (s['mode'], s['auth_status']) == ('scoped', 'ok')
    assert library(h).status_code == 401

    h.users.mode = 'down'
    h.refresh_status()
    s = session(h)
    assert (s['mode'], s['auth_status']) == ('global', 'unavailable')
    assert library(h).status_code == 200


def test_session_survives_a_blip(scoped):
    headers = scoped.as_user('alice')
    scoped.users.mode = 'down'
    scoped.refresh_status()
    assert session(scoped, headers)['mode'] == 'global'
    scoped.users.mode = 'ok'
    scoped.refresh_status()
    assert session(scoped, headers)['user']['name'] == 'alice'


def test_capabilities_lost_on_a_rollback(scoped):
    scoped.users.mode = 'no_caps'
    scoped.refresh_status()
    assert session(scoped)['mode'] == 'global'


def test_health_is_cached_for_the_ttl(scoped):
    session(scoped)
    for _ in range(5):
        scoped.clock.advance(1)
        session(scoped)
    assert scoped.users.calls['/api/health'] == 1


# --- token checks ---------------------------------------------------------------------------


def test_token_401_means_no_session_not_down(scoped):
    headers = scoped.as_user('alice')
    scoped.users.sessions.clear()
    scoped.clock.advance(scoped.settings.token_ttl + 1)
    s = session(scoped, headers)
    assert (s['mode'], s['auth_status'], s['user']) == ('scoped', 'ok', None)
    assert library(scoped, headers).status_code == 401


@pytest.mark.parametrize('token_mode', ['error', 'down'])
def test_token_failure_marks_down_and_goes_global(scoped, token_mode):
    headers = scoped.as_user('alice')
    scoped.clock.advance(scoped.settings.token_ttl + 1)
    scoped.users.token_mode = token_mode
    s = session(scoped, headers)
    assert (s['mode'], s['auth_status'], s['user']) == ('global', 'unavailable', None)
    assert library(scoped, headers).status_code == 200
    # Everyone else sees the outage at once, without their own failing call.
    assert session(scoped)['mode'] == 'global'


def test_token_cached_for_60s_by_hash(scoped):
    headers = scoped.as_user('alice')
    for _ in range(5):
        scoped.clock.advance(5)
        session(scoped, headers)
    assert '/api/token' not in scoped.users.calls
    scoped.clock.advance(60)
    session(scoped, headers)
    assert scoped.users.calls['/api/token'] == 1
    assert not any('tok-' in key for key in scoped.app.state.auth._tokens)


# --- hanging users-api ----------------------------------------------------------------------


def test_stale_state_is_served_while_refreshing_a_hung_api(make_harness):
    h = make_harness(auth_timeout=0.3)
    session(h)
    h.users.mode = 'hang'
    h.clock.advance(h.settings.health_ttl + 1)
    started = time.monotonic()
    assert session(h)['mode'] == 'scoped'
    assert time.monotonic() - started < 0.2
    h.client.portal.call(h.app.state.auth.settle)
    assert session(h)['mode'] == 'global'


def test_first_probe_on_a_hung_api_is_bounded(make_harness):
    h = make_harness(auth_timeout=0.3)
    h.users.mode = 'hang'
    started = time.monotonic()
    assert session(h)['mode'] == 'global'
    assert time.monotonic() - started < 1.5


def test_hung_token_check_is_bounded(make_harness):
    h = make_harness(auth_timeout=0.3)
    headers = h.as_user('alice')
    h.clock.advance(h.settings.token_ttl + 1)
    h.users.token_mode = 'hang'
    started = time.monotonic()
    assert session(h, headers)['mode'] == 'global'
    assert time.monotonic() - started < 1.5


def test_probe_and_token_checks_are_single_flight(tmp_path):
    calls = {'health': 0, 'token': 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.05)
        if request.url.path == '/api/health':
            calls['health'] += 1
            return httpx.Response(200, json={'capabilities': ['session-introspection', 'remember-me']})
        calls['token'] += 1
        return httpx.Response(200, json={'user': {'id': 1, 'name': 'a'}})

    async def run():
        settings = Settings(_env_file=None, data_dir=tmp_path)
        gateway = AuthGateway(settings, transport=httpx.MockTransport(handler))
        statuses = await asyncio.gather(*(gateway.status() for _ in range(50)))
        users = await asyncio.gather(*(gateway.verify('same-token') for _ in range(50)))
        await gateway.aclose()
        return statuses, users

    statuses, users = asyncio.run(run())
    assert set(statuses) == {'ok'}
    assert all(user.id == 1 for user in users)
    assert calls == {'health': 1, 'token': 1}


# --- AUTH_FAIL_MODE -------------------------------------------------------------------------


def test_fail_closed(make_harness):
    h = make_harness(auth_fail_mode='closed')
    h.users.mode = 'down'
    s = session(h)
    assert (s['mode'], s['auth_status']) == ('scoped', 'unavailable')
    for path in ('/api/library', '/api/stats', '/api/search?q=abc', '/api/documents/x/file'):
        assert h.client.get(path).status_code == 503
    assert h.client.get('/api/healthz').status_code == 200


def test_fail_closed_on_token_error(make_harness):
    h = make_harness(auth_fail_mode='closed')
    headers = h.as_user('alice')
    h.clock.advance(h.settings.token_ttl + 1)
    h.users.token_mode = 'error'
    assert library(h, headers).status_code == 503


def test_fail_closed_does_not_apply_when_unconfigured(make_harness):
    h = make_harness(auth_fail_mode='closed', users_api_url='')
    assert library(h).status_code == 200


# --- login / signup / logout ----------------------------------------------------------------


def test_login_sets_cookie_with_remember(scoped):
    response = scoped.login('alice')
    assert response.status_code == 200
    assert response.json()['user'] == {'id': 1, 'name': 'alice'}
    assert scoped.users.login_bodies[-1]['remember'] is True
    cookie = response.headers['set-cookie'].lower()
    assert cookie.startswith(f'{COOKIE_NAME}=tok-alice')
    assert 'httponly' in cookie
    assert 'samesite=lax' in cookie
    assert 'max-age=2592000' in cookie
    assert 'path=/' in cookie
    assert 'secure' not in cookie


def test_cookie_is_secure_over_https(scoped):
    response = scoped.client.post(
        'https://reader.test/api/auth/login', json={'name': 'alice', 'password': 'password-a'}
    )
    assert '; secure' in response.headers['set-cookie'].lower()


def test_login_wrong_password(scoped):
    response = scoped.login('alice', 'wrong')
    assert response.status_code == 401
    assert response.json() == {'error': 'Incorrect name or password.'}
    assert 'set-cookie' not in response.headers


def test_login_503_in_global_mode(make_harness):
    h = make_harness()
    h.users.mode = 'down'
    assert h.client.post('/api/auth/login', json={'name': 'a', 'password': 'b'}).status_code == 503


def test_login_503_when_users_api_breaks_mid_call(scoped):
    session(scoped)
    scoped.users.mode = 'error'
    assert scoped.login('alice', 'x').status_code == 503
    assert session(scoped)['mode'] == 'global'


def test_signup(scoped):
    response = scoped.client.post('/api/auth/signup', json={'name': 'carol', 'password': 'long-enough'})
    assert response.status_code == 200
    assert response.json()['user']['name'] == 'carol'
    assert COOKIE_NAME in response.cookies


def test_signup_conflict(scoped):
    response = scoped.client.post('/api/auth/signup', json={'name': 'alice', 'password': 'long-enough'})
    assert response.status_code == 409


@pytest.mark.parametrize('body', [
    {'name': '', 'password': 'long-enough'},
    {'name': 'x' * 101, 'password': 'long-enough'},
    {'name': 'dave', 'password': 'short'},
])
def test_signup_validation(scoped, body):
    response = scoped.client.post('/api/auth/signup', json=body)
    assert response.status_code == 422
    assert isinstance(response.json()['error'], str)


def test_signup_disabled(make_harness):
    h = make_harness(allow_signup=False)
    assert session(h)['allow_signup'] is False
    response = h.client.post('/api/auth/signup', json={'name': 'carol', 'password': 'long-enough'})
    assert response.status_code == 403


def test_logout_revokes_upstream_and_clears_cookie(scoped):
    response = scoped.login('alice')
    token = response.cookies[COOKIE_NAME]
    response = scoped.client.post('/api/auth/logout')
    assert response.status_code == 200
    assert response.json()['user'] is None
    assert scoped.users.logouts == [f'session_id={token}']
    set_cookie = response.headers['set-cookie'].lower()
    assert COOKIE_NAME in set_cookie and ('max-age=0' in set_cookie or 'expires=' in set_cookie)
    assert scoped.app.state.auth._tokens == {}


def test_logout_survives_users_api_outage(scoped):
    scoped.login('alice')
    session(scoped)
    scoped.users.mode = 'down'
    assert scoped.client.post('/api/auth/logout').status_code == 200


def test_sessions_do_not_leak_between_users_in_the_upstream_client(scoped):
    scoped.as_user('alice')
    scoped.as_user('bob')
    assert len(scoped.app.state.auth.client.cookies.jar) == 0


def test_parse_session_cookie_uses_the_right_header():
    response = httpx.Response(200, headers=[
        ('set-cookie', 'other=1; Path=/'),
        ('set-cookie', 'session_id=abc-_1; HttpOnly; Secure'),
    ])
    assert parse_session_cookie(response) == 'abc-_1'
    assert parse_session_cookie(httpx.Response(200)) is None


# --- rate limit -----------------------------------------------------------------------------


def test_login_rate_limited_per_username(scoped):
    for _ in range(10):
        assert scoped.login('alice', 'nope').status_code == 401
    response = scoped.login('alice', 'password-a')
    assert response.status_code == 429
    assert int(response.headers['retry-after']) >= 1
    scoped.clock.advance(61)
    assert scoped.login('alice', 'password-a').status_code == 200


def test_login_rate_limited_per_ip(scoped):
    for index in range(10):
        assert scoped.login('bob', f'nope{index}').status_code in (401, 429)
    response = scoped.client.post('/api/auth/login', json={'name': 'someone-else', 'password': 'x'})
    assert response.status_code == 429


def test_signup_shares_the_limit(scoped):
    for index in range(10):
        scoped.client.post('/api/auth/signup', json={'name': f'user{index}', 'password': 'long-enough'})
    response = scoped.client.post('/api/auth/signup', json={'name': 'one-more', 'password': 'long-enough'})
    assert response.status_code == 429


def test_rate_limiter_window():
    now = [0.0]
    limiter = RateLimiter(2, 10, clock=lambda: now[0])
    assert limiter.retry_after('k') == 0
    assert limiter.retry_after('k') == 0
    assert limiter.retry_after('k') == 10
    now[0] = 10.5
    assert limiter.retry_after('k') == 0


# --- CSRF and headers -----------------------------------------------------------------------


def test_csrf_rejects_cross_origin_writes(open_mode):
    response = open_mode.client.put(
        '/api/preferences', json={'data': {}}, headers={'Origin': 'https://evil.example'}
    )
    assert response.status_code == 403
    assert 'error' in response.json()


def test_csrf_rejects_null_origin(open_mode):
    response = open_mode.client.put('/api/preferences', json={'data': {}}, headers={'Origin': 'null'})
    assert response.status_code == 403


@pytest.mark.parametrize('headers', [
    {'Origin': 'http://reader.test'},
    {},
    {'Origin': 'https://reader.marcel.co.nz', 'X-Forwarded-Host': 'reader.marcel.co.nz'},
    {'Origin': 'https://reader.marcel.co.nz', 'X-Forwarded-Host': 'reader.marcel.co.nz:443'},
    {'Origin': 'https://reader.marcel.co.nz', 'X-Forwarded-Host': 'reader.marcel.co.nz, internal'},
])
def test_csrf_allows_same_origin(open_mode, headers):
    assert open_mode.client.put('/api/preferences', json={'data': {}}, headers=headers).status_code == 200


def test_csrf_forwarded_host_is_what_counts(open_mode):
    response = open_mode.client.put(
        '/api/preferences', json={'data': {}},
        headers={'Origin': 'http://reader.test', 'X-Forwarded-Host': 'reader.marcel.co.nz'},
    )
    assert response.status_code == 403


def test_csrf_ignores_safe_methods(open_mode):
    assert open_mode.client.get('/api/library', headers={'Origin': 'https://evil.example'}).status_code == 200


def test_csrf_covers_login(scoped):
    response = scoped.client.post(
        '/api/auth/login', json={'name': 'alice', 'password': 'password-a'}, headers={'Origin': 'https://evil.example'}
    )
    assert response.status_code == 403


def test_csrf_trusted_origin_for_dev(make_harness):
    h = make_harness(users_api_url='', csrf_trusted_origins='http://localhost:5173')
    response = h.client.put('/api/preferences', json={'data': {}}, headers={'Origin': 'http://localhost:5173'})
    assert response.status_code == 200


def test_security_headers_and_csp(open_mode):
    headers = open_mode.client.get('/api/session').headers
    csp = headers['content-security-policy']
    assert headers['x-content-type-options'] == 'nosniff'
    assert "script-src 'self' 'wasm-unsafe-eval'" in csp
    assert "worker-src 'self' blob:" in csp
    assert "font-src 'self' data:" in csp
    assert 'blob:' in csp.split('img-src')[1].split(';')[0]
    assert "style-src 'self' 'unsafe-inline'" in csp
    assert 'https:' not in csp
    assert "'unsafe-eval'" not in csp


def test_errors_are_json_with_error_key(open_mode):
    response = open_mode.client.get('/api/nope')
    assert response.status_code == 404
    assert 'error' in response.json()
    response = open_mode.client.post('/api/library')
    assert response.status_code == 405
    assert 'error' in response.json()


def test_oversized_json_body_rejected(open_mode):
    response = open_mode.client.put('/api/preferences', content=b'x' * (5 * 1024 * 1024))
    assert response.status_code == 413


def test_works_through_the_pdf_flow_with_private_doc(scoped, tmp_path):
    """Smoke: a session survives multipart upload and worker processing."""
    headers = scoped.as_user('alice')
    doc = scoped.ingest(pdf_samples.script_pdf(tmp_path / 'one.pdf'), headers=headers)
    assert doc['status'] == 'ready'
    assert doc['shared'] is False
