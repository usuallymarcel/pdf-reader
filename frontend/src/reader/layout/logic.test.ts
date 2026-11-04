import { describe, expect, it } from 'vitest'
import type { Doc, ReflowBlock } from '../../api/types'
import { buildSpreads, renderOrder, shouldDouble, spreadIndexOfPage, visualPages, type PageSize } from './spreads'
import { capRenderWidth, layoutSpread, scrollColumnWidth, spreadCrop } from './fit'
import { clampView, panRange, rubberClamp, zoomAt } from './viewTransform'
import { adjacentVolume, anchorToPosition, buildReflowIndex, positionToAnchor, scrollPosition } from './position'
import { chunkSections, sectionOfBlock } from './sections'
import { resolveTap } from '../input/tapZones'
import { resolveKey } from '../input/keyboard'
import { WheelPager } from '../input/wheelPager'
import { springDone, springStep } from '../input/spring'

const P: PageSize = [700, 1000]
const L: PageSize = [1400, 1000]
const pages = (s: { pages: number[] }[]) => s.map((x) => x.pages)

describe('buildSpreads', () => {
  it('single mode is one page per spread', () => {
    expect(pages(buildSpreads([P, P, P], { double: false, coverAlone: true, shift: false }))).toEqual([[1], [2], [3]])
  })
  it('keeps the cover alone and pairs the rest', () => {
    expect(pages(buildSpreads([P, P, P, P, P], { double: true, coverAlone: true, shift: false }))).toEqual([[1], [2, 3], [4, 5]])
  })
  it('pairs from page 1 without coverAlone', () => {
    expect(pages(buildSpreads([P, P, P, P], { double: true, coverAlone: false, shift: false }))).toEqual([[1, 2], [3, 4]])
  })
  it('never pairs a landscape page', () => {
    expect(pages(buildSpreads([P, P, L, P, P, P], { double: true, coverAlone: true, shift: false })))
      .toEqual([[1], [2], [3], [4, 5], [6]])
  })
  it('shift by one realigns pairing', () => {
    expect(pages(buildSpreads([P, P, P, P, P], { double: true, coverAlone: true, shift: true }))).toEqual([[1], [2], [3, 4], [5]])
    expect(pages(buildSpreads([P, P, P], { double: true, coverAlone: false, shift: true }))).toEqual([[1], [2, 3]])
  })
  it('finds the spread of a page and mirrors for RTL', () => {
    const s = buildSpreads([P, P, P, P, P], { double: true, coverAlone: true, shift: false })
    expect(spreadIndexOfPage(s, 3)).toBe(1)
    expect(spreadIndexOfPage(s, 5)).toBe(2)
    expect(visualPages(s[1]!, true)).toEqual([3, 2])
  })
  it('auto spreads need landscape, width and portrait pages', () => {
    expect(shouldDouble('auto', 1440, 900, [P])).toBe(true)
    expect(shouldDouble('auto', 390, 844, [P])).toBe(false)
    expect(shouldDouble('auto', 1440, 900, [L])).toBe(false)
    expect(shouldDouble('auto', 500, 400, [P])).toBe(false)
    expect(shouldDouble('double', 390, 844, [P])).toBe(true)
  })
  it('render order: current, ahead, one behind', () => {
    expect(renderOrder(5, 20, 3)).toEqual([5, 6, 7, 8, 4])
    expect(renderOrder(0, 2, 3)).toEqual([0, 1])
  })
})

describe('fit', () => {
  const size = (p: number): PageSize => (p === 2 ? [500, 1000] : P)
  it('contain fits both axes, equal page heights', () => {
    const l = layoutSpread([1, 2], size, 1000, 800, 'contain', 0)
    expect(l.h).toBeCloseTo(800)
    expect(l.boxes[0]!.h).toBe(l.boxes[1]!.h)
    expect(l.w).toBeLessThanOrEqual(1000)
    const narrow = layoutSpread([1], size, 300, 800, 'contain', 0)
    expect(narrow.w).toBeCloseTo(300)
  })
  it('width fit can overflow vertically', () => {
    const l = layoutSpread([1], size, 900, 400, 'width', 0)
    expect(l.w).toBeCloseTo(900)
    expect(l.h).toBeGreaterThan(400)
  })
  it('gap counts between pages only', () => {
    const l = layoutSpread([1, 2], size, 1000, 400, 'height', 10)
    expect(l.boxes[1]!.x).toBeCloseTo(l.boxes[0]!.w + 10)
  })
  it('spread crop is the union of content', () => {
    expect(spreadCrop([{ left: .1, right: .2, top: .05, bottom: 0 }, { left: .05, right: .3, top: .1, bottom: .1 }]))
      .toEqual({ left: .05, right: .2, top: .05, bottom: 0 })
  })
  it('caps render size at the pixel limit', () => {
    const w = capRenderWidth(20000, 0.7, 16_700_000)
    expect(w * (w / 0.7)).toBeLessThanOrEqual(16_700_001)
    expect(capRenderWidth(1000, 0.7, 16_700_000)).toBe(1000)
  })
  it('webtoon column stays reasonable on a desktop', () => {
    expect(scrollColumnWidth('contain', 1440, 900, [[800, 3000]])).toBe(720)
    expect(scrollColumnWidth('contain', 390, 844, [[800, 3000]])).toBe(390)
    expect(scrollColumnWidth('width', 1440, 900, [[800, 3000]])).toBe(1440)
  })
})

describe('view transform', () => {
  const d = { cw: 400, ch: 600, vw: 400, vh: 800 }
  it('centres content smaller than viewport', () => {
    expect(panRange(1, d)).toEqual({ minX: 0, maxX: 0, minY: 100, maxY: 100 })
  })
  it('keeps the focal point stable', () => {
    const z = zoomAt({ s: 1, x: 0, y: 100 }, 3, 200, 300)
    expect((200 - z.x) / z.s).toBeCloseTo(200)
    expect((300 - z.y) / z.s).toBeCloseTo(200)
  })
  it('clamps pan to edges', () => {
    expect(clampView({ s: 2, x: 50, y: -5000 }, d)).toEqual({ s: 2, x: 0, y: -400 })
  })
  it('rubber band resists and is monotonic', () => {
    expect(rubberClamp(150, 0, 100, 400)).toBeLessThan(150)
    expect(rubberClamp(150, 0, 100, 400)).toBeGreaterThan(100)
    expect(rubberClamp(50, 0, 100, 400)).toBe(50)
  })
})

describe('position mapping', () => {
  const blocks: ReflowBlock[] = [
    { t: 'h', text: 'Chapter', page: 1 },
    { t: 'p', text: 'a'.repeat(99), page: 1 },
    { t: 'img', page: 2 },
    { t: 'p', text: 'b'.repeat(99), page: 4 },
    { t: 'p', text: 'c'.repeat(99), page: 4 },
  ]
  const ix = buildReflowIndex(blocks)
  it('round-trips block anchors', () => {
    for (const a of [{ block: 1, char: 50 }, { block: 3, char: 10 }, { block: 4, char: 90 }]) {
      expect(positionToAnchor(ix, anchorToPosition(ix, a))).toEqual(a)
    }
  })
  it('maps a page without blocks to the block before', () => {
    expect(positionToAnchor(ix, { page: 3, offset: 0 })).toEqual({ block: 2, char: 0 })
    expect(positionToAnchor(ix, { page: 9, offset: 0.5 })).toEqual({ block: 4, char: 0 })
  })
  it('scroll offsets', () => {
    expect(scrollPosition([0, 100, 300], 150)).toEqual({ page: 2, offset: 0.25 })
    expect(scrollPosition([0, 100, 300], 0)).toEqual({ page: 1, offset: 0 })
  })
  it('finds adjacent volumes', () => {
    const d = (id: string, volume: number | null, series = 'S') => ({ id, volume, series, status: 'ready' }) as Doc
    const lib = [d('a', 1), d('b', 2), d('c', 4), d('x', 3, 'Other')]
    expect(adjacentVolume(lib, d('b', 2), 1)?.id).toBe('c')
    expect(adjacentVolume(lib, d('b', 2), -1)?.id).toBe('a')
    expect(adjacentVolume(lib, d('c', 4), 1)).toBeNull()
  })
})

describe('sections', () => {
  const p = (n: number, page = 1): ReflowBlock => ({ t: 'p', text: 'x'.repeat(n), page })
  it('splits at paragraph boundaries near the target', () => {
    const s = chunkSections(Array.from({ length: 10 }, () => p(600)), 1000)
    expect(s.every((x) => x.chars <= 1400)).toBe(true)
    expect(s[0]!.start).toBe(0)
    expect(s[s.length - 1]!.end).toBe(10)
    s.forEach((x, i) => { if (i) expect(x.start).toBe(s[i - 1]!.end) })
  })
  it('prefers a heading once reasonably full', () => {
    const blocks: ReflowBlock[] = [p(700), { t: 'h', text: 'Two', page: 2 }, p(700), p(700)]
    expect(chunkSections(blocks, 1000)[0]).toMatchObject({ start: 0, end: 1 })
  })
  it('does not split a giant paragraph, and merges a tiny tail', () => {
    expect(chunkSections([p(5000), p(50)], 1000)).toHaveLength(1)
  })
  it('finds a block section', () => {
    const s = [{ start: 0, end: 5, chars: 1 }, { start: 5, end: 9, chars: 1 }]
    expect(sectionOfBlock(s, 4)).toBe(0)
    expect(sectionOfBlock(s, 5)).toBe(1)
  })
})

describe('tap zones', () => {
  it('sides mirror for RTL and invert', () => {
    expect(resolveTap('sides', 0.1, 0.5, false, false)).toBe('prev')
    expect(resolveTap('sides', 0.9, 0.5, false, false)).toBe('next')
    expect(resolveTap('sides', 0.5, 0.5, false, false)).toBe('menu')
    expect(resolveTap('sides', 0.1, 0.5, true, false)).toBe('next')
    expect(resolveTap('sides', 0.1, 0.5, false, true)).toBe('next')
    expect(resolveTap('sides', 0.1, 0.5, true, true)).toBe('prev')
  })
  it('kindle L shape', () => {
    expect(resolveTap('kindle', 0.1, 0.5, false, false)).toBe('prev')
    expect(resolveTap('kindle', 0.6, 0.5, false, false)).toBe('next')
    expect(resolveTap('kindle', 0.1, 0.05, false, false)).toBe('menu')
    expect(resolveTap('kindle', 0.9, 0.5, true, false)).toBe('prev')
  })
  it('edges and off', () => {
    expect(resolveTap('edges', 0.3, 0.5, false, false)).toBe('menu')
    expect(resolveTap('edges', 0.05, 0.5, false, false)).toBe('prev')
    expect(resolveTap('off', 0.05, 0.5, false, false)).toBe('menu')
  })
})

describe('keyboard', () => {
  const k = (key: string, shiftKey = false) => ({ key, shiftKey, ctrlKey: false, metaKey: false, altKey: false })
  it('arrows follow direction', () => {
    expect(resolveKey(k('ArrowRight'), false)).toBe('next')
    expect(resolveKey(k('ArrowRight'), true)).toBe('prev')
    expect(resolveKey(k('ArrowLeft'), true)).toBe('next')
    expect(resolveKey(k(' ', true), true)).toBe('prev')
  })
  it('ignores browser shortcuts', () => {
    expect(resolveKey({ ...k('f'), ctrlKey: true }, false)).toBeNull()
  })
})

describe('wheel pager', () => {
  it('one trackpad flick is one page', () => {
    const w = new WheelPager()
    let flips = 0
    let t = 0
    for (let d = 60; d > 1; d *= 0.92) { t += 16; if (w.feed(d + 0.3, t)) flips++ }
    expect(flips).toBe(1)
  })
  it('each mouse notch flips, with cooldown', () => {
    const w = new WheelPager()
    expect(w.feed(120, 1000)).toBe(1)
    expect(w.feed(120, 1100)).toBe(0)
    expect(w.feed(-120, 1400)).toBe(-1)
  })
})

describe('spring', () => {
  it('settles on target', () => {
    let s = { x: 300, v: -1 }
    for (let i = 0; i < 120; i++) s = springStep(s, 0, 16)
    expect(springDone(s, 0)).toBe(true)
  })
})
