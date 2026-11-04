import { BookCheck, BookX, FolderPlus, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Sheet } from '../ui/primitives'
import { addToSeries, changeState, deleteDocs } from './actions'
import { useLibrary } from './data'
import { useLibraryUi } from './uiStore'

function SeriesPrompt({ onSubmit, onClose, names }: { onSubmit: (name: string) => void; onClose: () => void; names: string[] }) {
  const [name, setName] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) onSubmit(name.trim())
  }
  return (
    <Sheet title="Add to series" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="input-field">Series name
          <input value={name} onChange={(e) => setName(e.target.value)} list="series-names" required autoFocus autoComplete="off" />
          <datalist id="series-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
        </label>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Add</button>
        </div>
      </form>
    </Sheet>
  )
}

export function SelectionBar() {
  const selected = useLibraryUi((s) => s.selected)
  const stop = useLibraryUi((s) => s.stopSelecting)
  const { docs } = useLibrary()
  const [asking, setAsking] = useState(false)
  if (selected === null) return null
  const chosen = docs.filter((d) => selected.includes(d.id))
  const finish = () => { setAsking(false); stop() }
  const none = chosen.length === 0
  return (
    <>
      <div className="selection-bar" role="toolbar" aria-label="Selected books">
        <button type="button" className="icon-btn" onClick={stop} aria-label="Stop selecting"><X size={20} /></button>
        <span className="selection-count" aria-live="polite">{chosen.length} selected</span>
        <button type="button" className="icon-btn" disabled={none} onClick={() => { void changeState(chosen, { finished: true }); stop() }} aria-label="Mark finished" title="Mark finished"><BookCheck size={20} /></button>
        <button type="button" className="icon-btn" disabled={none} onClick={() => { void changeState(chosen, { finished: false }); stop() }} aria-label="Mark unread" title="Mark unread"><BookX size={20} /></button>
        <button type="button" className="icon-btn" disabled={none} onClick={() => setAsking(true)} aria-label="Add to series" title="Add to series"><FolderPlus size={20} /></button>
        <button type="button" className="icon-btn selection-delete" disabled={none} onClick={() => { deleteDocs(chosen); stop() }} aria-label="Delete" title="Delete"><Trash2 size={20} /></button>
      </div>
      {asking && (
        <SeriesPrompt
          names={[...new Set(docs.flatMap((d) => d.series ?? []))]}
          onClose={() => setAsking(false)}
          onSubmit={(name) => { void addToSeries(chosen, name); finish() }}
        />
      )}
    </>
  )
}
