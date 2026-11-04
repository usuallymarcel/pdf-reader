/** Pan/zoom state of one piece of content inside a viewport. x/y: content origin in viewport px. */
export interface View { s: number; x: number; y: number }
export interface Dimensions { cw: number; ch: number; vw: number; vh: number }

export const MIN_ZOOM = 1
export const MAX_ZOOM = 6

/** Allowed x/y range. When content is smaller than the viewport the range collapses to centred. */
export function panRange(s: number, d: Dimensions) {
  const w = d.cw * s
  const h = d.ch * s
  const minX = w <= d.vw ? (d.vw - w) / 2 : d.vw - w
  const maxX = w <= d.vw ? (d.vw - w) / 2 : 0
  const minY = h <= d.vh ? (d.vh - h) / 2 : d.vh - h
  const maxY = h <= d.vh ? (d.vh - h) / 2 : 0
  return { minX, maxX, minY, maxY }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function clampView(v: View, d: Dimensions): View {
  const s = clamp(v.s, MIN_ZOOM, MAX_ZOOM)
  const r = panRange(s, d)
  return { s, x: clamp(v.x, r.minX, r.maxX), y: clamp(v.y, r.minY, r.maxY) }
}

/** Zoom to `s` keeping the content point under the viewport focal point fixed. */
export function zoomAt(v: View, s: number, fx: number, fy: number): View {
  const k = s / v.s
  return { s, x: fx - (fx - v.x) * k, y: fy - (fy - v.y) * k }
}

/** Rubber-band: past the limit, displacement approaches `dim` asymptotically. */
export function rubber(over: number, dim: number): number {
  const a = Math.abs(over)
  return Math.sign(over) * dim * (1 - 1 / ((a * 0.55) / dim + 1))
}

/** Apply rubber-band resistance to a value beyond [lo, hi]. */
export function rubberClamp(v: number, lo: number, hi: number, dim: number): number {
  if (v < lo) return lo + rubber(v - lo, dim)
  if (v > hi) return hi + rubber(v - hi, dim)
  return v
}

/** Rubber-banded zoom scale, for pinching beyond the limits. */
export function rubberScale(s: number): number {
  if (s < MIN_ZOOM) return MIN_ZOOM - rubber(MIN_ZOOM - s, 0.35)
  if (s > MAX_ZOOM) return MAX_ZOOM + rubber(s - MAX_ZOOM, 1.2)
  return s
}
