import { isHex, mix } from './color'
import type { CustomColors, PageBackground, ReaderProfile } from './schema'

export interface Colorway { value: Exclude<PageBackground, 'custom'>; label: string; bg: string; fg: string }

/** Reading colours: the page behind images, and the page and ink of text mode. */
export const COLORWAYS: readonly Colorway[] = [
  { value: 'black', label: 'Black', bg: '#000000', fg: '#c8c8c8' },
  { value: 'dark', label: 'Charcoal', bg: '#15161a', fg: '#d6d7da' },
  { value: 'gray', label: 'Graphite', bg: '#2c2d31', fg: '#e2e2e4' },
  { value: 'navy', label: 'Navy', bg: '#0f1626', fg: '#c5cfe0' },
  { value: 'forest', label: 'Forest', bg: '#102018', fg: '#c4d6c4' },
  { value: 'plum', label: 'Plum', bg: '#1e1426', fg: '#d8c8e0' },
  { value: 'amber', label: 'Amber', bg: '#120d06', fg: '#e8b45e' },
  { value: 'white', label: 'White', bg: '#ffffff', fg: '#1b1b1d' },
  { value: 'paper', label: 'Paper', bg: '#faf7f0', fg: '#2a2620' },
  { value: 'sepia', label: 'Sepia', bg: '#f3ead9', fg: '#3b2e1e' },
  { value: 'sage', label: 'Sage', bg: '#dfe8d8', fg: '#26331f' },
  { value: 'sky', label: 'Sky', bg: '#dbe7f0', fg: '#1d2c3a' },
  { value: 'rose', label: 'Rose', bg: '#f5e1e3', fg: '#3a2226' },
]

export interface ReadingColors { bg: string; fg: string; muted: string }

const fallback = COLORWAYS[0] as Colorway

export function resolveColors(profile: Pick<ReaderProfile, 'background' | 'customColors'>): ReadingColors {
  const way: Pick<Colorway, 'bg' | 'fg'> = profile.background === 'custom'
    ? safeCustom(profile.customColors)
    : COLORWAYS.find((c) => c.value === profile.background) ?? fallback
  return { bg: way.bg, fg: way.fg, muted: mix(way.fg, way.bg, 0.6) }
}

/** Preferences sync from the server, so a hand-edited value must not reach the CSS. */
const safeCustom = (c: CustomColors) => ({ bg: isHex(c.bg) ? c.bg : fallback.bg, fg: isHex(c.fg) ? c.fg : fallback.fg })
