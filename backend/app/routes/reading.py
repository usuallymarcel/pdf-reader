from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import AuthContext, require_access
from app.db import get_db, get_write_db, utcnow
from app.models import Bookmark, Document, Preference, ReadingDay, ReadingState
from app.queries import only_visible, state_out, visible_document
from app.schemas import (
    BookmarkCreate, BookmarkOut, PreferencesEnvelope, PreferencesPut, ProgressUpdate, ReadingStateOut, StatePatch,
)

router = APIRouter(prefix='/api', tags=['reading'])


def _state_for(db: Session, auth: AuthContext, doc_id: str) -> ReadingState:
    state = db.get(ReadingState, (auth.scope, doc_id))
    if state is None:
        state = ReadingState(
            user_id=auth.scope, document_id=doc_id, page=1, offset=0.0, max_page=1, finished=False,
            favorite=False, seconds_read=0.0, overrides={}, client_ts=0,
        )
        db.add(state)
    return state


def _add_daily_seconds(db: Session, user_id: int, client_ts: int, seconds: float) -> None:
    """Booked on the day it was read, which for a queued offline update may be in the past."""
    now = utcnow()
    moment = min(datetime.fromtimestamp(client_ts / 1000, timezone.utc), now) if client_ts else now
    key = (user_id, moment.date().isoformat())
    day = db.get(ReadingDay, key)
    if day is None:
        db.add(ReadingDay(user_id=key[0], date=key[1], seconds=seconds))
    else:
        day.seconds += seconds


@router.put('/documents/{doc_id}/progress')
def put_progress(
    doc_id: str,
    update: ProgressUpdate,
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_write_db),
) -> ReadingStateOut:
    doc = visible_document(db, auth, doc_id)
    state = _state_for(db, auth, doc_id)
    page = min(update.page, doc.page_count) if doc.page_count else update.page

    state.seconds_read += update.seconds
    if update.seconds:
        _add_daily_seconds(db, auth.scope, update.client_ts, update.seconds)
    state.max_page = max(state.max_page, page)
    if doc.page_count and state.max_page >= doc.page_count:
        state.finished = True
    if update.client_ts >= state.client_ts:
        state.page = page
        state.offset = update.offset
        state.client_ts = update.client_ts
        state.last_read_at = utcnow()
    db.commit()
    return state_out(state)


@router.patch('/documents/{doc_id}/state')
def patch_state(
    doc_id: str,
    patch: StatePatch,
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_write_db),
) -> ReadingStateOut:
    visible_document(db, auth, doc_id)
    state = _state_for(db, auth, doc_id)
    if patch.reset_progress:
        state.page = 1
        state.offset = 0.0
        state.max_page = 1
        state.finished = False
        # Older queued writes must not bring the old position back.
        state.client_ts = max(state.client_ts, int(utcnow().timestamp() * 1000))
    changes = patch.model_dump(exclude_unset=True, exclude={'reset_progress'})
    for name, value in changes.items():
        setattr(state, name, value)
    db.commit()
    return state_out(state)


@router.get('/documents/{doc_id}/bookmarks')
def list_bookmarks(
    doc_id: str, auth: AuthContext = Depends(require_access), db: Session = Depends(get_db)
) -> list[BookmarkOut]:
    visible_document(db, auth, doc_id)
    bookmarks = db.scalars(
        select(Bookmark)
        .where(Bookmark.document_id == doc_id, Bookmark.user_id == auth.scope)
        .order_by(Bookmark.page, Bookmark.id)
    ).all()
    return [BookmarkOut.model_validate(bookmark) for bookmark in bookmarks]


@router.post('/documents/{doc_id}/bookmarks', status_code=201)
def create_bookmark(
    doc_id: str,
    data: BookmarkCreate,
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_write_db),
) -> BookmarkOut:
    visible_document(db, auth, doc_id)
    bookmark = Bookmark(user_id=auth.scope, document_id=doc_id, page=data.page, note=data.note, locator=data.locator)
    db.add(bookmark)
    db.commit()
    return BookmarkOut.model_validate(bookmark)


@router.delete('/bookmarks/{bookmark_id}', status_code=204)
def delete_bookmark(
    bookmark_id: int, auth: AuthContext = Depends(require_access), db: Session = Depends(get_write_db)
) -> None:
    bookmark = db.scalar(select(Bookmark).where(Bookmark.id == bookmark_id, Bookmark.user_id == auth.scope))
    if bookmark is None or db.scalar(only_visible(select(Document.id).where(Document.id == bookmark.document_id), auth)) is None:
        raise HTTPException(404, 'Bookmark not found.')
    db.delete(bookmark)
    db.commit()


@router.get('/preferences')
def get_preferences(auth: AuthContext = Depends(require_access), db: Session = Depends(get_db)) -> PreferencesEnvelope:
    preference = db.get(Preference, auth.scope)
    if preference is None:
        return PreferencesEnvelope(data=None, updated_at=None)
    return PreferencesEnvelope(data=preference.data, updated_at=preference.updated_at)


@router.put('/preferences')
def put_preferences(
    body: PreferencesPut, auth: AuthContext = Depends(require_access), db: Session = Depends(get_write_db)
) -> PreferencesEnvelope:
    preference = db.get(Preference, auth.scope)
    if preference is None:
        preference = Preference(user_id=auth.scope, data=body.data)
        db.add(preference)
    else:
        preference.data = body.data
        preference.updated_at = utcnow()
    db.commit()
    return PreferencesEnvelope(data=preference.data, updated_at=preference.updated_at)
