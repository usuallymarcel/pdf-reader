import { ApiError, api } from '../api/client'
import type { BulkChanges, Collection, Doc, DocPatch, StatePatch } from '../api/types'
import { queryClient } from '../app/queryClient'
import { DownloadError, useDownloads } from '../offline/downloads'
import { toast } from '../ui/primitives'
import { COLLECTIONS_KEY, LIBRARY_KEY, collectionFilter, updateDocInCache } from './data'
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

/** All the books change or none do. Resolves to whether it worked; failures are reported here. */
export async function bulkChange(docs: Doc[], changes: BulkChanges) {
  try {
    const saved = await api.bulkUpdate(docs.map((d) => d.id), changes)
    for (const doc of saved) updateDocInCache(doc.id, () => doc)
    return true
  } catch (err) {
    toast(message(err, 'Could not save that change'))
    return false
  }
}

export async function moveToSeries(docs: Doc[], series: string | null) {
  const before = new Map<string | null, Doc[]>()
  for (const doc of docs) before.set(doc.series, [...(before.get(doc.series) ?? []), doc])
  if (!await bulkChange(docs, { series })) return false
  const what = docs.length === 1 ? (docs[0]?.title ?? '') : `${docs.length} books`
  toast(series ? `Moved ${what} to ${series}` : `Took ${what} out of the series`, {
    label: 'Undo',
    run: () => { for (const [previous, group] of before) void bulkChange(group, { series: previous }) },
  }, UNDO_MS)
  return true
}

/* ---- collections ---- */

const refreshCollections = () => queryClient.invalidateQueries({ queryKey: COLLECTIONS_KEY })

export async function createCollection(name: string) {
  try {
    const made = await api.createCollection(name)
    await refreshCollections()
    return made
  } catch (err) {
    toast(message(err, 'Could not create that collection'))
    return null
  }
}

export async function renameCollection(collection: Collection, name: string) {
  try {
    await api.renameCollection(collection.id, name)
    await refreshCollections()
    return true
  } catch (err) {
    toast(message(err, 'Could not rename that collection'))
    return false
  }
}

export async function deleteCollection(collection: Collection) {
  try {
    await api.deleteCollection(collection.id)
  } catch (err) {
    toast(message(err, 'Could not delete that collection'))
    return
  }
  queryClient.setQueryData<Doc[]>(LIBRARY_KEY, (docs) => docs?.map((d) => ({
    ...d, collections: d.collections?.filter((id) => id !== collection.id),
  })))
  const ui = useLibraryUi.getState()
  if (ui.filter === collectionFilter(collection.id)) ui.setFilter('all')
  await refreshCollections()
}

/** Optimistic, like favorites: the tick moves at once and a failure rolls back through a refetch. */
export async function setInCollection(collection: Collection, docs: Doc[], member: boolean) {
  const ids = docs.map((d) => d.id)
  for (const doc of docs) {
    updateDocInCache(doc.id, (d) => {
      const others = (d.collections ?? []).filter((id) => id !== collection.id)
      return { ...d, collections: member ? [...others, collection.id] : others }
    })
  }
  try {
    await api.changeCollection(collection.id, member ? { add: ids } : { remove: ids })
  } catch (err) {
    toast(message(err, 'Could not change that collection'))
    await refresh()
  }
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
