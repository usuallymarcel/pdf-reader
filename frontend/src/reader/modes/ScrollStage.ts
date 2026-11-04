import type { ReaderProfile } from '../../settings/schema'
import { GestureRecognizer } from '../input/gestures'
import { reducedMotion } from '../input/spring'
import { resolveTap } from '../input/tapZones'
import { scrollColumnWidth } from '../layout/fit'
import { scrollPosition, type Position } from '../layout/position'
import { PageSlot } from '../pdf/PageSlot'
import type { PlanItem } from '../pdf/renderer'
import { dpr, type ReaderStage, type StageEnv } from './types'

const MAX_ZOOM = 4
const OVERSCAN = 1.5
const RESIZE_PLAN_DELAY_MS = 180
const END_CARD_VH = 0.7

/** Continuous / webtoon reading on native scrolling, with virtualised slots of known size. */
export class ScrollStage implements ReaderStage {
  private content = document.createElement('div')
  private slots = new Map<number, PageSlot>()
  private tops: number[] = [0]
  private width = 0
  private zoom = 1
  private vw = 0
  private vh = 0
  private anchor: Position
  private raf = 0
  private lastTop = 0
  private dirSign = 1
  private planKey = ''
  private planTimer: number | undefined
  private gestures: GestureRecognizer
  private resize: ResizeObserver
  private ac = new AbortController()
  private pinch: { dist: number; fx: number; fy: number; x: number; y: number; cx: number; cy: number; k: number } | null = null
  private wasAtEnd = false
  private suppressScroll = false

  constructor(private root: HTMLElement, private env: StageEnv, private profile: ReaderProfile, start: Position) {
    this.anchor = start
    root.classList.add('scroll-stage')
    this.content.className = 'scroll-content'
    root.appendChild(this.content)
    this.content.appendChild(env.endCard)
    env.endCard.classList.add('scroll-end')
    this.vw = root.clientWidth
    this.vh = root.clientHeight
    this.relayout()

    const o = { signal: this.ac.signal }
    root.addEventListener('scroll', this.onScroll, { ...o, passive: true })
    root.addEventListener('touchstart', this.touchStart, { ...o, passive: false })
    root.addEventListener('touchmove', this.touchMove, { ...o, passive: false })
    root.addEventListener('touchend', this.touchEnd, o)
    root.addEventListener('touchcancel', this.touchEnd, o)
    root.addEventListener('wheel', this.wheel, { ...o, passive: false })
    this.gestures = new GestureRecognizer(root, {
      delayTap: (x, y) => !this.env.overlayOpen() && this.tapAction(x, y) === 'menu',
      onTap: (x, y) => this.tap(x, y),
      onDoubleTap: (x, y) => this.commitZoom(this.zoom > 1.01 ? 1 : 2, x, y),
      // Clicks on the scrollbar are not taps.
      ignore: (e) => e.pointerType === 'mouse' && e.clientX - root.getBoundingClientRect().left >= root.clientWidth,
    })
    this.resize = new ResizeObserver(() => this.onResize())
    this.resize.observe(root)
  }

  private tapAction(x: number, y: number) {
    const p = this.profile
    return resolveTap(p.tapLayout, x / this.vw, y / this.vh, p.direction === 'rtl', p.tapInvert)
  }

  private tap(x: number, y: number) {
    if (this.env.overlayOpen()) { this.env.dismissOverlay(); return }
    const action = this.tapAction(x, y)
    if (action === 'menu') this.env.onMenuTap()
    else if (action === 'next') this.next()
    else this.prev()
  }

  /** Recompute geometry and hold the anchor exactly in place. */
  private relayout() {
    const sizes = this.env.sizes
    const base = scrollColumnWidth(this.profile.fit, this.vw, this.vh, sizes)
    this.width = base * this.zoom
    const gap = this.profile.pageGap
    const tops: number[] = [0]
    let y = 0
    for (const s of sizes) {
      y += (this.width * s[1]) / s[0] + gap
      tops.push(y)
    }
    this.tops = tops
    const end = this.env.endCard.style
    end.top = `${y}px`
    end.height = `${this.vh * END_CARD_VH}px`
    end.width = `${Math.min(this.vw, this.width)}px`
    end.left = `${Math.max(0, (this.width - this.vw) / 2)}px`
    const c = this.content.style
    c.width = `${this.width}px`
    c.height = `${y + this.vh * END_CARD_VH}px`
    c.marginLeft = `${this.contentLeft}px`
    for (const slot of this.slots.values()) this.layoutSlot(slot)
    this.restoreAnchor()
    this.syncWindow()
  }

  private slotHeight(page: number) {
    return (this.tops[page] ?? 0) - (this.tops[page - 1] ?? 0) - this.profile.pageGap
  }

  private layoutSlot(slot: PageSlot) {
    slot.layout({ x: 0, y: this.tops[slot.page - 1] ?? 0, w: this.width, h: this.slotHeight(slot.page) })
  }

  private restoreAnchor() {
    const { page, offset } = this.anchor
    const top = this.tops[page - 1] ?? 0
    const h = (this.tops[page] ?? top) - top
    this.suppressScroll = true
    this.root.scrollTop = top + offset * h
    this.lastTop = this.root.scrollTop
  }

  private pageAt(y: number) { return scrollPosition(this.tops, Math.max(0, y)).page }

  private syncWindow() {
    const top = this.root.scrollTop
    const first = this.pageAt(top - this.vh * OVERSCAN)
    const last = this.pageAt(top + this.vh * (1 + OVERSCAN))
    for (const [page, slot] of this.slots) {
      if (page < first || page > last) { slot.destroy(); this.slots.delete(page) }
    }
    for (let page = first; page <= last; page++) {
      if (this.slots.has(page)) continue
      const slot = new PageSlot(this.env.renderer, page)
      this.slots.set(page, slot)
      this.layoutSlot(slot)
      this.content.appendChild(slot.el)
    }
    this.plan()
  }

  private plan(force = false) {
    const top = this.root.scrollTop
    const n = this.env.sizes.length
    const first = this.pageAt(top)
    const last = this.pageAt(top + this.vh - 1)
    const key = `${first}:${last}:${this.dirSign}:${this.width}`
    if (key === this.planKey && !force) return
    this.planKey = key
    const width = this.width * dpr()
    const items: PlanItem[] = []
    for (let p = first; p <= last; p++) items.push({ page: p, width })
    const ahead = this.profile.preload
    for (let i = 1; i <= ahead; i++) {
      const p = this.dirSign > 0 ? last + i : first - i
      if (p >= 1 && p <= n) items.push({ page: p, width })
    }
    const behind = this.dirSign > 0 ? first - 1 : last + 1
    if (behind >= 1 && behind <= n) items.push({ page: behind, width })
    this.env.renderer.plan(items)
  }

  private onScroll = () => {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      const top = this.root.scrollTop
      if (this.suppressScroll) { this.suppressScroll = false; this.lastTop = top; this.syncWindow(); return }
      if (Math.abs(top - this.lastTop) > 1) this.dirSign = top > this.lastTop ? 1 : -1
      this.lastTop = top
      const before = this.anchor.page
      this.anchor = scrollPosition(this.tops, top)
      this.syncWindow()
      const total = this.tops[this.tops.length - 1] ?? 0
      const atEnd = top + this.vh > total + 40
      if (atEnd !== this.wasAtEnd) { this.wasAtEnd = atEnd; this.env.onEndCard(atEnd) }
      this.env.onPosition(this.anchor)
      if (before !== this.anchor.page) this.env.onFlip()
    })
  }

  private onResize() {
    const { clientWidth: w, clientHeight: h } = this.root
    if (w === this.vw && h === this.vh) return
    this.vw = w
    this.vh = h
    this.relayout()
    window.clearTimeout(this.planTimer)
    this.planTimer = window.setTimeout(() => this.plan(true), RESIZE_PLAN_DELAY_MS)
  }

  update(profile: ReaderProfile) {
    const prev = this.profile
    this.profile = profile
    if (prev.fit !== profile.fit || prev.pageGap !== profile.pageGap) this.relayout()
    else if (prev.preload !== profile.preload) this.plan(true)
  }

  private scrollByPage(sign: number) {
    this.root.scrollBy({ top: sign * this.vh * 0.85, behavior: reducedMotion() || this.profile.transition === 'none' ? 'auto' : 'smooth' })
    this.env.onFlip()
  }

  next() {
    const max = this.root.scrollHeight - this.vh
    if (this.root.scrollTop >= max - 2) {
      if (this.env.hasNext() && this.profile.autoNextVolume) this.env.onPastEnd()
      else this.env.onBoundary('end')
      return
    }
    this.scrollByPage(1)
  }

  prev() {
    if (this.root.scrollTop <= 1) { this.env.onBoundary('start'); return }
    this.scrollByPage(-1)
  }

  goTo(pos: Position) {
    this.anchor = pos
    this.restoreAnchor()
    this.syncWindow()
    this.env.onPosition(pos)
  }

  goToEnd() {
    this.root.scrollTop = this.root.scrollHeight
  }

  position() { return this.anchor }

  private get contentLeft() { return Math.max(0, (this.vw - this.width) / 2) }

  /** Change zoom keeping the content point under (fx, fy) stable. fx/fy are stage px. */
  private commitZoom(next: number, fx: number, fy: number) {
    this.applyZoom(next, this.root.scrollLeft + fx - this.contentLeft, this.root.scrollTop + fy, fx, fy)
  }

  /** Set zoom so that content point (cx, cy), in current content px, lands at stage point (fx, fy). */
  private applyZoom(next: number, cx: number, cy: number, fx: number, fy: number) {
    const z = Math.max(1, Math.min(MAX_ZOOM, next))
    const k = z / this.zoom
    this.zoom = z
    this.relayout()
    this.root.scrollLeft = cx * k - fx + this.contentLeft
    this.suppressScroll = true
    this.root.scrollTop = cy * k - fy
    this.lastTop = this.root.scrollTop
    this.anchor = scrollPosition(this.tops, this.root.scrollTop)
    this.syncWindow()
    this.plan(true)
    this.env.onPosition(this.anchor)
    this.env.onZoomed(z > 1.01)
  }

  zoomBy(factor: number) { this.commitZoom(this.zoom * factor, this.vw / 2, this.vh / 2) }
  zoomReset() { this.commitZoom(1, this.vw / 2, this.vh / 2) }

  private wheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    const r = this.root.getBoundingClientRect()
    this.commitZoom(this.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top)
  }

  private twoFinger(e: TouchEvent) {
    const a = e.touches[0] as Touch
    const b = e.touches[1] as Touch
    const r = this.root.getBoundingClientRect()
    return {
      dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      x: (a.clientX + b.clientX) / 2 - r.left,
      y: (a.clientY + b.clientY) / 2 - r.top,
    }
  }

  private touchStart = (e: TouchEvent) => {
    if (e.touches.length !== 2) return
    if (e.cancelable) e.preventDefault()
    const t = this.twoFinger(e)
    this.pinch = {
      dist: Math.max(1, t.dist), fx: t.x, fy: t.y, x: t.x, y: t.y, k: 1,
      cx: this.root.scrollLeft + t.x - this.contentLeft, cy: this.root.scrollTop + t.y,
    }
    this.content.style.transformOrigin = '0 0'
    this.content.style.willChange = 'transform'
  }

  private touchMove = (e: TouchEvent) => {
    const p = this.pinch
    if (!p || e.touches.length < 2) return
    if (e.cancelable) e.preventDefault()
    const t = this.twoFinger(e)
    const k = Math.max(1 / this.zoom * 0.8, Math.min((MAX_ZOOM / this.zoom) * 1.15, t.dist / p.dist))
    p.k = k
    p.x = t.x
    p.y = t.y
    // Live, compositor-only: the content point under the fingers follows them.
    const tx = t.x - p.fx + p.cx * (1 - k)
    const ty = t.y - p.fy + p.cy * (1 - k)
    this.content.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${k})`
  }

  private touchEnd = (e: TouchEvent) => {
    const p = this.pinch
    if (!p || e.touches.length >= 2) return
    this.pinch = null
    this.content.style.transform = ''
    this.content.style.willChange = ''
    this.applyZoom(this.zoom * p.k, p.cx, p.cy, p.x, p.y)
  }

  destroy() {
    this.ac.abort()
    this.resize.disconnect()
    this.gestures.destroy()
    cancelAnimationFrame(this.raf)
    window.clearTimeout(this.planTimer)
    for (const slot of this.slots.values()) slot.destroy()
    this.slots.clear()
    this.env.endCard.classList.remove('scroll-end')
    this.env.endCard.removeAttribute('style')
    this.env.endCard.remove()
    this.content.remove()
    this.root.classList.remove('scroll-stage')
  }
}
