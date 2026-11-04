import type { Direction, DocKind, ReaderMode } from '../api/types'

export type Theme =
  | 'system' | 'custom' | 'dark' | 'oled' | 'slate' | 'midnight' | 'forest' | 'plum' | 'ember'
  | 'light' | 'paper' | 'sepia' | 'sage' | 'sky' | 'blush'
export type Corners = 'sharp' | 'soft' | 'round'
export type Fit = 'contain' | 'width' | 'height' | 'original'
export type Spreads = 'auto' | 'single' | 'double'
export type Transition = 'slide' | 'fade' | 'none'
export type TapLayout = 'sides' | 'kindle' | 'edges' | 'off'
export type WheelAction = 'page' | 'zoom' | 'scroll'
export type PageBackground =
  | 'black' | 'dark' | 'gray' | 'navy' | 'forest' | 'plum' | 'amber' | 'white' | 'paper' | 'sepia' | 'sage' | 'sky' | 'rose' | 'custom'
export type ProgressIndicator = 'hairline' | 'pages' | 'off'
export type ReflowFont = 'literata' | 'inter' | 'system' | 'serif' | 'opendyslexic'
export type ReflowLayout = 'paged' | 'scroll'

export interface ReflowSettings {
  font: ReflowFont
  fontSize: number // px, 12..36
  lineHeight: number // 1.1..2.4
  margin: number // px horizontal, 0..96
  maxWidth: number // characters, 40..100
  paragraphSpacing: number // em, 0..2
  indent: number // em, 0..3
  justify: boolean
  hyphenate: boolean
  layout: ReflowLayout
  columns: 'auto' | 1 | 2
}

export interface CustomColors { bg: string; fg: string }

export interface PageFilters {
  brightness: number // 0.3..1.3
  contrast: number // 0.7..1.5
  warmth: number // 0..1
  invert: boolean
  grayscale: boolean
}

export interface ReaderProfile {
  mode: ReaderMode | 'auto' // auto = doc.suggested_mode
  direction: Direction
  spreads: Spreads
  coverAlone: boolean
  /** shift pairing by one, for misaligned scans */
  spreadShift: boolean
  fit: Fit
  pageGap: number // px, scroll mode and spreads, 0..48
  background: PageBackground
  /** used when background is 'custom' */
  customColors: CustomColors
  transition: Transition
  tapLayout: TapLayout
  tapInvert: boolean
  swipe: boolean
  wheel: WheelAction
  cropMargins: boolean
  /** keep zoom when turning pages */
  stickyZoom: boolean
  filters: PageFilters
  indicator: ProgressIndicator
  keepAwake: boolean
  autoNextVolume: boolean
  preload: number // pages ahead, 1..8
  reflow: ReflowSettings
}

export interface Preferences {
  version: 1
  theme: Theme
  accent: string // #rrggbb
  /** used when theme is 'custom' */
  customTheme: CustomColors
  corners: Corners
  coverSize: 'small' | 'medium' | 'large'
  haptics: boolean
  groupSeries: boolean
  profiles: Record<DocKind, ReaderProfile>
}

const reflow: ReflowSettings = {
  font: 'literata', fontSize: 19, lineHeight: 1.6, margin: 24, maxWidth: 68,
  paragraphSpacing: 0.2, indent: 1.2, justify: true, hyphenate: true, layout: 'paged', columns: 'auto',
}

const filters: PageFilters = { brightness: 1, contrast: 1, warmth: 0, invert: false, grayscale: false }

const baseProfile: ReaderProfile = {
  mode: 'auto', direction: 'ltr', spreads: 'auto', coverAlone: true, spreadShift: false, fit: 'contain', pageGap: 0,
  background: 'black', customColors: { bg: '#1c1a17', fg: '#e6dfd0' }, transition: 'slide', tapLayout: 'sides', tapInvert: false, swipe: true,
  wheel: 'page', cropMargins: false, stickyZoom: false, filters, indicator: 'off', keepAwake: true, autoNextVolume: true,
  preload: 4, reflow,
}

export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  theme: 'dark',
  accent: '#7c9cff',
  customTheme: { bg: '#14181f', fg: '#e8ecf2' },
  corners: 'soft',
  coverSize: 'medium',
  haptics: true,
  groupSeries: true,
  profiles: {
    manga: { ...baseProfile, direction: 'rtl', indicator: 'off' },
    novel: { ...baseProfile, spreads: 'single', background: 'dark', indicator: 'pages' },
  },
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Deep-merge `patch` over `base`. Unknown keys are kept so newer clients don't lose data. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(out[key], value)
  return out as T
}

/** The effective profile for a book: global profile for its kind, then per-book overrides. */
export function resolveProfile(
  prefs: Preferences,
  kind: DocKind,
  overrides: Record<string, unknown>,
  docDirection: Direction | null,
): ReaderProfile {
  const merged = deepMerge(prefs.profiles[kind], overrides)
  return docDirection && overrides.direction === undefined ? { ...merged, direction: docDirection } : merged
}
