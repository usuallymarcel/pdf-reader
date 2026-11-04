"""Wire contract: mirrors frontend/src/api/types.ts field for field."""
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, StringConstraints

Timestamp = Annotated[
    datetime,
    PlainSerializer(lambda v: v.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), return_type=str),
]
Kind = Literal['manga', 'novel']
Direction = Literal['ltr', 'rtl']
ShortText = Annotated[str, Field(min_length=1, max_length=500)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
DocIds = Annotated[list[str], Field(max_length=5000)]


class User(BaseModel):
    id: int
    name: str


class Session(BaseModel):
    mode: Literal['global', 'scoped']
    auth_status: Literal['disabled', 'unavailable', 'ok']
    user: User | None
    allow_signup: bool
    max_upload_mb: int


class Credentials(BaseModel):
    name: str = Field(max_length=200)
    password: str = Field(max_length=1024)


class Signup(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=8, max_length=1024)


class ReadingStateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    page: int = 1
    offset: float = 0.0
    max_page: int = 1
    finished: bool = False
    favorite: bool = False
    seconds_read: float = 0.0
    overrides: dict[str, Any] = Field(default_factory=dict)
    last_read_at: Timestamp | None = None
    client_ts: int = 0


class Doc(BaseModel):
    id: str
    title: str
    series: str | None
    volume: float | None
    author: str | None
    kind: Kind
    direction: Direction | None
    suggested_mode: Literal['paged', 'scroll', 'reflow']
    filename: str
    size: int
    page_count: int
    has_text: bool
    status: Literal['processing', 'ready', 'failed']
    error: str | None
    cover_version: str | None
    shared: bool
    editable: bool
    created_at: Timestamp
    updated_at: Timestamp
    state: ReadingStateOut
    collections: list[int]


class OutlineItem(BaseModel):
    title: str
    page: int
    level: int


class BookmarkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    document_id: str
    page: int
    note: str | None
    locator: int | None
    created_at: Timestamp


class DocDetail(Doc):
    page_sizes: list[tuple[float, float]]
    outline: list[OutlineItem]
    bookmarks: list[BookmarkOut]


class DocPatch(BaseModel):
    """Only the fields sent are applied. Unset defaults are not validated, explicit nulls are."""

    title: ShortText = None
    series: ShortText | None = None
    volume: float | None = Field(default=None, ge=0)
    author: ShortText | None = None
    kind: Kind = None
    direction: Direction | None = None
    shared: bool = None


class BulkChanges(BaseModel):
    """What a group of books can sensibly share. Unset fields stay as they are."""

    series: ShortText | None = None
    author: ShortText | None = None
    kind: Kind = None


class BulkPatch(BaseModel):
    ids: Annotated[list[str], Field(min_length=1, max_length=5000)]
    changes: BulkChanges


class CollectionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str


class CollectionWrite(BaseModel):
    name: Name


class CollectionItems(BaseModel):
    add: DocIds = []
    remove: DocIds = []


class UploadResult(BaseModel):
    document: Doc
    duplicate: bool


class ProgressUpdate(BaseModel):
    page: int = Field(ge=1)
    offset: float = Field(default=0.0, ge=0, le=1)
    seconds: float = Field(default=0.0, ge=0, le=86400)
    client_ts: int = Field(ge=0)


class StatePatch(BaseModel):
    favorite: bool = None
    finished: bool = None
    overrides: dict[str, Any] = None
    reset_progress: bool = False


class BookmarkCreate(BaseModel):
    page: int = Field(ge=1)
    note: str | None = Field(default=None, max_length=10000)
    locator: int | None = Field(default=None, ge=0)


class SearchHit(BaseModel):
    document_id: str
    title: str
    page: int
    snippet: str


class DailySeconds(BaseModel):
    date: str
    seconds: int


class Stats(BaseModel):
    documents: int
    finished: int
    pages_read: int
    seconds_read: int
    daily_seconds: list[DailySeconds]
    streak_days: int


class PreferencesEnvelope(BaseModel):
    data: dict[str, Any] | None
    updated_at: Timestamp | None


class PreferencesPut(BaseModel):
    data: dict[str, Any]
