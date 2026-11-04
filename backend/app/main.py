"""Application factory: `uvicorn app.main:create_app --factory`."""
import asyncio
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from app.auth import AuthGateway, RateLimiter
from app.config import Settings
from app.db import Database
from app.legacy import import_legacy
from app.middleware import GuardMiddleware
from app.routes import auth, collections, documents, frontend, health, library, reading, search
from app.storage import clean_tmp
from app.worker import IngestWorker

logging.basicConfig(level=logging.INFO, format='%(levelname)s %(name)s: %(message)s')


@asynccontextmanager
async def lifespan(app: FastAPI):
    state = app.state
    state.settings.ensure_dirs()
    await run_in_threadpool(clean_tmp, state.settings)
    await run_in_threadpool(import_legacy, state.db, state.settings)
    state.worker.start()
    auth_watch = asyncio.create_task(state.auth.watch())
    yield
    auth_watch.cancel()
    await run_in_threadpool(state.worker.stop)
    await state.auth.aclose()
    state.db.dispose()


async def http_error(_request: Request, error: HTTPException) -> JSONResponse:
    return JSONResponse({'error': str(error.detail)}, status_code=error.status_code, headers=error.headers)


async def validation_error(_request: Request, error: RequestValidationError) -> JSONResponse:
    first = error.errors()[0]
    field = '.'.join(str(part) for part in first['loc'] if part != 'body')
    return JSONResponse({'error': f'{field}: {first["msg"]}' if field else first['msg']}, status_code=422)


async def unexpected_error(_request: Request, _error: Exception) -> JSONResponse:
    return JSONResponse({'error': 'Something went wrong.'}, status_code=500)


def create_app(settings: Settings | None = None, users_transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    settings = settings or Settings()
    settings.ensure_dirs()

    app = FastAPI(title='Shelf', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.db = Database(settings.database_url)
    app.state.auth = AuthGateway(settings, transport=users_transport)
    app.state.login_limiter = RateLimiter(settings.login_rate_limit, settings.login_rate_window)
    app.state.worker = IngestWorker(app.state.db, settings)

    app.add_exception_handler(HTTPException, http_error)
    app.add_exception_handler(RequestValidationError, validation_error)
    app.add_exception_handler(Exception, unexpected_error)
    app.add_middleware(GuardMiddleware, trusted_origins=settings.trusted_origins)

    for module in (health, auth, library, collections, documents, reading, search):
        app.include_router(module.router)
    app.include_router(frontend.router)  # catch-all, must stay last
    return app
