import type { Preferences, Theme } from '../settings/schema'

const THEME_BG: Record<Exclude<Theme, 'system'>, string> = {
  dark: '#0b0c0e', oled: '#000000', light: '#f6f6f7', sepia: '#f3ead9',
}

const prefersLight = () => window.matchMedia('(prefers-color-scheme: light)')

export const resolveTheme = (theme: Theme) => (theme === 'system' ? (prefersLight().matches ? 'light' : 'dark') : theme)

/** Near-black or white, whichever reads on the accent colour. Falls back to near-black for named colours. */
function onAccent(accent: string) {
  const hex = /^#([0-9a-f]{6})/i.exec(accent)?.[1]
  if (!hex) return '#0b0c0e'
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.2 ? '#0b0c0e' : '#ffffff'
}

export function applyTheme(prefs: Pick<Preferences, 'theme' | 'accent'>) {
  const resolved = resolveTheme(prefs.theme)
  const root = document.documentElement
  root.dataset.theme = resolved
  root.style.setProperty('--accent', prefs.accent)
  root.style.setProperty('--on-accent', onAccent(prefs.accent))
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_BG[resolved])
}

export function watchSystemTheme(onChange: () => void) {
  const media = prefersLight()
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
