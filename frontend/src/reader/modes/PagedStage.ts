import type { ReaderProfile } from '../../settings/schema'
import { GestureRecognizer } from '../input/gestures'
import { reducedMotion, runSpring, tween } from '../input/spring'
import { resolveTap } from '../input/tapZones'
import { WheelPager } from '../input/wheelPager'
import { croppedSize, layoutSpread, NO_CROP, spreadCrop, type Crop, type SpreadLayout } from '../layout/fit'
import type { Position } from '../layout/position'
import { buildSpreads, renderOrder, shouldDouble, spreadIndexOfPage, visualPages, type Spread } from '../layout/spreads'
import {
  clampView, MAX_ZOOM, MIN_ZOOM, panRange, rubberClamp, rubberScale, zoomAt, type Dimensions, type View,
} from '../layout/viewTransform'
import { PageSlot } from '../pdf/PageSlot'
import type { PlanItem } from '../pdf/renderer'
import { dpr, type ReaderStage, type StageEnv } from './types'

const FLIP_DISTANCE = 0.22
const FLIP_VELOCITY = 0.35
const LEAF_GAP = 24
const FADE_MS = 180
const DOUBLE_TAP_ZOOM = 2.5
const HIRES_DELAY_MS = 220
const RESIZE_PLAN_DELAY_MS = 180
const PAN_FRICTION = 0.0035
const BOUNCE_PX = 28

interface Leaf {
  index: number
  el: HTMLDivElement
  zoom: HTMLDivElement
  slots: PageSlot[]
  layout: SpreadLayout
  crop: Crop
  view: View
}

type DragMode = 'flip' | 'pan' | 'none'

/** Paged reading: an imperative stage so a drag is transforms only, with no React work in the loop. */
export class PagedStage implements ReaderStage {
  private track = document.createElement('div')
  private leaves = new Map<number, Leaf>()
  private spreads: Spread[] = []
  private current = 0
  private vw = 0
  private vh = 0
  private pos = 0
  private spring: ReturnType<typeof runSpring> | null = null
  private cancelViewAnim: (() => void) | null = null
  private cancelMomentum: (() => void) | null = null
  private cancelFade: (() => void) | null = null
  private drag: { mode: DragMode; startPos: number; startView: View } | null = null
  private pinch: { start: View; cx: number; cy: number } | null = null
  private gestures: GestureRecognizer
  private pager = new WheelPager()
  private resize: ResizeObserver
  private hiResTimer: number | undefined
  private planTimer: number | undefined
  private ac = new AbortController()
  private cropsPending = new Set<number>()
  private wasZoomed = false
  private destroyed = false
  /** Exact place we entered at, so a mode round trip without moving loses nothing. */
  private origin: Position

  constructor(private root: HTMLElement, private env: StageEnv, private profile: ReaderProfile, start: Position) {
    this.origin = start
    root.classList.add('paged-stage')
    this.track.className = 'paged-track'
    root.appendChild(this.track)
    this.gestures = new GestureRecognizer(root, {
      delayTap: (x, y) => this.delayTap(x, y),
      onTap: (x, y) => this.tap(x, y),
      onDoubleTap: (x, y) => this.doubleTap(x, y),
      onPanStart: (_x, _y, dx, dy) => this.panStart(dx, dy),
      onPanMove: (dx, dy) => this.panMove(dx, dy),
      onPanEnd: (vx, vy) => this.panEnd(vx, vy),
      onPinchStart: (cx, cy) => this.pinchStart(cx, cy),
      onPinchMove: (s, cx, cy) => this.pinchMove(s, cx, cy),
      onPinchEnd: () => this.pinchEnd(),
      onDown: () => this.stopMotion(),
    })
    root.addEventListener('wheel', this.wheel, { passive: false, signal: this.ac.signal })
    this.measure()
    this.rebuild(start.page)
    this.resize = new ResizeObserver(() => this.onResize())
    this.resize.observe(root)
  }

  private get rtl() { return this.profile.direction === 'rtl' }
  private get sign() { return this.rtl ? -1 : 1 }
  private get step() { return this.vw + LEAF_GAP }
  private get endIndex() { return this.spreads.length }
  private get animated() { return !reducedMotion() && this.profile.transition !== 'none' }

  private measure() {
    this.vw = this.root.clientWidth
    this.vh = this.root.clientHeight
  }

  /* ---------- layout ---------- */

  private rebuild(page: number) {
    const p = this.profile
    const double = shouldDouble(p.spreads, this.vw, this.vh, this.env.sizes)
    this.spreads = buildSpreads(this.env.sizes, { double, coverAlone: p.coverAlone, shift: p.spreadShift })
    const atEnd = this.current >= this.endIndex && this.leaves.size > 0
    this.current = atEnd ? this.endIndex : spreadIndexOfPage(this.spreads, page)
    for (const leaf of this.leaves.values()) this.unmount(leaf)
    this.leaves.clear()
    this.stopSpring()
    this.setPos(0)
    this.syncLeaves()
    this.plan()
  }

  private cropFor(index: number): Crop {
    const spread = this.spreads[index]
    if (!this.profile.cropMargins || !spread) return NO_CROP
    const crops: Crop[] = []
    for (const page of spread.pages) {
      const c = this.env.renderer.cropOf(page)
      if (c) crops.push(c)
      else if (!this.cropsPending.has(page)) {
        this.cropsPending.add(page)
        void this.env.renderer.crop(page).then(() => {
          this.cropsPending.delete(page)
          if (!this.destroyed) this.relayoutLeaf(index)
        })
      }
    }
    return crops.length === spread.pages.length ? spreadCrop(crops) : NO_CROP
  }

  private layoutFor(index: number, crop: Crop): SpreadLayout {
    const spread = this.spreads[index]
    if (!spread) return { w: this.vw, h: this.vh, boxes: [] }
    const sizeOf = (page: number) => croppedSize(this.env.sizes[page - 1] ?? [1, 1], crop)
    return layoutSpread(visualPages(spread, this.rtl), sizeOf, this.vw, this.vh, this.profile.fit, this.profile.pageGap)
  }

  private dims(leaf: Leaf): Dimensions {
    return { cw: leaf.layout.w, ch: leaf.layout.h, vw: this.vw, vh: this.vh }
  }

  /** Where a leaf sits before the reader touches it; `from` is the side we arrived from. */
  private restingView(leaf: Leaf, s: number, from: 1 | -1): View {
    const d = this.dims(leaf)
    const r = panRange(s, d)
    const y = from > 0 ? r.maxY : r.minY
    const startRight = this.rtl === (from > 0)
    return { s, x: startRight ? r.minX : r.maxX, y }
  }

  private mount(index: number): Leaf {
    const el = document.createElement('div')
    el.className = 'leaf'
    const zoom = document.createElement('div')
    zoom.className = 'leaf-zoom'
    el.appendChild(zoom)
    const crop = this.cropFor(index)
    const layout = this.layoutFor(index, crop)
    const leaf: Leaf = { index, el, zoom, slots: [], layout, crop, view: { s: 1, x: 0, y: 0 } }
    if (index === this.endIndex) {
      el.classList.add('leaf-end')
      el.appendChild(this.env.endCard)
    } else {
      for (const box of layout.boxes) {
        const slot = new PageSlot(this.env.renderer, box.page)
        slot.layout(box, crop)
        zoom.appendChild(slot.el)
        leaf.slots.push(slot)
      }
    }
    zoom.style.width = `${layout.w}px`
    zoom.style.height = `${layout.h}px`
    leaf.view = this.restingView(leaf, 1, index >= this.current ? 1 : -1)
    this.applyView(leaf)
    this.placeLeaf(leaf)
    this.track.appendChild(el)
    return leaf
  }

  private unmount(leaf: Leaf) {
    for (const s of leaf.slots) s.destroy()
    if (leaf.index === this.endIndex && this.env.endCard.parentElement === leaf.el) this.env.endCard.remove()
    leaf.el.remove()
  }

  private relayoutLeaf(index: number) {
    const leaf = this.leaves.get(index)
    if (!leaf) return
    leaf.crop = this.cropFor(index)
    leaf.layout = this.layoutFor(index, leaf.crop)
    leaf.slots.forEach((slot, i) => {
      const box = leaf.layout.boxes[i]
      if (box) slot.layout(box, leaf.crop)
    })
    leaf.zoom.style.width = `${leaf.layout.w}px`
    leaf.zoom.style.height = `${leaf.layout.h}px`
    leaf.view = leaf.view.s > 1 ? clampView(leaf.view, this.dims(leaf)) : this.restingView(leaf, 1, 1)
    this.applyView(leaf)
    this.placeLeaf(leaf)
  }

  private placeLeaf(leaf: Leaf) {
    const x = (leaf.index - this.current) * this.step * this.sign
    leaf.el.style.transform = `translate3d(${x}px,0,0)`
  }

  private applyView(leaf: Leaf) {
    const { x, y, s } = leaf.view
    leaf.zoom.style.transform = `translate3d(${x}px,${y}px,0) scale(${s})`
  }

  private syncLeaves() {
    const want = [this.current - 1, this.current, this.current + 1].filter((i) => i >= 0 && i <= this.endIndex)
    for (const [i, leaf] of this.leaves) {
      if (!want.includes(i)) { this.unmount(leaf); this.leaves.delete(i) }
    }
    for (const i of want) {
      const leaf = this.leaves.get(i)
      if (leaf) this.placeLeaf(leaf)
      else this.leaves.set(i, this.mount(i))
    }
  }

  private setPos(px: number) {
    this.pos = px
    this.track.style.transform = `translate3d(${px}px,0,0)`
  }

  /** Render plan: on-screen pages first, sharper when zoomed; then ahead; then one behind. */
  private plan() {
    const p = this.profile
    const ratio = dpr()
    const items: PlanItem[] = []
    const order = renderOrder(Math.min(this.current, this.endIndex - 1), this.spreads.length, p.preload)
    for (const index of order) {
      const leaf = this.leaves.get(index)
      const crop = leaf?.crop ?? this.cropFor(index)
      const layout = leaf?.layout ?? this.layoutFor(index, crop)
      const zoom = index === this.current && leaf ? leaf.view.s : 1
      const cropW = Math.max(0.05, 1 - crop.left - crop.right)
      for (const box of layout.boxes) items.push({ page: box.page, width: (box.w / cropW) * ratio * zoom })
    }
    this.env.renderer.plan(items)
  }

  private onResize() {
    const { clientWidth: w, clientHeight: h } = this.root
    if (w === this.vw && h === this.vh) return
    const page = this.position().page
    this.vw = w
    this.vh = h
    // Synchronous, before paint: existing canvases just change CSS size, so rotation never flashes.
    const hadS = this.leaves.get(this.current)?.view.s ?? 1
    this.rebuild(page)
    if (hadS > 1) this.setZoom({ ...(this.currentLeaf()?.view ?? { x: 0, y: 0 }), s: hadS })
    window.clearTimeout(this.planTimer)
    this.planTimer = window.setTimeout(() => this.plan(), RESIZE_PLAN_DELAY_MS)
  }

  update(profile: ReaderProfile) {
    const prev = this.profile
    this.profile = profile
    const relevant = (['direction', 'spreads', 'coverAlone', 'spreadShift', 'fit', 'pageGap', 'cropMargins'] as const)
      .some((k) => prev[k] !== profile[k])
    if (relevant) this.rebuild(this.position().page)
    else if (prev.preload !== profile.preload) this.plan()
  }

  /* ---------- navigation ---------- */

  private currentLeaf() { return this.leaves.get(this.current) }

  position(): Position {
    const spread = this.spreads[Math.min(this.current, this.spreads.length - 1)]
    const page = spread?.pages[0] ?? 1
    return { page, offset: page === this.origin.page ? this.origin.offset : 0 }
  }

  private emit() {
    this.env.onEndCard(this.current === this.endIndex)
    this.env.onPosition(this.position())
  }

  private stopSpring() {
    this.spring?.cancel()
    this.spring = null
  }

  private stopMotion() {
    this.cancelMomentum?.()
    this.cancelMomentum = null
    this.cancelViewAnim?.()
    this.cancelViewAnim = null
  }

  private settle(velocity = 0) {
    this.stopSpring()
    if (!this.animated) { this.setPos(0); this.onSettled(); return }
    this.spring = runSpring({ x: this.pos, v: velocity }, () => 0, (x) => this.setPos(x), () => {
      this.spring = null
      this.onSettled()
    })
  }

  private onSettled() {
    for (const leaf of this.leaves.values()) {
      if (leaf.index !== this.current && leaf.view.s !== 1) {
        leaf.view = this.restingView(leaf, 1, leaf.index > this.current ? 1 : -1)
        this.applyView(leaf)
      }
    }
  }

  private flipTo(index: number, opts: { velocity?: number; animate?: boolean } = {}) {
    const target = Math.max(0, Math.min(this.endIndex, index))
    const delta = target - this.current
    if (!delta) { this.settle(opts.velocity); return }
    const from: 1 | -1 = delta > 0 ? 1 : -1
    const previous = this.currentLeaf()
    const sticky = this.profile.stickyZoom ? previous?.view.s ?? 1 : 1
    const adjacent = Math.abs(delta) === 1
    const useSpring = adjacent && this.animated && opts.animate !== false && this.profile.transition === 'slide'
    const fromDrag = opts.velocity !== undefined
    this.endFade()
    this.current = target
    this.syncLeaves()

    const leaf = this.currentLeaf()
    if (leaf) {
      leaf.view = this.restingView(leaf, sticky, from)
      this.applyView(leaf)
    }
    if (useSpring || fromDrag) {
      // Rebase so the picture does not move this frame; the spring then eases to the new leaf.
      const rebased = this.pos + delta * this.step * this.sign
      const limit = this.step
      this.setPos(Math.max(-limit, Math.min(limit, rebased)))
      this.settle(opts.velocity ?? 0)
    } else {
      this.stopSpring()
      this.setPos(0)
      if (adjacent && previous && this.profile.transition === 'fade' && this.animated) this.fadeOut(previous)
      this.onSettled()
    }
    this.afterFlip()
  }

  private fadeOut(leaf: Leaf) {
    leaf.el.style.transform = 'translate3d(0,0,0)'
    leaf.el.style.zIndex = '2'
    const finish = tween(FADE_MS, (t) => { leaf.el.style.opacity = String(1 - t) }, () => this.endFade())
    this.cancelFade = () => {
      finish()
      leaf.el.style.opacity = ''
      leaf.el.style.zIndex = ''
      this.placeLeaf(leaf)
    }
  }

  private endFade() {
    this.cancelFade?.()
    this.cancelFade = null
  }

  private afterFlip() {
    this.env.onFlip()
    this.emit()
    this.plan()
    this.notifyZoom()
  }

  private bounce(edge: 'start' | 'end') {
    this.env.onBoundary(edge)
    if (!this.animated) return
    const towards = (edge === 'start' ? 1 : -1) * this.sign
    this.stopSpring()
    this.spring = runSpring({ x: this.pos, v: towards * 0.9 }, () => 0, (x) => this.setPos(Math.max(-BOUNCE_PX, Math.min(BOUNCE_PX, x))), () => {
      this.spring = null
    })
  }

  next() {
    const leaf = this.currentLeaf()
    if (leaf && leaf.view.s === 1) {
      const r = panRange(1, this.dims(leaf))
      if (leaf.view.y > r.minY + 1) { this.scrollView(leaf, Math.max(r.minY, leaf.view.y - this.vh * 0.85)); return }
    }
    if (this.current === this.endIndex) {
      if (this.env.hasNext() && this.profile.autoNextVolume) this.env.onPastEnd()
      else this.bounce('end')
      return
    }
    this.flipTo(this.current + 1)
  }

  prev() {
    const leaf = this.currentLeaf()
    if (leaf && leaf.view.s === 1) {
      const r = panRange(1, this.dims(leaf))
      if (leaf.view.y < r.maxY - 1) { this.scrollView(leaf, Math.min(r.maxY, leaf.view.y + this.vh * 0.85)); return }
    }
    if (this.current === 0) { this.bounce('start'); return }
    this.flipTo(this.current - 1)
  }

  private scrollView(leaf: Leaf, y: number) {
    this.animateView(leaf, { ...leaf.view, y })
    this.env.onFlip()
  }

  goTo(pos: Position, animate = false) {
    this.flipTo(spreadIndexOfPage(this.spreads, pos.page), { animate })
  }

  goToEnd() { this.flipTo(this.endIndex, { animate: false }) }

  /* ---------- tap ---------- */

  private tapAction(x: number, y: number) {
    const p = this.profile
    return resolveTap(p.tapLayout, x / this.vw, y / this.vh, this.rtl, p.tapInvert)
  }

  private zoomed() { return (this.currentLeaf()?.view.s ?? 1) > 1.01 }

  private delayTap(x: number, y: number) {
    if (this.env.overlayOpen() || this.current === this.endIndex) return false
    return this.zoomed() || this.tapAction(x, y) === 'menu'
  }

  private tap(x: number, y: number) {
    if (this.env.overlayOpen()) { this.env.dismissOverlay(); return }
    const action = this.tapAction(x, y)
    if (action === 'menu') this.env.onMenuTap()
    else if (action === 'next') this.next()
    else this.prev()
  }

  private doubleTap(x: number, y: number) {
    const leaf = this.currentLeaf()
    if (!leaf || this.current === this.endIndex) return
    const target = leaf.view.s > 1.01
      ? this.restingView(leaf, 1, 1)
      : clampView(zoomAt(leaf.view, DOUBLE_TAP_ZOOM, x, y), this.dims(leaf))
    this.animateView(leaf, target)
  }

  /* ---------- zoom & pan ---------- */

  private notifyZoom() {
    const z = this.zoomed()
    if (z !== this.wasZoomed) {
      this.wasZoomed = z
      this.root.classList.toggle('zoomed', z)
      this.env.onZoomed(z)
    }
  }

  private scheduleHiRes() {
    window.clearTimeout(this.hiResTimer)
    this.hiResTimer = window.setTimeout(() => this.plan(), HIRES_DELAY_MS)
    this.notifyZoom()
  }

  private animateView(leaf: Leaf, to: View) {
    this.stopMotion()
    const from = leaf.view
    const done = () => {
      leaf.view = to
      this.applyView(leaf)
      this.cancelViewAnim = null
      this.scheduleHiRes()
    }
    if (reducedMotion()) { done(); return }
    this.cancelViewAnim = tween(200, (t) => {
      const s = from.s + (to.s - from.s) * t
      leaf.view = { s, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
      this.applyView(leaf)
    }, done)
  }

  private setZoom(v: View) {
    const leaf = this.currentLeaf()
    if (!leaf) return
    leaf.view = clampView(v, this.dims(leaf))
    this.applyView(leaf)
    this.scheduleHiRes()
  }

  zoomBy(factor: number) {
    const leaf = this.currentLeaf()
    if (!leaf) return
    const s = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, leaf.view.s * factor))
    this.animateView(leaf, clampView(zoomAt(leaf.view, s, this.vw / 2, this.vh / 2), this.dims(leaf)))
  }

  zoomReset() {
    const leaf = this.currentLeaf()
    if (leaf) this.animateView(leaf, this.restingView(leaf, 1, 1))
  }

  private pinchStart(cx: number, cy: number) {
    const leaf = this.currentLeaf()
    if (!leaf || this.current === this.endIndex) return
    this.stopMotion()
    if (Math.abs(this.pos) > 0.5) { this.stopSpring(); this.setPos(0) }
    this.pinch = { start: leaf.view, cx, cy }
  }

  private pinchMove(scale: number, cx: number, cy: number) {
    const leaf = this.currentLeaf()
    if (!leaf || !this.pinch) return
    const { start, cx: sx, cy: sy } = this.pinch
    const s = rubberScale(start.s * scale)
    const v = zoomAt(start, s, sx, sy)
    leaf.view = { s, x: v.x + cx - sx, y: v.y + cy - sy }
    this.applyView(leaf)
  }

  private pinchEnd() {
    const leaf = this.currentLeaf()
    if (!leaf || !this.pinch) return
    this.pinch = null
    this.animateView(leaf, clampView(leaf.view, this.dims(leaf)))
  }

  private panStart(dx: number, dy: number) {
    const leaf = this.currentLeaf()
    const view = leaf?.view ?? { s: 1, x: 0, y: 0 }
    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.1
    const canFlip = this.profile.swipe && horizontal
    let mode: DragMode
    if (!leaf || this.current === this.endIndex) {
      mode = canFlip ? 'flip' : 'none'
    } else {
      const r = panRange(view.s, this.dims(leaf))
      const pannable = r.maxX - r.minX > 1 || r.maxY - r.minY > 1
      if (!pannable) mode = canFlip ? 'flip' : 'none'
      else {
        // Only a fresh gesture that starts at the edge and pushes outward turns the page.
        const atEdge = dx > 0 ? view.x >= r.maxX - 1 : view.x <= r.minX + 1
        mode = canFlip && atEdge ? 'flip' : 'pan'
      }
    }
    this.stopSpring()
    this.drag = { mode, startPos: this.pos, startView: view }
  }

  private dragLimits() {
    const hasPrev = this.current > 0
    const hasNext = this.current < this.endIndex
    const towardsPrev = this.sign * this.step
    const towardsNext = -this.sign * this.step
    const lo = Math.min(hasPrev ? towardsPrev : 0, hasNext ? towardsNext : 0, 0)
    const hi = Math.max(hasPrev ? towardsPrev : 0, hasNext ? towardsNext : 0, 0)
    return { lo, hi }
  }

  private panMove(dx: number, dy: number) {
    const d = this.drag
    if (!d) return
    if (d.mode === 'flip') {
      const { lo, hi } = this.dragLimits()
      this.setPos(rubberClamp(d.startPos + dx, lo, hi, this.vw * 0.5))
    } else if (d.mode === 'pan') {
      const leaf = this.currentLeaf()
      if (!leaf) return
      const r = panRange(leaf.view.s, this.dims(leaf))
      leaf.view = {
        s: leaf.view.s,
        x: rubberClamp(d.startView.x + dx, r.minX, r.maxX, this.vw * 0.5),
        y: rubberClamp(d.startView.y + dy, r.minY, r.maxY, this.vh * 0.5),
      }
      this.applyView(leaf)
    }
  }

  private panEnd(vx: number, vy: number) {
    const d = this.drag
    this.drag = null
    if (!d) return
    if (d.mode === 'none') { this.settle(); return }
    if (d.mode === 'pan') { this.momentum(vx, vy); return }
    const offset = this.pos
    const dist = Math.abs(offset) > this.vw * FLIP_DISTANCE
    const fling = Math.abs(vx) > FLIP_VELOCITY && Math.sign(vx) === Math.sign(offset)
    const towards = offset < 0 ? this.sign : -this.sign // +1 = forward in reading order
    if (!(dist || fling) || !offset) { this.settle(vx); return }
    if (towards < 0 && this.current === 0) { this.env.onBoundary('start'); this.settle(vx); return }
    if (towards > 0 && this.current === this.endIndex) {
      if (this.env.hasNext() && this.profile.autoNextVolume) this.env.onPastEnd()
      else this.env.onBoundary('end')
      this.settle(vx)
      return
    }
    this.flipTo(this.current + towards, { velocity: vx })
  }

  private momentum(vx: number, vy: number) {
    const leaf = this.currentLeaf()
    if (!leaf) return
    const dims = this.dims(leaf)
    let v = clampView(leaf.view, dims)
    const outOfBounds = v.x !== leaf.view.x || v.y !== leaf.view.y
    if (outOfBounds) { this.animateView(leaf, v); return }
    if (reducedMotion() || Math.hypot(vx, vy) < 0.05) { this.scheduleHiRes(); return }
    let last = performance.now()
    let raf = requestAnimationFrame(function tick(this: void, now: number) {
      const dt = Math.min(32, now - last)
      last = now
      const k = Math.exp(-PAN_FRICTION * dt)
      vx *= k
      vy *= k
      v = clampView({ s: v.s, x: v.x + vx * dt, y: v.y + vy * dt }, dims)
      leaf.view = v
      apply()
      if (Math.hypot(vx, vy) > 0.02) raf = requestAnimationFrame(tick)
    })
    const apply = () => this.applyView(leaf)
    this.cancelMomentum = () => cancelAnimationFrame(raf)
  }

  private wheel = (e: WheelEvent) => {
    e.preventDefault()
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? this.vh : 1
    const dy = e.deltaY * unit
    const dx = e.deltaX * unit
    const r = this.root.getBoundingClientRect()
    const leaf = this.currentLeaf()
    const wantZoom = e.ctrlKey || e.metaKey || this.profile.wheel === 'zoom'
    if (wantZoom) {
      if (!leaf || this.current === this.endIndex) return
      this.stopMotion()
      const s = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, leaf.view.s * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002))))
      this.setZoom(zoomAt(leaf.view, s, e.clientX - r.left, e.clientY - r.top))
      return
    }
    const pannable = leaf && this.current !== this.endIndex && (() => {
      const p = panRange(leaf.view.s, this.dims(leaf))
      return p.maxX - p.minX > 1 || p.maxY - p.minY > 1
    })()
    if (leaf && pannable && (this.zoomed() || this.profile.wheel === 'scroll')) {
      this.stopMotion()
      this.setZoom({ s: leaf.view.s, x: leaf.view.x - dx, y: leaf.view.y - dy })
      return
    }
    const flip = this.pager.feed(Math.abs(dy) >= Math.abs(dx) ? dy : dx, e.timeStamp)
    if (flip > 0) this.next()
    else if (flip < 0) this.prev()
  }

  destroy() {
    this.destroyed = true
    this.ac.abort()
    this.resize.disconnect()
    this.gestures.destroy()
    this.stopSpring()
    this.stopMotion()
    this.endFade()
    window.clearTimeout(this.hiResTimer)
    window.clearTimeout(this.planTimer)
    for (const leaf of this.leaves.values()) this.unmount(leaf)
    this.leaves.clear()
    this.track.remove()
    this.root.classList.remove('paged-stage', 'zoomed')
  }
}
