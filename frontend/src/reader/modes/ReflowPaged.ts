import { resolveColors } from '../../settings/colorways'
import type { ReaderProfile } from '../../settings/schema'
import { GestureRecognizer } from '../input/gestures'
import { reducedMotion, runSpring } from '../input/spring'
import { resolveTap } from '../input/tapZones'
import { WheelPager } from '../input/wheelPager'
import { anchorFraction, anchorToPosition, positionToAnchor, type Anchor, type Position } from '../layout/position'
import { reflowMetrics, type ReflowMetrics } from '../layout/reflowMetrics'
import { sectionOfBlock } from '../layout/sections'
import { rubberClamp } from '../layout/viewTransform'
import {
  applyTypography, buildSectionDom, charRect, firstCharWhere, loadFont, planSlots, selectionActive, typographyKey,
  type ReflowBook, type ReflowStageApi, type SectionDom,
} from './reflowDom'
import type { StageEnv } from './types'

const FLIP_DISTANCE = 0.2
const FLIP_VELOCITY = 0.3

interface Mounted extends SectionDom {
  index: number
  pages: number
  left: number
}

/** Reflowed text paginated with CSS columns. Only the current section and its neighbours are in the DOM. */
export class ReflowPaged implements ReflowStageApi {
  private box = document.createElement('div')
  private track = document.createElement('div')
  private endLeaf = document.createElement('div')
  private mounted = new Map<number, Mounted>()
  private m!: ReflowMetrics
  private height = 0
  private sec = 0
  private page = 0
  private atEnd = false
  private pos = 0
  private spring: ReturnType<typeof runSpring> | null = null
  private dragStart: number | null = null
  private gestures: GestureRecognizer
  private pager = new WheelPager()
  private resize: ResizeObserver
  private ac = new AbortController()
  private cachedAnchor: Anchor
  private key = ''
  private destroyed = false
  private resizeTimer: number | undefined

  constructor(
    private root: HTMLElement,
    private env: StageEnv,
    private book: ReflowBook,
    private profile: ReaderProfile,
    start: Anchor,
  ) {
    this.cachedAnchor = start
    root.classList.add('reflow-stage', 'reflow-paged')
    this.box.className = 'rf-box'
    this.track.className = 'rf-track'
    this.endLeaf.className = 'rf-end'
    this.endLeaf.appendChild(env.endCard)
    this.box.appendChild(this.track)
    root.appendChild(this.box)
    this.gestures = new GestureRecognizer(root, {
      ignore: (e) => selectionActive() && e.pointerType !== 'mouse',
      delayTap: () => false,
      onTap: (x, y) => this.tap(x, y),
      onDoubleTap: () => undefined,
      onPanStart: (_x, _y, dx, dy, type) => this.panStart(dx, dy, type),
      onPanMove: (dx) => this.panMove(dx),
      onPanEnd: (vx) => this.panEnd(vx),
    })
    root.addEventListener('wheel', this.wheel, { passive: false, signal: this.ac.signal })
    this.repaginate(start)
    void this.ensureFont()
    this.resize = new ResizeObserver(() => this.onResize())
    this.resize.observe(root)
  }

  private async ensureFont() {
    const s = this.profile.reflow
    await loadFont(s.font, s.fontSize)
    if (!this.destroyed && this.profile.reflow.font === s.font) this.repaginate(this.anchor())
  }

  private clearMounted() {
    for (const m of this.mounted.values()) {
      for (const s of m.slots) s.destroy()
      m.el.remove()
    }
    this.mounted.clear()
  }

  /** Full layout pass, holding the anchor. */
  private repaginate(anchor: Anchor) {
    const p = this.profile
    applyTypography(this.root, p.reflow, resolveColors(p), this.book.lang)
    this.key = typographyKey(p.reflow)
    const cs = getComputedStyle(this.root)
    const vw = this.root.clientWidth
    this.height = Math.max(100, this.root.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom))
    this.m = reflowMetrics(vw, this.root.clientHeight, p.reflow)
    this.box.style.width = `${this.m.box}px`
    this.box.style.height = `${this.height}px`
    this.endLeaf.style.width = `${this.m.box}px`
    this.endLeaf.style.height = `${this.height}px`
    this.clearMounted()
    this.stopSpring()
    this.showAnchor(anchor)
  }

  private showAnchor(a: Anchor) {
    const sec = sectionOfBlock(this.book.sections, a.block)
    this.sec = sec
    this.page = 0
    this.atEnd = false
    this.mountAround(sec)
    const m = this.mounted.get(sec)
    if (m) {
      const block = m.el.querySelector(`[data-b="${a.block}"]`)
      const rect = block && charRect(block, a.char)
      if (rect) {
        const left = m.el.getBoundingClientRect().left
        this.page = Math.max(0, Math.min(m.pages - 1, Math.floor((rect.left - left + 2) / this.m.step)))
      }
    }
    this.setPos(-this.targetX())
    this.cachedAnchor = a
  }

  private imgBox = (aspect: number) => {
    const maxW = this.m.col
    const maxH = this.height
    const w = Math.min(maxW, maxH * aspect)
    return { w: Math.floor(w), h: Math.floor(w / aspect) }
  }

  private mountSection(index: number): Mounted {
    const known = this.mounted.get(index)
    if (known) return known
    const dom = buildSectionDom(this.book, index, this.env.renderer, this.env.sizes, this.imgBox)
    const { columns, col, gap } = this.m
    const s = dom.el.style
    s.width = `${columns * col + (columns - 1) * gap}px`
    s.height = `${this.height}px`
    s.columnWidth = `${col}px`
    s.columnCount = String(columns)
    s.columnGap = `${gap}px`
    s.top = '0'
    this.track.appendChild(dom.el)
    const m: Mounted = { ...dom, index, pages: 1, left: 0 }
    m.pages = this.measure(m)
    this.mounted.set(index, m)
    return m
  }

  private measure(m: Mounted) {
    const last = m.el.lastElementChild
    const rects = last?.getClientRects()
    const r = rects?.[rects.length - 1]
    if (!r) return 1
    const left = m.el.getBoundingClientRect().left
    return Math.max(1, Math.floor((r.left - left + 2) / this.m.step) + 1)
  }

  /** Mount a section and its neighbours edge to edge with `sec` at track x=0. */
  private mountAround(sec: number) {
    const last = this.book.sections.length - 1
    const keep = [sec - 1, sec, sec + 1].filter((i) => i >= 0 && i <= last)
    for (const [i, m] of this.mounted) {
      if (!keep.includes(i)) {
        for (const s of m.slots) s.destroy()
        m.el.remove()
        this.mounted.delete(i)
      }
    }
    for (const i of keep) this.mountSection(i)
    const halfGap = this.m.gap / 2
    const centre = this.mounted.get(sec) as Mounted
    centre.left = 0
    const before = this.mounted.get(sec - 1)
    if (before) before.left = -before.pages * this.m.step
    const after = this.mounted.get(sec + 1)
    if (after) after.left = centre.pages * this.m.step
    for (const m of this.mounted.values()) m.el.style.left = `${m.left + halfGap}px`
    const tail = after ?? centre
    if (sec === last) {
      this.endLeaf.style.left = `${centre.pages * this.m.step}px`
      if (this.endLeaf.parentElement !== this.track) this.track.appendChild(this.endLeaf)
    } else if (tail !== centre || sec < last) {
      this.endLeaf.remove()
    }
    planSlots(this.env.renderer, [...this.mounted.values()].flatMap((m) => m.slots))
  }

  private targetX(): number {
    const m = this.mounted.get(this.sec)
    if (!m) return 0
    return this.atEnd ? m.left + m.pages * this.m.step : m.left + this.page * this.m.step
  }

  private setPos(px: number) {
    this.pos = px
    this.track.style.transform = `translate3d(${px}px,0,0)`
  }

  private stopSpring() {
    this.spring?.cancel()
    this.spring = null
  }

  private rebase() {
    const m = this.mounted.get(this.sec)
    const shift = m?.left ?? 0
    const needsMount = !!m && (shift !== 0 || !this.neighboursMounted())
    if (!needsMount) return
    this.mountAround(this.sec)
    this.spring?.shift(shift)
    this.setPos(this.pos + shift)
  }

  private neighboursMounted() {
    const last = this.book.sections.length - 1
    return (this.sec === 0 || this.mounted.has(this.sec - 1)) && (this.sec === last || this.mounted.has(this.sec + 1))
  }

  private settle(velocity = 0) {
    this.stopSpring()
    const done = () => {
      this.spring = null
      this.rebase()
      this.setPos(-this.targetX())
      this.afterMove()
    }
    if (reducedMotion() || this.profile.transition === 'none') { done(); return }
    this.spring = runSpring({ x: this.pos, v: velocity }, () => -this.targetX(), (x) => this.setPos(x), done)
  }

  private afterMove() {
    this.env.onEndCard(this.atEnd)
    if (this.atEnd) return
    this.cachedAnchor = this.locate()
    this.env.onPosition(anchorToPosition(this.book.index, this.cachedAnchor), anchorFraction(this.book.index, this.cachedAnchor))
  }

  /** First text visible on the current page. */
  private locate(): Anchor {
    const m = this.mounted.get(this.sec)
    if (!m) return this.cachedAnchor
    const pageLeft = m.el.getBoundingClientRect().left + this.page * this.m.step - 2
    const blocks = m.el.children
    let lo = 0
    let hi = blocks.length - 1
    const endsPast = (i: number) => {
      const rects = (blocks[i] as Element).getClientRects()
      const r = rects[rects.length - 1]
      return !!r && r.left >= pageLeft
    }
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (endsPast(mid)) hi = mid
      else lo = mid + 1
    }
    const block = blocks[lo] as HTMLElement
    const first = block.getClientRects()[0]
    const char = first && first.left >= pageLeft ? 0 : firstCharWhere(block, (r) => r.left >= pageLeft)
    return { block: Number(block.dataset.b), char }
  }

  private advance(): boolean {
    const m = this.mounted.get(this.sec)
    if (!m) return false
    if (this.atEnd) return false
    if (this.page < m.pages - 1) this.page++
    else if (this.sec < this.book.sections.length - 1) {
      if (!this.mounted.has(this.sec + 1)) this.rebase()
      this.sec++
      this.page = 0
      if (!this.neighboursMounted()) this.rebase()
    } else this.atEnd = true
    return true
  }

  private retreat(): boolean {
    if (this.atEnd) { this.atEnd = false; return true }
    if (this.page > 0) { this.page--; return true }
    if (this.sec === 0) return false
    if (!this.mounted.has(this.sec - 1)) this.rebase()
    this.sec--
    this.page = (this.mounted.get(this.sec)?.pages ?? 1) - 1
    if (!this.neighboursMounted()) this.rebase()
    return true
  }

  next() {
    if (this.atEnd) {
      if (this.env.hasNext() && this.profile.autoNextVolume) this.env.onPastEnd()
      else this.env.onBoundary('end')
      return
    }
    this.advance()
    this.env.onFlip()
    this.settle()
  }

  prev() {
    if (this.retreat()) { this.env.onFlip(); this.settle() }
    else this.env.onBoundary('start')
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

  private panStart(dx: number, dy: number, type: string) {
    // A mouse drag selects text; only touch and pen swipe.
    if (type === 'mouse' || !this.profile.swipe || Math.abs(dx) < Math.abs(dy)) return
    this.stopSpring()
    this.dragStart = this.pos
  }

  private panMove(dx: number) {
    if (this.dragStart === null) return
    const atFirst = this.sec === 0 && this.page === 0
    const hi = atFirst ? 0 : Number.POSITIVE_INFINITY
    this.setPos(rubberClamp(this.dragStart + dx, Number.NEGATIVE_INFINITY, hi, this.m.step * 0.4))
  }

  private panEnd(vx: number) {
    if (this.dragStart === null) return
    const moved = this.pos - -this.targetX()
    this.dragStart = null
    const far = Math.abs(moved) > this.m.step * FLIP_DISTANCE
    const fling = Math.abs(vx) > FLIP_VELOCITY && Math.sign(vx) === Math.sign(moved)
    if (far || fling) {
      if (moved < 0) {
        if (this.atEnd) {
          if (this.env.hasNext() && this.profile.autoNextVolume) this.env.onPastEnd()
          else this.env.onBoundary('end')
        } else { this.advance(); this.env.onFlip() }
      } else if (this.retreat()) this.env.onFlip()
      else this.env.onBoundary('start')
    }
    this.settle(vx)
  }

  private wheel = (e: WheelEvent) => {
    e.preventDefault()
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? this.root.clientHeight : 1
    const flip = this.pager.feed((Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * unit, e.timeStamp)
    if (flip > 0) this.next()
    else if (flip < 0) this.prev()
  }

  private onResize() {
    window.clearTimeout(this.resizeTimer)
    const a = this.anchor()
    this.repaginate(a)
    // Layout again once the rotation has fully landed; the anchor is what holds the place.
    this.resizeTimer = window.setTimeout(() => {
      if (this.root.clientWidth !== this.m.box && this.m.columns === 1) this.repaginate(a)
    }, 150)
  }

  update(profile: ReaderProfile) {
    const prev = this.profile
    this.profile = profile
    applyTypography(this.root, profile.reflow, resolveColors(profile), this.book.lang)
    if (typographyKey(profile.reflow) === this.key) return
    const a = this.anchor()
    this.repaginate(a)
    if (prev.reflow.font !== profile.reflow.font) void this.ensureFont()
  }

  anchor() { return this.cachedAnchor }

  goToAnchor(a: Anchor) {
    this.stopSpring()
    this.showAnchor(a)
    this.env.onEndCard(false)
    this.env.onPosition(anchorToPosition(this.book.index, a), anchorFraction(this.book.index, a))
  }

  goTo(pos: Position) { this.goToAnchor(positionToAnchor(this.book.index, pos)) }

  goToEnd() {
    this.stopSpring()
    this.sec = this.book.sections.length - 1
    this.mountAround(this.sec)
    this.atEnd = true
    this.setPos(-this.targetX())
    this.env.onEndCard(true)
  }

  position(): Position { return anchorToPosition(this.book.index, this.cachedAnchor) }

  zoomBy() { /* type size is a setting: the reader changes it */ }
  zoomReset() { /* type size is a setting: the reader changes it */ }

  destroy() {
    this.destroyed = true
    window.clearTimeout(this.resizeTimer)
    this.ac.abort()
    this.resize.disconnect()
    this.gestures.destroy()
    this.stopSpring()
    this.clearMounted()
    this.env.endCard.remove()
    this.box.remove()
    this.root.classList.remove('reflow-stage', 'reflow-paged')
    this.root.removeAttribute('style')
  }
}
