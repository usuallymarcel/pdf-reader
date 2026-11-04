export type KeyAction =
  | 'next' | 'prev' | 'first' | 'last' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'fullscreen' | 'cycleMode'
  | 'bookmark' | 'contents' | 'settings' | 'search' | 'shortcuts' | 'escape' | 'prevVolume' | 'nextVolume'

export interface KeyLike { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }

/** Map a key press to a reader action. Arrow keys follow reading direction. */
export function resolveKey(e: KeyLike, rtl: boolean): KeyAction | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null
  switch (e.key) {
    case 'ArrowRight': return rtl ? 'prev' : 'next'
    case 'ArrowLeft': return rtl ? 'next' : 'prev'
    case 'ArrowDown': case 'PageDown': return 'next'
    case 'ArrowUp': case 'PageUp': return 'prev'
    case ' ': return e.shiftKey ? 'prev' : 'next'
    case 'Home': return 'first'
    case 'End': return 'last'
    case '+': case '=': return 'zoomIn'
    case '-': case '_': return 'zoomOut'
    case '0': return 'zoomReset'
    case 'f': return 'fullscreen'
    case 'm': return 'cycleMode'
    case 'b': return 'bookmark'
    case 't': return 'contents'
    case 's': return 'settings'
    case '/': return 'search'
    case '?': return 'shortcuts'
    case 'Escape': return 'escape'
    case '[': return 'prevVolume'
    case ']': return 'nextVolume'
    default: return null
  }
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t instanceof HTMLInputElement) return !['range', 'checkbox', 'radio', 'button'].includes(t.type)
  return t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable
}

export const SHORTCUTS: readonly (readonly [string, string])[] = [
  ['← → ↑ ↓', 'Turn page'], ['PgUp PgDn', 'Turn page'], ['Space', 'Next page (Shift: back)'], ['Home End', 'First / last page'],
  ['+ - 0', 'Zoom in, out, reset'], ['F', 'Fullscreen'], ['M', 'Cycle mode'], ['B', 'Bookmark'], ['T', 'Contents'],
  ['S', 'Settings'], ['/', 'Search'], ['[ ]', 'Previous / next volume'], ['Esc', 'Close or go back'], ['?', 'This list'],
]
