"""Auth truth table and the users-api BFF. Everything about who a request is lives here."""
import asyncio
import hashlib
import logging
import re
import time
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass
from http.cookiejar import DefaultCookiePolicy
from typing import Literal

import httpx
from fastapi import Depends, HTTPException, Request

from app.config import Settings
from app.schemas import Session, User

log = logging.getLogger(__name__)

COOKIE_NAME = 'reader_session'
COOKIE_MAX_AGE = 30 * 24 * 3600
REQUIRED_CAPABILITIES = {'session-introspection', 'remember-me'}
MAX_CACHED_TOKENS = 4096

AuthStatus = Literal['disabled', 'unavailable', 'ok']


class UsersApiDown(Exception):
    pass


class _Down:
    """Token check result meaning users-api failed, as opposed to rejecting the token."""


DOWN = _Down()


@dataclass(frozen=True)
class AuthContext:
    mode: Literal['global', 'scoped']
    auth_status: AuthStatus
    user: User | None = None

    @property
    def fail_closed(self) -> bool:
        """users-api is down and AUTH_FAIL_MODE=closed: no data may be served."""
        return self.mode == 'scoped' and self.auth_status != 'ok'

    @property
    def scope(self) -> int:
        return self.user.id if self.user else 0


def token_key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def parse_session_cookie(response: httpx.Response) -> str | None:
    # Read the header directly: the cookie is Secure and this hop is plain http.
    for header in response.headers.get_list('set-cookie'):
        match = re.match(r'\s*session_id=([^;]+)', header)
        if match:
            return match.group(1).strip().strip('"')
    return None


class AuthGateway:
    def __init__(
        self,
        settings: Settings,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.settings = settings
        self.clock = clock
        self.client = httpx.AsyncClient(
            base_url=settings.users_api_base or 'http://users-api.invalid',
            transport=transport,
            timeout=settings.login_timeout,
        )
        # Never let a shared client carry one user's session cookie into the next request.
        self.client.cookies.jar.set_policy(DefaultCookiePolicy(allowed_domains=[]))
        self._status: AuthStatus = 'unavailable'
        self._checked_at: float | None = None
        self._probe: asyncio.Task | None = None
        self._tokens: OrderedDict[str, tuple[User | None, float]] = OrderedDict()
        self._token_tasks: dict[str, asyncio.Task] = {}

    async def aclose(self) -> None:
        tasks = [t for t in (self._probe, *self._token_tasks.values()) if t]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.client.aclose()

    # --- health -------------------------------------------------------------------------

    async def status(self) -> AuthStatus:
        """Current users-api status. Only the very first call waits (bounded by auth_timeout);
        afterwards a stale value is served at once and refreshed in the background."""
        if not self.settings.users_api_base:
            return 'disabled'
        if self._checked_at is None:
            await asyncio.shield(self._start_probe())
        elif self.clock() - self._checked_at >= self.settings.health_ttl:
            self._start_probe()
        return self._status

    async def watch(self) -> None:
        """Probes on a timer so status stays fresh through idle periods, when no request
        would trigger a refresh and the first visitor would get a stale mode."""
        if not self.settings.users_api_base:
            return
        while True:
            await asyncio.sleep(self.settings.health_ttl)
            await self._start_probe()

    def _start_probe(self) -> asyncio.Task:
        if self._probe is None or self._probe.done():
            self._probe = asyncio.create_task(self._run_probe())
        return self._probe

    async def _run_probe(self) -> None:
        healthy = False
        try:
            async with asyncio.timeout(self.settings.auth_timeout):
                response = await self.client.get('/api/health')
            if response.status_code == 200:
                capabilities = response.json().get('capabilities', [])
                healthy = REQUIRED_CAPABILITIES.issubset(capabilities)
        except (httpx.HTTPError, TimeoutError, ValueError, AttributeError, TypeError):
            pass
        self._set_status('ok' if healthy else 'unavailable')

    def _set_status(self, status: AuthStatus) -> None:
        if status != self._status:
            log.info('users-api status: %s -> %s', self._status, status)
        self._status = status
        self._checked_at = self.clock()

    def mark_down(self) -> None:
        self._set_status('unavailable')

    async def settle(self) -> None:
        """Waits for a running background probe, for tests."""
        if self._probe:
            await asyncio.shield(self._probe)

    # --- tokens -------------------------------------------------------------------------

    async def verify(self, token: str) -> User | None:
        """User for a token, None if rejected. Raises UsersApiDown if users-api failed."""
        key = token_key(token)
        cached = self._tokens.get(key)
        if cached and cached[1] > self.clock():
            return cached[0]
        task = self._token_tasks.get(key)
        if task is None:
            task = asyncio.create_task(self._check_token(token, key))
            self._token_tasks[key] = task
            task.add_done_callback(lambda _: self._token_tasks.pop(key, None))
        result = await asyncio.shield(task)
        if result is DOWN:
            raise UsersApiDown
        return result

    async def _check_token(self, token: str, key: str) -> User | None | _Down:
        try:
            async with asyncio.timeout(self.settings.auth_timeout):
                response = await self.client.post('/api/token', json={'token': token})
            if response.status_code == 401:
                self._remember(key, None)
                return None
            if response.status_code != 200:
                return DOWN
            user = User.model_validate(response.json()['user'])
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError):
            return DOWN
        self._remember(key, user)
        return user

    def _remember(self, key: str, user: User | None) -> None:
        self._tokens[key] = (user, self.clock() + self.settings.token_ttl)
        self._tokens.move_to_end(key)
        while len(self._tokens) > MAX_CACHED_TOKENS:
            self._tokens.popitem(last=False)

    # --- request context ----------------------------------------------------------------

    def _without_auth(self, status: AuthStatus) -> AuthContext:
        if status == 'unavailable' and self.settings.auth_fail_mode == 'closed':
            return AuthContext('scoped', status)
        return AuthContext('global', status)

    async def context(self, request: Request) -> AuthContext:
        status = await self.status()
        if status != 'ok':
            return self._without_auth(status)
        token = request.cookies.get(COOKIE_NAME)
        if not token:
            return AuthContext('scoped', status)
        try:
            user = await self.verify(token)
        except UsersApiDown:
            self.mark_down()
            return self._without_auth('unavailable')
        return AuthContext('scoped', status, user)

    # --- BFF calls ----------------------------------------------------------------------

    async def _credentials_call(self, path: str, name: str, password: str) -> tuple[str, User] | None:
        """(session token, user), or None when users-api answered verified: false."""
        try:
            response = await self.client.post(path, json={'name': name, 'password': password, 'remember': True})
            if response.status_code >= 500:
                raise UsersApiDown
            body = response.json()
            if not body.get('verified'):
                return None
            user = User.model_validate(body['user'])
        except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError) as error:
            self.mark_down()
            raise UsersApiDown from error
        except UsersApiDown:
            self.mark_down()
            raise
        token = parse_session_cookie(response)
        if not token:
            log.error('users-api accepted credentials but set no session cookie')
            raise UsersApiDown
        self._remember(token_key(token), user)
        return token, user

    async def login(self, name: str, password: str) -> tuple[str, User] | None:
        return await self._credentials_call('/api/users/login', name, password)

    async def signup(self, name: str, password: str) -> tuple[str, User] | None:
        return await self._credentials_call('/api/users/sign_up', name, password)

    async def logout(self, token: str) -> None:
        self._tokens.pop(token_key(token), None)
        if not self.settings.users_api_base:
            return
        try:
            await self.client.post(
                '/api/users/logout',
                headers={'Cookie': f'session_id={token}'},
                timeout=self.settings.auth_timeout,
            )
        except httpx.HTTPError:
            log.warning('users-api logout failed; dropping the local session anyway')


class RateLimiter:
    """Sliding window, in-process. The BFF hides client IPs from Traefik's limiter upstream."""

    MAX_KEYS = 10000

    def __init__(self, limit: int, window: float, clock: Callable[[], float] = time.monotonic):
        self.limit = limit
        self.window = window
        self.clock = clock
        self._hits: dict[str, deque[float]] = {}

    def retry_after(self, key: str) -> float:
        """Records an attempt. Returns 0 if it is allowed, else seconds until it would be."""
        now = self.clock()
        hits = self._hits.setdefault(key, deque())
        while hits and hits[0] <= now - self.window:
            hits.popleft()
        if len(hits) >= self.limit:
            return hits[0] + self.window - now
        hits.append(now)
        if len(self._hits) > self.MAX_KEYS:
            self._hits = {k: v for k, v in self._hits.items() if v and v[-1] > now - self.window}
        return 0.0


async def get_auth(request: Request) -> AuthContext:
    return await request.app.state.auth.context(request)


async def require_access(auth: AuthContext = Depends(get_auth)) -> AuthContext:
    """Guard for every data endpoint."""
    if auth.fail_closed:
        raise HTTPException(503, 'The login service is unavailable. Try again shortly.')
    if auth.mode == 'scoped' and auth.user is None:
        raise HTTPException(401, 'Sign in to continue.')
    return auth


def session_payload(request: Request, auth: AuthContext) -> Session:
    settings: Settings = request.app.state.settings
    return Session(
        mode=auth.mode,
        auth_status=auth.auth_status,
        user=auth.user,
        allow_signup=settings.allow_signup,
        max_upload_mb=settings.max_upload_mb,
    )
