"""One-time import of the old Flask app's /data/reader.sqlite3."""
import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app.config import Settings
from app.db import Database, utcnow
from app.filename_parser import parse_filename
from app.models import Document, ReadingState
from app.storage import clean_filename

log = logging.getLogger(__name__)

GLOBAL_SCOPE = 0


def _parse_time(value: str | None) -> datetime:
    try:
        return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return utcnow()


def _read_rows(path: Path) -> list[dict]:
    connection = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in connection.execute('SELECT * FROM documents')]
    finally:
        connection.close()


def import_legacy(db: Database, settings: Settings) -> int:
    """Returns how many documents were imported. Safe to run on every boot: existing ids are
    skipped, so a crash halfway simply continues next time."""
    path = settings.legacy_db
    if not path.is_file():
        return 0
    try:
        rows = _read_rows(path)
    except sqlite3.Error:
        log.exception('could not read %s; leaving it in place', path)
        return 0

    imported = 0
    with db.write() as session:
        for row in rows:
            doc_id, filename = row.get('id'), row.get('filename')
            if not doc_id or not filename or session.get(Document, doc_id) is not None:
                continue
            stored_name = Path(row.get('stored_name') or f'{doc_id}.pdf').name
            pdf = settings.pdf_dir / stored_name
            if not pdf.is_file():
                log.warning('legacy document %s has no file %s; skipping', doc_id, stored_name)
                continue
            filename = clean_filename(filename)
            parsed = parse_filename(filename)
            created = _parse_time(row.get('uploaded_at'))
            session.add(Document(
                id=doc_id,
                owner_id=None,
                filename=filename,
                stored_name=stored_name,
                size=pdf.stat().st_size,
                title=parsed.title,
                series=parsed.series,
                volume=parsed.volume,
                status='processing',
                created_at=created,
                updated_at=created,
            ))
            page = max(1, int(row.get('last_page') or 1))
            session.add(ReadingState(user_id=GLOBAL_SCOPE, document_id=doc_id, page=page, max_page=page))
            imported += 1
        session.commit()

    os.replace(path, path.with_name(path.name + '.migrated'))
    log.info('imported %s legacy documents', imported)
    return imported
