import type { Session } from '../api/types'
import { apiCacheName, coverCacheName, dlCacheName, type Scope, type SwInbound } from './paths'

const LAST_USER_KEY = 'shelf.lastUser'

/** Cache Storage and service workers exist only in secure contexts (https or localhost). */
export const offlineSupported = typeof caches !== 'undefined' && 'serviceWorker' in navigator

export const scopeOf = (session: Pick<Session, 'mode' | 'user'>): Scope =>
  session.mode === 'global' ? 'global' : session.user ? `u${session.user.id}` : 'anon'

let current: Scope = 'anon'
export const currentScope = () => current

export function postToWorker(message: SwInbound) {
  if (!('serviceWorker' in navigator)) return
  const direct = navigator.serviceWorker.controller
  if (direct) direct.postMessage(message)
  else void navigator.serviceWorker.getRegistration().then((reg) => reg?.active?.postMessage(message))
}

async function wipeScope(scope: Scope) {
  if (!offlineSupported) return
  await Promise.all([dlCacheName(scope), apiCacheName(scope), coverCacheName(scope)].map((n) => caches.delete(n)))
}

/**
 * Makes `next` the active scope. Caches are keyed by scope so another user's data is unreachable by
 * construction; on top of that, a sign-in as a different user deletes the previous user's data. A flip
 * to global or an expired session leaves the keyed data dormant: it only comes back for the same user.
 */
export async function activateScope(next: Scope) {
  current = next
  postToWorker({ type: 'SCOPE', scope: next })
  if (!next.startsWith('u')) return
  const previous = localStorage.getItem(LAST_USER_KEY) as Scope | null
  if (previous && previous !== next) await wipeScope(previous)
  localStorage.setItem(LAST_USER_KEY, next)
}

/** Explicit sign-out: nothing of this user stays on the device. */
export async function wipeOnLogout(scope: Scope) {
  await wipeScope(scope)
  localStorage.removeItem(LAST_USER_KEY)
}
