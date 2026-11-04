import { MoreHorizontal } from 'lucide-react'
import { useCallback, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import type { Doc } from '../api/types'
import { Cover } from './Cover'
import { SelectMark } from './BookCard'
import { useLibraryUi } from './uiStore'
import { useCardPress } from './useCardPress'

export function seriesPath(name: string) {
  return `/series/${encodeURIComponent(name)}`
}

export function SeriesCard({ name, docs }: { name: string; docs: Doc[] }) {
  const selected = useLibraryUi((s) => s.selected)
  const toggleSelected = useLibraryUi((s) => s.toggleSelected)
  const startSelecting = useLibraryUi((s) => s.startSelecting)
  const openSeries = useLibraryUi((s) => s.openSeries)
  const ids = docs.map((d) => d.id)
  const open = useCallback(() => openSeries(name), [openSeries, name])
  const { consumeLongPress, ...pressHandlers } = useCardPress(open)

  const selecting = selected !== null
  const isSelected = selecting && ids.every((id) => selected.includes(id))
  const finished = docs.filter((d) => d.state.finished).length
  const count = `${docs.length} volumes`
  const sub = finished === docs.length ? `${count} · Finished` : finished > 0 ? `${finished} of ${docs.length} read` : count
  const progress = finished / docs.length

  const onClick = (e: MouseEvent) => {
    if (consumeLongPress()) { e.preventDefault(); return }
    if (selecting) { e.preventDefault(); toggleSelected(ids); return }
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); startSelecting(ids) }
  }

  return (
    <div className="card card-series" data-selected={isSelected} {...pressHandlers}>
      <Link to={seriesPath(name)} viewTransition data-card-link draggable={false} onClick={onClick} className="card-link" aria-label={`${name}, ${sub}`}>
        <span className="cover-stack">
          {[...docs.slice(1, 3)].reverse().map((doc, i, all) => (
            <span key={doc.id} className="cover cover-behind" data-depth={all.length - i}><Cover doc={doc} /></span>
          ))}
          <span className="cover">
            {docs[0] && <Cover doc={docs[0]} />}
            {progress > 0 && progress < 1 && <span className="cover-progress"><span style={{ transform: `scaleX(${progress})` }} /></span>}
            <span className="cover-count">{docs.length}</span>
            {selecting && <SelectMark selected={isSelected} />}
          </span>
        </span>
        <span className="card-title">{name}</span>
        <span className="card-sub">{sub}</span>
      </Link>
      {!selecting && (
        <button type="button" className="card-menu" tabIndex={-1} onClick={open} aria-label={`More for ${name}`}>
          <MoreHorizontal size={18} />
        </button>
      )}
    </div>
  )
}
