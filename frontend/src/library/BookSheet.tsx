import {
  ArrowDownToLine, BookOpen, CheckCheck, CircleSlash, Download, FolderInput, Heart, ListChecks, Pencil, RotateCcw, RotateCw, Share2, Tags, Trash2, X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { downloadUrl } from '../api/client'
import type { Doc } from '../api/types'
import { useReadySession } from '../app/session'
import { formatBytes, useDownloads } from '../offline/downloads'
import { offlineSupported } from '../offline/scope'
import { Sheet, Switch, toast } from '../ui/primitives'
import { changeState, deleteDocs, downloadForOffline, patchDoc, retryProcessing } from './actions'
import { CollectionPicker } from './CollectionPicker'
import { Cover } from './Cover'
import { useLibrary } from './data'
import { EditForm } from './EditForm'
import { MovePicker } from './MovePicker'
import { seriesPath } from './SeriesCard'
import { useLibraryUi } from './uiStore'

export function Action({ icon, children, onClick, danger }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" className="action-row" data-danger={danger} onClick={onClick}>
      {icon}<span>{children}</span>
    </button>
  )
}

function OfflineAction({ doc }: { doc: Doc }) {
  const downloaded = useDownloads((s) => s.books[doc.id])
  const active = useDownloads((s) => s.active[doc.id])
  const { cancel, remove } = useDownloads()
  if (!offlineSupported || doc.status !== 'ready') return null
  if (active) {
    const pct = active.total ? Math.round((active.loaded / active.total) * 100) : 0
    return (
      <div className="action-row action-progress">
        <ArrowDownToLine size={20} aria-hidden="true" />
        <span>
          Downloading {pct}%
          <span className="meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Download progress"><span style={{ transform: `scaleX(${pct / 100})` }} /></span>
        </span>
        <button type="button" className="icon-btn" onClick={() => cancel(doc.id)} aria-label="Cancel download"><X size={18} /></button>
      </div>
    )
  }
  if (downloaded) {
    return <Action icon={<CircleSlash size={20} />} onClick={() => void remove(doc.id).then(() => toast('Removed from this device'))}>Remove download ({formatBytes(downloaded.size)})</Action>
  }
  return <Action icon={<ArrowDownToLine size={20} />} onClick={() => void downloadForOffline(doc)}>Download for offline</Action>
}

function Details({ doc }: { doc: Doc }) {
  const rows: [string, string][] = [
    ['Pages', doc.page_count ? String(doc.page_count) : 'Unknown'],
    ['Size', formatBytes(doc.size)],
    ['Type', doc.kind === 'manga' ? 'Manga' : 'Novel'],
    ['Added', new Date(doc.created_at).toLocaleDateString(undefined, { dateStyle: 'medium' })],
  ]
  return <dl className="book-facts">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
}

function SheetBody({ doc, onView }: { doc: Doc; onView: (view: View) => void }) {
  const session = useReadySession()
  const close = () => useLibraryUi.getState().openSheet(null)
  const { state } = doc
  const started = state.page > 1
  const canShare = session.mode === 'scoped' && doc.editable

  return (
    <>
      <div className="book-head">
        <span className="cover"><Cover doc={doc} eager /></span>
        <div>
          {doc.series && (
            <p className="book-series">
              <Link to={seriesPath(doc.series)} viewTransition onClick={close}>{doc.series}</Link>{doc.volume !== null ? ` · Vol. ${doc.volume}` : ''}
            </p>
          )}
          <p className="book-title">{doc.title}</p>
          {doc.author && <p className="book-author">{doc.author}</p>}
          {doc.status === 'failed' && <p className="book-error">{doc.error ?? 'This file could not be processed.'}</p>}
        </div>
      </div>

      {doc.status === 'ready' && (
        <Link to={`/read/${doc.id}`} viewTransition className="btn btn-primary btn-block" onClick={close}>
          <BookOpen size={18} aria-hidden="true" /> {started ? `Continue from page ${state.page}` : 'Read'}
        </Link>
      )}
      {doc.status === 'failed' && (
        <button type="button" className="btn btn-primary btn-block" onClick={() => { void retryProcessing(doc); close() }}>
          <RotateCw size={18} aria-hidden="true" /> Retry processing
        </button>
      )}

      <Details doc={doc} />

      <div className="action-list">
        <Action icon={<Heart size={20} fill={state.favorite ? 'currentColor' : 'none'} />} onClick={() => void changeState([doc], { favorite: !state.favorite })}>
          {state.favorite ? 'Remove from favorites' : 'Add to favorites'}
        </Action>
        <Action icon={<CheckCheck size={20} />} onClick={() => void changeState([doc], { finished: !state.finished })}>
          {state.finished ? 'Mark as unread' : 'Mark as finished'}
        </Action>
        <OfflineAction doc={doc} />
        {doc.editable && <Action icon={<FolderInput size={20} />} onClick={() => onView('move')}>Move to series</Action>}
        <Action icon={<Tags size={20} />} onClick={() => onView('collections')}>Collections</Action>
        {doc.editable && <Action icon={<Pencil size={20} />} onClick={() => onView('edit')}>Edit details</Action>}
        {canShare && (
          <div className="action-row">
            <Share2 size={20} aria-hidden="true" />
            <span>{doc.shared ? 'Shared with everyone' : 'Share with everyone'}</span>
            {!doc.shared && <Switch checked={false} label="Share with everyone" onChange={() => void patchDoc(doc, { shared: true }).catch(() => toast('Could not share this book'))} />}
          </div>
        )}
        <a className="action-row" href={downloadUrl(doc.id)} download={doc.filename}>
          <Download size={20} aria-hidden="true" /><span>Save original PDF</span>
        </a>
        {started && <Action icon={<RotateCcw size={20} />} onClick={() => void changeState([doc], { reset_progress: true })}>Reset progress</Action>}
        <Action icon={<ListChecks size={20} />} onClick={() => useLibraryUi.getState().startSelecting([doc.id])}>Select multiple</Action>
        {doc.editable && <Action danger icon={<Trash2 size={20} />} onClick={() => deleteDocs([doc])}>Delete</Action>}
      </div>
    </>
  )
}

type View = 'details' | 'edit' | 'move' | 'collections'

const TITLES: Record<View, string> = { details: 'Details', edit: 'Edit details', move: 'Move to series', collections: 'Collections' }

/** Details and every per-book action. Long-press, right-click and the kebab all land here. */
export function BookSheet() {
  const id = useLibraryUi((s) => s.sheetDocId)
  const openSheet = useLibraryUi((s) => s.openSheet)
  const { docs } = useLibrary()
  const [view, setView] = useState<View>('details')
  const doc = docs.find((d) => d.id === id)
  if (!doc) return null
  const close = () => { setView('details'); openSheet(null) }
  return (
    <Sheet title={TITLES[view]} onClose={close}>
      {view === 'edit' && <EditForm doc={doc} seriesNames={[...new Set(docs.flatMap((d) => d.series ?? []))]} onDone={() => setView('details')} />}
      {view === 'move' && <MovePicker docs={[doc]} onDone={() => setView('details')} />}
      {view === 'collections' && <CollectionPicker ids={[doc.id]} />}
      {view === 'details' && <SheetBody doc={doc} onView={setView} />}
    </Sheet>
  )
}
