import { create } from 'zustand'

export type LibrarySort = 'recent' | 'added' | 'title' | 'progress'
export type LibraryFilter = 'all' | 'reading' | 'unread' | 'finished' | 'favorites' | 'manga' | 'novels' | 'downloaded'

const STORAGE_KEY = 'shelf.library-ui'

interface Stored { sort: LibrarySort; filter: LibraryFilter }

function load(): Stored {
  try {
    return { sort: 'recent', filter: 'all', ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Stored> }
  } catch {
    return { sort: 'recent', filter: 'all' }
  }
}

interface LibraryUi extends Stored {
  query: string
  /** open details sheet */
  sheetDocId: string | null
  /** null: not in multi-select mode */
  selected: string[] | null
  /** hidden from view while their undo toast is up */
  pendingDeletes: string[]
  setSort: (sort: LibrarySort) => void
  setFilter: (filter: LibraryFilter) => void
  setQuery: (query: string) => void
  openSheet: (id: string | null) => void
  startSelecting: (ids?: string[]) => void
  toggleSelected: (ids: string[]) => void
  stopSelecting: () => void
  hideDeleted: (ids: string[]) => void
  restoreDeleted: (ids: string[]) => void
}

export const useLibraryUi = create<LibraryUi>((set, get) => {
  const persist = () => {
    const { sort, filter } = get()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sort, filter }))
  }
  return {
    ...load(),
    query: '',
    sheetDocId: null,
    selected: null,
    pendingDeletes: [],
    setSort: (sort) => { set({ sort }); persist() },
    setFilter: (filter) => { set({ filter }); persist() },
    setQuery: (query) => set({ query }),
    openSheet: (sheetDocId) => set({ sheetDocId }),
    startSelecting: (ids = []) => set({ selected: ids, sheetDocId: null }),
    toggleSelected: (ids) => set((s) => {
      const current = s.selected ?? []
      const allIn = ids.every((id) => current.includes(id))
      return { selected: allIn ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])] }
    }),
    stopSelecting: () => set({ selected: null }),
    hideDeleted: (ids) => set((s) => ({ pendingDeletes: [...s.pendingDeletes, ...ids] })),
    restoreDeleted: (ids) => set((s) => ({ pendingDeletes: s.pendingDeletes.filter((id) => !ids.includes(id)) })),
  }
})
