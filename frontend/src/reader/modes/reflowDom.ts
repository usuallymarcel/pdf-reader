import type { ReflowBlock, ReflowDoc } from '../../api/types'
import type { OutlineItem } from '../../api/types'
import type { ReadingColors } from '../../settings/colorways'
import type { ReaderProfile, ReflowFont, ReflowSettings } from '../../settings/schema'
import { buildReflowIndex, type Anchor, type Position, type ReflowIndex } from '../layout/position'
import { chunkSections, type Section } from '../layout/sections'
import type { PageSize } from '../layout/spreads'
import { PageSlot } from '../pdf/PageSlot'
import type { PageRenderer, PlanItem } from '../pdf/renderer'
import { dpr, type ReaderStage } from './types'

export interface ReflowBook {
  blocks: readonly ReflowBlock[]
  index: ReflowIndex
  sections: Section[]
  lang: string
}

/** Horizontal text extracted from a PDF: pick a language tag so `hyphens:auto` has a dictionary. */
function guessLang(blocks: readonly ReflowBlock[]): string {
  const sample = blocks.slice(0, 40).map((b) => (b.t === 'img' ? '' : b.text)).join(' ').slice(0, 2000)
  if (/[぀-ヿ]/.test(sample)) return 'ja'
  if (/[一-鿿]/.test(sample)) return 'zh'
  if (/[가-힯]/.test(sample)) return 'ko'
  return document.documentElement.lang || 'en'
}

export function buildBook(doc: ReflowDoc, outline: readonly OutlineItem[]): ReflowBook {
  const blocks = doc.blocks
  return {
    blocks,
    index: buildReflowIndex(blocks),
    sections: chunkSections(blocks, 15000, new Set(outline.filter((o) => o.level <= 1).map((o) => o.page))),
    lang: guessLang(blocks),
  }
}

const FONT_STACK: Record<ReflowFont, string> = {
  literata: "'Literata Variable', Georgia, serif",
  inter: "'Inter Variable', system-ui, sans-serif",
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  opendyslexic: "'OpenDyslexic', system-ui, sans-serif",
}

/** Self-hosted webfonts load only when chosen. */
export async function loadFont(font: ReflowFont, size: number): Promise<void> {
  if (font === 'literata') await import('@fontsource-variable/literata/index.css')
  else if (font === 'inter') await import('@fontsource-variable/inter/index.css')
  else if (font === 'opendyslexic') await import('@fontsource/opendyslexic/400.css')
  else return
  const family = FONT_STACK[font].split(',')[0] ?? ''
  await document.fonts.load(`${size}px ${family}`).catch(() => undefined)
}

export function applyTypography(root: HTMLElement, s: ReflowSettings, c: ReadingColors, lang: string) {
  const st = root.style
  st.setProperty('--rf-font', FONT_STACK[s.font])
  st.setProperty('--rf-size', `${s.fontSize}px`)
  st.setProperty('--rf-lh', String(s.lineHeight))
  st.setProperty('--rf-para', `${s.paragraphSpacing}em`)
  st.setProperty('--rf-indent', `${s.indent}em`)
  st.setProperty('--rf-align', s.justify ? 'justify' : 'start')
  st.setProperty('--rf-hyphens', s.hyphenate ? 'auto' : 'manual')
  st.setProperty('--rf-bg', c.bg)
  st.setProperty('--rf-fg', c.fg)
  st.setProperty('--rf-muted', c.muted)
  root.lang = lang
}

/** A key for everything that changes pagination. */
export const typographyKey = (s: ReflowSettings) =>
  [s.font, s.fontSize, s.lineHeight, s.margin, s.maxWidth, s.paragraphSpacing, s.indent, s.columns, s.hyphenate, s.justify].join('|')

export interface SectionDom {
  el: HTMLElement
  slots: PageSlot[]
}

/** Build a section's DOM. All text goes through textContent: nothing from a PDF is ever parsed as HTML. */
export function buildSectionDom(
  book: ReflowBook,
  sectionIndex: number,
  renderer: PageRenderer,
  sizes: readonly PageSize[],
  imgBox: (aspect: number) => { w: number; h: number },
): SectionDom {
  const section = book.sections[sectionIndex] as Section
  const el = document.createElement('section')
  el.className = 'rf-section'
  el.dataset.section = String(sectionIndex)
  const slots: PageSlot[] = []
  for (let i = section.start; i < section.end; i++) {
    const b = book.blocks[i] as ReflowBlock
    let node: HTMLElement
    if (b.t === 'img') {
      node = document.createElement('figure')
      node.className = 'rf-img'
      const size = sizes[b.page - 1] ?? [1, 1]
      const { w, h } = imgBox(size[0] / size[1])
      node.style.height = `${h}px`
      node.style.width = `${w}px`
      const slot = new PageSlot(renderer, b.page)
      slot.layout({ x: 0, y: 0, w, h })
      node.appendChild(slot.el)
      slots.push(slot)
    } else {
      node = document.createElement(b.t === 'h' ? 'h2' : 'p')
      node.textContent = b.text
    }
    node.dataset.b = String(i)
    el.appendChild(node)
  }
  return { el, slots }
}

export function planSlots(renderer: PageRenderer, slots: readonly PageSlot[]) {
  const ratio = dpr()
  const items: PlanItem[] = slots.map((s) => ({ page: s.page, width: s.wantedWidth(ratio) }))
  renderer.plan(items)
}

/** Character offset of the first char in `block` for which `past` holds; rects are monotonic in flow. */
export function firstCharWhere(block: Element, past: (r: DOMRect) => boolean): number {
  const text = block.firstChild
  if (!(text instanceof Text)) return 0
  const range = document.createRange()
  const test = (i: number) => {
    range.setStart(text, i)
    range.setEnd(text, Math.min(i + 1, text.length))
    const r = range.getClientRects()[0]
    return !!r && past(r)
  }
  let lo = 0
  let hi = text.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (test(mid)) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** Client rect of a character inside a block element (or the block itself). */
export function charRect(block: Element, char: number): DOMRect | undefined {
  const text = block.firstChild
  if (char > 0 && text instanceof Text && text.length > 0) {
    const i = Math.min(char, text.length - 1)
    const range = document.createRange()
    range.setStart(text, i)
    range.setEnd(text, i + 1)
    return range.getClientRects()[0] ?? block.getClientRects()[0]
  }
  return block.getClientRects()[0]
}

export const selectionActive = () => {
  const s = window.getSelection()
  return !!s && !s.isCollapsed
}

export interface ReflowStageApi extends ReaderStage {
  anchor(): Anchor
  goToAnchor(a: Anchor): void
}

export type { Position, ReaderProfile }
