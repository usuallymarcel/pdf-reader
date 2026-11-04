import { useEffect, useRef } from 'react'
import {
  AlignJustify, ArrowLeft, Bookmark as BookmarkIcon, BookOpen, List, Maximize, Minimize, Rows3, Search, Settings2, Type,
} from 'lucide-react'
import type { Bookmark, DocDetail } from '../../api/types'
import type { ProgressIndicator } from '../../settings/schema'
import { fullscreenAvailable, toggleFullscreen, useIsFullscreen } from '../hooks/device'
import type { ReaderView } from '../look'
import type { PageRenderer } from '../pdf/renderer'
import { useReaderUi, type Panel } from '../store'
import { Scrubber } from './Scrubber'

const EDGE_PX = 72
const IDLE_MS = 2500

const titleWithVolume = (d: DocDetail) =>
  d.series && d.volume !== null ? `${d.series}, Vol. ${d.volume}` : d.title

export function TopBar({ doc, bookmarks, onBack, onBookmark, onPanel }: {
  doc: DocDetail
  bookmarks: readonly Bookmark[]
  onBack: () => void
  onBookmark: () => void
  onPanel: (p: Panel) => void
}) {
  const open = useReaderUi((s) => s.chrome)
  const page = useReaderUi((s) => s.position.page)
  const marked = bookmarks.some((b) => b.page === page)
  return (
    <header className="reader-bar reader-top" data-open={open} inert={!open}>
      <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}><ArrowLeft size={22} /></button>
      <h1 className="reader-title" title={doc.title}>{titleWithVolume(doc)}</h1>
      <button type="button" className="icon-btn" aria-label={marked ? 'Remove bookmark' : 'Add bookmark'} aria-pressed={marked} onClick={onBookmark}>
        <BookmarkIcon size={21} fill={marked ? 'currentColor' : 'none'} />
      </button>
      <button type="button" className="icon-btn" aria-label="Contents" onClick={() => onPanel('contents')}><List size={22} /></button>
      <button type="button" className="icon-btn" aria-label="Search" onClick={() => onPanel('search')}><Search size={21} /></button>
      <button type="button" className="icon-btn" aria-label="Settings" onClick={() => onPanel('settings')}><Settings2 size={21} /></button>
    </header>
  )
}

const VIEW_ICON = { paged: BookOpen, scroll: Rows3, 'text-paged': Type, 'text-scroll': AlignJustify } as const
const VIEW_LABEL = { paged: 'Paged', scroll: 'Continuous', 'text-paged': 'Text', 'text-scroll': 'Text, continuous' } as const

export function BottomBar({ doc, renderer, rtl, view, onSeek, onCycleMode }: {
  doc: DocDetail
  renderer: PageRenderer | null
  rtl: boolean
  view: ReaderView
  onSeek: (page: number) => void
  onCycleMode: () => void
}) {
  const open = useReaderUi((s) => s.chrome)
  const page = useReaderUi((s) => s.position.page)
  const fullscreen = useIsFullscreen()
  const ModeIcon = VIEW_ICON[view]
  return (
    <footer className="reader-bar reader-bottom" data-open={open} inert={!open}>
      <Scrubber total={doc.page_count} rtl={rtl} renderer={renderer} onSeek={onSeek} />
      <div className="reader-bottom-row">
        <output className="reader-pages" aria-live="off">{page} / {doc.page_count}</output>
        <span className="reader-spacer" />
        <button type="button" className="reader-mode" aria-label={`Reading mode: ${VIEW_LABEL[view]}. Change`} onClick={onCycleMode}>
          <ModeIcon size={18} />{VIEW_LABEL[view]}
        </button>
        {fullscreenAvailable() && (
          <button type="button" className="icon-btn" aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen}>
            {fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
          </button>
        )}
      </div>
    </footer>
  )
}

/** Nothing covers the page unless asked: a faint page count or a hairline, or nothing at all. */
export function Indicator({ kind, total, rtl }: { kind: ProgressIndicator; total: number; rtl: boolean }) {
  const page = useReaderUi((s) => s.position.page)
  const fraction = useReaderUi((s) => s.fraction)
  const chrome = useReaderUi((s) => s.chrome)
  if (kind === 'off' || chrome) return null
  if (kind === 'pages') return <div className="indicator-pages" aria-hidden>{page} / {total}</div>
  return <div className="indicator-line" aria-hidden style={{ width: `${Math.min(1, fraction) * 100}%`, [rtl ? 'right' : 'left']: 0 }} />
}

/** Desktop: edges reveal the chrome, which autohides with the cursor after idle. */
export function CursorIdle() {
  const set = useReaderUi((s) => s.set)
  const revealed = useRef(false)
  useEffect(() => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return
    let timer: number | undefined
    const reader = document.querySelector<HTMLElement>('.reader')
    const hide = () => {
      reader?.classList.add('cursor-hidden')
      const s = useReaderUi.getState()
      if (s.chrome && !s.panel && !document.querySelector('.reader-bar:hover')) set({ chrome: false })
      revealed.current = false
    }
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      reader?.classList.remove('cursor-hidden')
      window.clearTimeout(timer)
      timer = window.setTimeout(hide, IDLE_MS)
      const s = useReaderUi.getState()
      if (s.panel) return
      const near = e.clientY <= EDGE_PX || e.clientY >= window.innerHeight - EDGE_PX
      if (near && !s.chrome) { set({ chrome: true }); revealed.current = true }
    }
    window.addEventListener('pointermove', move)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', move)
      reader?.classList.remove('cursor-hidden')
    }
  }, [set])
  return null
}
