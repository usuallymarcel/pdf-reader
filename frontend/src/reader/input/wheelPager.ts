/**
 * Turns a wheel stream into discrete page flips. A notched mouse wheel flips once per notch (with a short
 * cooldown); a trackpad flick, with its long inertia tail, flips exactly once until the stream dies out or
 * a clearly new flick arrives.
 */
const STREAM_GAP_MS = 170
const NOTCH_COOLDOWN_MS = 260
const TRACKPAD_THRESHOLD = 40
const NOTCH_MIN = 50

export class WheelPager {
  private lastEvent = -Infinity
  private lastFlip = -Infinity
  private accum = 0
  private armed = true
  private peak = 0

  /** Returns 1 / -1 when a flip should happen, otherwise 0. `delta` is px, positive = forward. */
  feed(delta: number, now: number): 1 | -1 | 0 {
    const gap = now - this.lastEvent
    this.lastEvent = now
    const mag = Math.abs(delta)
    if (gap > STREAM_GAP_MS) { this.accum = 0; this.armed = true; this.peak = 0 }
    if (mag >= NOTCH_MIN && Number.isInteger(delta) && gap > 60) {
      // Discrete mouse notch: large integer delta, spaced out in time.
      if (now - this.lastFlip < NOTCH_COOLDOWN_MS) return 0
      this.lastFlip = now
      this.armed = false
      this.accum = 0
      return delta > 0 ? 1 : -1
    }
    // Inertia decays; a magnitude jump well above the decayed tail is a fresh flick.
    if (!this.armed && mag > this.peak * 1.8 && mag > 12 && now - this.lastFlip > 200) { this.armed = true; this.accum = 0 }
    this.peak = this.armed ? Math.max(this.peak, mag) : mag
    if (!this.armed) return 0
    if (this.accum !== 0 && Math.sign(this.accum) !== Math.sign(delta)) this.accum = 0
    this.accum += delta
    if (Math.abs(this.accum) < TRACKPAD_THRESHOLD) return 0
    const dir = this.accum > 0 ? 1 : -1
    this.accum = 0
    this.armed = false
    this.lastFlip = now
    return dir
  }
}
