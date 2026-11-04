import { resolveColors } from '../../settings/colorways'
import type { ReaderProfile } from '../../settings/schema'
import { GestureRecognizer } from '../input/gestures'
import { reducedMotion } from '../input/spring'
import { resolveTap } from '../input/tapZones'
import { anchorFraction, anchorToPosition, positionToAnchor, type Anchor, type Position } from '../layout/position'
import { reflowMetrics } from '../layout/reflowMetrics'
import { sectionOfBlock } from '../layout/sections'
import {
  applyTypography, buildSectionDom, charRect, firstCharWhere, loadFont, planSlots, selectionActive, typographyKey,
  type ReflowBook, type ReflowStageApi, type SectionDom,
} from './reflowDom'
import type { StageEnv } from './types'

const CHARS_PER_LINE_PAD = 1.08
const EMIT_MS = 180

/** Reflowed text on native scrolling. Three sections live in the DOM; spacers stand in for the rest. */
export class ReflowScroll implements ReflowStageApi {
  private column = document.createElement('div')
  private topSpacer = document.createElement('div')
  private bottomSpacer = document.createElement('div')
  private mounted = new Map<number, SectionDom>()
  private heights: number[] = []
  private measuredKey = ''
  private lo = 0
  private hi = -1
  private cachedAnchor: Anchor
  private raf = 0
  private emitTimer: number | undefined
  private gestures: GestureRecognizer
  private resize: ResizeObserver
  private ac = new AbortController()
  private destroyed = false
  private colWidth = 0
  private wasAtEnd = false
  private lastPage = 0
  /** A jump moved the scroll position, as opposed to the reader scrolling. */
  private jumped = false

  constructor(
    private root: HTMLElement,
    private env: StageEnv,
    private book: ReflowBook,
    private profile: ReaderProfile,
    start: Anchor,
  ) {
    this.cachedAnchor = start
    root.classList.add('reflow-stage', 'reflow-scroll')
    this.column.className = 'rf-column'
    this.column.append(this.topSpacer, this.bottomSpacer, env.endCard)
    root.appendChild(this.column)
    this.gestures = new GestureRecognizer(root, {
      ignore: (e) => selectionActive() && e.pointerType !== 'mouse',
      delayTap: () => false,
      onTap: (x, y) => this.tap(x, y),
      onDoubleTap: () => undefined,
    })
    root.addEventListener('scroll', this.onScroll, { passive: true, signal: this.ac.signal })
    this.layout(start)
    void this.ensureFont()
    this.resize = new ResizeObserver(() => this.layout(this.cachedAnchor))
    this.resize.observe(root)
  }

  private async ensureFont() {
    const s = this.profile.reflow
    await loadFont(s.font, s.fontSize)
    if (!this.destroyed && this.profile.reflow.font === s.font) this.layout(this.cachedAnchor, true)
  }

  private estimate() {
    const s = this.profile.reflow
    const charPx = s.fontSize * 0.46 * CHARS_PER_LINE_PAD
    const perLine = Math.max(10, this.colWidth / charPx)
    const lineH = s.fontSize * s.lineHeight
    return this.book.sections.map((sec) => (sec.chars / perLine) * lineH * 1.1)
  }

  private clear() {
    for (const m of this.mounted.values()) {
      for (const s of m.slots) s.destroy()
      m.el.remove()
    }
    this.mounted.clear()
    this.lo = 0
    this.hi = -1
  }

  private layout(anchor: Anchor, force = false) {
    const p = this.profile
    applyTypography(this.root, p.reflow, resolveColors(p), this.book.lang)
    const vw = this.root.clientWidth
    const col = reflowMetrics(vw, this.root.clientHeight, { ...p.reflow, columns: 1 }).col
    const key = `${typographyKey(p.reflow)}|${col}`
    if (key === this.measuredKey && !force) return
    this.measuredKey = key
    this.colWidth = col
    this.column.style.width = `${col}px`
    this.heights = this.estimate()
    this.clear()
    this.showAnchor(anchor)
  }

  private imgBox = (aspect: number) => {
    const w = Math.min(this.colWidth, this.root.clientHeight * 0.9 * aspect)
    return { w: Math.floor(w), h: Math.floor(w / aspect) }
  }

  private sumHeights(from: number, to: number) {
    let t = 0
    for (let i = from; i < to; i++) t += this.heights[i] ?? 0
    return t
  }

  /** Move the mounted window, keeping `ref` (a section staying mounted) visually still. */
  private setWindow(lo: number, hi: number, ref: number | null) {
    const refEl = ref !== null ? this.mounted.get(ref)?.el : undefined
    const refTop = refEl?.getBoundingClientRect().top
    for (const [i, m] of this.mounted) {
      if (i < lo || i > hi) {
        this.heights[i] = m.el.offsetHeight
        for (const s of m.slots) s.destroy()
        m.el.remove()
        this.mounted.delete(i)
      }
    }
    for (let i = lo; i <= hi; i++) {
      if (this.mounted.has(i)) continue
      const dom = buildSectionDom(this.book, i, this.env.renderer, this.env.sizes, this.imgBox)
      const next = this.mounted.get(i + 1)?.el ?? this.bottomSpacer
      this.column.insertBefore(dom.el, next)
      this.mounted.set(i, dom)
    }
    this.lo = lo
    this.hi = hi
    this.topSpacer.style.height = `${this.sumHeights(0, lo)}px`
    this.bottomSpacer.style.height = `${this.sumHeights(hi + 1, this.heights.length)}px`
    for (let i = lo; i <= hi; i++) {
      const h = this.mounted.get(i)?.el.offsetHeight
      if (h) this.heights[i] = h
    }
    if (refEl && refTop !== undefined) {
      // Writing scrollTop stops a smooth scroll, so leave it alone unless something really moved.
      const shift = refEl.getBoundingClientRect().top - refTop
      if (Math.abs(shift) >= 1) this.root.scrollTop += shift
    }
    planSlots(this.env.renderer, [...this.mounted.values()].flatMap((m) => m.slots))
  }

  private showAnchor(a: Anchor) {
    const sec = sectionOfBlock(this.book.sections, a.block)
    const last = this.book.sections.length - 1
    this.setWindow(Math.max(0, sec - 1), Math.min(last, sec + 1), null)
    const block = this.mounted.get(sec)?.el.querySelector(`[data-b="${a.block}"]`)
    const rect = block && charRect(block, a.char)
    if (rect) this.root.scrollTop += rect.top - this.root.getBoundingClientRect().top - 24
    this.cachedAnchor = a
    this.jumped = true
  }

  private currentSection(): number {
    const viewMid = this.root.getBoundingClientRect().top + this.root.clientHeight / 2
    for (const [i, m] of this.mounted) {
      const r = m.el.getBoundingClientRect()
      if (r.top <= viewMid && r.bottom >= viewMid) return i
    }
    // Scrolled into a spacer: work it out from section heights.
    const y = this.root.scrollTop + this.root.clientHeight / 2
    let t = 0
    for (let i = 0; i < this.heights.length; i++) {
      t += this.heights[i] ?? 0
      if (t >= y) return i
    }
    return this.heights.length - 1
  }

  private onScroll = () => {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      const sec = this.currentSection()
      const last = this.book.sections.length - 1
      const lo = Math.max(0, sec - 1)
      const hi = Math.min(last, sec + 1)
      if (lo !== this.lo || hi !== this.hi) this.setWindow(lo, hi, this.mounted.has(sec) ? sec : null)
      const rootBottom = this.root.scrollTop + this.root.clientHeight
      const atEnd = rootBottom >= this.root.scrollHeight - this.env.endCard.offsetHeight * 0.5
      if (atEnd !== this.wasAtEnd) { this.wasAtEnd = atEnd; this.env.onEndCard(atEnd) }
      window.clearTimeout(this.emitTimer)
      this.emitTimer = window.setTimeout(() => this.emit(), EMIT_MS)
    })
  }

  private emit() {
    if (this.destroyed) return
    this.cachedAnchor = this.locate()
    const pos = anchorToPosition(this.book.index, this.cachedAnchor)
    if (pos.page !== this.lastPage && !this.jumped) this.env.onFlip() // scrolling on puts the bars away
    this.lastPage = pos.page
    this.jumped = false
    this.env.onPosition(pos, anchorFraction(this.book.index, this.cachedAnchor))
  }

  private locate(): Anchor {
    const top = this.root.getBoundingClientRect().top + 2
    // In document order: after scrolling back up the map's insertion order is not.
    const sections = [...this.mounted.entries()].sort((a, b) => a[0] - b[0])
    for (const [, m] of sections) {
      const r = m.el.getBoundingClientRect()
      if (r.bottom <= top) continue
      const blocks = m.el.children
      let lo = 0
      let hi = blocks.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if ((blocks[mid] as Element).getBoundingClientRect().bottom > top) hi = mid
        else lo = mid + 1
      }
      const block = blocks[lo] as HTMLElement
      const char = block.getBoundingClientRect().top >= top ? 0 : firstCharWhere(block, (c) => c.bottom > top)
      return { block: Number(block.dataset.b), char }
    }
    return this.cachedAnchor
  }

  private tap(x: number, y: number) {
    if (selectionActive()) return
    if (this.env.overlayOpen()) { this.env.dismissOverlay(); return }
    const p = this.profile
    const action = resolveTap(p.tapLayout, x / this.root.clientWidth, y / this.root.clientHeight, false, p.tapInvert)
    if (action === 'menu') this.env.onMenuTap()
    else if (action === 'next') this.next()
    else this.prev()
  }

  private scrollPage(sign: number) {
    this.root.scrollBy({ top: sign * this.root.clientHeight * 0.88, behavior: reducedMotion() || this.profile.transition === 'none' ? 'auto' : 'smooth' })
    this.env.onFlip()
  }

  next() {
    if (this.root.scrollTop + this.root.clientHeight >= this.root.scrollHeight - 2) {
      if (this.env.hasNext() && this.profile.autoNextVolume) this.env.onPastEnd()
      else this.env.onBoundary('end')
      return
    }
    this.scrollPage(1)
  }

  prev() {
    if (this.root.scrollTop <= 0) { this.env.onBoundary('start'); return }
    this.scrollPage(-1)
  }

  update(profile: ReaderProfile) {
    const fontChanged = profile.reflow.font !== this.profile.reflow.font
    const a = this.cachedAnchor
    this.profile = profile
    this.layout(a)
    applyTypography(this.root, profile.reflow, resolveColors(profile), this.book.lang)
    if (fontChanged) void this.ensureFont()
  }

  anchor() { return this.cachedAnchor }

  goToAnchor(a: Anchor) {
    this.showAnchor(a)
    this.env.onPosition(anchorToPosition(this.book.index, a), anchorFraction(this.book.index, a))
  }

  goTo(pos: Position) { this.goToAnchor(positionToAnchor(this.book.index, pos)) }

  goToEnd() {
    const last = this.book.sections.length - 1
    this.setWindow(Math.max(0, last - 1), last, null)
    this.root.scrollTop = this.root.scrollHeight
  }

  position(): Position { return anchorToPosition(this.book.index, this.cachedAnchor) }

  zoomBy() { /* type size is a setting */ }
  zoomReset() { /* type size is a setting */ }

  destroy() {
    this.destroyed = true
    this.ac.abort()
    this.resize.disconnect()
    this.gestures.destroy()
    cancelAnimationFrame(this.raf)
    window.clearTimeout(this.emitTimer)
    this.clear()
    this.env.endCard.remove()
    this.column.remove()
    this.root.classList.remove('reflow-stage', 'reflow-scroll')
    this.root.removeAttribute('style')
  }
}
