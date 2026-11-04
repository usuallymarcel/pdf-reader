// Minimal stand-in for the backend: real Range support, in-memory state. Fixtures dir from FIXTURES env.
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const dir = process.env.FIXTURES
const port = Number(process.env.MOCK_PORT ?? 8123)
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))

const LOREM = `Rain had been falling on the harbour for three days when the letter finally arrived, carried up the hill by a boy who would not meet her eyes. She read it twice by the window, then folded it into the sleeve of her coat and went down to the kitchen, where the kettle had long since boiled dry. There was a kind of relief in it, she decided, the way there is relief in the first cold step into the sea.`

function reflow(pages) {
  const blocks = []
  for (let page = 1; page <= pages; page++) {
    if ((page - 1) % 8 === 0) blocks.push({ t: 'h', text: `Chapter ${(page - 1) / 8 + 1}`, page })
    if (page === 6) { blocks.push({ t: 'img', page }); continue }
    for (let i = 0; i < 7; i++) blocks.push({ t: 'p', text: `[p${page}.${i}] ${LOREM} ${LOREM}`, page })
  }
  return { version: 1, blocks }
}

const NOW = '2026-11-04T10:00:00Z'
const docBase = (id, patch) => ({
  id, title: id, series: null, volume: null, author: null, kind: 'manga', direction: null, suggested_mode: 'paged',
  filename: `${id}.pdf`, size: meta[id].size, page_count: meta[id].sizes.length, has_text: false, status: 'ready', error: null,
  cover_version: '1', shared: true, editable: true, created_at: NOW, updated_at: NOW,
  page_sizes: meta[id].sizes, bookmarks: [],
  outline: [],
  state: { page: 1, offset: 0, max_page: 1, finished: false, favorite: false, seconds_read: 0, overrides: {}, last_read_at: null, client_ts: 0 },
  ...patch,
})

let docs
let log
let stats
function reset() {
  docs = {
    manga: docBase('manga', { title: 'Test Manga v01', series: 'Test Manga', volume: 1, outline: [{ title: 'Chapter 1', page: 2, level: 1 }, { title: 'Chapter 2', page: 12, level: 1 }] }),
    manga2: docBase('manga2', { title: 'Test Manga v02', series: 'Test Manga', volume: 2 }),
    webtoon: docBase('webtoon', { title: 'Long Strip', suggested_mode: 'scroll' }),
    big: docBase('big', { title: 'Huge Scan' }),
    novel: docBase('novel', { title: 'A Novel', kind: 'novel', has_text: true, suggested_mode: 'reflow', outline: [{ title: 'Chapter 1', page: 1, level: 1 }, { title: 'Chapter 2', page: 9, level: 1 }] }),
  }
  log = []
  stats = { rangeBytes: {}, requests: {}, fullGets: {} }
}
reset()

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}
const body = (req) => new Promise((resolve) => {
  let s = ''
  req.on('data', (c) => { s += c })
  req.on('end', () => resolve(s ? JSON.parse(s) : {}))
})

function file(req, res, id) {
  const path = join(dir, `${id}.pdf`)
  const size = statSync(path).size
  stats.requests[id] = (stats.requests[id] ?? 0) + 1
  const headers = { 'Content-Type': 'application/pdf', 'Accept-Ranges': 'bytes', ETag: `"${id}"` }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
  const count = (stream) => stream.on('data', (c) => { stats.rangeBytes[id] = (stats.rangeBytes[id] ?? 0) + c.length })
  if (m) {
    const start = Number(m[1])
    const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1)
    if (process.env.MOCK_TRACE) console.log(id, start, end - start + 1)
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    count(createReadStream(path, { start, end })).pipe(res)
  } else {
    stats.fullGets[id] = (stats.fullGets[id] ?? 0) + 1
    res.writeHead(200, { ...headers, 'Content-Length': size })
    // pdf.js aborts this as soon as it sees Accept-Ranges; the dev proxy may drain it anyway, so it is not counted.
    const s = createReadStream(path)
    s.pipe(res)
    res.on('close', () => s.destroy())
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  let m
  if (path === '/__reset') { reset(); return send(res, 200, {}) }
  if (path === '/__stats') return send(res, 200, { ...stats, log })
  if (path === '/__set' && req.method === 'POST') {
    const { id, state } = await body(req)
    Object.assign(docs[id].state, state)
    return send(res, 200, {})
  }
  if (path === '/api/session') return send(res, 200, { mode: 'global', auth_status: 'disabled', user: null, allow_signup: true, max_upload_mb: 2048 })
  if (path === '/api/library') return send(res, 200, Object.values(docs))
  if (path === '/api/preferences') return send(res, 200, { data: null, updated_at: null })
  if (path === '/api/search') {
    const q = url.searchParams.get('q')
    return send(res, 200, [3, 9].map((page) => ({ document_id: url.searchParams.get('doc'), title: 'x', page, snippet: `before &amp; <mark>${q}</mark> after` })))
  }
  if ((m = /^\/api\/bookmarks\/(\d+)$/.exec(path))) return send(res, 204)
  if (!(m = /^\/api\/documents\/([^/]+)(?:\/(.+))?$/.exec(path))) return send(res, 404, { error: 'nope' })
  const [, id, rest] = m
  const doc = docs[id]
  if (!doc) return send(res, 404, { error: 'no doc' })
  if (!rest) return send(res, 200, doc)
  if (rest === 'file') return file(req, res, id)
  if (rest === 'text') return doc.has_text ? send(res, 200, reflow(doc.page_count)) : send(res, 404, { error: 'no text' })
  if (rest === 'progress') {
    const u = await body(req)
    log.push({ id, ...u })
    Object.assign(doc.state, { page: u.page, offset: u.offset ?? 0, client_ts: u.client_ts, max_page: Math.max(doc.state.max_page, u.page) })
    return send(res, 200, doc.state)
  }
  if (rest === 'state') {
    Object.assign(doc.state, await body(req))
    return send(res, 200, doc.state)
  }
  if (rest === 'bookmarks') {
    const b = await body(req)
    const bookmark = { id: Date.now() % 100000, document_id: id, note: null, locator: null, created_at: NOW, ...b }
    doc.bookmarks.push(bookmark)
    return send(res, 200, bookmark)
  }
  return send(res, 404, { error: 'nope' })
}).listen(port, () => console.log(`mock api on ${port}`))
