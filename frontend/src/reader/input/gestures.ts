/** Single pointer-event gesture layer: tap, double-tap, pan with velocity, and two-finger pinch. */

export interface GestureHandlers {
  /** Should a tap here wait for a possible double-tap? */
  delayTap(x: number, y: number): boolean
  onTap(x: number, y: number, e: PointerEvent): void
  onDoubleTap(x: number, y: number): void
  onPanStart?(x: number, y: number, dx: number, dy: number, pointerType: string): void
  onPanMove?(dx: number, dy: number): void
  /** velocities in px/ms */
  onPanEnd?(vx: number, vy: number, dx: number, dy: number): void
  onPinchStart?(cx: number, cy: number): void
  /** scale relative to pinch start; centre in stage px */
  onPinchMove?(scale: number, cx: number, cy: number): void
  onPinchEnd?(): void
  /** Any new first contact. */
  onDown?(e: PointerEvent): void
  /** Return true to leave this gesture alone entirely (e.g. text selection). */
  ignore?(e: PointerEvent): boolean
}

interface Tracked { x: number; y: number; startX: number; startY: number; type: string }
interface Sample { t: number; x: number; y: number }

const TOUCH_SLOP = 10
const MOUSE_SLOP = 4
const DOUBLE_MS = 280
const TAP_DELAY_MS = 250
const DOUBLE_DIST = 36
const LONG_PRESS_MS = 550

type Phase = 'idle' | 'pending' | 'pan' | 'pinch' | 'dead'

export class GestureRecognizer {
  private pointers = new Map<number, Tracked>()
  private phase: Phase = 'idle'
  private samples: Sample[] = []
  private downAt = 0
  private tapTimer: number | undefined
  private lastTap: { x: number; y: number; t: number } | null = null
  private pendingTap: { x: number; y: number; e: PointerEvent } | null = null
  private pinchStartDist = 0
  private ac = new AbortController()

  constructor(private el: HTMLElement, private h: GestureHandlers) {
    const o = { signal: this.ac.signal }
    el.addEventListener('pointerdown', this.down, o)
    el.addEventListener('pointermove', this.move, o)
    el.addEventListener('pointerup', this.up, o)
    el.addEventListener('pointercancel', this.cancel, o)
    // iOS Safari: keep its page-zoom gesture out of the way.
    el.addEventListener('gesturestart', (e) => e.preventDefault(), o)
  }

  destroy() {
    this.ac.abort()
    window.clearTimeout(this.tapTimer)
  }

  private local(e: PointerEvent) {
    const r = this.el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (this.h.ignore?.(e)) return
    const { x, y } = this.local(e)
    this.pointers.set(e.pointerId, { x, y, startX: x, startY: y, type: e.pointerType })
    if (this.pointers.size === 1) {
      this.phase = 'pending'
      this.downAt = e.timeStamp
      this.samples = [{ t: e.timeStamp, x, y }]
      this.h.onDown?.(e)
    } else if (this.pointers.size === 2) {
      if (this.phase === 'pan') this.endPan(true)
      this.flushPendingTap(false)
      this.phase = 'pinch'
      const [a, b] = this.pair()
      this.pinchStartDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
      this.h.onPinchStart?.((a.x + b.x) / 2, (a.y + b.y) / 2)
    }
  }

  private pair(): [Tracked, Tracked] {
    const [a, b] = [...this.pointers.values()]
    return [a as Tracked, b as Tracked]
  }

  private move = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId)
    if (!p) return
    const { x, y } = this.local(e)
    p.x = x
    p.y = y
    if (this.phase === 'pinch') {
      if (this.pointers.size < 2) return
      const [a, b] = this.pair()
      this.h.onPinchMove?.(Math.hypot(a.x - b.x, a.y - b.y) / this.pinchStartDist, (a.x + b.x) / 2, (a.y + b.y) / 2)
      return
    }
    const dx = x - p.startX
    const dy = y - p.startY
    if (this.phase === 'pending') {
      const slop = p.type === 'mouse' ? MOUSE_SLOP : TOUCH_SLOP
      if (Math.hypot(dx, dy) < slop) return
      this.phase = 'pan'
      // Capture only once it is a drag, so plain clicks keep their natural target.
      try { this.el.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
      this.h.onPanStart?.(p.startX, p.startY, dx, dy, p.type)
    }
    if (this.phase === 'pan') {
      this.samples.push({ t: e.timeStamp, x, y })
      if (this.samples.length > 8) this.samples.shift()
      this.h.onPanMove?.(dx, dy)
    }
  }

  private velocity() {
    const s = this.samples
    const last = s[s.length - 1]
    if (!last) return { vx: 0, vy: 0 }
    let first = last
    for (let i = s.length - 1; i >= 0; i--) {
      const c = s[i] as Sample
      if (last.t - c.t > 100) break
      first = c
    }
    const dt = last.t - first.t
    if (dt < 8) return { vx: 0, vy: 0 }
    return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt }
  }

  private endPan(interrupted: boolean) {
    const p = [...this.pointers.values()][0]
    const { vx, vy } = interrupted ? { vx: 0, vy: 0 } : this.velocity()
    this.h.onPanEnd?.(vx, vy, p ? p.x - p.startX : 0, p ? p.y - p.startY : 0)
  }

  private up = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId)
    if (!p) return
    if (this.phase === 'pinch') {
      this.pointers.delete(e.pointerId)
      if (this.pointers.size < 2) { this.h.onPinchEnd?.(); this.phase = this.pointers.size ? 'dead' : 'idle' }
      return
    }
    if (this.phase === 'dead') {
      this.pointers.delete(e.pointerId)
      if (!this.pointers.size) this.phase = 'idle'
      return
    }
    if (this.phase === 'pan') {
      this.endPan(false)
    } else if (this.phase === 'pending' && e.timeStamp - this.downAt < LONG_PRESS_MS) {
      this.tap(p.x, p.y, e)
    }
    this.pointers.delete(e.pointerId)
    this.phase = 'idle'
  }

  private cancel = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return
    if (this.phase === 'pan') this.endPan(true)
    if (this.phase === 'pinch' && this.pointers.size === 2) this.h.onPinchEnd?.()
    this.pointers.delete(e.pointerId)
    this.phase = this.pointers.size ? 'dead' : 'idle'
  }

  private flushPendingTap(fire: boolean) {
    window.clearTimeout(this.tapTimer)
    const t = this.pendingTap
    this.pendingTap = null
    if (t && fire) this.h.onTap(t.x, t.y, t.e)
  }

  private tap(x: number, y: number, e: PointerEvent) {
    const last = this.lastTap
    if (last && e.timeStamp - last.t < DOUBLE_MS && Math.hypot(x - last.x, y - last.y) < DOUBLE_DIST) {
      this.lastTap = null
      this.flushPendingTap(false)
      this.h.onDoubleTap(x, y)
      return
    }
    this.flushPendingTap(true)
    if (this.h.delayTap(x, y)) {
      this.lastTap = { x, y, t: e.timeStamp }
      this.pendingTap = { x, y, e }
      this.tapTimer = window.setTimeout(() => this.flushPendingTap(true), TAP_DELAY_MS)
    } else {
      this.lastTap = null
      this.h.onTap(x, y, e)
    }
  }
}
