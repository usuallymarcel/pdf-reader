import type { ReflowSettings } from '../../settings/schema'

export interface ReflowMetrics {
  columns: number
  /** Column width, px. */
  col: number
  /** Gap between columns, and so between pages, px. */
  gap: number
  /** Distance between consecutive pages, px. */
  step: number
  /** Width of the visible text box, px. */
  box: number
}

/** Rough average glyph width as a fraction of font size: enough to turn "characters" into px. */
const CH_EM = 0.5
const TWO_COLUMN_MIN_WIDTH = 900
const MAX_SPREAD_GAP = 120

export function wantTwoColumns(s: ReflowSettings, vw: number, vh: number): boolean {
  if (s.columns === 1) return false
  const colMin = s.fontSize * CH_EM * 30
  if (vw < colMin * 2 + 2 * s.margin) return false
  return s.columns === 2 || (vw >= TWO_COLUMN_MIN_WIDTH && vw / vh >= 1.2)
}

/**
 * Pagination geometry for CSS columns. All column gaps must be equal, so one page is `columns * (col + gap)`
 * wide and half a gap serves as the outer margin. On a single column the gap fills the viewport,
 * so neighbouring pages stay fully off-screen.
 */
export function reflowMetrics(vw: number, vh: number, s: ReflowSettings): ReflowMetrics {
  const margin = Math.max(s.margin, 12)
  const measure = s.fontSize * CH_EM * s.maxWidth
  if (wantTwoColumns(s, vw, vh)) {
    const minGap = Math.max(margin * 2, 40)
    const col = Math.floor(Math.min(measure, (vw - 2 * minGap) / 2))
    const gap = Math.floor(Math.min((vw - 2 * col) / 2, MAX_SPREAD_GAP))
    return { columns: 2, col, gap, step: 2 * (col + gap), box: 2 * (col + gap) }
  }
  const col = Math.floor(Math.min(measure, vw - 2 * margin))
  const gap = Math.floor(vw) - col
  return { columns: 1, col, gap, step: col + gap, box: col + gap }
}
