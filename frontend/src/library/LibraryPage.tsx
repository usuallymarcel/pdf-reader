import { ListChecks, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { useOnline } from '../app/session'
import { useDownloads } from '../offline/downloads'
import { usePreferences } from '../settings/store'
import { BookSheet } from './BookSheet'
import { ContinueShelf } from './ContinueShelf'
import { continueReading, matchesFilter, matchesQuery, sortItems, toShelfItems, useLibrary } from './data'
import { InsideSearch } from './InsideSearch'
import { EmptyLibrary, InstallHint, OfflineBanner } from './Notices'
import { SelectionBar } from './SelectionBar'
import { GridSkeleton, ShelfGrid } from './ShelfGrid'
import { useLibraryUi, type LibraryFilter, type LibrarySort } from './uiStore'

const FILTERS: { value: LibraryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'reading', label: 'Reading' },
  { value: 'unread', label: 'Unread' },
  { value: 'finished', label: 'Finished' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'manga', label: 'Manga' },
  { value: 'novels', label: 'Novels' },
  { value: 'downloaded', label: 'Downloaded' },
]

const SORTS: { value: LibrarySort; label: string }[] = [
  { value: 'recent', label: 'Recent' },
  { value: 'added', label: 'Added' },
  { value: 'title', label: 'Title' },
  { value: 'progress', label: 'Progress' },
]

function useSlashToSearch(input: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement
      if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      e.preventDefault()
      input.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [input])
}

export function LibraryPage() {
  const { docs, isPending, isError, fetchStatus, refetch } = useLibrary()
  const { sort, filter, query, selected, setSort, setFilter, setQuery, startSelecting, stopSelecting } = useLibraryUi()
  const groupSeries = usePreferences((s) => s.prefs.groupSeries)
  const downloaded = useDownloads((s) => s.books)
  const online = useOnline()
  const input = useRef<HTMLInputElement>(null)
  useSlashToSearch(input)

  useEffect(() => {
    if (selected === null) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stopSelecting() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, stopSelecting])

  const searching = query.trim().length > 0
  const items = useMemo(() => {
    const visible = docs.filter((d) => matchesFilter(d, online ? filter : 'all', downloaded) && matchesQuery(d, query))
    return sortItems(toShelfItems(visible, groupSeries && !searching), sort)
  }, [docs, filter, query, sort, groupSeries, searching, downloaded, online])

  const reading = useMemo(() => continueReading(docs), [docs])
  const showContinue = filter === 'all' && !searching && selected === null
  const loading = isPending && fetchStatus !== 'idle'
  const libraryIsEmpty = !loading && !isError && docs.length === 0

  return (
    <div className="page library">
      <header className="page-head">
        <h1>Library</h1>
        {docs.length > 0 && (
          <button type="button" className="text-btn" onClick={() => (selected === null ? startSelecting() : stopSelecting())}>
            <ListChecks size={18} aria-hidden="true" /> {selected === null ? 'Select' : 'Done'}
          </button>
        )}
      </header>

      {!online && <OfflineBanner />}
      <InstallHint />

      {!libraryIsEmpty && (
        <div className="toolbar">
          <label className="search">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">Search your library</span>
            <input ref={input} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles, series, authors" enterKeyHint="search" autoComplete="off" autoCorrect="off" spellCheck={false} />
            <kbd aria-hidden="true">/</kbd>
            {searching && <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><X size={16} /></button>}
          </label>
          <label className="sort">
            <span className="sr-only">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as LibrarySort)}>
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        </div>
      )}

      {online && !libraryIsEmpty && !searching && (
        <div className="chips" role="radiogroup" aria-label="Filter">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" role="radio" aria-checked={filter === f.value} onClick={() => setFilter(f.value)}>{f.label}</button>
          ))}
        </div>
      )}

      {showContinue && <ContinueShelf docs={reading} />}

      {loading && <GridSkeleton />}
      {isError && docs.length === 0 && (
        <div className="empty">
          <h2>Couldn&rsquo;t load your library</h2>
          <button type="button" className="btn" onClick={() => void refetch()}>Try again</button>
        </div>
      )}
      {libraryIsEmpty && (online ? <EmptyLibrary /> : (
        <div className="empty">
          <h2>Nothing downloaded yet</h2>
          <p>Books you download for offline reading will be here when you have no connection.</p>
        </div>
      ))}

      {items.length > 0 && (
        <section aria-label="Books">
          {showContinue && reading.length > 0 && <h2 className="section-title">All books</h2>}
          <ShelfGrid items={items} />
        </section>
      )}
      {!libraryIsEmpty && !loading && items.length === 0 && !searching && (
        <div className="empty empty-small">
          <h2>Nothing in this view</h2>
          <button type="button" className="btn" onClick={() => setFilter('all')}>Show all books</button>
        </div>
      )}

      {searching && online && <InsideSearch query={query} />}

      <BookSheet />
      <SelectionBar />
    </div>
  )
}
