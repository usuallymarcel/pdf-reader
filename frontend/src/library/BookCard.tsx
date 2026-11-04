import { AlertTriangle, ArrowDownToLine, Check, Heart, MoreHorizontal, RotateCw } from 'lucide-react'
import { useCallback, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import type { Doc } from '../api/types'
import { useDownloads } from '../offline/downloads'
import { retryProcessing } from './actions'
import { Cover } from './Cover'
import { progressOf, volumeLabel } from './data'
import { useLibraryUi } from './uiStore'
import { useCardPress } from './useCardPress'

function subtitle(doc: Doc, showSeries: boolean) {
  if (doc.status === 'processing') return 'Processing'
  if (doc.status === 'failed') return 'Could not process'
  if (!showSeries) {
    if (doc.state.finished) return 'Finished'
    return doc.state.page > 1 ? `${Math.round(progressOf(doc) * 100)}%` : `${doc.page_count} pages`
  }
  const parts = [doc.series, volumeLabel(doc)].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : doc.author ?? (doc.kind === 'manga' ? 'Manga' : 'Novel')
}

export function SelectMark({ selected }: { selected: boolean }) {
  return <span className="select-mark" data-on={selected}>{selected && <Check size={16} strokeWidth={3} />}</span>
}

export function BookCard({ doc, showSeries = true }: { doc: Doc; showSeries?: boolean }) {
  const selected = useLibraryUi((s) => s.selected)
  const toggleSelected = useLibraryUi((s) => s.toggleSelected)
  const startSelecting = useLibraryUi((s) => s.startSelecting)
  const openSheet = useLibraryUi((s) => s.openSheet)
  const downloaded = useDownloads((s) => !!s.books[doc.id])
  const open = useCallback(() => openSheet(doc.id), [openSheet, doc.id])
  const press = useCardPress(open)
  const { consumeLongPress, ...pressHandlers } = press

  const selecting = selected !== null
  const isSelected = selected?.includes(doc.id) ?? false
  const progress = progressOf(doc)
  const ready = doc.status === 'ready'

  const onClick = (e: MouseEvent) => {
    if (consumeLongPress()) { e.preventDefault(); return }
    if (selecting) { e.preventDefault(); toggleSelected([doc.id]); return }
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); startSelecting([doc.id]); return }
    if (!ready) { e.preventDefault(); open() }
  }

  return (
    <div className="card" data-selected={isSelected} data-status={doc.status} {...pressHandlers}>
      <Link to={`/read/${doc.id}`} viewTransition data-card-link draggable={false} onClick={onClick} className="card-link" aria-label={`${doc.title}${doc.status === 'ready' ? '' : `, ${doc.status}`}`}>
        <span className="cover">
          <Cover doc={doc} />
          {doc.status === 'processing' && <span className="cover-shimmer" />}
          {doc.status === 'failed' && <span className="cover-failed"><AlertTriangle size={22} aria-hidden="true" /></span>}
          {doc.state.finished && <span className="cover-check"><Check size={13} strokeWidth={3} /></span>}
          {!doc.state.finished && progress > 0.005 && <span className="cover-progress"><span style={{ transform: `scaleX(${progress})` }} /></span>}
          <span className="cover-badges">
            {doc.state.favorite && <Heart size={13} fill="currentColor" strokeWidth={0} aria-label="Favorite" />}
            {downloaded && <ArrowDownToLine size={13} strokeWidth={2.5} aria-label="Downloaded" />}
          </span>
          {selecting && <SelectMark selected={isSelected} />}
        </span>
        <span className="card-title">{doc.title}</span>
        <span className="card-sub">{subtitle(doc, showSeries)}</span>
      </Link>
      {doc.status === 'failed' && !selecting && (
        <div className="card-overlay">
          <button type="button" className="card-retry" onClick={() => void retryProcessing(doc)}>
            <RotateCw size={14} aria-hidden="true" /> Retry
          </button>
        </div>
      )}
      {!selecting && (
        <button type="button" className="card-menu" tabIndex={-1} onClick={open} aria-label={`More for ${doc.title}`}>
          <MoreHorizontal size={18} />
        </button>
      )}
    </div>
  )
}
