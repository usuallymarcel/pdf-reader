import { dismissToast, toast } from '../ui/primitives'

const UPDATE_TOAST_MS = 60 * 60 * 1000
const UPDATE_CHECK_MS = 60 * 60 * 1000

/** Dispatched by the app shell on every route change. */
export const ROUTE_EVENT = 'shelf:route'

const isReading = () => location.pathname.startsWith('/read/')

function offerUpdate(worker: ServiceWorker) {
  let shown: number | null = null
  // Never over a book: withdraw on entering the reader and offer again on the way out.
  const sync = () => {
    if (isReading()) {
      if (shown !== null) dismissToast(shown)
      shown = null
    } else if (shown === null) {
      shown = toast('Update ready', {
        label: 'Reload',
        run: () => {
          navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true })
          worker.postMessage({ type: 'SKIP_WAITING' })
        },
      }, UPDATE_TOAST_MS)
    }
  }
  window.addEventListener(ROUTE_EVENT, sync)
  sync()
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null)
  if (!reg) return
  if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting)
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing
    // A first install has no active worker; checking the controller here would race clients.claim().
    const isUpdate = reg.active !== null
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && isUpdate) offerUpdate(worker)
    })
  })
  window.setInterval(() => { void reg.update().catch(() => undefined) }, UPDATE_CHECK_MS)
}
