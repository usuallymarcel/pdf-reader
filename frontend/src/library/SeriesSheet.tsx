import { BookCheck, BookX, FolderInput, FolderMinus, ListChecks, Pencil, Tags } from 'lucide-react'
import { useId, useMemo, useState, type FormEvent } from 'react'
import { useMatch, useNavigate } from 'react-router-dom'
import type { Doc, DocKind } from '../api/types'
import { Segmented, Sheet } from '../ui/primitives'
import { bulkChange, changeState, moveToSeries } from './actions'
import { Action } from './BookSheet'
import { CollectionPicker } from './CollectionPicker'
import { compareVolumes, useLibrary } from './data'
import { MovePicker } from './MovePicker'
import { seriesPath } from './SeriesCard'
import { useLibraryUi } from './uiStore'

const KINDS = [{ value: 'manga', label: 'Manga' }, { value: 'novel', label: 'Novel' }] as const

const shared = <T,>(values: T[]): T | undefined => (values.every((v) => v === values[0]) ? values[0] : undefined)

function EditSeries({ name, volumes, names, onSaved, onCancel }: {
  name: string
  volumes: Doc[]
  names: string[]
  onSaved: (name: string) => void
  onCancel: () => void
}) {
  const id = useId()
  const originalAuthor = shared(volumes.map((d) => d.author ?? ''))
  const originalKind = shared(volumes.map((d) => d.kind))
  const [series, setSeries] = useState(name)
  const [author, setAuthor] = useState(originalAuthor ?? '')
  const [kind, setKind] = useState<DocKind | undefined>(originalKind)
  const [saving, setSaving] = useState(false)
  const next = series.trim()
  const clash = names.find((n) => n !== name && n.toLowerCase() === next.toLowerCase())

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!next) return
    setSaving(true)
    const target = clash ?? next
    const changes: Parameters<typeof bulkChange>[1] = {}
    if (author.trim() !== (originalAuthor ?? '')) changes.author = author.trim() || null
    if (kind && kind !== originalKind) changes.kind = kind
    if (target !== name && !await moveToSeries(volumes, target)) { setSaving(false); return }
    const changed = Object.keys(changes).length === 0 || await bulkChange(volumes, changes)
    // Once renamed there is no staying here, even if the rest failed and said so.
    if (changed || target !== name) onSaved(target)
    else setSaving(false)
  }

  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <label className="input-field">Series name
        <input value={series} onChange={(e) => setSeries(e.target.value)} list={`${id}-series`} required maxLength={500} autoComplete="off" />
        <datalist id={`${id}-series`}>{names.filter((n) => n !== name).map((n) => <option key={n} value={n} />)}</datalist>
      </label>
      {clash && <p className="hint" role="status">{clash} already exists, so these volumes will join it.</p>}
      <label className="input-field">Author
        <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={originalAuthor === undefined ? 'Different on each volume' : undefined} autoComplete="off" maxLength={500} />
      </label>
      <div className="field-col"><span className="label">Type</span>
        <Segmented label="Type" value={kind as DocKind} options={KINDS} onChange={setKind} />
      </div>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving || !next}>{clash ? 'Merge' : 'Save'}</button>
      </div>
    </form>
  )
}

type View = 'actions' | 'edit' | 'move' | 'collections'

const TITLES: Record<Exclude<View, 'actions'>, string> = {
  edit: 'Edit series', move: 'Merge into another series', collections: 'Collections',
}

/** Everything that applies to a whole series, on the same long-press, right-click or menu as a book. */
export function SeriesSheet() {
  const name = useLibraryUi((s) => s.seriesSheet)
  const openSeries = useLibraryUi((s) => s.openSeries)
  const startSelecting = useLibraryUi((s) => s.startSelecting)
  const { docs } = useLibrary()
  const navigate = useNavigate()
  const onSeriesPage = useMatch('/series/:name')
  const [view, setView] = useState<View>('actions')
  const volumes = useMemo(() => docs.filter((d) => d.series === name).sort(compareVolumes), [docs, name])
  const names = useMemo(() => [...new Set(docs.flatMap((d) => d.series ?? []))], [docs])
  if (!name || volumes.length === 0) return null

  const close = () => { setView('actions'); openSeries(null) }
  /** The page this sheet may be sitting on is named after the series that just changed. */
  const leave = (next: string | null) => {
    close()
    if (onSeriesPage?.params.name === name && next !== name) navigate(next ? seriesPath(next) : '/', { replace: true })
  }
  const finished = volumes.every((d) => d.state.finished)

  return (
    <Sheet title={view === 'actions' ? name : TITLES[view]} onClose={close}>
      {view === 'edit' && <EditSeries name={name} volumes={volumes} names={names} onSaved={leave} onCancel={() => setView('actions')} />}
      {view === 'move' && <MovePicker docs={volumes} onDone={leave} />}
      {view === 'collections' && <CollectionPicker ids={volumes.map((d) => d.id)} />}
      {view === 'actions' && (
        <div className="action-list">
          <Action icon={<Pencil size={20} />} onClick={() => setView('edit')}>Rename and edit</Action>
          <Action icon={<FolderInput size={20} />} onClick={() => setView('move')}>Merge into another series</Action>
          <Action icon={<Tags size={20} />} onClick={() => setView('collections')}>Add to collection</Action>
          <Action icon={finished ? <BookX size={20} /> : <BookCheck size={20} />} onClick={() => { void changeState(volumes, { finished: !finished }); close() }}>
            {finished ? 'Mark all as unread' : 'Mark all as finished'}
          </Action>
          <Action icon={<ListChecks size={20} />} onClick={() => { close(); startSelecting(volumes.map((d) => d.id)) }}>Select volumes</Action>
          <Action icon={<FolderMinus size={20} />} onClick={() => { void moveToSeries(volumes, null).then((done) => { if (done) leave(null) }) }}>
            Ungroup, keeping the books
          </Action>
        </div>
      )}
    </Sheet>
  )
}
