// Fictional seed library. Covers are SVG art so screenshots show a believable, colourful shelf.
const MB = 1024 * 1024
export const FILE_SIZE = 9 * MB + 12345 // spans several 4 MiB chunks

export const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString()

const baseState = { page: 1, offset: 0, max_page: 1, finished: false, favorite: false, seconds_read: 0, overrides: {}, last_read_at: null, client_ts: 0 }

function doc(id, title, extra = {}) {
  const { state, ...rest } = extra
  return {
    id, title, series: null, volume: null, author: null, kind: 'manga', direction: null, suggested_mode: 'paged',
    filename: `${title}.pdf`, size: FILE_SIZE, page_count: 200, has_text: false, status: 'ready', error: null, cover_version: '1',
    shared: true, editable: true, created_at: daysAgo(40), updated_at: daysAgo(40), owner: null,
    state: { ...baseState, ...state }, ...rest,
  }
}

const volume = (prefix, series, n, extra = {}) => doc(`${prefix}${n}`, `${series} Vol. ${n}`, { series, volume: n, author: 'Haru Mizuno', ...extra })
const read = (n, page) => ({ state: { page, max_page: page, seconds_read: 900, last_read_at: daysAgo(n), client_ts: 1 } })
const done = { state: { page: 200, max_page: 200, finished: true, seconds_read: 4000, last_read_at: daysAgo(20), client_ts: 1 } }

/** A small genuine PDF so the real reader can open a book. */
export function realPdf(pages = 3) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>']
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`)
  for (let i = 0; i < pages; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Contents ${4 + i * 2} 0 R >>`)
    const stream = `0.2 0.4 0.7 rg 40 ${60 + i * 80} 320 300 re f`
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  let body = '%PDF-1.4\n'
  const offsets = objects.map((obj, i) => {
    const at = body.length
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
    return at
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const at of offsets) body += `${String(at).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

export function seedDocs(count = 0) {
  const docs = [
    volume('tide', 'Tidewater', 1, done),
    volume('tide', 'Tidewater', 2, done),
    volume('tide', 'Tidewater', 3, read(0.1, 84)),
    volume('tide', 'Tidewater', 4),
    volume('tide', 'Tidewater', 10),
    volume('ash', 'Ashen Crown', 1, read(2, 150)),
    volume('ash', 'Ashen Crown', 2),
    volume('ash', 'Ashen Crown', 3),
    doc('novel1', 'The Lantern Keeper of Nine Rivers', { kind: 'novel', suggested_mode: 'reflow', has_text: true, author: 'Sora Inoue', page_count: 342, ...read(1, 121) }),
    doc('novel2', 'A Quiet Year in Salt Harbor', { kind: 'novel', suggested_mode: 'reflow', has_text: true, author: 'Mei Tanaka', page_count: 288, state: { favorite: true } }),
    doc('novel3', 'Letters to the Winter Station', { kind: 'novel', has_text: true, author: 'Ren Aoki', page_count: 310, ...done }),
    doc('one1', 'Paper Moon Courier', { author: 'Yuki Sato', ...read(4, 32) }),
    doc('one2', 'Iron Garden', { author: 'Kaito Mori' }),
    doc('one3', 'Glass Sparrow', { author: 'Nao Fujita', state: { favorite: true } }),
    doc('one4', 'Midnight Atlas', { author: 'Aya Kondo', ...done }),
    doc('proc1', 'Northbound Vol. 1', { status: 'processing', cover_version: null, page_count: 0, created_at: daysAgo(0) }),
    doc('fail1', 'Corrupted Scan', { status: 'failed', error: 'The file is encrypted or damaged.', cover_version: null, page_count: 0 }),
    doc('private1', 'Private Sketchbook', { owner: 1, shared: false }),
    doc('real1', 'Real Sample', { page_count: 3, direction: 'ltr', size: realPdf().length, real: true, created_at: daysAgo(90) }),
  ]
  for (let i = 0; i < count; i++) docs.push(doc(`bulk${i}`, `Generated Book ${i}`))
  return docs
}

const hash = (s) => [...s].reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 5381)
const PALETTES = [
  ['#0f2b46', '#2f7f9f', '#f2d8a7'], ['#3b1224', '#c2384e', '#f4c8a8'], ['#14352e', '#3fa37e', '#ecdfa5'],
  ['#2a1b4a', '#7a5bd0', '#f0b7c8'], ['#3a2612', '#d08a3c', '#f6e2bf'], ['#10131c', '#5c6f9e', '#e8e4d8'],
  ['#42170f', '#e2622e', '#f9d27a'], ['#16303a', '#e0705a', '#f4ead5'],
]
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

export function coverSvg(d) {
  const h = hash(d.series ?? d.title)
  const [bg, mid, ink] = PALETTES[h % PALETTES.length]
  const cx = 80 + (h >> 3) % 240
  const cy = 170 + (h >> 7) % 240
  const r = 90 + (h >> 11) % 90
  const title = escape(d.series ?? d.title).split(' ')
  const lines = title.reduce((all, w) => {
    const last = all.at(-1)
    if (last !== undefined && (last + w).length < 13) all[all.length - 1] = `${last} ${w}`
    else all.push(w)
    return all
  }, [])
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600">
<rect width="400" height="600" fill="${bg}"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="${mid}"/>
<path d="M0 ${430 + (h >> 5) % 60} L${120 + (h >> 9) % 160} ${360 + (h >> 13) % 70} L400 ${450 + (h >> 4) % 60} V600 H0Z" fill="${ink}" opacity=".16"/>
<path d="M0 ${500 + (h >> 6) % 40} Q200 ${440 + (h >> 10) % 60} 400 ${510 + (h >> 8) % 40} V600 H0Z" fill="${bg}"/>
<g font-family="Georgia,serif" font-size="46" font-weight="700" fill="${ink}">${lines.map((l, i) => `<text x="28" y="${70 + i * 52}">${l}</text>`).join('')}</g>
${d.volume !== null ? `<text x="372" y="572" text-anchor="end" font-family="Georgia,serif" font-size="30" fill="${ink}">${d.volume}</text>` : ''}
</svg>`
}
