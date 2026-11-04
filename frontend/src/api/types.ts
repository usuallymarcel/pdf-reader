/** Wire contract between frontend and backend. The backend mirrors this exactly. */

export type AuthStatus =
  | 'disabled' // USERS_API_URL not configured
  | 'unavailable' // configured but down or missing capabilities
  | 'ok'

export interface User {
  id: number
  name: string
}

export interface Session {
  /** global: no login, everything shared. scoped: per-user data, login required. */
  mode: 'global' | 'scoped'
  auth_status: AuthStatus
  user: User | null
  allow_signup: boolean
  max_upload_mb: number
}

export type DocStatus = 'processing' | 'ready' | 'failed'
export type DocKind = 'manga' | 'novel'
export type Direction = 'ltr' | 'rtl'
export type ReaderMode = 'paged' | 'scroll' | 'reflow'

export interface ReadingState {
  page: number // 1-based source PDF page
  /** 0..1 offset within the page (scroll/reflow) */
  offset: number
  max_page: number
  finished: boolean
  favorite: boolean
  seconds_read: number
  /** partial ReaderProfile, per-book */
  overrides: Record<string, unknown>
  last_read_at: string | null // ISO-8601 UTC
  client_ts: number // ms epoch of the write that won
}

export interface Doc {
  id: string
  title: string
  series: string | null
  volume: number | null
  author: string | null
  kind: DocKind
  direction: Direction | null // null = use profile default
  suggested_mode: ReaderMode
  filename: string
  size: number
  page_count: number
  has_text: boolean
  status: DocStatus
  error: string | null
  /** cache-buster for /cover */
  cover_version: string | null
  /** true when owner_id is null. Always true in global mode. */
  shared: boolean
  /** caller may PATCH/DELETE */
  editable: boolean
  created_at: string
  updated_at: string
  state: ReadingState
}

export interface OutlineItem {
  title: string
  page: number
  level: number
}

export interface Bookmark {
  id: number
  document_id: string
  page: number
  note: string | null
  /** reflow block index for exact restoration, when set */
  locator: number | null
  created_at: string
}

export interface DocDetail extends Doc {
  /** [width,height] in points per page, rotation applied. length === page_count */
  page_sizes: [number, number][]
  outline: OutlineItem[]
  bookmarks: Bookmark[]
}

export interface DocPatch {
  title?: string
  series?: string | null
  volume?: number | null
  author?: string | null
  kind?: DocKind
  direction?: Direction | null
  /** owner only, scoped mode; true clears owner */
  shared?: boolean
}

export interface ProgressUpdate {
  page: number
  offset?: number
  /** seconds actively read since the last update; always accumulated */
  seconds?: number
  client_ts: number
}

export interface StatePatch {
  favorite?: boolean
  finished?: boolean
  overrides?: Record<string, unknown>
  /** sets page 1, max_page 1, finished false */
  reset_progress?: boolean
}

export type ReflowBlock =
  | { t: 'p'; text: string; page: number }
  | { t: 'h'; text: string; page: number }
  | { t: 'img'; page: number }

export interface ReflowDoc {
  version: 1
  blocks: ReflowBlock[]
}

export interface SearchHit {
  document_id: string
  title: string
  page: number
  /** HTML-escaped text containing only <mark> tags */
  snippet: string
}

export interface Stats {
  documents: number
  finished: number
  pages_read: number
  seconds_read: number
  /** last 30 UTC days, oldest first */
  daily_seconds: { date: string; seconds: number }[]
  streak_days: number
}

export interface PreferencesEnvelope {
  data: Record<string, unknown> | null
  updated_at: string | null
}

export interface UploadResult {
  document: Doc
  duplicate: boolean
}
