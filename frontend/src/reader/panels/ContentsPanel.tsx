import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../../api/client'
import type { Bookmark, DocDetail, OutlineItem } from '../../api/types'
import { Segmented, Sheet } from '../../ui/primitives'
import { Thumb } from '../chrome/Thumb'
import type { PageRenderer } from '../pdf/renderer'
import { useReaderUi } from '../store'

type Tab = 'outline' | 'pages' | 'bookmarks'

const TILE_W = 104
const TILE_GAP = 10
const TILE_LABEL = 22

/** Virtualised thumbnail grid: only rows near the viewport exist, so 500 pages cost the same as 20. */
function PagesGrid({ doc, renderer, onJump }: { doc: DocDetail; renderer: PageRenderer; onJump: (page: number) => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const current = useReaderUi((s) => s.position.page)
  const [view, setView] = useState({ top: 0, width: 340, height: 500 })
  const aspect = useMemo(() => {
    const s = doc.page_sizes[Math.floor(doc.page_count / 2)] ?? [7, 10]
    return Math.min(2.2, s[1] / s[0])
  }, [doc.page_sizes, doc.page_count])
  const columns = Math.max(2, Math.floor((view.width + TILE_GAP) / (TILE_W + TILE_GAP)))
  const tileW = (view.width - (columns - 1) * TILE_GAP) / columns
  const rowH = tileW * aspect + TILE_LABEL + TILE_GAP
  const rows = Math.ceil(doc.page_count / columns)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => setView((v) => ({ ...v, width: el.clientWidth, height: el.clientHeight }))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const centred = useRef(false)
  useEffect(() => {
    const el = scroller.current
    if (!el || centred.current || view.width < 100) return
    centred.current = true
    el.scrollTop = Math.max(0, Math.floor((current - 1) / columns) * rowH - view.height / 2 + rowH / 2)
  }, [current, columns, rowH, view])

  const first = Math.max(0, Math.floor(view.top / rowH) - 1)
  const last = Math.min(rows - 1, Math.ceil((view.top + view.height) / rowH))
  const cells: number[] = []
  for (let r = first; r <= last; r++) {
    for (let c = 0; c < columns; c++) {
      const page = r * columns + c + 1
      if (page <= doc.page_count) cells.push(page)
    }
  }
  return (
    <div ref={scroller} className="pages-grid" onScroll={(e) => {
      const top = e.currentTarget.scrollTop
      setView((v) => ({ ...v, top }))
    }}>
      <div style={{ height: rows * rowH, position: 'relative' }}>
        {cells.map((page) => {
          const r = Math.floor((page - 1) / columns)
          const c = (page - 1) % columns
          return (
            <button key={page} type="button" className="page-tile" aria-label={`Page ${page}`} aria-current={page === current ? 'page' : undefined}
              style={{ width: tileW, top: r * rowH, left: c * (tileW + TILE_GAP) }} onClick={() => onJump(page)}>
              <span className="page-tile-img" style={{ height: tileW * aspect }}><Thumb renderer={renderer} page={page} /></span>
              <span>{page}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function ContentsPanel({ doc, chapters, renderer, bookmarks, onJump, onBookmark, onClose }: {
  doc: DocDetail
  /** Headings found in the text: stands in for a PDF without an outline of its own. */
  chapters: readonly OutlineItem[]
  renderer: PageRenderer | null
  bookmarks: readonly Bookmark[]
  onJump: (page: number) => void
  onBookmark: (b: Bookmark) => void
  onClose: () => void
}) {
  const outline = doc.outline.length ? doc.outline : chapters
  const [tab, setTab] = useState<Tab>(outline.length ? 'outline' : 'pages')
  const page = useReaderUi((s) => s.position.page)
  const [removed, setRemoved] = useState<number[]>([])
  const currentOutline = useMemo(() => {
    let index = -1
    outline.forEach((o, i) => { if (o.page <= page) index = i })
    return index
  }, [outline, page])
  const visible = bookmarks.filter((b) => !removed.includes(b.id))

  return (
    <Sheet title="Contents" onClose={onClose}>
      <div className="panel-tabs">
        <Segmented label="Contents view" value={tab} onChange={setTab}
          options={[{ value: 'outline', label: 'Outline' }, { value: 'pages', label: 'Pages' }, { value: 'bookmarks', label: 'Bookmarks' }]} />
      </div>
      {tab === 'outline' && (
        outline.length ? (
          <ol className="outline">
            {outline.map((o, i) => (
              <li key={`${o.page}-${i}`}>
                <button type="button" aria-current={i === currentOutline ? 'true' : undefined}
                  style={{ paddingLeft: 8 + Math.max(0, o.level - 1) * 16 }} onClick={() => onJump(o.page)}>
                  <span>{o.title}</span><span className="outline-page">{o.page}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : <p className="panel-empty">This book has no outline.</p>
      )}
      {tab === 'pages' && renderer && <PagesGrid doc={doc} renderer={renderer} onJump={onJump} />}
      {tab === 'bookmarks' && (
        visible.length ? (
          <ul className="outline">
            {[...visible].sort((a, b) => a.page - b.page).map((b) => (
              <li key={b.id} className="bookmark-row">
                <button type="button" onClick={() => onBookmark(b)}>
                  <span>{b.note || `Page ${b.page}`}</span><span className="outline-page">{b.page}</span>
                </button>
                <button type="button" className="icon-btn" aria-label={`Remove bookmark on page ${b.page}`}
                  onClick={() => { setRemoved((r) => [...r, b.id]); api.deleteBookmark(b.id).catch(() => undefined) }}>
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="panel-empty">No bookmarks yet. Press the bookmark button while reading.</p>
      )}
    </Sheet>
  )
}
