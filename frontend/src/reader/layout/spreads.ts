import type { Spreads } from '../../settings/schema'

export type PageSize = readonly [number, number]

export interface Spread {
  /** 1-based source pages in reading order (1 or 2 entries). */
  pages: number[]
}

export interface SpreadOptions {
  double: boolean
  coverAlone: boolean
  /** Shift the pairing by one, for scans whose facing pages are misaligned. */
  shift: boolean
}

export const isWide = (size: PageSize | undefined): boolean => !!size && size[0] > size[1]

/** Group pages into spreads. Landscape pages are a spread in their own right and restart pairing. */
export function buildSpreads(sizes: readonly PageSize[], opts: SpreadOptions): Spread[] {
  const out: Spread[] = []
  if (!opts.double) {
    for (let i = 0; i < sizes.length; i++) out.push({ pages: [i + 1] })
    return out
  }
  let solo = (opts.coverAlone ? 1 : 0) + (opts.shift ? 1 : 0)
  for (let i = 0; i < sizes.length; i++) {
    const page = i + 1
    if (solo > 0 || isWide(sizes[i])) {
      solo = Math.max(0, solo - 1)
      out.push({ pages: [page] })
    } else if (i + 1 < sizes.length && !isWide(sizes[i + 1])) {
      out.push({ pages: [page, page + 1] })
      i++
    } else {
      out.push({ pages: [page] })
    }
  }
  return out
}

export function spreadIndexOfPage(spreads: readonly Spread[], page: number): number {
  let lo = 0
  let hi = spreads.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    const first = spreads[mid]?.pages[0] ?? 1
    if (first <= page) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Left-to-right on-screen order: RTL books show the first page on the right. */
export const visualPages = (spread: Spread, rtl: boolean): number[] =>
  rtl ? [...spread.pages].reverse() : spread.pages

function medianAspect(sizes: readonly PageSize[]): number {
  if (!sizes.length) return 0.7
  const step = Math.max(1, Math.floor(sizes.length / 64))
  const sample: number[] = []
  for (let i = 0; i < sizes.length; i += step) {
    const s = sizes[i]
    if (s) sample.push(s[0] / s[1])
  }
  sample.sort((a, b) => a - b)
  return sample[sample.length >> 1] ?? 0.7
}

/** spreads:'auto' = double when the viewport is landscape with enough width and the pages are portrait. */
export function shouldDouble(setting: Spreads, vw: number, vh: number, sizes: readonly PageSize[]): boolean {
  if (setting === 'double') return true
  if (setting === 'single') return false
  return vw / Math.max(1, vh) >= 1.15 && vw >= 640 && medianAspect(sizes) < 1
}

/** Spread indexes to keep rendered, in priority order: current, then ahead, then one behind. */
export function renderOrder(current: number, total: number, ahead: number): number[] {
  const out: number[] = []
  if (current >= 0 && current < total) out.push(current)
  for (let i = 1; i <= ahead && current + i < total; i++) out.push(current + i)
  if (current - 1 >= 0) out.push(current - 1)
  return out
}
