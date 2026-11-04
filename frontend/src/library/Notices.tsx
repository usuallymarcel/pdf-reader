import { CloudOff, Share, X } from 'lucide-react'
import { useState } from 'react'
import { useReadySession } from '../app/session'
import { openFilePicker } from './upload/store'

const HINT_KEY = 'shelf.ios-hint-dismissed'

export function OfflineBanner() {
  return (
    <p className="offline-banner" role="status">
      <CloudOff size={15} aria-hidden="true" /> You&rsquo;re offline. Showing downloaded books.
    </p>
  )
}

function shouldHintInstall() {
  const ua = navigator.userAgent
  const ios = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
    || window.matchMedia('(display-mode: standalone)').matches
  return ios && safari && !standalone && localStorage.getItem(HINT_KEY) === null
}

export function InstallHint() {
  const [show, setShow] = useState(shouldHintInstall)
  if (!show) return null
  return (
    <aside className="install-hint">
      <div>
        <strong>Read full screen</strong>
        <p>Tap <Share size={15} aria-label="Share" /> then Add to Home Screen. Installed, Shelf hides Safari&rsquo;s bars and every page gets the whole display.</p>
      </div>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => { localStorage.setItem(HINT_KEY, '1'); setShow(false) }}><X size={18} /></button>
    </aside>
  )
}

export function EmptyLibrary() {
  const session = useReadySession()
  return (
    <div className="empty">
      <svg viewBox="0 0 220 120" className="empty-art" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="66" y="26" width="16" height="78" rx="2" />
          <rect x="86" y="14" width="20" height="90" rx="2" />
          <rect x="110" y="34" width="14" height="70" rx="2" />
          <rect x="139" y="23" width="17" height="82" rx="2" transform="rotate(10 147 104)" />
          <path d="M20 106h180" strokeLinecap="round" />
        </g>
      </svg>
      <h2>Your shelf is empty</h2>
      <p>Add manga and light novels as PDFs. Volumes group into series by themselves, and processing happens on your server.</p>
      <button type="button" className="btn btn-primary" onClick={() => openFilePicker(session.max_upload_mb)}>Add PDFs</button>
      <p className="empty-note">Or drop files anywhere on this page. Up to {session.max_upload_mb.toLocaleString()} MB each.</p>
    </div>
  )
}
