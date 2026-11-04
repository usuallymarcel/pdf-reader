import { create } from 'zustand'
import type { Position } from './layout/position'

export type Panel = 'contents' | 'search' | 'settings' | 'shortcuts' | null

interface ReaderUi {
  position: Position
  /** 0..1 through the book */
  fraction: number
  chrome: boolean
  panel: Panel
  atEnd: boolean
  zoomed: boolean
  set(patch: Partial<Omit<ReaderUi, 'set'>>): void
}

/** Live reader UI state. Only chrome subscribes to it, so a page turn never re-renders the stage. */
export const useReaderUi = create<ReaderUi>((set) => ({
  position: { page: 1, offset: 0 },
  fraction: 0,
  chrome: false,
  panel: null,
  atEnd: false,
  zoomed: false,
  set,
}))
