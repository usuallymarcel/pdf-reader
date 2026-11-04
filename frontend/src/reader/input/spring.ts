export interface SpringState { x: number; v: number } // px, px/ms

const STIFFNESS = 0.00028 // px/ms² per px
const DAMPING = 2 * Math.sqrt(STIFFNESS) * 0.92

/** Advance a slightly under-damped spring. Sub-stepped so a dropped frame cannot make it unstable. */
export function springStep(s: SpringState, target: number, dtMs: number): SpringState {
  let { x, v } = s
  let left = Math.min(dtMs, 64)
  while (left > 0) {
    const dt = Math.min(left, 4)
    v += (-STIFFNESS * (x - target) - DAMPING * v) * dt
    x += v * dt
    left -= dt
  }
  return { x, v }
}

export const springDone = (s: SpringState, target: number) => Math.abs(s.x - target) < 0.5 && Math.abs(s.v) < 0.02

/** Drive a spring on rAF. `target` is read every frame so it may be rebased mid-flight. */
export function runSpring(
  from: SpringState,
  target: () => number,
  onFrame: (x: number) => void,
  onDone: () => void,
): { cancel(): void; shift(dx: number): void; velocity(): number } {
  let s = from
  let last = performance.now()
  let raf = requestAnimationFrame(function tick(now) {
    s = springStep(s, target(), now - last)
    last = now
    if (springDone(s, target())) { onFrame(target()); onDone(); return }
    onFrame(s.x)
    raf = requestAnimationFrame(tick)
  })
  return {
    cancel: () => cancelAnimationFrame(raf),
    shift: (dx) => { s = { x: s.x + dx, v: s.v } },
    velocity: () => s.v,
  }
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Tween t from 0 to 1 with an ease-out curve. Returns a cancel function. */
export function tween(ms: number, onFrame: (t: number) => void, onDone: () => void): () => void {
  const start = performance.now()
  let raf = requestAnimationFrame(function tick(now) {
    const p = Math.min(1, (now - start) / ms)
    onFrame(1 - (1 - p) ** 3)
    if (p >= 1) { onDone(); return }
    raf = requestAnimationFrame(tick)
  })
  return () => cancelAnimationFrame(raf)
}
