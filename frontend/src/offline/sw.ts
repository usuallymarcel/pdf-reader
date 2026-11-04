/// <reference lib="webworker" />
import { cleanupOutdatedCaches, getCacheKeyForURL, matchPrecache, precache } from 'workbox-precaching'
import {
  DL_META_RE, META_CACHE, META_SCOPE_URL, PDFJS_CACHE, apiCacheName, coverCacheName, dlCacheName,
  dlChunkUrl, dlMetaUrl, type DownloadMeta, type Scope, type SwInbound,
} from './paths'
import { chunkSlices, parseRange } from './range'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] }

const NETWORK_TIMEOUT_MS = 3000
const MAX_COVERS = 600
const DOC_RE = /^\/api\/documents\/([^/]+)(?:\/(file|cover|text))?$/

precache(self.__WB_MANIFEST)
cleanupOutdatedCaches()

/* A new worker stays waiting until the user accepts the update toast. */
self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([self.clients.claim(), scopeReady().then(loadDownloaded)]))
})

/* ---- scope: survives worker restarts through a small meta cache ---- */

let scope: Scope | null = null

async function scopeReady(): Promise<Scope> {
  if (scope) return scope
  const saved = await (await caches.open(META_CACHE)).match(META_SCOPE_URL)
  scope = saved ? (await saved.text()) as Scope : 'anon'
  return scope
}

async function setScope(next: Scope) {
  scope = next
  downloaded = null
  await (await caches.open(META_CACHE)).put(META_SCOPE_URL, new Response(next))
  await loadDownloaded()
}

/* ---- downloaded books: knowing the ids lets every other /file request bypass the worker ---- */

let downloaded: Set<string> | null = null

async function loadDownloaded(): Promise<Set<string>> {
  const cache = await caches.open(dlCacheName(await scopeReady()))
  const ids = new Set<string>()
  for (const req of await cache.keys()) {
    const id = DL_META_RE.exec(new URL(req.url).pathname)?.[1]
    if (id) ids.add(id)
  }
  downloaded = ids
  return ids
}

async function downloadMeta(id: string): Promise<DownloadMeta | null> {
  const cache = await caches.open(dlCacheName(await scopeReady()))
  const res = await cache.match(dlMetaUrl(id))
  return res ? await res.json() as DownloadMeta : null
}

/** Touches only the chunks the range needs, so memory stays bounded for any file size. */
async function readRange(id: string, meta: DownloadMeta, start: number, end: number): Promise<Blob> {
  const cache = await caches.open(dlCacheName(await scopeReady()))
  const parts: Blob[] = []
  for (const { index, from, to } of chunkSlices({ start, end }, meta.chunkSize)) {
    const chunk = await cache.match(dlChunkUrl(id, index))
    if (!chunk) throw new Error(`missing chunk ${index} of ${id}`)
    parts.push((await chunk.blob()).slice(from, to))
  }
  return new Blob(parts, { type: meta.contentType })
}

function wholeFileStream(id: string, meta: DownloadMeta): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    async pull(controller) {
      if (index >= meta.chunks) { controller.close(); return }
      const start = index * meta.chunkSize
      const blob = await readRange(id, meta, start, Math.min(start + meta.chunkSize, meta.size) - 1)
      index++
      controller.enqueue(new Uint8Array(await blob.arrayBuffer()))
    },
  })
}

async function fileFromDownload(request: Request, id: string, meta: DownloadMeta): Promise<Response> {
  const range = parseRange(request.headers.get('Range'), meta.size)
  const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Content-Type': meta.contentType })
  if (meta.etag) headers.set('ETag', meta.etag)
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${meta.size}`)
    return new Response(null, { status: 416, headers })
  }
  if (!range) {
    headers.set('Content-Length', String(meta.size))
    return new Response(wholeFileStream(id, meta), { status: 200, headers })
  }
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${meta.size}`)
  headers.set('Content-Length', String(range.end - range.start + 1))
  return new Response(await readRange(id, meta, range.start, range.end), { status: 206, headers })
}

/** Only reached when a freshly woken worker does not know the ids yet: fetch() streams, it never buffers. */
async function fileOrNetwork(request: Request, id: string): Promise<Response> {
  const ids = downloaded ?? await loadDownloaded()
  const meta = ids.has(id) ? await downloadMeta(id) : null
  return meta ? fileFromDownload(request, id, meta) : fetch(request)
}

async function textOrNetwork(request: Request, id: string): Promise<Response> {
  const ids = downloaded ?? await loadDownloaded()
  if (ids.has(id)) {
    const cache = await caches.open(dlCacheName(await scopeReady()))
    const hit = await cache.match(new URL(request.url).pathname)
    if (hit) return hit
  }
  return fetch(request)
}

/* ---- runtime strategies ---- */

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res.ok) await cache.put(request, res.clone())
  return res
}

async function trimCovers(cache: Cache) {
  const keys = await cache.keys()
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_COVERS)).map((k) => cache.delete(k)))
}

async function cover(request: Request, id: string): Promise<Response> {
  const active = await scopeReady()
  if (active === 'anon') return fetch(request)
  const cache = await caches.open(coverCacheName(active))
  const hit = await cache.match(request)
  if (hit) return hit
  try {
    const res = await fetch(request)
    if (res.ok) {
      await cache.put(request, res.clone())
      void trimCovers(cache)
    }
    return res
  } catch (err) {
    // An older version of the cover beats none at all when offline; downloaded books always have one.
    const dl = await caches.open(dlCacheName(active))
    const fallback = await cache.match(request, { ignoreSearch: true })
      ?? await dl.match(`/api/documents/${id}/cover`, { ignoreSearch: true })
    if (fallback) return fallback
    throw err
  }
}

async function networkFirst(request: Request, event: FetchEvent, documentId?: string): Promise<Response> {
  const active = await scopeReady()
  if (active === 'anon') return fetch(request)
  const cache = await caches.open(apiCacheName(active))
  const network = fetch(request).then(async (res) => {
    if (res.ok) await cache.put(request, res.clone())
    return res
  })
  event.waitUntil(network.then(() => undefined, () => undefined))

  const fallback = async () => {
    const hit = await cache.match(request)
    if (hit || !documentId) return hit
    return (await caches.open(dlCacheName(active))).match(`/api/documents/${documentId}`)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), NETWORK_TIMEOUT_MS) })
  try {
    const first = await Promise.race([network, timedOut])
    if (first !== 'timeout') return first
    return await fallback() ?? await network
  } catch (err) {
    const hit = await fallback()
    if (hit) return hit
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/* ---- routing ---- */

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  const path = url.pathname

  if (request.mode === 'navigate') {
    if (path.startsWith('/api/')) return
    event.respondWith(matchPrecache('/index.html').then((res) => res ?? fetch(request)))
    return
  }
  if (getCacheKeyForURL(url.href)) {
    event.respondWith(matchPrecache(url.href).then((res) => res ?? fetch(request)))
    return
  }
  if (path.startsWith('/pdfjs/')) {
    event.respondWith(cacheFirst(request, PDFJS_CACHE))
    return
  }
  if (path === '/api/library' || path === '/api/session') {
    event.respondWith(networkFirst(request, event))
    return
  }
  const doc = DOC_RE.exec(path)
  if (!doc) return
  const id = doc[1] as string
  const part = doc[2]
  if (!part) event.respondWith(networkFirst(request, event, id))
  else if (part === 'cover') event.respondWith(cover(request, id))
  else {
    // Known not to be downloaded: leave the request to the browser. ?download=1 is always the network's.
    if (url.searchParams.has('download') || (downloaded && !downloaded.has(id))) return
    event.respondWith(part === 'file' ? fileOrNetwork(request, id) : textOrNetwork(request, id))
  }
})

self.addEventListener('message', (event) => {
  const message = event.data as SwInbound
  if (message.type === 'SKIP_WAITING') void self.skipWaiting()
  else if (message.type === 'SCOPE') event.waitUntil(setScope(message.scope))
  else if (message.type === 'DOWNLOADS_CHANGED') event.waitUntil(loadDownloaded())
})
