import { describe, expect, it } from 'vitest'
import { THEMES, themeTokens, usableColors } from '../app/theme'
import { isContinuous, isTextView, makeView, nextView, viewOf, viewPatch } from '../reader/look'
import { contrast, isHex, mix, readableOn, toneOf } from './color'
import { COLORWAYS, resolveColors } from './colorways'
import { DEFAULT_PREFERENCES, deepMerge, type PageBackground } from './schema'

const solid = (value: string | undefined) => (value ?? '').slice(0, 7)

describe('colour maths', () => {
  it('mixes and measures', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mix('#ff0000', '#0000ff', 1)).toBe('#ff0000')
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21)
    expect(contrast('#123456', '#123456')).toBeCloseTo(1)
    expect(toneOf('#f6f6f7')).toBe('light')
    expect(toneOf('#0b0c0e')).toBe('dark')
  })

  it('accepts only full hex colours', () => {
    expect(isHex('#a1B2c3')).toBe(true)
    for (const bad of ['red', '#fff', '#12345g', 'url(x)', 1, null, undefined]) expect(isHex(bad)).toBe(false)
  })

  it('picks readable text for any accent', () => {
    for (const accent of ['#7c9cff', '#111111', '#ffffff', '#e0b04c', '#0000ff']) {
      expect(contrast(accent, readableOn(accent))).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('themes', () => {
  it.each(THEMES.map((t) => [t.label, t] as const))('%s stays readable', (_label, theme) => {
    const tokens = themeTokens(theme.bg, theme.fg)
    const bg = solid(tokens['--bg'])
    const raised = solid(tokens['--bg-raised'])
    const overlay = solid(tokens['--bg-overlay'])
    expect(contrast(bg, theme.fg)).toBeGreaterThanOrEqual(7)
    expect(contrast(raised, theme.fg)).toBeGreaterThanOrEqual(7)
    expect(contrast(overlay, theme.fg)).toBeGreaterThanOrEqual(7)
    expect(contrast(bg, solid(tokens['--fg-muted']))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(raised, solid(tokens['--fg-muted']))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(bg, solid(tokens['--fg-faint']))).toBeGreaterThanOrEqual(2.5)
  })

  it('all have different ids and backgrounds', () => {
    expect(new Set(THEMES.map((t) => t.value)).size).toBe(THEMES.length)
    expect(new Set(THEMES.map((t) => t.bg)).size).toBe(THEMES.length)
  })

  it('a custom theme can never hide the settings that would fix it', () => {
    expect(usableColors('#808080', '#808080').fg).not.toBe('#808080')
    expect(contrast('#808080', usableColors('#808080', '#808080').fg)).toBeGreaterThanOrEqual(4.5)
    expect(usableColors('#101010', '#f0f0f0')).toEqual({ bg: '#101010', fg: '#f0f0f0', adjusted: false })
    expect(usableColors('nonsense', 'url(x)').bg).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('reading colours', () => {
  it.each(COLORWAYS.map((c) => [c.label, c] as const))('%s reads comfortably', (_label, way) => {
    expect(contrast(way.bg, way.fg)).toBeGreaterThanOrEqual(7)
  })

  it('custom colours come through, bad ones do not', () => {
    const custom = { background: 'custom' as PageBackground, customColors: { bg: '#102030', fg: '#e0e0d0' } }
    expect(resolveColors(custom)).toMatchObject({ bg: '#102030', fg: '#e0e0d0' })
    const hostile = resolveColors({ background: 'custom', customColors: { bg: 'url(evil)', fg: 'red;' } })
    expect(isHex(hostile.bg) && isHex(hostile.fg)).toBe(true)
  })

  it('an unknown colourway from a newer client falls back', () => {
    expect(isHex(resolveColors({ background: 'future' as PageBackground, customColors: { bg: '#000000', fg: '#ffffff' } }).bg)).toBe(true)
  })

  it('preferences saved before these options existed gain the defaults', () => {
    const merged = deepMerge(DEFAULT_PREFERENCES, { theme: 'sepia', profiles: { novel: { background: 'white' } } })
    expect(merged.corners).toBe('soft')
    expect(merged.customTheme).toEqual(DEFAULT_PREFERENCES.customTheme)
    expect(merged.profiles.novel.customColors).toEqual(DEFAULT_PREFERENCES.profiles.novel.customColors)
    expect(merged.profiles.novel.background).toBe('white')
  })
})

describe('reader views', () => {
  it('text has both flows', () => {
    expect(viewOf('reflow', 'scroll')).toBe('text-scroll')
    expect(viewOf('reflow', 'paged')).toBe('text-paged')
    expect(viewOf('scroll', 'paged')).toBe('scroll')
  })

  it('every view survives a round trip through its settings patch', () => {
    for (const view of ['paged', 'scroll', 'text-paged', 'text-scroll'] as const) {
      const base = deepMerge(DEFAULT_PREFERENCES.profiles.novel, viewPatch(view))
      expect(viewOf(base.mode as 'paged', base.reflow.layout)).toBe(view)
      expect(makeView(isTextView(view), isContinuous(view))).toBe(view)
    }
  })

  it('image books never cycle into text', () => {
    expect(nextView('paged', false)).toBe('scroll')
    expect(nextView('scroll', false)).toBe('paged')
    expect(nextView('scroll', true)).toBe('text-paged')
    expect(nextView('text-paged', true)).toBe('text-scroll')
    expect(nextView('text-scroll', true)).toBe('paged')
  })
})
