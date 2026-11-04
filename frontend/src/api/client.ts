import type {
  Bookmark, Doc, DocDetail, DocPatch, PreferencesEnvelope, ProgressUpdate, ReadingState,
  ReflowDoc, SearchHit, Session, StatePatch, Stats, UploadResult,
} from './types'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Fired whenever any request gets a 401, so the app can flip to the login screen. */
export const AUTH_REQUIRED_EVENT = 'shelf:auth-required'

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json')
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers })
  if (res.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const fileUrl = (id: string) => `/api/documents/${id}/file`
export const downloadUrl = (id: string) => `/api/documents/${id}/file?download=1`
export const coverUrl = (doc: Pick<Doc, 'id' | 'cover_version'>) =>
  `/api/documents/${doc.id}/cover?v=${encodeURIComponent(doc.cover_version ?? '0')}`

export const api = {
  session: () => request<Session>('/api/session'),
  login: (name: string, password: string) => request<Session>('/api/auth/login', json('POST', { name, password })),
  signup: (name: string, password: string) => request<Session>('/api/auth/signup', json('POST', { name, password })),
  logout: () => request<Session>('/api/auth/logout', json('POST')),

  library: () => request<Doc[]>('/api/library'),
  stats: () => request<Stats>('/api/stats'),
  document: (id: string) => request<DocDetail>(`/api/documents/${id}`),
  patchDocument: (id: string, patch: DocPatch) => request<Doc>(`/api/documents/${id}`, json('PATCH', patch)),
  deleteDocument: (id: string) => request<void>(`/api/documents/${id}`, { method: 'DELETE' }),
  reprocess: (id: string) => request<Doc>(`/api/documents/${id}/reprocess`, json('POST')),
  reflow: (id: string) => request<ReflowDoc>(`/api/documents/${id}/text`),

  saveProgress: (id: string, update: ProgressUpdate, keepalive = false) =>
    request<ReadingState>(`/api/documents/${id}/progress`, { ...json('PUT', update), keepalive }),
  patchState: (id: string, patch: StatePatch) => request<ReadingState>(`/api/documents/${id}/state`, json('PATCH', patch)),

  addBookmark: (id: string, b: { page: number; note?: string; locator?: number }) =>
    request<Bookmark>(`/api/documents/${id}/bookmarks`, json('POST', b)),
  deleteBookmark: (bookmarkId: number) => request<void>(`/api/bookmarks/${bookmarkId}`, { method: 'DELETE' }),

  preferences: () => request<PreferencesEnvelope>('/api/preferences'),
  savePreferences: (data: Record<string, unknown>) => request<PreferencesEnvelope>('/api/preferences', json('PUT', { data })),

  search: (q: string, doc?: string, limit = 50) => {
    const params = new URLSearchParams({ q, limit: String(limit) })
    if (doc) params.set('doc', doc)
    return request<SearchHit[]>(`/api/search?${params}`)
  },
}

/** XHR because fetch has no upload progress. Resolves on 200 (duplicate) or 201. */
export function uploadDocument(
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const form = new FormData()
    form.append('file', file)
    xhr.open('POST', '/api/documents')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onload = () => {
      if (xhr.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as UploadResult)
      else reject(new ApiError(xhr.status, (xhr.response as { error?: string } | null)?.error ?? `Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'))
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(form)
  })
}
