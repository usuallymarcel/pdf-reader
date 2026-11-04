import type { Doc, ReaderMode } from '../api/types'
import type { PageFilters, ReaderProfile, ReflowLayout } from '../settings/schema'

/** The page look as a CSS filter: cheap, and needs no re-render. */
export function filterCss(f: PageFilters): string {
  const parts: string[] = []
  if (f.invert) parts.push('invert(1)', 'hue-rotate(180deg)')
  if (f.brightness !== 1) parts.push(`brightness(${f.brightness})`)
  if (f.contrast !== 1) parts.push(`contrast(${f.contrast})`)
  if (f.grayscale) parts.push('grayscale(1)')
  if (f.warmth > 0) parts.push(`sepia(${(f.warmth * 0.55).toFixed(3)})`, `hue-rotate(${(-f.warmth * 8).toFixed(1)}deg)`)
  return parts.length ? parts.join(' ') : 'none'
}

export function effectiveMode(profile: ReaderProfile, doc: Pick<Doc, 'suggested_mode' | 'has_text'>): ReaderMode {
  const mode = profile.mode === 'auto' ? doc.suggested_mode : profile.mode
  return mode === 'reflow' && !doc.has_text ? 'paged' : mode
}

/** What the reader shows: the original pages or the text, each either paged or continuous. */
export type ReaderView = 'paged' | 'scroll' | 'text-paged' | 'text-scroll'

export const viewOf = (mode: ReaderMode, layout: ReflowLayout): ReaderView =>
  (mode === 'reflow' ? `text-${layout}` : mode)

export const viewPatch = (view: ReaderView): Record<string, unknown> => {
  if (view === 'paged' || view === 'scroll') return { mode: view }
  return { mode: 'reflow', reflow: { layout: view === 'text-scroll' ? 'scroll' : 'paged' } }
}

export const isTextView = (view: ReaderView) => view === 'text-paged' || view === 'text-scroll'
export const isContinuous = (view: ReaderView) => view === 'scroll' || view === 'text-scroll'

export const makeView = (text: boolean, continuous: boolean): ReaderView =>
  (text ? (continuous ? 'text-scroll' : 'text-paged') : (continuous ? 'scroll' : 'paged'))

const ORDER: readonly ReaderView[] = ['paged', 'scroll', 'text-paged', 'text-scroll']

export const nextView = (view: ReaderView, hasText: boolean): ReaderView => {
  const views = hasText ? ORDER : ORDER.slice(0, 2)
  return views[(views.indexOf(view) + 1) % views.length] ?? 'paged'
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" }

/** Split a search snippet into plain and <mark>ed runs without ever parsing it as HTML. */
export function snippetParts(snippet: string): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = []
  const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (e) => ENTITIES[e] ?? e)
  snippet.split(/(<mark>.*?<\/mark>)/s).forEach((run) => {
    if (!run) return
    const marked = run.startsWith('<mark>')
    out.push({ text: decode(marked ? run.slice(6, -7) : run), mark: marked })
  })
  return out
}

/** Remove from `overrides` every leaf that `patch` sets, so a global change becomes visible on this book. */
export function stripOverrides(overrides: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...overrides }
  for (const [key, value] of Object.entries(patch)) {
    const cur = out[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && cur && typeof cur === 'object') {
      const inner = stripOverrides(cur as Record<string, unknown>, value as Record<string, unknown>)
      if (Object.keys(inner).length) out[key] = inner
      else delete out[key]
    } else {
      delete out[key]
    }
  }
  return out
}
