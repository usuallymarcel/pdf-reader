from collections.abc import Iterator
from datetime import datetime, timezone

from fastapi import Request
from sqlalchemy import DateTime, create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator


class Base(DeclarativeBase):
    pass


class UTCDateTime(TypeDecorator):
    """Stores naive UTC (SQLite has no timezones), returns aware UTC."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):
        return None if value is None else value.astimezone(timezone.utc).replace(tzinfo=None)

    def process_result_value(self, value, dialect):
        return None if value is None else value.replace(tzinfo=timezone.utc)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def build_engine(url: str) -> Engine:
    # One uvicorn worker, but up to 40 threadpool threads plus the ingest worker.
    engine = create_engine(
        url,
        pool_size=20,
        max_overflow=20,
        connect_args={'check_same_thread': False, 'timeout': 30},
    )

    @event.listens_for(engine, 'connect')
    def on_connect(dbapi_connection, _record):
        # pysqlite's implicit transactions are turned off so that `begin` below decides how
        # each transaction starts.
        dbapi_connection.isolation_level = None
        cursor = dbapi_connection.cursor()
        cursor.execute('PRAGMA journal_mode=WAL')
        cursor.execute('PRAGMA synchronous=NORMAL')
        cursor.execute('PRAGMA busy_timeout=30000')
        cursor.execute('PRAGMA foreign_keys=ON')
        cursor.close()

    @event.listens_for(engine, 'begin')
    def on_begin(conn):
        # A deferred transaction that reads and then writes fails instantly with SQLITE_BUSY if
        # another writer got in between: busy_timeout does not cover the upgrade. Write sessions
        # therefore take the write lock up front and queue on busy_timeout instead.
        immediate = conn.get_execution_options().get('sqlite_immediate', False)
        conn.exec_driver_sql('BEGIN IMMEDIATE' if immediate else 'BEGIN')

    return engine


class Database:
    def __init__(self, url: str):
        self.engine = build_engine(url)
        writer = self.engine.execution_options(sqlite_immediate=True)
        self.read = sessionmaker(self.engine, autoflush=False, expire_on_commit=False)
        self.write = sessionmaker(writer, autoflush=False, expire_on_commit=False)

    def dispose(self) -> None:
        self.engine.dispose()


def get_db(request: Request) -> Iterator[Session]:
    with request.app.state.db.read() as session:
        yield session


def get_write_db(request: Request) -> Iterator[Session]:
    """Session for routes that write. Commit explicitly in the route."""
    with request.app.state.db.write() as session:
        yield session
