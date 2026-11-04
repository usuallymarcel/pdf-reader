import type { TapLayout } from '../../settings/schema'

export type TapAction = 'prev' | 'next' | 'menu'
export interface ZoneRect { action: TapAction; x: number; y: number; w: number; h: number }

const SIDE = 1 / 3
const KINDLE_EDGE = 0.25
const KINDLE_TOP = 0.15
const EDGE = 0.16

/** Zones as fractions of the stage, in screen space, with direction and inversion applied. */
export function tapZones(layout: TapLayout, rtl: boolean, invert: boolean): ZoneRect[] {
  const prev: TapAction = invert ? 'next' : 'prev'
  const next: TapAction = invert ? 'prev' : 'next'
  const left = rtl ? next : prev
  const right = rtl ? prev : next
  switch (layout) {
    case 'sides':
      return [
        { action: left, x: 0, y: 0, w: SIDE, h: 1 },
        { action: 'menu', x: SIDE, y: 0, w: SIDE, h: 1 },
        { action: right, x: 1 - SIDE, y: 0, w: SIDE, h: 1 },
      ]
    case 'edges':
      return [
        { action: left, x: 0, y: 0, w: EDGE, h: 1 },
        { action: 'menu', x: EDGE, y: 0, w: 1 - 2 * EDGE, h: 1 },
        { action: right, x: 1 - EDGE, y: 0, w: EDGE, h: 1 },
      ]
    case 'kindle':
      // Back is the narrow strip on the side pages turn back to; the rest moves forward.
      return [
        { action: 'menu', x: 0, y: 0, w: 1, h: KINDLE_TOP },
        { action: prev, x: rtl ? 1 - KINDLE_EDGE : 0, y: KINDLE_TOP, w: KINDLE_EDGE, h: 1 - KINDLE_TOP },
        { action: next, x: rtl ? 0 : KINDLE_EDGE, y: KINDLE_TOP, w: 1 - KINDLE_EDGE, h: 1 - KINDLE_TOP },
      ]
    case 'off':
      return [{ action: 'menu', x: 0, y: 0, w: 1, h: 1 }]
  }
}

/** Action for a tap at (fx, fy), fractions of the stage. */
export function resolveTap(layout: TapLayout, fx: number, fy: number, rtl: boolean, invert: boolean): TapAction {
  for (const z of tapZones(layout, rtl, invert)) {
    if (fx >= z.x && fx <= z.x + z.w && fy >= z.y && fy <= z.y + z.h) return z.action
  }
  return 'menu'
}
