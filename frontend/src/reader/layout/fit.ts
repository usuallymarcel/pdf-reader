import type { Fit } from '../../settings/schema'
import type { PageSize } from './spreads'

/** Fractions of the page removed from each side. */
export interface Crop { left: number; right: number; top: number; bottom: number }
export const NO_CROP: Crop = { left: 0, right: 0, top: 0, bottom: 0 }

export interface PageBox { page: number; x: number; y: number; w: number; h: number }
export interface SpreadLayout { w: number; h: number; boxes: PageBox[] }

const CSS_PX_PER_PT = 96 / 72

export function croppedSize(size: PageSize, crop: Crop): [number, number] {
  return [size[0] * (1 - crop.left - crop.right), size[1] * (1 - crop.top - crop.bottom)]
}

/** Lay out a spread (pages already in on-screen order) inside a viewport, all pages at equal height. */
export function layoutSpread(
  pages: readonly number[],
  sizeOf: (page: number) => PageSize,
  vw: number,
  vh: number,
  fit: Fit,
  gap: number,
): SpreadLayout {
  const sizes = pages.map(sizeOf)
  const aspects = sizes.map(([w, h]) => w / h)
  const sumAspect = aspects.reduce((a, b) => a + b, 0) || 1
  const gaps = gap * Math.max(0, pages.length - 1)
  const availW = Math.max(1, vw - gaps)
  let h: number
  if (fit === 'width') h = availW / sumAspect
  else if (fit === 'height') h = vh
  else if (fit === 'original') h = Math.max(...sizes.map((s) => s[1]), 1) * CSS_PX_PER_PT
  else h = Math.min(vh, availW / sumAspect)
  const boxes: PageBox[] = []
  let x = 0
  pages.forEach((page, i) => {
    const w = (aspects[i] ?? 1) * h
    boxes.push({ page, x, y: 0, w, h })
    x += w + gap
  })
  return { w: x - gap, h, boxes }
}

/** Stable crop for a spread: the union of content, applied identically so both pages stay aligned. */
export function spreadCrop(crops: readonly Crop[]): Crop {
  if (!crops.length) return NO_CROP
  return {
    left: Math.min(...crops.map((c) => c.left)),
    right: Math.min(...crops.map((c) => c.right)),
    top: Math.min(...crops.map((c) => c.top)),
    bottom: Math.min(...crops.map((c) => c.bottom)),
  }
}

/** Column width for continuous mode. All pages share it so strips line up. */
export function scrollColumnWidth(fit: Fit, vw: number, vh: number, sizes: readonly PageSize[]): number {
  const step = Math.max(1, Math.floor(sizes.length / 64))
  const aspects: number[] = []
  let maxW = 0
  for (let i = 0; i < sizes.length; i += step) {
    const s = sizes[i]
    if (s) { aspects.push(s[0] / s[1]); maxW = Math.max(maxW, s[0]) }
  }
  aspects.sort((a, b) => a - b)
  const aspect = aspects[aspects.length >> 1] ?? 0.7
  if (fit === 'width') return vw
  if (fit === 'original') return Math.min(maxW * CSS_PX_PER_PT, vw * 6)
  // contain/height: a whole page in view, except long strips, which read best at a phone-like column.
  const webtoon = aspect < 1 / 2
  return webtoon ? Math.min(vw, Math.max(720, vh * 0.75)) : Math.min(vw, vh * aspect)
}

/** Largest width that keeps width×height within maxPixels, for a page of this aspect (w/h). */
export function capRenderWidth(width: number, aspect: number, maxPixels: number, maxSide = 8192): number {
  let w = Math.min(width, maxSide, maxSide * aspect)
  const pixels = (w * w) / aspect
  if (pixels > maxPixels) w = Math.sqrt(maxPixels * aspect)
  return Math.max(1, Math.floor(w))
}
