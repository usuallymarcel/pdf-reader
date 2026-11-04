import type { Doc, ReflowBlock } from '../../api/types'

/** Where the reader is, in source-PDF terms: shared by every mode. */
export interface Position { page: number; offset: number }

/** A place inside the reflow document. */
export interface Anchor { block: number; char: number }

const blockLength = (b: ReflowBlock) => (b.t === 'img' ? 200 : b.text.length + 1)

export interface ReflowIndex {
  blocks: readonly ReflowBlock[]
  /** cumulative chars before block i; length blocks.length + 1 */
  cum: number[]
  /** page -> indexes of blocks starting on it */
  byPage: Map<number, number[]>
  pagesAsc: number[]
  total: number
}

export function buildReflowIndex(blocks: readonly ReflowBlock[]): ReflowIndex {
  const cum: number[] = [0]
  const byPage = new Map<number, number[]>()
  blocks.forEach((b, i) => {
    cum.push((cum[i] ?? 0) + blockLength(b))
    const list = byPage.get(b.page)
    if (list) list.push(i)
    else byPage.set(b.page, [i])
  })
  return { blocks, cum, byPage, pagesAsc: [...byPage.keys()].sort((a, b) => a - b), total: cum[blocks.length] ?? 0 }
}

/** Page and in-page fraction for a reflow anchor. */
export function anchorToPosition(ix: ReflowIndex, a: Anchor): Position {
  const block = ix.blocks[a.block]
  if (!block) return { page: 1, offset: 0 }
  const list = ix.byPage.get(block.page) ?? [a.block]
  const first = list[0] ?? a.block
  const last = list[list.length - 1] ?? a.block
  const start = ix.cum[first] ?? 0
  const end = ix.cum[last + 1] ?? start + 1
  const at = (ix.cum[a.block] ?? 0) + a.char
  return { page: block.page, offset: Math.min(0.999, Math.max(0, (at - start) / Math.max(1, end - start))) }
}

/** Nearest reflow anchor for a page position. Pages with no block starting on them map to the block before. */
export function positionToAnchor(ix: ReflowIndex, pos: Position): Anchor {
  if (!ix.blocks.length) return { block: 0, char: 0 }
  const list = ix.byPage.get(pos.page)
  if (!list) {
    let lo = 0
    let hi = ix.pagesAsc.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if ((ix.pagesAsc[mid] ?? 0) <= pos.page) { found = mid; lo = mid + 1 } else hi = mid - 1
    }
    if (found < 0) return { block: 0, char: 0 }
    const last = ix.byPage.get(ix.pagesAsc[found] ?? 0) ?? [0]
    return { block: last[last.length - 1] ?? 0, char: 0 }
  }
  const first = list[0] ?? 0
  const lastBlock = list[list.length - 1] ?? 0
  const start = ix.cum[first] ?? 0
  const end = ix.cum[lastBlock + 1] ?? start
  const target = start + pos.offset * (end - start)
  let block = first
  for (const i of list) {
    if ((ix.cum[i] ?? 0) <= target + 0.5) block = i
    else break
  }
  const char = Math.max(0, Math.round(target - (ix.cum[block] ?? 0)))
  const b = ix.blocks[block]
  return { block, char: b && b.t !== 'img' ? Math.min(char, b.text.length) : 0 }
}

/** Fraction of the book read at an anchor. */
export const anchorFraction = (ix: ReflowIndex, a: Anchor) =>
  ix.total ? ((ix.cum[a.block] ?? 0) + a.char) / ix.total : 0

/** Offset within the page as saved for scroll mode: fraction of page height above the viewport top. */
export function scrollPosition(tops: readonly number[], scrollTop: number): Position {
  let lo = 0
  let hi = tops.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((tops[mid] ?? 0) <= scrollTop) lo = mid
    else hi = mid - 1
  }
  const top = tops[lo] ?? 0
  const h = (tops[lo + 1] ?? top + 1) - top
  return { page: lo + 1, offset: Math.min(0.999, Math.max(0, (scrollTop - top) / Math.max(1, h))) }
}

/** The adjacent volume in the same series, ordered by volume number. */
export function adjacentVolume(library: readonly Doc[], doc: Pick<Doc, 'id' | 'series' | 'volume'>, step: 1 | -1): Doc | null {
  if (!doc.series || doc.volume === null) return null
  let best: Doc | null = null
  for (const d of library) {
    if (d.id === doc.id || d.series !== doc.series || d.volume === null || d.status !== 'ready') continue
    if ((d.volume - doc.volume) * step <= 0) continue
    if (!best || (d.volume - (best.volume ?? 0)) * step < 0) best = d
  }
  return best
}
