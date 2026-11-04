import { Check, ChevronDown, RotateCw, X } from 'lucide-react'
import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { formatBytes } from '../../offline/downloads'
import { useUploads, type UploadItem } from './store'

function UploadRow({ item }: { item: UploadItem }) {
  const { cancel, retry } = useUploads()
  const percent = Math.round(item.progress * 100)
  const detail = item.status === 'failed' ? item.error
    : item.status === 'queued' ? 'Waiting'
    : item.status === 'done' ? 'Added'
    : `${percent}% of ${formatBytes(item.file.size)}`
  return (
    <li className="upload-row" data-status={item.status}>
      <div className="upload-text">
        <span className="upload-name">{item.file.name}</span>
        <span className="upload-detail">{detail}</span>
      </div>
      {item.status === 'done'
        ? <span className="upload-done"><Check size={18} aria-label="Done" /></span>
        : (
          <>
            {item.status === 'failed' && (
              <button type="button" className="icon-btn" onClick={() => retry(item.id)} aria-label={`Retry ${item.file.name}`}><RotateCw size={18} /></button>
            )}
            <button type="button" className="icon-btn" onClick={() => cancel(item.id)} aria-label={`Cancel ${item.file.name}`}><X size={18} /></button>
          </>
        )}
      <div className="upload-bar" aria-hidden="true"><span style={{ transform: `scaleX(${item.progress})` }} /></div>
    </li>
  )
}

/** Mounted above the routes so it follows every navigation; steps aside inside the reader. */
export function UploadTray() {
  const items = useUploads((s) => s.items)
  const { pathname } = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  if (items.length === 0 || pathname.startsWith('/read/')) return null
  const remaining = items.filter((i) => i.status === 'queued' || i.status === 'uploading').length
  const failed = items.filter((i) => i.status === 'failed').length
  const title = remaining > 0 ? `Uploading ${remaining} ${remaining === 1 ? 'file' : 'files'}`
    : failed > 0 ? `${failed} failed` : 'All uploaded'
  return (
    <section className="upload-tray" aria-label="Uploads">
      <header>
        <h2 aria-live="polite">{title}</h2>
        <button type="button" className="icon-btn" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? 'Show uploads' : 'Hide uploads'}>
          <ChevronDown size={20} style={{ transform: collapsed ? 'rotate(180deg)' : undefined }} />
        </button>
      </header>
      {!collapsed && <ul>{items.map((item) => <UploadRow key={item.id} item={item} />)}</ul>}
    </section>
  )
}
