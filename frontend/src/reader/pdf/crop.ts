import type { Crop } from '../layout/fit'

const MAX_CROP = 0.25
const PAD = 0.008
/** A row/column counts as content when this share of its pixels differ from the background. */
const INK = 0.006
const TOLERANCE = 28

/**
 * Detect page margins from a small RGBA render. The background is taken from the four corners, so both
 * white and black (scanned) margins work. The result is a little conservative: never eats into content.
 */
export function detectCrop(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Crop {
  const lum = (i: number) => ((rgba[i] ?? 0) * 3 + (rgba[i + 1] ?? 0) * 6 + (rgba[i + 2] ?? 0)) / 10
  const at = (x: number, y: number) => lum((y * w + x) * 4)
  const corners = [at(1, 1), at(w - 2, 1), at(1, h - 2), at(w - 2, h - 2)].sort((a, b) => a - b)
  const bg = ((corners[1] ?? 0) + (corners[2] ?? 0)) / 2

  const rowHasInk = (y: number) => {
    let n = 0
    for (let x = 0; x < w; x++) if (Math.abs(at(x, y) - bg) > TOLERANCE) n++
    return n > w * INK
  }
  const colHasInk = (x: number) => {
    let n = 0
    for (let y = 0; y < h; y++) if (Math.abs(at(x, y) - bg) > TOLERANCE) n++
    return n > h * INK
  }

  const limitX = Math.floor(w * MAX_CROP)
  const limitY = Math.floor(h * MAX_CROP)
  let top = 0
  while (top < limitY && !rowHasInk(top)) top++
  let bottom = 0
  while (bottom < limitY && !rowHasInk(h - 1 - bottom)) bottom++
  let left = 0
  while (left < limitX && !colHasInk(left)) left++
  let right = 0
  while (right < limitX && !colHasInk(w - 1 - right)) right++

  const f = (v: number, dim: number) => Math.max(0, v / dim - PAD)
  return { left: f(left, w), right: f(right, w), top: f(top, h), bottom: f(bottom, h) }
}
