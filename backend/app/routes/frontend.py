"""Serves the built frontend, with SPA fallback for client-side routes."""
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse

router = APIRouter(tags=['frontend'])

NO_CACHE = 'no-cache'
IMMUTABLE = 'public, max-age=31536000, immutable'
SHORT_CACHE = 'public, max-age=3600'
# Must be revalidated, or a browser could stay on an old release for good.
ENTRY_FILES = {'index.html', 'sw.js', 'registerSW.js', 'manifest.webmanifest', 'manifest.json'}


def _cache_control(relative: Path) -> str:
    if relative.parts[0] == 'assets':
        return IMMUTABLE
    return NO_CACHE if relative.name in ENTRY_FILES else SHORT_CACHE


@router.api_route('/{path:path}', methods=['GET', 'HEAD'], include_in_schema=False)
def serve_frontend(path: str, request: Request) -> Response:
    if path == 'api' or path.startswith('api/'):
        raise HTTPException(404, 'Not found.')

    dist: Path = request.app.state.settings.frontend_dist.resolve()
    if path:
        candidate = (dist / path).resolve()
        if candidate.is_relative_to(dist) and candidate.is_file():
            return FileResponse(candidate, headers={'Cache-Control': _cache_control(candidate.relative_to(dist))})
        # A missing hashed asset must 404. Answering with HTML would make a stale tab fail on a
        # JS parse error, and a service worker could cache it.
        if path.startswith('assets/') or '.' in path.rsplit('/', 1)[-1]:
            raise HTTPException(404, 'Not found.')

    index = dist / 'index.html'
    if not index.is_file():
        raise HTTPException(404, 'Frontend not built.')
    return FileResponse(index, media_type='text/html', headers={'Cache-Control': NO_CACHE})
