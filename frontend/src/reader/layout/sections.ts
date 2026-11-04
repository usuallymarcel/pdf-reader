import type { ReflowBlock } from '../../api/types'

export interface Section { start: number; end: number; chars: number }

const size = (b: ReflowBlock) => (b.t === 'img' ? 400 : b.text.length + 1)

/**
 * Split the book into sections of roughly `target` chars so the DOM stays small. Breaks land on block
 * boundaries; headings and outline pages attract a break once a section is 60% full; a block is never split.
 */
export function chunkSections(blocks: readonly ReflowBlock[], target = 15000, outlinePages?: ReadonlySet<number>): Section[] {
  const out: Section[] = []
  let start = 0
  let chars = 0
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1]
    const heading = b.t === 'h' || (!!outlinePages?.has(b.page) && !!prev && prev.page !== b.page)
    if (i > start && (chars >= target || (heading && chars >= target * 0.6))) {
      out.push({ start, end: i, chars })
      start = i
      chars = 0
    }
    chars += size(b)
  })
  if (start < blocks.length) {
    const last = out[out.length - 1]
    if (last && chars < target * 0.15) { last.end = blocks.length; last.chars += chars }
    else out.push({ start, end: blocks.length, chars })
  }
  return out
}

export function sectionOfBlock(sections: readonly Section[], block: number): number {
  let lo = 0
  let hi = sections.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((sections[mid]?.start ?? 0) <= block) lo = mid
    else hi = mid - 1
  }
  return lo
}
