import { BarChart3, Library, LogOut, Plus, Settings } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useLibraryUi } from '../library/uiStore'
import { DropZone } from '../library/upload/DropZone'
import { openFilePicker } from '../library/upload/store'
import { useLogout, useReadySession } from './session'

const NAV = [
  { to: '/', label: 'Library', Icon: Library, end: true },
  { to: '/stats', label: 'Stats', Icon: BarChart3, end: false },
  { to: '/settings', label: 'Settings', Icon: Settings, end: false },
] as const

/** Library tab stays lit inside a series. */
const isActive = (to: string, pathname: string, active: boolean) => active || (to === '/' && pathname.startsWith('/series/'))

function useHideOnScroll() {
  const [hidden, setHidden] = useState(false)
  const { pathname } = useLocation()
  const last = useRef(0)
  useEffect(() => {
    setHidden(false)
    last.current = window.scrollY
    const onScroll = () => {
      const y = window.scrollY
      const delta = y - last.current
      if (Math.abs(delta) < 8) return
      last.current = y
      setHidden(delta > 0 && y > 64)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [pathname])
  return hidden
}

function Sidebar({ onUpload }: { onUpload: () => void }) {
  const session = useReadySession()
  const logout = useLogout()
  const { pathname } = useLocation()
  return (
    <aside className="sidebar" aria-label="Main">
      <div className="wordmark"><img src="/icon.svg" alt="" width="26" height="26" /> Shelf</div>
      <nav>
        {NAV.map(({ to, label, Icon, end }) => (
          <NavLink key={to} to={to} end={end} viewTransition className={({ isActive: a }) => (isActive(to, pathname, a) ? 'active' : '')}>
            <Icon size={19} aria-hidden="true" /> {label}
          </NavLink>
        ))}
      </nav>
      <button type="button" className="btn sidebar-upload" onClick={onUpload}><Plus size={18} aria-hidden="true" /> Add PDFs</button>
      {session.user && (
        <div className="sidebar-account">
          <span>{session.user.name}</span>
          <button type="button" className="icon-btn" onClick={() => logout.mutate()} aria-label="Sign out" title="Sign out"><LogOut size={18} /></button>
        </div>
      )}
    </aside>
  )
}

function BottomNav({ onUpload }: { onUpload: () => void }) {
  const hidden = useHideOnScroll()
  const selecting = useLibraryUi((s) => s.selected !== null)
  const { pathname } = useLocation()
  return (
    <nav className="bottom-nav" data-hidden={hidden || selecting} aria-label="Main">
      {NAV.map(({ to, label, Icon, end }) => (
        <NavLink key={to} to={to} end={end} viewTransition className={({ isActive: a }) => (isActive(to, pathname, a) ? 'active' : '')}>
          <Icon size={22} aria-hidden="true" /><span>{label}</span>
        </NavLink>
      ))}
      <button type="button" className="nav-add" onClick={onUpload} aria-label="Add PDFs"><Plus size={24} /></button>
    </nav>
  )
}

export function Shell() {
  const session = useReadySession()
  const upload = () => openFilePicker(session.max_upload_mb)
  return (
    <div className="shell">
      <Sidebar onUpload={upload} />
      <main className="main"><Outlet /></main>
      <BottomNav onUpload={upload} />
      <DropZone maxUploadMb={session.max_upload_mb} />
    </div>
  )
}
