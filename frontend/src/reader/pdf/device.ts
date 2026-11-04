export interface DeviceLimits {
  /** Pixel budget for rendered pages. */
  pixels: number
  /** Pixel budget for thumbnails. */
  thumbPixels: number
  /** Largest single canvas (iOS refuses anything over 16.7MP). */
  maxCanvasPixels: number
  concurrency: number
  /** Range-chunk bytes retained by the PDF worker before the document is quietly reopened. */
  recycleBytes: number
}

const MP = 1_000_000
const MB = 1024 * 1024

export function deviceLimits(memoryGb: number | undefined, phone: boolean): DeviceLimits {
  const low = memoryGb !== undefined && memoryGb <= 2
  const pixels = phone ? (low ? 24 : 40) * MP : low ? 40 * MP : 150 * MP
  return {
    pixels,
    thumbPixels: (phone ? 6 : 16) * MP,
    maxCanvasPixels: Math.min(16.7 * MP, pixels / 3),
    concurrency: phone ? 1 : 2,
    recycleBytes: (phone ? 192 : 1024) * MB,
  }
}

export function detectLimits(): DeviceLimits {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const coarse = window.matchMedia('(pointer: coarse)').matches
  const phone = coarse && Math.min(screen.width, screen.height) < 820
  return deviceLimits(memory, phone)
}

export const devicePixelRatioCapped = () => Math.min(window.devicePixelRatio || 1, 3)
