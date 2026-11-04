"""Scope rules and the Doc wire shape, shared by the routes."""
from fastapi import HTTPException
from sqlalchemy import Select, or_, select
from sqlalchemy.orm import Session

from app.auth import AuthContext
from app.models import Document, ReadingState
from app.schemas import Doc, ReadingStateOut


def only_visible(statement: Select, auth: AuthContext) -> Select:
    """global: everything. scoped: own and shared documents."""
    if auth.mode == 'global':
        return statement
    return statement.where(or_(Document.owner_id.is_(None), Document.owner_id == auth.scope))


def visible_document(session: Session, auth: AuthContext, doc_id: str) -> Document:
    """Someone else's private document does not exist, as far as the caller can tell."""
    doc = session.scalar(only_visible(select(Document).where(Document.id == doc_id), auth))
    if doc is None:
        raise HTTPException(404, 'Document not found.')
    return doc


def state_out(state: ReadingState | None) -> ReadingStateOut:
    return ReadingStateOut.model_validate(state) if state else ReadingStateOut()


def doc_fields(doc: Document, state: ReadingState | None, auth: AuthContext) -> dict:
    return {
        'id': doc.id,
        'title': doc.title,
        'series': doc.series,
        'volume': doc.volume,
        'author': doc.author,
        'kind': doc.kind,
        'direction': doc.direction,
        'suggested_mode': doc.suggested_mode,
        'filename': doc.filename,
        'size': doc.size,
        'page_count': doc.page_count,
        'has_text': doc.has_text,
        'status': doc.status,
        'error': doc.error,
        'cover_version': doc.cover_version,
        'shared': auth.mode == 'global' or doc.owner_id is None,
        'editable': auth.mode == 'global' or doc.owner_id is None or doc.owner_id == auth.scope,
        'created_at': doc.created_at,
        'updated_at': doc.updated_at,
        'state': state_out(state),
    }


def doc_out(session: Session, doc: Document, auth: AuthContext) -> Doc:
    state = session.get(ReadingState, (auth.scope, doc.id))
    return Doc(**doc_fields(doc, state, auth))
