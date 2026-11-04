import { usePreferences } from '../settings/store'
import { BookCard } from './BookCard'
import type { ShelfItem } from './data'
import { SeriesCard } from './SeriesCard'
import { useGridKeys } from './useGridKeys'

const LARGE_LIBRARY = 150

export function ShelfGrid({ items, showSeries = true }: { items: ShelfItem[]; showSeries?: boolean }) {
  const size = usePreferences((s) => s.prefs.coverSize)
  const { ref, onKeyDown } = useGridKeys<HTMLDivElement>(items.length)
  return (
    <div ref={ref} className="grid" data-size={size} data-large={items.length > LARGE_LIBRARY} onKeyDown={onKeyDown}>
      {items.map((item) => (item.type === 'doc'
        ? <BookCard key={item.key} doc={item.doc} showSeries={showSeries} />
        : <SeriesCard key={item.key} name={item.name} docs={item.docs} />))}
    </div>
  )
}

export function GridSkeleton() {
  const size = usePreferences((s) => s.prefs.coverSize)
  return (
    <div className="grid" data-size={size} aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <div className="card skeleton" key={i}>
          <span className="cover" />
          <span className="skeleton-line" />
          <span className="skeleton-line short" />
        </div>
      ))}
    </div>
  )
}
