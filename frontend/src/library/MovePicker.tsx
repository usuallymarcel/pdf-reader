import { FolderMinus, FolderOpen, FolderPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Doc } from '../api/types'
import { moveToSeries } from './actions'
import { naturalCompare, useLibrary } from './data'

/** Pick an existing series or type a new one. This is also how two misspelled series become one. */
export function MovePicker({ docs, onDone }: { docs: Doc[]; onDone: (series: string | null) => void }) {
  const { docs: library } = useLibrary()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const counts = useMemo(() => {
    const found = new Map<string, number>()
    for (const d of library) if (d.series) found.set(d.series, (found.get(d.series) ?? 0) + 1)
    return found
  }, [library])
  const name = query.trim()
  const lower = name.toLowerCase()
  const names = [...counts.keys()].sort(naturalCompare).filter((n) => n.toLowerCase().includes(lower))
  const exact = [...counts.keys()].some((n) => n.toLowerCase() === lower)
  const allIn = (series: string) => docs.every((d) => d.series === series)

  const move = async (series: string | null) => {
    setBusy(true)
    if (await moveToSeries(docs, series)) onDone(series)
    else setBusy(false)
  }

  return (
    <>
      <label className="input-field">
        <span className="sr-only">Series name</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a series, or name a new one" autoComplete="off" maxLength={500} />
      </label>
      <div className="action-list picker-list">
        {name && !exact && (
          <button type="button" className="action-row" disabled={busy} onClick={() => void move(name)}>
            <FolderPlus size={20} aria-hidden="true" /><span>New series &ldquo;{name}&rdquo;</span>
          </button>
        )}
        {names.map((n) => (
          <button key={n} type="button" className="action-row" disabled={busy || allIn(n)} onClick={() => void move(n)}>
            <FolderOpen size={20} aria-hidden="true" />
            <span>{n}</span>
            <span className="muted">{allIn(n) ? 'Already here' : counts.get(n)}</span>
          </button>
        ))}
        {names.length === 0 && !name && <p className="panel-note">No series yet. Type a name to start one.</p>}
        {docs.some((d) => d.series) && (
          <button type="button" className="action-row" disabled={busy} onClick={() => void move(null)}>
            <FolderMinus size={20} aria-hidden="true" /><span>Take out of series</span>
          </button>
        )}
      </div>
    </>
  )
}
