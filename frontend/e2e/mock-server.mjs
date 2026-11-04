// Mock of the Shelf backend that also serves dist/ with the production CSP, so the real service worker
// runs against it. Run: node e2e/mock-server.mjs  (PORT, default 4173).
// Control from tests: POST /__mock/reset {mode, library}, /__mock/set {...}; GET /__mock/log.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { coverSvg, daysAgo, realPdf, seedDocs } from './mock-data.mjs'

const PORT = Number(process.env.PORT ?? 4173)
const DIST = resolve(process.env.DIST ?? resolve(import.meta.dirname, '../dist'))
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; manifest-src 'self'"
const USERS = { alice: { id: 1, name: 'alice' }, bob: { id: 2, name: 'bob' } }
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.json': 'application/json',
}

const fresh = (overrides = {}) => ({
  mode: 'global', authStatus: 'disabled', allowSignup: true, maxUploadMb: 50, failLibrary: false,
  docs: seedDocs(), log: [], prefs: {}, delayMs: 0, ...overrides,
})
let state = fresh()

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

const readJson = (req) => new Promise((done) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    try { done(JSON.parse(Buffer.concat(chunks).toString() || '{}')) } catch { done({}) }
  })
})

function currentUser(req) {
  if (state.mode !== 'scoped') return null
  const name = /mock_session=(\w+)/.exec(req.headers.cookie ?? '')?.[1]
  return USERS[name] ?? null
}

const session = (req) => ({
  mode: state.mode, auth_status: state.authStatus, user: currentUser(req),
  allow_signup: state.allowSignup, max_upload_mb: state.maxUploadMb,
})

const visible = (user) => state.docs.filter((d) => state.mode === 'global' || d.owner === null || d.owner === user?.id)
const publicDoc = ({ owner: _owner, real: _real, ...doc }) => doc
const detail = (doc) => ({
  ...publicDoc(doc),
  page_sizes: Array.from({ length: doc.page_count }, () => [612, 792]), outline: [], bookmarks: [],
})
const realBytes = realPdf()
const byteAt = (i) => (i * 31 + (i >> 8)) & 255

function serveFile(req, res, doc, download) {
  const size = doc.size
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/pdf', ETag: `"${doc.id}"`, 'Cache-Control': 'private, max-age=31536000, immutable' }
  if (download) headers['Content-Disposition'] = `attachment; filename="${doc.filename}"`
  let start = 0
  let end = size - 1
  let status = 200
  if (range) {
    if (range[1] === '') { start = Math.max(0, size - Number(range[2])) } else {
      start = Number(range[1])
      if (range[2] !== '') end = Math.min(Number(range[2]), size - 1)
    }
    status = 206
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  }
  headers['Content-Length'] = String(end - start + 1)
  res.writeHead(status, headers)
  let at = start
  const pump = () => {
    while (at <= end) {
      const n = Math.min(64 * 1024, end + 1 - at)
      const chunk = Buffer.alloc(n)
      for (let i = 0; i < n; i++) chunk[i] = doc.real ? realBytes[at + i] : byteAt(at + i)
      at += n
      if (!res.write(chunk)) { res.once('drain', pump); return }
    }
    res.end()
  }
  pump()
}

function upload(req, res, user) {
  const chunks = []
  let total = 0
  req.on('data', (c) => { total += c.length; if (chunks.length < 1) chunks.push(c) })
  req.on('end', () => {
    const head = chunks[0]?.toString('latin1') ?? ''
    const filename = /filename="([^"]+)"/.exec(head)?.[1] ?? 'file.pdf'
    if (/broken/.test(filename)) { send(res, 415, { error: 'Not a PDF' }); return }
    const duplicate = /dup/.test(filename)
    const existing = duplicate ? state.docs[0] : null
    if (existing) { send(res, 200, { document: publicDoc(existing), duplicate: true }); return }
    const id = `up${Date.now()}${Math.floor(Math.random() * 1000)}`
    const now = new Date().toISOString()
    const doc = {
      ...seedDocs()[0], id, title: filename.replace(/\.pdf$/i, ''), series: null, volume: null, author: null, filename, size: total,
      status: 'processing', cover_version: null, created_at: now, updated_at: now, owner: user?.id ?? null,
      state: { page: 1, offset: 0, max_page: 1, finished: false, favorite: false, seconds_read: 0, overrides: {}, last_read_at: null, client_ts: 0 },
    }
    state.docs.unshift(doc)
    setTimeout(() => { doc.status = 'ready'; doc.cover_version = '1' }, 2500)
    send(res, 201, { document: publicDoc(doc), duplicate: false })
  })
}

const stats = () => ({
  documents: state.docs.length, finished: 6, pages_read: 4218, seconds_read: 183400, streak_days: 9,
  daily_seconds: Array.from({ length: 30 }, (_, i) => ({
    date: daysAgo(29 - i).slice(0, 10),
    seconds: [0, 1200, 3400, 0, 0, 800, 5200, 2600, 900, 0, 0, 4100, 6200, 1800, 0, 700, 2500, 3900, 0, 1500, 4800, 7200, 2200, 1000, 3000, 600, 2800, 3600, 5100, 1900][i],
  })),
})

async function api(req, res, url) {
  const path = url.pathname
  const method = req.method
  state.log.push({ method, path: path + url.search, range: req.headers.range ?? null })
  if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs))
  const user = currentUser(req)

  if (path === '/api/session') return send(res, 200, session(req))
  if (path === '/api/auth/login' || path === '/api/auth/signup') {
    const body = await readJson(req)
    if (state.mode === 'global') return send(res, 503, { error: 'Accounts are unavailable' })
    if (body.password === 'wrong') return send(res, 401, { error: 'Invalid credentials' })
    const next = USERS[body.name]
    if (!next) return send(res, 401, { error: 'Invalid credentials' })
    res.setHeader('Set-Cookie', `mock_session=${body.name}; Path=/; HttpOnly; SameSite=Lax`)
    return send(res, 200, { ...session(req), user: next })
  }
  if (path === '/api/auth/logout') {
    res.setHeader('Set-Cookie', 'mock_session=; Path=/; Max-Age=0')
    return send(res, 200, { ...session(req), user: null })
  }
  if (state.mode === 'scoped' && !user) return send(res, 401, { error: 'Sign in required' })

  if (path === '/api/library') {
    if (state.failLibrary) return send(res, 500, { error: 'boom' })
    return send(res, 200, visible(user).map(publicDoc))
  }
  if (path === '/api/stats') return send(res, 200, stats())
  if (path === '/api/preferences') {
    const key = user?.id ?? 0
    if (method === 'PUT') state.prefs[key] = (await readJson(req)).data
    return send(res, 200, { data: state.prefs[key] ?? null, updated_at: null })
  }
  if (path === '/api/search') {
    const q = url.searchParams.get('q') ?? ''
    const hits = visible(user).filter((d) => d.status === 'ready').slice(0, 3).map((d, i) => ({
      document_id: d.id, title: d.title, page: 12 + i * 31,
      snippet: `the road &lt;north&gt; ran on, and <mark>${q}</mark> waited at the gate &amp; said nothing`,
    }))
    return send(res, 200, hits)
  }
  if (path === '/api/documents' && method === 'POST') return upload(req, res, user)
  if (path === '/api/documents/bulk-update' && method === 'POST') {
    const { ids, changes } = await readJson(req)
    const docs = visible(user).filter((d) => ids.includes(d.id))
    if (docs.length !== ids.length) return send(res, 404, { error: 'Document not found.' })
    for (const d of docs) Object.assign(d, changes)
    return send(res, 200, docs.map(publicDoc))
  }
  if (path === '/api/collections') {
    state.collections ??= []
    if (method === 'GET') return send(res, 200, [...state.collections].sort((a, b) => a.name.localeCompare(b.name)))
    const { name } = await readJson(req)
    if (state.collections.some((c) => c.name === name)) return send(res, 409, { error: 'You already have a collection with that name.' })
    const made = { id: (state.nextCollection = (state.nextCollection ?? 0) + 1), name }
    state.collections.push(made)
    return send(res, 201, made)
  }
  const collection = /^\/api\/collections\/(\d+)(\/items)?$/.exec(path)
  if (collection) {
    const id = Number(collection[1])
    const found = (state.collections ?? []).find((c) => c.id === id)
    if (!found) return send(res, 404, { error: 'Collection not found.' })
    if (collection[2]) {
      const { add = [], remove = [] } = await readJson(req)
      for (const d of state.docs) {
        d.collections = (d.collections ?? []).filter((c) => c !== id || !remove.includes(d.id))
        if (add.includes(d.id) && !d.collections.includes(id)) d.collections.push(id)
      }
      return send(res, 204)
    }
    if (method === 'PATCH') { found.name = (await readJson(req)).name; return send(res, 200, found) }
    state.collections = state.collections.filter((c) => c !== found)
    for (const d of state.docs) d.collections = (d.collections ?? []).filter((c) => c !== id)
    return send(res, 204)
  }

  const match = /^\/api\/documents\/([^/]+)(?:\/(\w+))?$/.exec(path)
  const bookmark = /^\/api\/bookmarks\/\d+$/.test(path)
  if (bookmark) return send(res, 204)
  if (!match) return send(res, 404, { error: 'Not found' })
  const doc = visible(user).find((d) => d.id === match[1])
  if (!doc) return send(res, 404, { error: 'Not found' })
  const part = match[2]
  if (!part && method === 'GET') return send(res, 200, detail(doc))
  if (!part && method === 'PATCH') { Object.assign(doc, await readJson(req)); return send(res, 200, publicDoc(doc)) }
  if (!part && method === 'DELETE') { state.docs = state.docs.filter((d) => d !== doc); return send(res, 204) }
  if (part === 'reprocess') { doc.status = 'processing'; doc.error = null; setTimeout(() => { doc.status = 'ready' }, 2500); return send(res, 200, publicDoc(doc)) }
  if (part === 'file') return serveFile(req, res, doc, url.searchParams.has('download'))
  if (part === 'cover') {
    if (!doc.cover_version) return send(res, 404, { error: 'No cover' })
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=31536000, immutable' })
    return res.end(coverSvg(doc))
  }
  if (part === 'text') return doc.has_text ? send(res, 200, { version: 1, blocks: [{ t: 'p', text: `Text of ${doc.title}`, page: 1 }] }) : send(res, 404, { error: 'No text' })
  if (part === 'state') {
    const patch = await readJson(req)
    const { reset_progress: reset, ...rest } = patch
    Object.assign(doc.state, rest, reset ? { page: 1, max_page: 1, finished: false } : {})
    return send(res, 200, doc.state)
  }
  if (part === 'progress') {
    const update = await readJson(req)
    state.progress = [...(state.progress ?? []), { id: doc.id, ...update }]
    Object.assign(doc.state, { page: update.page, last_read_at: new Date().toISOString(), client_ts: update.client_ts })
    return send(res, 200, doc.state)
  }
  return send(res, 404, { error: 'Not found' })
}

function serveStatic(res, pathname) {
  const candidate = join(DIST, decodeURIComponent(pathname))
  const isFile = candidate.startsWith(DIST) && existsSync(candidate) && statSync(candidate).isFile()
  const file = isFile ? candidate : join(DIST, 'index.html')
  if (!existsSync(file)) { res.writeHead(503); res.end('dist/ not built'); return }
  const ext = extname(file)
  const immutable = pathname.startsWith('/assets/')
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Content-Security-Policy': CSP,
  })
  createReadStream(file).pipe(res)
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.pathname === '/__mock/reset') {
    const body = await readJson(req)
    const { library, ...rest } = body
    state = fresh({ ...rest, docs: library === 'empty' ? [] : library === 'big' ? seedDocs(400) : seedDocs() })
    return send(res, 200, { ok: true })
  }
  if (url.pathname === '/__mock/set') { Object.assign(state, await readJson(req)); return send(res, 200, { ok: true }) }
  if (url.pathname === '/__mock/log') return send(res, 200, { log: state.log, progress: state.progress ?? [] })
  if (url.pathname.startsWith('/api/')) return void api(req, res, url).catch((err) => send(res, 500, { error: String(err) }))
  return serveStatic(res, url.pathname)
}).listen(PORT, () => console.log(`mock on http://localhost:${PORT}`))
