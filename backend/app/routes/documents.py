import gzip
import logging
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.requests import ClientDisconnect

from app.auth import AuthContext, require_access
from app.config import Settings
from app.db import Database, get_db, get_write_db, utcnow
from app.filename_parser import parse_filename
from app.models import Bookmark, Document, ReadingState
from app.queries import doc_fields, doc_out, only_visible, visible_document
from app.schemas import BookmarkOut, Doc, DocDetail, DocPatch, UploadResult
from app.storage import ReceivedUpload, UploadRejected, derived_dir, new_id, receive_upload, remove_document_files

log = logging.getLogger(__name__)

router = APIRouter(prefix='/api/documents', tags=['documents'])

IMMUTABLE = 'private, max-age=31536000, immutable'
TRUE_VALUES = {'1', 'true', 'on', 'yes'}


def _store_upload(
    db: Database, settings: Settings, upload: ReceivedUpload, auth: AuthContext
) -> tuple[Doc, bool]:
    """Registers a received temp file. The write lock is held from the duplicate check to the
    commit, so two identical concurrent uploads cannot both pass the check."""
    wants_shared = upload.fields.get('shared', '').strip().lower() in TRUE_VALUES
    owner_id = auth.user.id if auth.user and not wants_shared else None
    owner_filter = Document.owner_id.is_(None) if owner_id is None else Document.owner_id == owner_id

    with db.write() as session:
        existing = session.scalar(select(Document).where(Document.sha256 == upload.sha256, owner_filter))
        if existing is not None:
            return doc_out(session, existing, auth), True

        doc_id = new_id()
        stored_name = f'{doc_id}.pdf'
        parsed = parse_filename(upload.filename)
        doc = Document(
            id=doc_id,
            owner_id=owner_id,
            filename=upload.filename,
            stored_name=stored_name,
            sha256=upload.sha256,
            size=upload.size,
            title=parsed.title,
            series=parsed.series,
            volume=parsed.volume,
            status='processing',
        )
        session.add(doc)
        session.flush()
        destination = settings.pdf_dir / stored_name
        upload.path.replace(destination)
        try:
            session.commit()
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        return doc_out(session, doc, auth), False


@router.post('', status_code=201, responses={200: {'model': UploadResult}})
async def upload_document(request: Request, auth: AuthContext = Depends(require_access)) -> UploadResult:
    settings: Settings = request.app.state.settings
    try:
        upload = await receive_upload(request, settings)
    except UploadRejected as rejected:
        raise HTTPException(rejected.status, rejected.message) from None
    except ClientDisconnect:
        return Response(status_code=400)

    try:
        document, duplicate = await run_in_threadpool(_store_upload, request.app.state.db, settings, upload, auth)
    finally:
        upload.path.unlink(missing_ok=True)  # already moved unless it was a duplicate or an error

    if not duplicate:
        request.app.state.worker.notify()
    result = UploadResult(document=document, duplicate=duplicate)
    return JSONResponse(result.model_dump(mode='json'), status_code=200 if duplicate else 201)


@router.get('/{doc_id}')
def get_document(doc_id: str, auth: AuthContext = Depends(require_access), db: Session = Depends(get_db)) -> DocDetail:
    doc = visible_document(db, auth, doc_id)
    bookmarks = db.scalars(
        select(Bookmark)
        .where(Bookmark.document_id == doc_id, Bookmark.user_id == auth.scope)
        .order_by(Bookmark.page, Bookmark.id)
    ).all()
    state = db.get(ReadingState, (auth.scope, doc_id))
    return DocDetail(
        **doc_fields(doc, state, auth),
        page_sizes=[tuple(size) for size in doc.page_sizes],
        outline=doc.outline,
        bookmarks=[BookmarkOut.model_validate(bookmark) for bookmark in bookmarks],
    )


@router.patch('/{doc_id}')
def patch_document(
    doc_id: str,
    patch: DocPatch,
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_write_db),
) -> Doc:
    doc = visible_document(db, auth, doc_id)
    changes = patch.model_dump(exclude_unset=True)
    shared = changes.pop('shared', None)
    if shared is not None and auth.mode == 'scoped':
        if doc.owner_id is None and shared is False:
            raise HTTPException(403, 'A shared document cannot be made private.')
        if shared and doc.owner_id is not None:
            doc.owner_id = None

    for name, value in changes.items():
        setattr(doc, name, value)
    doc.edited_fields = sorted(set(doc.edited_fields or ()) | set(changes) - {'direction'})
    doc.updated_at = utcnow()
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, 'The same file is already shared.') from None
    return doc_out(db, doc, auth)


@router.delete('/{doc_id}', status_code=204)
def delete_document(
    doc_id: str,
    request: Request,
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_write_db),
) -> None:
    doc = visible_document(db, auth, doc_id)
    stored_name = doc.stored_name
    db.delete(doc)
    db.commit()
    # Row first: from here on the worker's publish step finds nothing to update and cleans up.
    request.app.state.worker.cancel(doc_id)
    remove_document_files(request.app.state.settings, stored_name, doc_id)


@router.post('/{doc_id}/reprocess')
def reprocess_document(
    doc_id: str,
    request: Request,
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_write_db),
) -> Doc:
    doc = visible_document(db, auth, doc_id)
    if doc.status != 'processing':  # already queued or running: nothing to do
        doc.status = 'processing'
        doc.error = None
        doc.updated_at = utcnow()
        db.commit()
        request.app.state.worker.notify()
    return doc_out(db, doc, auth)


def _not_modified(request: Request, etag: str) -> bool:
    candidates = request.headers.get('if-none-match', '')
    return etag in (c.strip() for c in candidates.split(',')) or candidates.strip() == '*'


@router.api_route('/{doc_id}/file', methods=['GET', 'HEAD'])
def get_file(
    doc_id: str,
    request: Request,
    download: bool = False,
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_db),
) -> Response:
    doc = visible_document(db, auth, doc_id)
    path: Path = request.app.state.settings.pdf_dir / doc.stored_name
    filename, version = doc.filename, doc.sha256
    # A yield dependency outlives the response: don't pin a connection while streaming 500 MB.
    db.close()
    try:
        stat = path.stat()
    except FileNotFoundError:
        raise HTTPException(404, 'File not found.') from None

    etag = f'"{version or f"{stat.st_mtime_ns:x}-{stat.st_size:x}"}"'
    headers = {'ETag': etag, 'Cache-Control': IMMUTABLE}
    if _not_modified(request, etag):
        return Response(status_code=304, headers=headers)
    return FileResponse(
        path,
        media_type='application/pdf',
        filename=filename,
        content_disposition_type='attachment' if download else 'inline',
        headers=headers,
        stat_result=stat,
    )


@router.get('/{doc_id}/cover')
def get_cover(
    doc_id: str,
    request: Request,
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_db),
) -> Response:
    doc = visible_document(db, auth, doc_id)
    path = derived_dir(request.app.state.settings, doc_id) / 'cover.webp'
    version = doc.cover_version
    db.close()
    if not version or not path.is_file():
        raise HTTPException(404, 'No cover yet.')
    etag = f'"{version}"'
    headers = {'ETag': etag, 'Cache-Control': IMMUTABLE}
    if _not_modified(request, etag):
        return Response(status_code=304, headers=headers)
    return FileResponse(path, media_type='image/webp', headers=headers)


@router.get('/{doc_id}/text')
def get_text(
    doc_id: str,
    request: Request,
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_db),
) -> Response:
    doc = visible_document(db, auth, doc_id)
    path = derived_dir(request.app.state.settings, doc_id) / 'reflow.json.gz'
    has_text, version = doc.has_text, doc.cover_version or doc.updated_at.isoformat()
    db.close()
    if not has_text or not path.is_file():
        raise HTTPException(404, 'This document has no text.')

    etag = f'"text-{version}"'
    headers = {'ETag': etag, 'Cache-Control': 'private, no-cache', 'Vary': 'Accept-Encoding'}
    if _not_modified(request, etag):
        return Response(status_code=304, headers=headers)
    compressed = path.read_bytes()
    if 'gzip' in request.headers.get('accept-encoding', '').lower():
        headers['Content-Encoding'] = 'gzip'
        return Response(compressed, media_type='application/json', headers=headers)
    return Response(gzip.decompress(compressed), media_type='application/json', headers=headers)
