"""Pure ASGI middleware: BaseHTTPMiddleware would get in the way of streaming uploads and of
noticing client disconnects."""
import json
from urllib.parse import urlsplit

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

CSP = '; '.join([
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    # pdf.js builds FontFaces from data: and blob: URLs.
    "font-src 'self' data: blob:",
    "connect-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])

SECURITY_HEADERS = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

SAFE_METHODS = {'GET', 'HEAD', 'OPTIONS'}
MAX_JSON_BODY = 4 * 1024 * 1024
UPLOAD_PATH = '/api/documents'


def _canonical(scheme: str, host: str) -> str:
    host = host.strip().lower()
    for suffix, default_scheme in ((':443', 'https'), (':80', 'http')):
        if host.endswith(suffix) and scheme == default_scheme:
            return host[: -len(suffix)]
    return host


def _same_origin(origin: str, headers: Headers, scheme: str) -> bool:
    if origin == 'null':
        return False
    parts = urlsplit(origin)
    # X-Forwarded-Host may carry a chain; the first entry is what the browser addressed.
    forwarded = headers.get('x-forwarded-host', '').split(',')[0].strip()
    host = forwarded or headers.get('host', '')
    return bool(parts.netloc) and _canonical(parts.scheme, parts.netloc) == _canonical(parts.scheme, host)


def _error_messages(status: int, message: str) -> tuple[Message, Message]:
    body = json.dumps({'error': message}).encode()
    start = {
        'type': 'http.response.start',
        'status': status,
        'headers': [(b'content-type', b'application/json'), (b'content-length', str(len(body)).encode())],
    }
    return start, {'type': 'http.response.body', 'body': body}


class GuardMiddleware:
    """Security headers on every response; CSRF and body-size checks before the app runs."""

    def __init__(self, app: ASGIApp, trusted_origins: set[str]):
        self.app = app
        self.trusted_origins = trusted_origins

    def _rejection(self, scope: Scope) -> tuple[int, str] | None:
        if scope['method'] in SAFE_METHODS:
            return None
        headers = Headers(scope=scope)
        origin = headers.get('origin')
        if origin and origin.rstrip('/') not in self.trusted_origins:
            if not _same_origin(origin, headers, scope.get('scheme', '')):
                return 403, 'Cross-origin request rejected.'
        if scope['path'] != UPLOAD_PATH:
            length = headers.get('content-length', '')
            if length.isdigit() and int(length) > MAX_JSON_BODY:
                return 413, 'Request body too large.'
        return None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message['type'] == 'http.response.start':
                headers = MutableHeaders(scope=message)
                for name, value in SECURITY_HEADERS.items():
                    headers.setdefault(name, value)
            await send(message)

        rejection = self._rejection(scope)
        if rejection:
            for message in _error_messages(*rejection):
                await send_with_headers(message)
            return
        await self.app(scope, receive, send_with_headers)
