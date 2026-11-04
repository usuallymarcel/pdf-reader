from datetime import datetime

from sqlalchemy import BigInteger, Boolean, Float, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime, utcnow


class Document(Base):
    __tablename__ = 'documents'
    __table_args__ = (
        # Backstop for the sha dedupe; owner NULL (shared) counts as one owner.
        Index('uq_documents_owner_sha', text('coalesce(owner_id, 0)'), 'sha256', unique=True),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_id: Mapped[int | None] = mapped_column(Integer, index=True)
    filename: Mapped[str] = mapped_column(Text)
    stored_name: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str | None] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(BigInteger, default=0)

    title: Mapped[str] = mapped_column(Text)
    series: Mapped[str | None] = mapped_column(Text)
    volume: Mapped[float | None] = mapped_column(Float)
    author: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(16), default='novel')
    direction: Mapped[str | None] = mapped_column(String(8))
    suggested_mode: Mapped[str] = mapped_column(String(16), default='paged')
    # Metadata fields set by a user, which a reprocess must not overwrite.
    edited_fields: Mapped[list] = mapped_column(JSON, default=list)

    page_count: Mapped[int] = mapped_column(Integer, default=0)
    page_sizes: Mapped[list] = mapped_column(JSON, default=list)
    outline: Mapped[list] = mapped_column(JSON, default=list)
    has_text: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default='processing', index=True)
    error: Mapped[str | None] = mapped_column(Text)
    cover_version: Mapped[str | None] = mapped_column(String(32))

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class ReadingState(Base):
    __tablename__ = 'reading_states'

    user_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    document_id: Mapped[str] = mapped_column(ForeignKey('documents.id', ondelete='CASCADE'), primary_key=True)
    page: Mapped[int] = mapped_column(Integer, default=1)
    offset: Mapped[float] = mapped_column(Float, default=0.0)
    max_page: Mapped[int] = mapped_column(Integer, default=1)
    finished: Mapped[bool] = mapped_column(Boolean, default=False)
    favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    seconds_read: Mapped[float] = mapped_column(Float, default=0.0)
    overrides: Mapped[dict] = mapped_column(JSON, default=dict)
    last_read_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    client_ts: Mapped[int] = mapped_column(BigInteger, default=0)


class ReadingDay(Base):
    """Seconds read per UTC day. Outlives the documents, so stats survive a delete."""

    __tablename__ = 'reading_days'

    user_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    date: Mapped[str] = mapped_column(String(10), primary_key=True)
    seconds: Mapped[float] = mapped_column(Float, default=0.0)


class Bookmark(Base):
    __tablename__ = 'bookmarks'

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    document_id: Mapped[str] = mapped_column(ForeignKey('documents.id', ondelete='CASCADE'), index=True)
    page: Mapped[int] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(Text)
    locator: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Preference(Base):
    __tablename__ = 'preferences'

    user_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    data: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class PageText(Base):
    """Source rows of the page_fts index. Triggers keep the index in step, including on the FK
    cascade when a document is deleted."""

    __tablename__ = 'page_text'
    __table_args__ = (UniqueConstraint('document_id', 'page'),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(ForeignKey('documents.id', ondelete='CASCADE'))
    page: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
