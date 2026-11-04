import { create } from 'zustand'
import { coverUrl, fileUrl } from '../api/client'
import type { Doc, DocDetail } from '../api/types'
import { CHUNK_SIZE, DL_CHUNK_RE, DL_META_RE, dlCacheName, dlChunkUrl, dlMetaUrl, type DownloadMeta } from './paths'
import { currentScope, offlineSupported, postToWorker } from './scope'

export interface DownloadedBook extends DownloadMeta { doc: Doc }

export class DownloadError extends Error {}

interface ActiveDownload { loaded: number; total: number; abort: AbortController }

interface DownloadStore {
  books: Record<string, DownloadedBook>
  active: Record<string, ActiveDownload>
  refresh: () => Promise<void>
  download: (doc: Doc) => Promise<void>
  cancel: (id: string) => void
  remove: (id: string) => Promise<void>
  clear: () => Promise<void>
}

const activeCache = () => caches.open(dlCacheName(currentScope()))

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

async function checkQuota(size: number) {
  const estimate = await navigator.storage?.estimate?.()
  if (!estimate?.quota) return
  const free = estimate.quota - (estimate.usage ?? 0)
  if (free < size * 1.05) throw new DownloadError(`Not enough storage: needs ${formatBytes(size)}, ${formatBytes(free)} free`)
}

/** Streams the PDF into fixed-size chunks; memory stays at one chunk whatever the file size. */
async function storeChunks(cache: Cache, id: string, res: Response, onProgress: (loaded: number) => void) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const buffer = new Uint8Array(CHUNK_SIZE)
  let fill = 0
  let chunks = 0
  let loaded = 0
  const flush = async () => {
    await cache.put(dlChunkUrl(id, chunks), new Response(buffer.slice(0, fill)))
    chunks++
    fill = 0
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    let at = 0
    while (at < value.length) {
      const take = Math.min(value.length - at, CHUNK_SIZE - fill)
      buffer.set(value.subarray(at, at + take), fill)
      fill += take
      at += take
      loaded += take
      if (fill === CHUNK_SIZE) await flush()
    }
    onProgress(loaded)
  }
  if (fill > 0) await flush()
  return { chunks, size: loaded }
}

async function deleteBookEntries(cache: Cache, id: string) {
  const prefixes = [`/__shelf/dl/${id}/`, `/api/documents/${id}`]
  const keys = await cache.keys()
  await Promise.all(keys
    .filter((k) => prefixes.some((p) => new URL(k.url).pathname.startsWith(p)))
    .map((k) => cache.delete(k)))
}

async function putResponse(cache: Cache, url: string, signal: AbortSignal, optional = false) {
  const res = await fetch(url, { signal, credentials: 'same-origin' })
  if (res.ok) await cache.put(url, res)
  else if (!optional) throw new DownloadError(`Download failed (${res.status})`)
}

export const useDownloads = create<DownloadStore>((set, get) => ({
  books: {},
  active: {},

  refresh: async () => {
    if (!offlineSupported) return
    const cache = await activeCache()
    const keys = await cache.keys()
    const metaIds = new Set(keys.flatMap((k) => DL_META_RE.exec(new URL(k.url).pathname)?.[1] ?? []))
    const books: Record<string, DownloadedBook> = {}
    for (const id of metaIds) {
      const res = await cache.match(dlMetaUrl(id))
      if (res) books[id] = await res.json() as DownloadedBook
    }
    // A killed tab can leave chunks behind without a meta entry.
    const stale = keys.filter((k) => {
      const id = DL_CHUNK_RE.exec(new URL(k.url).pathname)?.[1]
      return id && !metaIds.has(id) && !get().active[id]
    })
    await Promise.all(stale.map((k) => cache.delete(k)))
    set({ books })
  },

  download: async (doc) => {
    if (!offlineSupported) throw new DownloadError('Offline storage needs a secure (https) connection')
    if (get().active[doc.id] || get().books[doc.id]) return
    const abort = new AbortController()
    const update = (loaded: number) => set((s) => ({ active: { ...s.active, [doc.id]: { loaded, total: doc.size, abort } } }))
    update(0)
    const cache = await activeCache()
    try {
      await checkQuota(doc.size)
      void navigator.storage?.persist?.()
      const res = await fetch(fileUrl(doc.id), { signal: abort.signal, credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok || !res.body) throw new DownloadError(`Download failed (${res.status})`)
      const { chunks, size } = await storeChunks(cache, doc.id, res, update)
      await putResponse(cache, `/api/documents/${doc.id}`, abort.signal)
      if (doc.has_text) await putResponse(cache, `/api/documents/${doc.id}/text`, abort.signal, true)
      if (doc.cover_version) await putResponse(cache, coverUrl(doc), abort.signal, true)
      const detail = await (await cache.match(`/api/documents/${doc.id}`))?.json() as DocDetail
      const { page_sizes: _sizes, outline: _outline, bookmarks: _bookmarks, ...summary } = detail
      const meta: DownloadedBook = {
        id: doc.id, size, chunks, chunkSize: CHUNK_SIZE, downloadedAt: Date.now(),
        etag: res.headers.get('ETag'),
        contentType: res.headers.get('Content-Type') ?? 'application/pdf',
        doc: summary,
      }
      await cache.put(dlMetaUrl(doc.id), new Response(JSON.stringify(meta)))
      set((s) => ({ books: { ...s.books, [doc.id]: meta } }))
      postToWorker({ type: 'DOWNLOADS_CHANGED' })
    } catch (err) {
      await deleteBookEntries(cache, doc.id).catch(() => undefined)
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (err instanceof DOMException && err.name === 'QuotaExceededError') throw new DownloadError('Storage is full')
      throw err
    } finally {
      set((s) => {
        const { [doc.id]: _done, ...active } = s.active
        return { active }
      })
    }
  },

  cancel: (id) => get().active[id]?.abort.abort(),

  remove: async (id) => {
    if (!offlineSupported) return
    await deleteBookEntries(await activeCache(), id)
    set((s) => {
      const { [id]: _gone, ...books } = s.books
      return { books }
    })
    postToWorker({ type: 'DOWNLOADS_CHANGED' })
  },

  clear: async () => {
    if (!offlineSupported) return
    await caches.delete(dlCacheName(currentScope()))
    set({ books: {} })
    postToWorker({ type: 'DOWNLOADS_CHANGED' })
  },
}))

/** Library fallback when even the worker's cached copy is missing. */
export function downloadedDocs(): Doc[] {
  return Object.values(useDownloads.getState().books).map((b) => b.doc)
}

export async function storageEstimate() {
  const estimate = await navigator.storage?.estimate?.()
  return estimate?.quota ? { used: estimate.usage ?? 0, quota: estimate.quota } : null
}
