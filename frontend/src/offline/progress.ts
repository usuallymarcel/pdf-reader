import { ApiError, api } from '../api/client'
import type { Doc, ProgressUpdate } from '../api/types'
import { inProgressStore } from './idb'
import type { Scope } from './paths'
import { currentScope } from './scope'

interface Queued extends ProgressUpdate {
  key: string
  id: string
  scope: Scope
  seconds: number
}

const retryable = (err: unknown) =>
  !(err instanceof ApiError) || err.status === 401 || err.status === 408 || err.status === 429 || err.status >= 500

function enqueue(id: string, update: ProgressUpdate, scope: Scope) {
  const key = `${scope}:${id}`
  return inProgressStore<void>((store, done) => {
    const read = store.get(key)
    read.onsuccess = () => {
      const previous = read.result as Queued | undefined
      const latest = !previous || update.client_ts >= previous.client_ts ? update : previous
      store.put({
        key, id, scope,
        page: latest.page, offset: latest.offset, client_ts: latest.client_ts,
        seconds: (previous?.seconds ?? 0) + (update.seconds ?? 0),
      } satisfies Queued)
      done()
    }
  })
}

const queued = (scope: Scope) => inProgressStore<Queued[]>((store, done) => {
  const all = store.getAll()
  all.onsuccess = () => done((all.result as Queued[]).filter((q) => q.scope === scope))
})

/** Sent seconds leave the queue; whatever was queued while the PUT was in flight stays. */
const settle = (sent: Queued) => inProgressStore<void>((store, done) => {
  const read = store.get(sent.key)
  read.onsuccess = () => {
    const now = read.result as Queued | undefined
    if (now) {
      if (now.client_ts === sent.client_ts && now.seconds === sent.seconds) store.delete(sent.key)
      else store.put({ ...now, seconds: Math.max(0, now.seconds - sent.seconds) })
    }
    done()
  }
})

let flushing = false

export async function flushProgress() {
  const scope = currentScope()
  if (flushing || scope === 'anon' || !navigator.onLine) return
  flushing = true
  try {
    for (const item of await queued(scope)) {
      const { page, offset, seconds, client_ts } = item
      try {
        await api.saveProgress(item.id, { page, offset, seconds, client_ts })
      } catch (err) {
        if (retryable(err)) return
        // otherwise the book is gone or the write is invalid: drop it below
      }
      await settle(item)
    }
  } catch {
    /* IndexedDB unavailable: nothing to flush */
  } finally {
    flushing = false
  }
}

/** Sends at once. A write that cannot reach the server is queued per book and flushed later. */
export function saveProgress(id: string, update: ProgressUpdate, keepalive = false): void {
  const scope = currentScope()
  api.saveProgress(id, update, keepalive).catch((err: unknown) => {
    if (retryable(err) && scope !== 'anon') enqueue(id, update, scope).catch(() => undefined)
  })
}

/** Shows queued positions in the library while they cannot reach the server. */
export async function overlayQueuedProgress(docs: Doc[]): Promise<Doc[]> {
  const items = await queued(currentScope()).catch(() => [] as Queued[])
  if (items.length === 0) return docs
  const byId = new Map(items.map((q) => [q.id, q]))
  return docs.map((doc) => {
    const item = byId.get(doc.id)
    if (!item || item.client_ts <= doc.state.client_ts) return doc
    return {
      ...doc,
      state: {
        ...doc.state,
        page: item.page,
        offset: item.offset ?? doc.state.offset,
        max_page: Math.max(doc.state.max_page, item.page),
        last_read_at: new Date(item.client_ts).toISOString(),
      },
    }
  })
}

export function startProgressSync(onFlushed: () => void) {
  const flush = () => { void flushProgress().then(onFlushed) }
  window.addEventListener('online', flush)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush() })
  flush()
}
