import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { AUTH_REQUIRED_EVENT } from '../api/client'
import { useDownloads } from '../offline/downloads'
import type { Scope } from '../offline/paths'
import { activateScope, scopeOf } from '../offline/scope'
import { usePreferences } from '../settings/store'
import { SESSION_KEY, rememberSession, useSession } from './session'

/**
 * Reacts to session changes without ever touching the route tree, so an open reader stays mounted.
 * The active scope decides which caches the worker may serve, what the library shows and who owns prefs.
 */
export function SessionWatcher() {
  const qc = useQueryClient()
  const { data: session } = useSession()
  const previous = useRef<Scope | null>(null)

  useEffect(() => {
    const onAuthRequired = () => { void qc.invalidateQueries({ queryKey: SESSION_KEY }) }
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
  }, [qc])

  const scope = session ? scopeOf(session) : null

  useEffect(() => { if (session) rememberSession(session) }, [session])

  useEffect(() => {
    if (!scope || previous.current === scope) return
    const changed = previous.current !== null
    previous.current = scope
    void (async () => {
      await activateScope(scope)
      await useDownloads.getState().refresh()
      if (changed) {
        // reset, not remove: mounted pages stay subscribed and refetch for the new scope.
        await Promise.all([qc.resetQueries({ queryKey: ['library'] }), qc.resetQueries({ queryKey: ['stats'] })])
      }
      if (scope !== 'anon') await usePreferences.getState().hydrate()
    })()
  }, [qc, scope])

  return null
}
