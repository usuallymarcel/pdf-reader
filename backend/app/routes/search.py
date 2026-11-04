import html
import re

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.auth import AuthContext, require_access
from app.db import get_db
from app.schemas import SearchHit

router = APIRouter(prefix='/api', tags=['search'])

# Control characters: page text is stripped of them at ingest, so they can't be forged by a PDF.
MARK_OPEN, MARK_CLOSE = '\x01', '\x02'
SNIPPET_TOKENS = 48
LIKE_CONTEXT = 60
MIN_TRIGRAM = 3


def escape_snippet(snippet: str) -> str:
    """Page text is untrusted: escape everything, then restore only the highlight marks."""
    return html.escape(snippet).replace(MARK_OPEN, '<mark>').replace(MARK_CLOSE, '</mark>')


def fts_terms(query: str) -> str:
    """Each word a quoted phrase, so FTS5 syntax in a query is just text. Words too short for a
    trigram cannot be matched and are left out."""
    terms = [term for term in query.split() if len(term) >= MIN_TRIGRAM]
    return ' '.join('"' + term.replace('"', '""') + '"' for term in terms)


def like_pattern(query: str) -> str:
    return '%' + re.sub(r'([\\%_])', r'\\\1', query) + '%'


def around_match(body: str, query: str) -> str:
    start = body.casefold().find(query.casefold())
    if start < 0:
        return body[:LIKE_CONTEXT * 2]
    end = start + len(query)
    left, right = max(0, start - LIKE_CONTEXT), min(len(body), end + LIKE_CONTEXT)
    return (
        ('…' if left else '') + body[left:start] + MARK_OPEN + body[start:end] + MARK_CLOSE
        + body[end:right] + ('…' if right < len(body) else '')
    )


@router.get('/search')
def search(
    q: str = Query(default='', max_length=500),
    doc: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_db),
) -> list[SearchHit]:
    query = q.strip()
    if not query:
        return []

    filters = ''
    params: dict = {'limit': limit}
    if auth.mode == 'scoped':
        filters += ' AND (d.owner_id IS NULL OR d.owner_id = :user)'
        params['user'] = auth.scope
    if doc:
        filters += ' AND d.id = :doc'
        params['doc'] = doc

    terms = fts_terms(query)
    if terms:
        params['terms'] = terms
        order = 't.page' if doc else 'rank'
        rows = db.execute(text(f"""
            SELECT t.document_id, d.title, t.page,
                   snippet(page_fts, 0, char(1), char(2), '…', {SNIPPET_TOKENS}) AS snippet
            FROM page_fts
            JOIN page_text t ON t.id = page_fts.rowid
            JOIN documents d ON d.id = t.document_id
            WHERE page_fts MATCH :terms {filters}
            ORDER BY {order} LIMIT :limit
        """), params).all()
        return [
            SearchHit(document_id=row[0], title=row[1], page=row[2], snippet=escape_snippet(row[3]))
            for row in rows
        ]

    params['pattern'] = like_pattern(query)
    rows = db.execute(text(f"""
        SELECT t.document_id, d.title, t.page, t.text
        FROM page_text t
        JOIN documents d ON d.id = t.document_id
        WHERE t.text LIKE :pattern ESCAPE '\\' {filters}
        ORDER BY d.created_at DESC, t.page LIMIT :limit
    """), params).all()
    return [
        SearchHit(document_id=row[0], title=row[1], page=row[2], snippet=escape_snippet(around_match(row[3], query)))
        for row in rows
    ]
