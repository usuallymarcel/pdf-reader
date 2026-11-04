import { ApiError, api } from '../api/client'
import type { Doc, DocPatch, StatePatch } from '../api/types'
import { queryClient } from '../app/queryClient'
import { DownloadError, useDownloads } from '../offline/downloads'
import { toast } from '../ui/primitives'
import { LIBRARY_KEY, updateDocInCache } from './data'
import { useLibraryUi } from './uiStore'

const UNDO_MS = 6000

const refresh = () => queryClient.invalidateQueries({ queryKey: LIBRARY_KEY })
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback)

function localState(doc: Doc, patch: StatePatch): Doc {
  const state = { ...doc.state }
  if (patch.favorite !== undefined) state.favorite = patch.favorite
  if (patch.finished !== undefined) state.finished = patch.finished
  if (patch.reset_progress) Object.assign(state, { page: 1, offset: 0, max_page: 1, finished: false })
  return { ...doc, state }
}

/** Optimistic: the card reacts at once, a failure rolls back through a refetch. */
export async function changeState(docs: Doc[], patch: StatePatch) {
  for (const doc of docs) updateDocInCache(doc.id, (d) => localState(d, patch))
  const results = await Promise.allSettled(docs.map((d) => api.patchState(d.id, patch)))
  if (results.some((r) => r.status === 'rejected')) {
    toast('Could not save that change')
    await refresh()
  }
}

export async function patchDoc(doc: Doc, patch: DocPatch) {
  const saved = await api.patchDocument(doc.id, patch)
  updateDocInCache(doc.id, () => saved)
  return saved
}

export async function addToSeries(docs: Doc[], series: string) {
  const results = await Promise.allSettled(docs.map((d) => patchDoc(d, { series })))
  const failed = results.filter((r) => r.status === 'rejected').length
  toast(failed ? `${failed} could not be moved` : `Added to ${series}`)
  await refresh()
}

export async function retryProcessing(doc: Doc) {
  updateDocInCache(doc.id, (d) => ({ ...d, status: 'processing', error: null }))
  try {
    const saved = await api.reprocess(doc.id)
    updateDocInCache(doc.id, () => saved)
  } catch (err) {
    toast(message(err, 'Could not retry'))
    await refresh()
  }
}

/** Hidden now, deleted when the undo window ends. */
export function deleteDocs(docs: Doc[]) {
  const ui = useLibraryUi.getState()
  const ids = docs.map((d) => d.id)
  ui.hideDeleted(ids)
  ui.openSheet(null)
  let undone = false
  const label = docs.length === 1 ? `Deleted ${docs[0]?.title ?? ''}` : `Deleted ${docs.length} books`
  toast(label, {
    label: 'Undo',
    run: () => {
      undone = true
      useLibraryUi.getState().restoreDeleted(ids)
    },
  }, UNDO_MS)
  window.setTimeout(() => {
    if (undone) return
    void (async () => {
      const results = await Promise.allSettled(docs.map(async (d) => {
        await api.deleteDocument(d.id)
        await useDownloads.getState().remove(d.id)
      }))
      if (results.some((r) => r.status === 'rejected')) toast('Some books could not be deleted')
      await refresh()
      useLibraryUi.getState().restoreDeleted(ids)
    })()
  }, UNDO_MS)
}

export async function downloadForOffline(doc: Doc) {
  try {
    await useDownloads.getState().download(doc)
    if (useDownloads.getState().books[doc.id]) toast(`${doc.title} is available offline`)
  } catch (err) {
    toast(err instanceof DownloadError ? err.message : 'Download failed')
  }
}
