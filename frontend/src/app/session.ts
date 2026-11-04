import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { api } from '../api/client'
import type { Session } from '../api/types'
import { scopeOf, wipeOnLogout } from '../offline/scope'
import { toast } from '../ui/primitives'

const STORAGE_KEY = 'shelf.session'
export const SESSION_KEY = ['session'] as const

export function cachedSession(): Session | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) as Session : undefined
  } catch {
    return undefined
  }
}

export const rememberSession = (session: Session) => localStorage.setItem(STORAGE_KEY, JSON.stringify(session))

export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: api.session,
    initialData: cachedSession,
    initialDataUpdatedAt: 0, // always verify a cached session
    refetchOnWindowFocus: 'always',
    refetchInterval: 60_000,
    retry: false,
  })
}

/** Session once known; only for components rendered behind the session gate. */
export function useReadySession(): Session {
  const { data } = useSession()
  if (!data) throw new Error('useReadySession used outside the session gate')
  return data
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const before = qc.getQueryData<Session>(SESSION_KEY)
      const session = await api.logout()
      if (before) await wipeOnLogout(scopeOf(before))
      return session
    },
    onSuccess: (session) => {
      qc.setQueryData(SESSION_KEY, session)
    },
    onError: () => toast('Could not sign out. Check your connection.'),
  })
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/** False when the device is offline or the last session check could not reach the server. */
export function useOnline() {
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine)
  const { isError } = useSession()
  return online && !isError
}
