import { ArrowLeft, Play } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { coverUrl } from '../api/client'
import { BookSheet } from './BookSheet'
import { compareVolumes, nextUnread, toShelfItems, useLibrary } from './data'
import { SelectionBar } from './SelectionBar'
import { GridSkeleton, ShelfGrid } from './ShelfGrid'

export function SeriesPage() {
  const { name = '' } = useParams()
  const { docs, isPending } = useLibrary()
  const volumes = useMemo(() => docs.filter((d) => d.series === name).sort(compareVolumes), [docs, name])
  const finished = volumes.filter((d) => d.state.finished).length
  const next = nextUnread(volumes)
  const backdrop = volumes.find((d) => d.cover_version)
  const pages = volumes.reduce((sum, d) => sum + d.page_count, 0)

  return (
    <div className="page series">
      {backdrop && <div className="series-backdrop" aria-hidden="true" style={{ backgroundImage: `url("${coverUrl(backdrop)}")` }} />}
      <Link to="/" viewTransition className="back-link"><ArrowLeft size={20} aria-hidden="true" /> Library</Link>
      <header className="series-head">
        <h1>{name}</h1>
        {volumes.length > 0 && (
          <>
            <p className="series-meta">
              {volumes.length} {volumes.length === 1 ? 'volume' : 'volumes'} · {pages.toLocaleString()} pages
              {volumes[0]?.author ? ` · ${volumes[0].author}` : ''}
            </p>
            <div className="series-progress">
              <span className="meter" role="progressbar" aria-valuenow={finished} aria-valuemin={0} aria-valuemax={volumes.length} aria-label="Volumes finished">
                <span style={{ transform: `scaleX(${finished / volumes.length})` }} />
              </span>
              <span>{finished} of {volumes.length} read</span>
            </div>
            {next && (
              <Link to={`/read/${next.id}`} viewTransition className="btn btn-primary">
                <Play size={16} fill="currentColor" aria-hidden="true" />
                {next.state.page > 1 ? 'Continue' : finished > 0 ? 'Read next' : 'Start reading'}
                {next.volume !== null ? ` Vol. ${next.volume}` : ''}
              </Link>
            )}
          </>
        )}
      </header>
      {isPending
        ? <GridSkeleton />
        : volumes.length > 0
          ? <ShelfGrid items={toShelfItems(volumes, false)} showSeries={false} />
          : <p className="empty">This series is no longer in your library.</p>}
      <BookSheet />
      <SelectionBar />
    </div>
  )
}
