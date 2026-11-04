import { contrast, isHex, mix, readableOn, toneOf } from '../settings/color'
import type { Corners, Preferences, Theme } from '../settings/schema'

export interface ThemeDef { value: Exclude<Theme, 'system' | 'custom'>; label: string; bg: string; fg: string }

export const THEMES: readonly ThemeDef[] = [
  { value: 'dark', label: 'Dark', bg: '#0b0c0e', fg: '#f1f2f4' },
  { value: 'oled', label: 'Black', bg: '#000000', fg: '#f1f2f4' },
  { value: 'slate', label: 'Slate', bg: '#20242b', fg: '#e8eaee' },
  { value: 'midnight', label: 'Midnight', bg: '#0e1424', fg: '#e3e8f4' },
  { value: 'forest', label: 'Forest', bg: '#0e1712', fg: '#dfe9e0' },
  { value: 'plum', label: 'Plum', bg: '#171021', fg: '#ebe2f2' },
  { value: 'ember', label: 'Ember', bg: '#1a100c', fg: '#f2e5dc' },
  { value: 'light', label: 'Light', bg: '#f6f6f7', fg: '#16171a' },
  { value: 'paper', label: 'Paper', bg: '#fbf9f4', fg: '#27241f' },
  { value: 'sepia', label: 'Sepia', bg: '#f3ead9', fg: '#3b2e1e' },
  { value: 'sage', label: 'Sage', bg: '#e6ece2', fg: '#202b22' },
  { value: 'sky', label: 'Sky', bg: '#e5eef6', fg: '#1a2a3a' },
  { value: 'blush', label: 'Blush', bg: '#f7e9e9', fg: '#3a2328' },
]

const RADII: Record<Corners, [number, number, number]> = { sharp: [3, 4, 8], soft: [8, 12, 20], round: [12, 18, 28] }

const MIN_UI_CONTRAST = 4.5
const fallback = THEMES[0] as ThemeDef

const prefersLight = () => window.matchMedia('(prefers-color-scheme: light)')

export const resolveTheme = (theme: Theme): Exclude<Theme, 'system'> =>
  (theme === 'system' ? (prefersLight().matches ? 'light' : 'dark') : theme)

/** A custom theme can't be allowed to hide the very controls that would fix it. */
export function usableColors(bg: string, fg: string) {
  const background = isHex(bg) ? bg : fallback.bg
  const text = isHex(fg) && contrast(background, fg) >= MIN_UI_CONTRAST ? fg : readableOn(background)
  return { bg: background, fg: text, adjusted: text !== fg }
}

/** Every surface, line and shade of text comes from one background and one text colour. */
export function themeTokens(bg: string, fg: string): Record<string, string> {
  const light = toneOf(bg) === 'light'
  const raised = light ? mix('#ffffff', bg, 0.6) : mix(fg, bg, 0.05)
  return {
    '--bg': bg,
    '--bg-raised': raised,
    '--bg-overlay': `${light ? raised : mix(fg, bg, 0.09)}f5`,
    '--bg-hover': `${fg}${light ? '12' : '16'}`,
    '--fg': fg,
    '--fg-muted': mix(fg, bg, light ? 0.74 : 0.64),
    '--fg-faint': mix(fg, bg, light ? 0.5 : 0.44),
    '--line': `${fg}${light ? '1c' : '1a'}`,
    '--danger': light ? '#c62f2f' : '#ff6b6b',
    '--shadow': light ? '0 8px 28px #0002' : '0 8px 32px #0009',
  }
}

export function applyTheme(prefs: Pick<Preferences, 'theme' | 'accent' | 'customTheme' | 'corners'>) {
  const resolved = resolveTheme(prefs.theme)
  const def = THEMES.find((t) => t.value === resolved) ?? fallback
  const { bg, fg } = resolved === 'custom' ? usableColors(prefs.customTheme.bg, prefs.customTheme.fg) : def
  const accent = isHex(prefs.accent) ? prefs.accent : '#7c9cff'
  const [s, m, l] = RADII[prefs.corners] ?? RADII.soft
  const vars = {
    ...themeTokens(bg, fg),
    '--accent': accent,
    '--on-accent': readableOn(accent),
    '--radius-s': `${s}px`,
    '--radius-m': `${m}px`,
    '--radius-l': `${l}px`,
  }
  const tone = toneOf(bg)
  const root = document.documentElement
  root.dataset.theme = resolved
  root.dataset.tone = tone
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
  root.style.backgroundColor = bg
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg)
  try {
    // public/boot.js replays this before first paint, so nothing flashes the default theme.
    localStorage.setItem('shelf.theme', JSON.stringify({ theme: resolved, tone, bg, vars }))
  } catch { /* storage full or denied: only costs a flash */ }
}

export function watchSystemTheme(onChange: () => void) {
  const media = prefersLight()
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
