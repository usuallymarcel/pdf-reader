import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { ApiError, api } from '../api/client'
import type { Doc } from '../api/types'
import { queryClient } from '../app/queryClient'
import { useOnline, useSession } from '../app/session'
import { downloadedDocs, useDownloads } from '../offline/downloads'
import { overlayQueuedProgress } from '../offline/progress'
import { useLibraryUi, type LibraryFilter, type LibrarySort } from './uiStore'

export const LIBRARY_KEY = ['library'] as const

async function fetchLibrary() {
  try {
    return await overlayQueuedProgress(await api.library())
  } catch (err) {
    if (err instanceof ApiError) throw err
    return overlayQueuedProgress(downloadedDocs()) // unreachable, and the worker has no copy either
  }
}

/** Every doc the current scope can see, minus deletes waiting out their undo window. */
export function useLibrary() {
  const { data: session } = useSession()
  const online = useOnline()
  const hidden = useLibraryUi((s) => s.pendingDeletes)
  const downloaded = useDownloads((s) => s.books)
  const enabled = !!session && (session.mode === 'global' || !!session.user)
  const query = useQuery({
    queryKey: LIBRARY_KEY,
    queryFn: fetchLibrary,
    enabled,
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === 'processing') ? 2000 : false),
  })
  const docs = useMemo(() => {
    const all = query.data ?? []
    if (online) return all.filter((d) => !hidden.includes(d.id))
    // Offline only what can actually be opened, even books newer than the cached library.
    const known = new Set(all.map((d) => d.id))
    const extra = Object.values(downloaded).map((b) => b.doc).filter((d) => !known.has(d.id))
    return [...all.filter((d) => downloaded[d.id]), ...extra]
  }, [query.data, hidden, online, downloaded])
  return { ...query, docs }
}

export function updateDocInCache(id: string, change: (doc: Doc) => Doc) {
  queryClient.setQueryData<Doc[]>(LIBRARY_KEY, (docs) => docs?.map((d) => (d.id === id ? change(d) : d)))
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
export const naturalCompare = (a: string, b: string) => collator.compare(a, b)

export function compareVolumes(a: Doc, b: Doc) {
  if (a.volume !== null && b.volume !== null && a.volume !== b.volume) return a.volume - b.volume
  if (a.volume !== null && b.volume === null) return -1
  if (a.volume === null && b.volume !== null) return 1
  return naturalCompare(a.title, b.title)
}

export const progressOf = (doc: Doc) =>
  doc.state.finished ? 1 : doc.page_count > 0 ? Math.min(1, doc.state.page / doc.page_count) : 0

export const isStarted = (doc: Doc) => doc.state.finished || doc.state.page > 1 || doc.state.seconds_read > 0
export const isReading = (doc: Doc) => !doc.state.finished && isStarted(doc)

export function continueReading(docs: Doc[], limit = 12) {
  return docs
    .filter((d) => d.status === 'ready' && isReading(d) && d.state.last_read_at)
    .sort((a, b) => (b.state.last_read_at ?? '').localeCompare(a.state.last_read_at ?? ''))
    .slice(0, limit)
}

export function matchesFilter(doc: Doc, filter: LibraryFilter, downloaded: Record<string, unknown>) {
  switch (filter) {
    case 'all': return true
    case 'reading': return isReading(doc)
    case 'unread': return !isStarted(doc)
    case 'finished': return doc.state.finished
    case 'favorites': return doc.state.favorite
    case 'manga': return doc.kind === 'manga'
    case 'novels': return doc.kind === 'novel'
    case 'downloaded': return !!downloaded[doc.id]
  }
}

export function matchesQuery(doc: Doc, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [doc.title, doc.series, doc.author, doc.filename].some((v) => v?.toLowerCase().includes(q))
}

export type ShelfItem =
  | { type: 'doc'; key: string; doc: Doc }
  | { type: 'series'; key: string; name: string; docs: Doc[] }

/** Multi-volume series collapse to one stack. A lone volume stays an ordinary book. */
export function toShelfItems(docs: Doc[], group: boolean): ShelfItem[] {
  if (!group) return docs.map((doc) => ({ type: 'doc', key: doc.id, doc }))
  const bySeries = new Map<string, Doc[]>()
  for (const doc of docs) if (doc.series) bySeries.set(doc.series, [...(bySeries.get(doc.series) ?? []), doc])
  const seen = new Set<string>()
  const items: ShelfItem[] = []
  for (const doc of docs) {
    const volumes = doc.series ? bySeries.get(doc.series) : undefined
    if (!doc.series || !volumes || volumes.length < 2) items.push({ type: 'doc', key: doc.id, doc })
    else if (!seen.has(doc.series)) {
      seen.add(doc.series)
      items.push({ type: 'series', key: `series:${doc.series}`, name: doc.series, docs: [...volumes].sort(compareVolumes) })
    }
  }
  return items
}

const itemDocs = (item: ShelfItem) => (item.type === 'doc' ? [item.doc] : item.docs)
const latest = (values: (string | null)[]) => values.reduce<string>((m, v) => (v && v > m ? v : m), '')
const itemTitle = (item: ShelfItem) => (item.type === 'doc' ? item.doc.series ?? item.doc.title : item.name)
const itemProgress = (item: ShelfItem) => {
  const docs = itemDocs(item)
  return docs.reduce((sum, d) => sum + progressOf(d), 0) / docs.length
}

export function sortItems(items: ShelfItem[], sort: LibrarySort): ShelfItem[] {
  const decorated = items.map((item) => {
    const docs = itemDocs(item)
    switch (sort) {
      case 'recent': return { item, key: latest(docs.map((d) => d.state.last_read_at ?? d.created_at)) }
      case 'added': return { item, key: latest(docs.map((d) => d.created_at)) }
      case 'title': return { item, key: itemTitle(item) }
      case 'progress': return { item, key: itemProgress(item) }
    }
  })
  return decorated.sort((a, b) => {
    if (sort === 'title') return naturalCompare(a.key as string, b.key as string)
    if (sort === 'progress') return (b.key as number) - (a.key as number)
    return (b.key as string).localeCompare(a.key as string)
  }).map((d) => d.item)
}

/** The volume to continue: the one in progress, otherwise the first not finished. */
export function nextUnread(volumes: Doc[]) {
  const open = volumes.filter((d) => !d.state.finished && d.status === 'ready')
  return open.find(isStarted) ?? open[0] ?? null
}

export function volumeLabel(doc: Doc) {
  return doc.volume !== null ? `Vol. ${doc.volume}` : null
}
