import { useId, useState, type FormEvent } from 'react'
import { ApiError } from '../api/client'
import type { Direction, Doc, DocKind } from '../api/types'
import { Segmented } from '../ui/primitives'
import { patchDoc } from './actions'

const KINDS = [{ value: 'manga', label: 'Manga' }, { value: 'novel', label: 'Novel' }] as const
const DIRECTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'ltr', label: 'Left to right' },
  { value: 'rtl', label: 'Right to left' },
] as const

export function EditForm({ doc, seriesNames, onDone }: { doc: Doc; seriesNames: string[]; onDone: () => void }) {
  const id = useId()
  const [title, setTitle] = useState(doc.title)
  const [series, setSeries] = useState(doc.series ?? '')
  const [volume, setVolume] = useState(doc.volume?.toString() ?? '')
  const [author, setAuthor] = useState(doc.author ?? '')
  const [kind, setKind] = useState<DocKind>(doc.kind)
  const [direction, setDirection] = useState<Direction | 'default'>(doc.direction ?? 'default')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const volumeNumber = volume.trim() === '' ? null : Number(volume)
    if (volumeNumber !== null && !Number.isFinite(volumeNumber)) { setError('Volume must be a number'); return }
    setSaving(true)
    try {
      await patchDoc(doc, {
        title: title.trim() || doc.title,
        series: series.trim() || null,
        volume: volumeNumber,
        author: author.trim() || null,
        kind,
        direction: direction === 'default' ? null : direction,
      })
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save')
      setSaving(false)
    }
  }

  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <label className="input-field">Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} />
      </label>
      <div className="form-pair">
        <label className="input-field">Series
          <input value={series} onChange={(e) => setSeries(e.target.value)} list={`${id}-series`} autoComplete="off" />
          <datalist id={`${id}-series`}>{seriesNames.map((s) => <option key={s} value={s} />)}</datalist>
        </label>
        <label className="input-field input-short">Volume
          <input value={volume} onChange={(e) => setVolume(e.target.value)} inputMode="decimal" />
        </label>
      </div>
      <label className="input-field">Author
        <input value={author} onChange={(e) => setAuthor(e.target.value)} autoComplete="off" />
      </label>
      <div className="field-col"><span className="label">Type</span>
        <Segmented label="Type" value={kind} options={KINDS} onChange={setKind} />
      </div>
      <div className="field-col"><span className="label">Reading direction</span>
        <Segmented label="Reading direction" value={direction} options={DIRECTIONS} onChange={setDirection} />
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>Save</button>
      </div>
    </form>
  )
}
