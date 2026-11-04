"""Files on the data volume, and receiving uploads without holding them in memory."""
import hashlib
import logging
import re
import shutil
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import Request
from fastapi.concurrency import run_in_threadpool
from python_multipart.multipart import MultipartParser, parse_options_header

from app.config import Settings

log = logging.getLogger(__name__)

PDF_MAGIC = b'%PDF-'
MAGIC_WINDOW = 1024
MAX_FILENAME = 255
MAX_FIELD = 1024
# Multipart boundaries and part headers on top of the file itself.
MULTIPART_OVERHEAD = 64 * 1024


class UploadRejected(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


def new_id() -> str:
    return uuid.uuid4().hex


def clean_tmp(settings: Settings) -> None:
    """Whatever is in tmp at boot was left by a crash."""
    for entry in settings.tmp_dir.iterdir():
        if entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            entry.unlink(missing_ok=True)


def derived_dir(settings: Settings, doc_id: str) -> Path:
    return settings.derived_dir / doc_id


def remove_document_files(settings: Settings, stored_name: str, doc_id: str) -> None:
    (settings.pdf_dir / stored_name).unlink(missing_ok=True)
    shutil.rmtree(derived_dir(settings, doc_id), ignore_errors=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def clean_filename(raw: str) -> str:
    name = re.split(r'[\\/]', raw)[-1]
    name = re.sub(r'[\x00-\x1f\x7f]', '', name).strip()
    return name[-MAX_FILENAME:] or 'document.pdf'


class _FileSink:
    """Writes one upload to /data/tmp, hashing as it goes and enforcing limits on the fly."""

    def __init__(self, directory: Path, limit: int):
        handle = tempfile.NamedTemporaryFile(dir=directory, prefix='upload-', suffix='.pdf', delete=False)
        self.handle = handle
        self.path = Path(handle.name)
        self.limit = limit
        self.size = 0
        self.digest = hashlib.sha256()
        self.head = bytearray()

    def write(self, data: bytes) -> None:
        self.size += len(data)
        if self.size > self.limit:
            raise UploadRejected(413, 'That PDF is larger than the upload limit.')
        if len(self.head) < MAGIC_WINDOW:
            self.head += data[: MAGIC_WINDOW - len(self.head)]
            if len(self.head) >= MAGIC_WINDOW:
                self.check_magic()
        self.digest.update(data)
        self.handle.write(data)

    def check_magic(self) -> None:
        if PDF_MAGIC not in self.head:
            raise UploadRejected(415, 'Only PDF files are supported.')

    def discard(self) -> None:
        self.handle.close()
        self.path.unlink(missing_ok=True)


@dataclass
class _Part:
    name: str = ''
    filename: str | None = None
    header_field: bytes = b''
    header_value: bytes = b''
    data: bytearray = field(default_factory=bytearray)


@dataclass
class ReceivedUpload:
    path: Path
    filename: str
    size: int
    sha256: str
    fields: dict[str, str]


class _UploadParser:
    """Callbacks for python-multipart's low-level parser. Starlette's request.form() would spool
    the whole body to the system temp dir before a route could enforce anything."""

    def __init__(self, settings: Settings, boundary: bytes):
        self.settings = settings
        self.sink: _FileSink | None = None
        self.filename = ''
        self.fields: dict[str, str] = {}
        self.part = _Part()
        self.parser = MultipartParser(boundary, callbacks={
            'on_part_begin': self.on_part_begin,
            'on_header_field': self.on_header_field,
            'on_header_value': self.on_header_value,
            'on_header_end': self.on_header_end,
            'on_part_data': self.on_part_data,
            'on_part_end': self.on_part_end,
        })

    def on_part_begin(self) -> None:
        self.part = _Part()

    def on_header_field(self, data: bytes, start: int, end: int) -> None:
        self.part.header_field += data[start:end]

    def on_header_value(self, data: bytes, start: int, end: int) -> None:
        self.part.header_value += data[start:end]

    def on_header_end(self) -> None:
        part = self.part
        if part.header_field.lower() == b'content-disposition':
            _, options = parse_options_header(part.header_value)
            part.name = options.get(b'name', b'').decode('utf-8', 'replace')
            if b'filename' in options:
                part.filename = options[b'filename'].decode('utf-8', 'replace')
        part.header_field, part.header_value = b'', b''

    def on_part_data(self, data: bytes, start: int, end: int) -> None:
        part = self.part
        if part.name == 'file' and part.filename is not None:
            if self.sink is None:
                self.sink = _FileSink(self.settings.tmp_dir, self.settings.max_upload_bytes)
                self.filename = part.filename
            self.sink.write(data[start:end])
        elif len(part.data) + end - start <= MAX_FIELD:
            part.data += data[start:end]

    def on_part_end(self) -> None:
        if self.part.filename is None and self.part.name:
            self.fields[self.part.name] = self.part.data.decode('utf-8', 'replace')

    def write(self, chunk: bytes) -> None:
        self.parser.write(chunk)


async def receive_upload(request: Request, settings: Settings) -> ReceivedUpload:
    """Streams a multipart upload to /data/tmp. The caller owns the returned temp file. On any
    failure, a client abort included, the temp file is gone by the time this raises."""
    content_type, options = parse_options_header(request.headers.get('content-type', ''))
    boundary = options.get(b'boundary')
    if content_type != b'multipart/form-data' or not boundary:
        raise UploadRejected(400, 'Expected a multipart upload.')

    length = request.headers.get('content-length', '')
    if length.isdigit() and int(length) > settings.max_upload_bytes + MULTIPART_OVERHEAD:
        raise UploadRejected(413, 'That PDF is larger than the upload limit.')

    parser = _UploadParser(settings, boundary)
    try:
        async for chunk in request.stream():
            if chunk:
                # Hashing and disk writes must not stall the event loop.
                await run_in_threadpool(parser.write, chunk)
        sink = parser.sink
        if sink is None or sink.size == 0:
            raise UploadRejected(400, 'Choose a PDF to upload.')
        sink.check_magic()
        sink.handle.close()
    except BaseException:
        # BaseException: a task cancelled at shutdown must not leave its temp file behind either.
        if parser.sink:
            parser.sink.discard()
        raise
    return ReceivedUpload(
        path=sink.path,
        filename=clean_filename(parser.filename),
        size=sink.size,
        sha256=sink.digest.hexdigest(),
        fields=parser.fields,
    )
