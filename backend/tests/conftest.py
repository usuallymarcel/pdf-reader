import time
from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

from app.auth import COOKIE_NAME
from app.config import Settings
from app.main import create_app
from tests import pdf_samples

BACKEND = Path(__file__).resolve().parent.parent


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeUsersApi:
    """The relevant behaviour of users-api, including its odd bits: failed logins are a 200 with
    verified: false, and the session arrives as a Secure cookie."""

    CAPS = ['session-introspection', 'remember-me']

    def __init__(self):
        self.mode = 'ok'  # ok | down | error | no_caps | old | hang
        self.token_mode = 'ok'  # ok | down | error | hang
        self.users: dict[str, dict] = {'alice': {'id': 1, 'password': 'password-a'}, 'bob': {'id': 2, 'password': 'password-b'}}
        self.sessions: dict[str, tuple[int, str]] = {}
        self.calls: dict[str, int] = {}
        self.logouts: list[str] = []
        self.login_bodies: list[dict] = []
        self.hang_seconds = 30.0
        self._next_user = 100

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        import asyncio
        import json

        path = request.url.path
        self.calls[path] = self.calls.get(path, 0) + 1
        if path == '/api/health':
            if self.mode == 'down':
                raise httpx.ConnectError('down')
            if self.mode == 'hang':
                await asyncio.sleep(self.hang_seconds)
            if self.mode == 'error':
                return httpx.Response(503, json={'status': 'unavailable', 'capabilities': []})
            if self.mode == 'old':
                return httpx.Response(404, json={'detail': 'Not Found'})
            caps = ['session-introspection'] if self.mode == 'no_caps' else self.CAPS
            return httpx.Response(200, json={'status': 'ok', 'capabilities': caps})

        if self.mode == 'down':
            raise httpx.ConnectError('down')
        if self.mode == 'error':
            return httpx.Response(500, text='boom')

        if path == '/api/token':
            if self.token_mode == 'down':
                raise httpx.ConnectError('down')
            if self.token_mode == 'error':
                return httpx.Response(502, text='bad gateway')
            if self.token_mode == 'hang':
                await asyncio.sleep(self.hang_seconds)
            token = json.loads(request.content)['token']
            if token not in self.sessions:
                return httpx.Response(401, json={'detail': 'Invalid Session'})
            user_id, name = self.sessions[token]
            return httpx.Response(200, json={'verified': True, 'user': {'id': user_id, 'name': name}})

        if path == '/api/users/login':
            body = json.loads(request.content)
            self.login_bodies.append(body)
            user = self.users.get(body['name'])
            if not user or user['password'] != body['password']:
                return httpx.Response(200, json={'verified': False, 'message': 'Incorrect login details'})
            return self._session_response(user['id'], body['name'])

        if path == '/api/users/sign_up':
            body = json.loads(request.content)
            if body['name'] in self.users:
                return httpx.Response(200, json={'verified': False, 'message': 'user exists already for that name'})
            self._next_user += 1
            self.users[body['name']] = {'id': self._next_user, 'password': body['password']}
            return self._session_response(self._next_user, body['name'])

        if path == '/api/users/logout':
            self.logouts.append(request.headers.get('cookie', ''))
            return httpx.Response(200, json={'ok': True})

        return httpx.Response(404, json={'detail': 'Not Found'})

    def _session_response(self, user_id: int, name: str) -> httpx.Response:
        token = f'tok-{name}-{len(self.sessions)}'
        self.sessions[token] = (user_id, name)
        return httpx.Response(
            200,
            json={'verified': True, 'message': 'ok', 'user': {'id': user_id, 'name': name}},
            headers={'set-cookie': f'session_id={token}; HttpOnly; Max-Age=2592000; Path=/; SameSite=lax; Secure'},
        )


class Harness:
    def __init__(self, client: TestClient, users: FakeUsersApi, clock: FakeClock, settings: Settings):
        self.client = client
        self.users = users
        self.clock = clock
        self.settings = settings
        self.app = client.app

    def login(self, name: str = 'alice', password: str | None = None) -> httpx.Response:
        password = password or self.users.users[name]['password']
        return self.client.post('/api/auth/login', json={'name': name, 'password': password})

    def as_user(self, name: str) -> dict:
        """Cookie header for a user, leaving the client's own jar alone."""
        response = self.login(name)
        assert response.status_code == 200, response.text
        token = response.cookies[COOKIE_NAME]
        self.client.cookies.clear()
        return {'Cookie': f'{COOKIE_NAME}={token}'}

    def refresh_status(self) -> None:
        """Lets the health cache expire and waits for the background probe."""
        self.clock.advance(self.settings.health_ttl + 1)
        self.client.get('/api/session')
        self.client.portal.call(self.app.state.auth.settle)

    def upload(self, path: Path, *, name: str | None = None, headers: dict | None = None) -> httpx.Response:
        with path.open('rb') as handle:
            return self.client.post(
                '/api/documents',
                files={'file': (name or path.name, handle, 'application/pdf')},
                headers=headers or {},
            )

    def wait_ready(self, doc_id: str, headers: dict | None = None, timeout: float = 30) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            doc = self.client.get(f'/api/documents/{doc_id}', headers=headers or {}).json()
            if doc.get('status') != 'processing':
                return doc
            time.sleep(0.05)
        raise AssertionError(f'{doc_id} still processing')

    def ingest(self, path: Path, *, name: str | None = None, headers: dict | None = None) -> dict:
        response = self.upload(path, name=name, headers=headers)
        assert response.status_code == 201, response.text
        return self.wait_ready(response.json()['document']['id'], headers)


def migrate(settings: Settings) -> None:
    config = Config(str(BACKEND / 'alembic.ini'))
    config.set_main_option('script_location', str(BACKEND / 'app' / 'migrations'))
    config.attributes['database_url'] = settings.database_url
    config.attributes['configure_logging'] = False
    command.upgrade(config, 'head')


@pytest.fixture
def make_harness(tmp_path):
    clients = []

    def build(subdir: str = 'data', prepare=None, **overrides) -> Harness:
        values = {
            'data_dir': tmp_path / subdir,
            'frontend_dist': tmp_path / 'dist',
            'users_api_url': 'http://users-api:8000',
            'max_upload_mb': 2,
        }
        values.update(overrides)
        settings = Settings(_env_file=None, **values)
        settings.ensure_dirs()
        migrate(settings)
        if prepare:
            prepare(settings)
        users = FakeUsersApi()
        clock = FakeClock()
        app = create_app(settings, users_transport=httpx.MockTransport(users))
        app.state.auth.clock = clock
        app.state.login_limiter.clock = clock
        client = TestClient(app, base_url='http://reader.test')
        client.__enter__()
        clients.append(client)
        return Harness(client, users, clock, settings)

    yield build
    for client in clients:
        client.__exit__(None, None, None)


@pytest.fixture
def scoped(make_harness) -> Harness:
    return make_harness()


@pytest.fixture
def open_mode(make_harness) -> Harness:
    """No users-api configured: the classic single-user setup."""
    return make_harness(users_api_url='')


@pytest.fixture
def sample_pdf(tmp_path) -> Path:
    return pdf_samples.script_pdf(tmp_path / 'sample.pdf')
