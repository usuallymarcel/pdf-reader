import { CloudOff } from 'lucide-react'
import { Outlet } from 'react-router-dom'
import { LoginPage } from '../auth/LoginPage'
import { useSession } from './session'

export function Splash() {
  return <div className="splash" aria-hidden="true"><img src="/icon.svg" alt="" width="56" height="56" /></div>
}

export function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="unreachable" role="alert">
      <CloudOff size={28} aria-hidden="true" />
      <h1>Can&rsquo;t reach Shelf</h1>
      <p>Check your connection and try again.</p>
      <button type="button" className="btn" onClick={onRetry}>Try again</button>
    </div>
  )
}

/** What stands between a route and the session: null means the route may render. */
export function useGateScreen() {
  const { data, isError, refetch } = useSession()
  if (!data) return isError ? <Unreachable onRetry={() => void refetch()} /> : <Splash />
  if (data.mode === 'scoped' && !data.user) return <LoginPage session={data} />
  return null
}

export function SessionGate() {
  return useGateScreen() ?? <Outlet />
}
