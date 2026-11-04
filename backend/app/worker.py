"""Single background worker: runs app.ingest in a subprocess per document, one at a time.

The queue is the database itself: every document with status 'processing'. That makes re-queueing
on boot automatic, and notify() only has to wake the thread.
"""
import gzip
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from sqlalchemy import delete, insert, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import Database
from app.filename_parser import is_generic_name
from app.ingest import EXIT_REFUSED
from app.models import Document, PageText
from app.storage import derived_dir, sha256_file

log = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parent.parent
POLL_SECONDS = 0.1
# Extra time to open a huge file, before the page count is known.
SECONDS_PER_GIB = 120


class _Run:
    """One subprocess. Its deadline moves once it has reported the page count."""

    def __init__(self, process: subprocess.Popen, deadline: float):
        self.process = process
        self.deadline = deadline
        self.error: str | None = None
        self.reader: threading.Thread | None = None


class IngestWorker:
    command = (sys.executable, '-m', 'app.ingest')

    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings
        self._wake = threading.Event()
        self._stopping = threading.Event()
        self._cancelled = threading.Event()
        self._lock = threading.Lock()
        self._current: str | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name='ingest', daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=10)

    def notify(self) -> None:
        self._wake.set()

    def cancel(self, doc_id: str) -> None:
        """Kills the running subprocess if it is working on doc_id."""
        with self._lock:
            if self._current == doc_id:
                self._cancelled.set()

    def _loop(self) -> None:
        while not self._stopping.is_set():
            self._wake.clear()
            try:
                doc_id = self._next_document()
                if doc_id is None:
                    self._wake.wait()
                    continue
                self._process(doc_id)
            except Exception:
                log.exception('ingest worker error')
                self._stopping.wait(5)

    def _next_document(self) -> str | None:
        with self.db.read() as session:
            return session.scalar(
                select(Document.id).where(Document.status == 'processing').order_by(Document.created_at).limit(1)
            )

    def _process(self, doc_id: str) -> None:
        with self.db.read() as session:
            doc = session.get(Document, doc_id)
            if doc is None:
                return
            pdf = self.settings.pdf_dir / doc.stored_name

        if not pdf.is_file():
            self._fail(doc_id, 'The PDF file is missing from storage.')
            return

        out = self.settings.tmp_dir / f'ingest-{doc_id}'
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True)
        with self._lock:
            self._current = doc_id
            self._cancelled.clear()
        try:
            outcome = self._run_subprocess(pdf, out)
            if outcome == 'stopped':
                return  # stays 'processing', so the next boot picks it up
            if outcome == 'cancelled':
                return
            if outcome is not None:
                self._fail(doc_id, outcome)
                return
            try:
                self._publish(doc_id, pdf, out)
            except (OSError, ValueError, KeyError, TypeError):
                # Otherwise the document would stay queued and be retried forever.
                log.exception('could not publish ingest result of %s', doc_id)
                self._fail(doc_id, 'Processing crashed on this PDF.')
        finally:
            with self._lock:
                self._current = None
            shutil.rmtree(out, ignore_errors=True)

    def _open_deadline(self, pdf: Path) -> float:
        # Hostile files can spend a long time before the page count is even known.
        gib = pdf.stat().st_size / 1024 ** 3
        return time.monotonic() + self.settings.ingest_open_timeout + gib * SECONDS_PER_GIB

    def _page_deadline(self, pages: int) -> float:
        budget = self.settings.ingest_open_timeout + pages * self.settings.ingest_page_timeout
        return time.monotonic() + min(budget, self.settings.ingest_max_timeout)

    def _read_output(self, run: _Run) -> None:
        for line in run.process.stdout:
            try:
                message = json.loads(line)
                if 'pages' in message:
                    run.deadline = self._page_deadline(int(message['pages']))
                if 'error' in message:
                    run.error = str(message['error'])
            except (ValueError, TypeError):
                continue

    def _run_subprocess(self, pdf: Path, out: Path) -> str | None:
        """None on success, 'stopped', 'cancelled', or an error message for the user."""
        process = subprocess.Popen(
            [*self.command, str(pdf), str(out)],
            cwd=BACKEND_DIR,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'},
        )
        run = _Run(process, self._open_deadline(pdf))
        run.reader = threading.Thread(target=self._read_output, args=(run,), daemon=True)
        run.reader.start()
        try:
            while process.poll() is None:
                if self._stopping.is_set():
                    return 'stopped'
                if self._cancelled.is_set():
                    return 'cancelled'
                if time.monotonic() > run.deadline:
                    log.warning('ingest of %s timed out', pdf.name)
                    return 'Processing this PDF took too long.'
                time.sleep(POLL_SECONDS)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            run.reader.join(timeout=5)
            process.stdout.close()

        if process.returncode == 0:
            return None
        if process.returncode == EXIT_REFUSED and run.error:
            return run.error
        log.warning('ingest of %s exited with %s', pdf.name, process.returncode)
        return 'Processing crashed on this PDF.'

    def _fail(self, doc_id: str, message: str) -> None:
        with self.db.write() as session:
            doc = session.get(Document, doc_id)
            if doc is None:
                return
            doc.status = 'failed'
            doc.error = message
            doc.has_text = False
            doc.cover_version = None
            session.execute(delete(PageText).where(PageText.document_id == doc_id))
            session.commit()
        shutil.rmtree(derived_dir(self.settings, doc_id), ignore_errors=True)

    def _unique_sha(self, session: Session, doc: Document, pdf: Path) -> str | None:
        """Legacy imports arrive without a hash; two of them may be the same file."""
        sha = sha256_file(pdf)
        clash = session.scalar(
            select(Document.id).where(
                Document.sha256 == sha,
                Document.id != doc.id,
                Document.owner_id.is_(None) if doc.owner_id is None else Document.owner_id == doc.owner_id,
            )
        )
        return None if clash else sha

    def _publish(self, doc_id: str, pdf: Path, out: Path) -> None:
        meta = json.loads((out / 'meta.json').read_text(encoding='utf-8'))
        with gzip.open(out / 'pages.json.gz', 'rt', encoding='utf-8') as handle:
            page_texts = json.load(handle)

        # Replace the derived files first. If the document is deleted meanwhile, either the delete
        # route removes them afterwards, or the update below finds no row and removes them here.
        (out / 'meta.json').unlink()
        (out / 'pages.json.gz').unlink()
        destination = derived_dir(self.settings, doc_id)
        shutil.rmtree(destination, ignore_errors=True)
        os.replace(out, destination)

        with self.db.write() as session:
            doc = session.get(Document, doc_id)
            if doc is None:
                shutil.rmtree(destination, ignore_errors=True)
                return
            edited = set(doc.edited_fields or ())
            doc.page_count = meta['page_count']
            doc.page_sizes = meta['page_sizes']
            doc.outline = meta['outline']
            doc.has_text = meta['has_text']
            doc.suggested_mode = meta['suggested_mode']
            if 'kind' not in edited:
                doc.kind = meta['kind']
            if 'title' not in edited and meta['title'] and is_generic_name(doc.filename):
                doc.title = meta['title']
            if 'author' not in edited and meta['author']:
                doc.author = meta['author']
            if doc.sha256 is None:
                doc.sha256 = self._unique_sha(session, doc, pdf)
            doc.cover_version = f'{time.time_ns() // 1_000_000:x}' if meta['has_cover'] else None
            doc.status = 'ready'
            doc.error = None
            session.execute(delete(PageText).where(PageText.document_id == doc_id))
            if page_texts:
                session.execute(insert(PageText), [
                    {'document_id': doc_id, 'page': page, 'text': text} for page, text in page_texts
                ])
            session.commit()
