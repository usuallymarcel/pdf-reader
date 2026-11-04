import { create } from 'zustand'
import { ApiError, uploadDocument } from '../../api/client'
import type { Doc } from '../../api/types'
import { queryClient } from '../../app/queryClient'
import { formatBytes } from '../../offline/downloads'
import { toast } from '../../ui/primitives'
import { LIBRARY_KEY } from '../data'

const CONCURRENCY = 2
const REMOVE_DONE_AFTER_MS = 2500

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed'

export interface UploadItem {
  id: number
  file: File
  status: UploadStatus
  progress: number
  error: string | null
}

interface UploadStore {
  items: UploadItem[]
  /** Adds files, rejecting non-PDFs and anything over the server's limit right away. */
  add: (files: File[], maxUploadMb: number) => void
  cancel: (id: number) => void
  retry: (id: number) => void
  clearFinished: () => void
}

let seq = 0
const controllers = new Map<number, AbortController>()

const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name)

// Lives outside React on purpose: uploads carry on across every route change.
export const useUploads = create<UploadStore>((set, get) => {
  const patch = (id: number, change: Partial<UploadItem>) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...change } : i)) }))
  const drop = (id: number) => set((s) => ({ items: s.items.filter((i) => i.id !== id) }))

  const finish = (id: number, doc: Doc, duplicate: boolean) => {
    patch(id, { status: 'done', progress: 1 })
    window.setTimeout(() => drop(id), REMOVE_DONE_AFTER_MS)
    if (duplicate) toast(`${doc.title} is already in your library`)
    else queryClient.setQueryData<Doc[]>(LIBRARY_KEY, (docs) => (docs ? [doc, ...docs.filter((d) => d.id !== doc.id)] : docs))
    void queryClient.invalidateQueries({ queryKey: LIBRARY_KEY })
  }

  const run = async (item: UploadItem) => {
    const abort = new AbortController()
    controllers.set(item.id, abort)
    patch(item.id, { status: 'uploading', progress: 0, error: null })
    try {
      const { document, duplicate } = await uploadDocument(item.file, (progress) => patch(item.id, { progress }), abort.signal)
      finish(item.id, document, duplicate)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') drop(item.id)
      else patch(item.id, { status: 'failed', error: err instanceof ApiError ? err.message : 'Upload failed' })
    } finally {
      controllers.delete(item.id)
      pump()
    }
  }

  const pump = () => {
    const { items } = get()
    let slots = CONCURRENCY - items.filter((i) => i.status === 'uploading').length
    for (const item of items) {
      if (slots <= 0) break
      if (item.status === 'queued') { slots--; void run(item) }
    }
  }

  return {
    items: [],
    add: (files, maxUploadMb) => {
      const accepted: UploadItem[] = []
      for (const file of files) {
        if (!isPdf(file)) toast(`${file.name} is not a PDF`)
        else if (file.size > maxUploadMb * 1024 * 1024) toast(`${file.name} is ${formatBytes(file.size)}, over the ${maxUploadMb} MB limit`)
        else accepted.push({ id: ++seq, file, status: 'queued', progress: 0, error: null })
      }
      if (accepted.length === 0) return
      set((s) => ({ items: [...s.items, ...accepted] }))
      pump()
    },
    cancel: (id) => {
      const running = controllers.get(id)
      if (running) running.abort()
      else drop(id)
    },
    retry: (id) => { patch(id, { status: 'queued', progress: 0, error: null }); pump() },
    clearFinished: () => set((s) => ({ items: s.items.filter((i) => i.status === 'queued' || i.status === 'uploading') })),
  }
})

let pickerInput: HTMLInputElement | null = null

/** Opens the system file picker. Must be called from a user gesture. */
export function openFilePicker(maxUploadMb: number) {
  pickerInput?.remove()
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = 'application/pdf,.pdf'
  input.hidden = true
  input.addEventListener('change', () => {
    useUploads.getState().add([...(input.files ?? [])], maxUploadMb)
    input.remove()
  })
  document.body.append(input)
  pickerInput = input
  input.click()
}
