import { Check, Minus, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { Collection, Doc } from '../api/types'
import { createCollection, deleteCollection, renameCollection, setInCollection } from './actions'
import { inCollection, useCollections, useLibrary } from './data'

function Row({ collection, chosen }: { collection: Collection; chosen: Doc[] | null }) {
  const { docs } = useLibrary()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [name, setName] = useState(collection.name)
  const count = docs.filter((d) => inCollection(d, collection.id)).length
  const members = chosen?.filter((d) => inCollection(d, collection.id)).length ?? 0
  const all = !!chosen && chosen.length > 0 && members === chosen.length
  const some = members > 0 && !all

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const next = name.trim()
    if (next && (next === collection.name || await renameCollection(collection, next))) setEditing(false)
  }

  if (editing) {
    return (
      <form className="picker-row" onSubmit={(e) => void save(e)}>
        <input className="picker-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Collection name" maxLength={200} autoFocus />
        <button type="submit" className="icon-btn" aria-label="Save name"><Check size={18} /></button>
        <button type="button" className="icon-btn" aria-label="Cancel" onClick={() => { setName(collection.name); setEditing(false) }}><X size={18} /></button>
      </form>
    )
  }
  if (confirming) {
    return (
      <div className="picker-row">
        <span className="picker-name">Delete &ldquo;{collection.name}&rdquo;? Its books stay in your library.</span>
        <button type="button" className="btn btn-danger" onClick={() => void deleteCollection(collection)}>Delete</button>
        <button type="button" className="btn" onClick={() => setConfirming(false)}>Keep</button>
      </div>
    )
  }
  const label = (
    <>
      {chosen && <span className="check-box" data-on={all || some}>{all ? <Check size={14} strokeWidth={3} /> : some ? <Minus size={14} strokeWidth={3} /> : null}</span>}
      <span className="picker-name">{collection.name}</span>
      <span className="muted">{count}</span>
    </>
  )
  return (
    <div className="picker-row">
      {chosen
        ? <button type="button" className="picker-main" role="checkbox" aria-checked={all ? true : some ? 'mixed' : false} onClick={() => void setInCollection(collection, chosen, !all)}>{label}</button>
        : <div className="picker-main">{label}</div>}
      <button type="button" className="icon-btn" aria-label={`Rename ${collection.name}`} onClick={() => setEditing(true)}><Pencil size={17} /></button>
      <button type="button" className="icon-btn" aria-label={`Delete ${collection.name}`} onClick={() => setConfirming(true)}><Trash2 size={17} /></button>
    </div>
  )
}

/** Tick the collections `ids` belong to; without ids, just manage the list. */
export function CollectionPicker({ ids }: { ids?: string[] }) {
  const { docs } = useLibrary()
  const { data: collections = [] } = useCollections()
  const chosen = ids ? docs.filter((d) => ids.includes(d.id)) : null
  const [name, setName] = useState('')

  const create = async (e: FormEvent) => {
    e.preventDefault()
    const next = name.trim()
    if (!next) return
    const made = await createCollection(next)
    if (!made) return
    setName('')
    if (chosen) await setInCollection(made, chosen, true)
  }

  return (
    <>
      <form className="picker-new" onSubmit={(e) => void create(e)}>
        <label className="input-field">
          <span className="sr-only">New collection</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New collection" autoComplete="off" maxLength={200} />
        </label>
        <button type="submit" className="btn" disabled={!name.trim()}><Plus size={18} aria-hidden="true" /> Add</button>
      </form>
      {collections.length > 0
        ? <div className="picker-list">{collections.map((c) => <Row key={c.id} collection={c} chosen={chosen} />)}</div>
        : <p className="panel-note">Collections are your own shelves, like &ldquo;Favourite isekai&rdquo; or &ldquo;To read next&rdquo;. A book can be in as many as you like.</p>}
    </>
  )
}
