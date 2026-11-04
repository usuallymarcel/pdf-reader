import { BookCheck, BookX, BookOpenText, FolderInput, Heart, Images, MoreHorizontal, Tags, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { Doc } from '../api/types'
import { Sheet } from '../ui/primitives'
import { bulkChange, changeState, deleteDocs } from './actions'
import { Action } from './BookSheet'
import { CollectionPicker } from './CollectionPicker'
import { useLibrary } from './data'
import { MovePicker } from './MovePicker'
import { useLibraryUi } from './uiStore'

function AuthorForm({ docs, onDone }: { docs: Doc[]; onDone: () => void }) {
  const [author, setAuthor] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void bulkChange(docs, { author: author.trim() || null }).then((done) => { if (done) onDone() })
  }
  return (
    <form className="picker-new" onSubmit={submit}>
      <label className="input-field">
        <span className="sr-only">Author</span>
        <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Set author on all of these" autoComplete="off" maxLength={500} />
      </label>
      <button type="submit" className="btn">Set</button>
    </form>
  )
}

type Panel = 'move' | 'collections' | 'more'

const TITLES: Record<Panel, string> = { move: 'Move to series', collections: 'Collections', more: 'More actions' }

export function SelectionBar() {
  const selected = useLibraryUi((s) => s.selected)
  const stop = useLibraryUi((s) => s.stopSelecting)
  const { docs } = useLibrary()
  const [panel, setPanel] = useState<Panel | null>(null)
  if (selected === null) return null
  const chosen = docs.filter((d) => selected.includes(d.id))
  const finish = () => { setPanel(null); stop() }
  const none = chosen.length === 0
  return (
    <>
      <div className="selection-bar" role="toolbar" aria-label="Selected books">
        <button type="button" className="icon-btn" onClick={stop} aria-label="Stop selecting"><X size={20} /></button>
        <span className="selection-count" aria-live="polite">{chosen.length} selected</span>
        <button type="button" className="icon-btn" disabled={none} onClick={() => setPanel('move')} aria-label="Move to series" title="Move to series"><FolderInput size={20} /></button>
        <button type="button" className="icon-btn" disabled={none} onClick={() => setPanel('collections')} aria-label="Collections" title="Collections"><Tags size={20} /></button>
        <button type="button" className="icon-btn" disabled={none} onClick={() => setPanel('more')} aria-label="More actions" title="More actions"><MoreHorizontal size={20} /></button>
        <button type="button" className="icon-btn selection-delete" disabled={none} onClick={() => { deleteDocs(chosen); stop() }} aria-label="Delete" title="Delete"><Trash2 size={20} /></button>
      </div>
      {panel && (
        <Sheet title={TITLES[panel]} onClose={() => setPanel(null)}>
          {panel === 'move' && <MovePicker docs={chosen} onDone={finish} />}
          {panel === 'collections' && <CollectionPicker ids={chosen.map((d) => d.id)} />}
          {panel === 'more' && (
            <>
              <div className="action-list">
                <Action icon={<BookCheck size={20} />} onClick={() => { void changeState(chosen, { finished: true }); finish() }}>Mark finished</Action>
                <Action icon={<BookX size={20} />} onClick={() => { void changeState(chosen, { finished: false }); finish() }}>Mark unread</Action>
                <Action icon={<Heart size={20} />} onClick={() => { void changeState(chosen, { favorite: true }); finish() }}>Add to favorites</Action>
                <Action icon={<Images size={20} />} onClick={() => { void bulkChange(chosen, { kind: 'manga' }).then(finish) }}>Set type to manga</Action>
                <Action icon={<BookOpenText size={20} />} onClick={() => { void bulkChange(chosen, { kind: 'novel' }).then(finish) }}>Set type to novel</Action>
              </div>
              <AuthorForm docs={chosen} onDone={finish} />
            </>
          )}
        </Sheet>
      )}
    </>
  )
}
