/** Cache layout shared by the page and the service worker. Every user-data cache is keyed by scope. */

/** 'global' in global mode, 'u<id>' for a signed-in user, 'anon' when signed out (nothing is ever cached). */
export type Scope = 'global' | 'anon' | `u${number}`

export const CHUNK_SIZE = 4 * 1024 * 1024

export const dlCacheName = (scope: Scope) => `shelf-dl-${scope}`
export const apiCacheName = (scope: Scope) => `shelf-api-${scope}`
export const coverCacheName = (scope: Scope) => `shelf-covers-${scope}`
export const PDFJS_CACHE = 'shelf-pdfjs'
export const META_CACHE = 'shelf-meta'
export const META_SCOPE_URL = '/__shelf/scope'

/** Downloaded PDFs live as fixed-size chunks so a Range read never loads a whole 500MB file on a phone. */
export const dlMetaUrl = (id: string) => `/__shelf/dl/${id}/meta`
export const dlChunkUrl = (id: string, index: number) => `/__shelf/dl/${id}/chunk/${index}`
export const DL_META_RE = /^\/__shelf\/dl\/([^/]+)\/meta$/
export const DL_CHUNK_RE = /^\/__shelf\/dl\/([^/]+)\/chunk\/\d+$/

export interface DownloadMeta {
  id: string
  size: number
  chunkSize: number
  chunks: number
  etag: string | null
  contentType: string
  downloadedAt: number
}

export type SwInbound =
  | { type: 'SCOPE'; scope: Scope }
  | { type: 'DOWNLOADS_CHANGED' }
  | { type: 'SKIP_WAITING' }
