import { create } from 'zustand'
import { api } from '../api/client'
import { DEFAULT_PREFERENCES, deepMerge, type Preferences } from './schema'

const STORAGE_KEY = 'shelf.preferences'
const SAVE_DEBOUNCE_MS = 800

function loadLocal(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? deepMerge(DEFAULT_PREFERENCES, JSON.parse(raw)) : DEFAULT_PREFERENCES
  } catch {
    return DEFAULT_PREFERENCES
  }
}

interface PreferencesStore {
  prefs: Preferences
  /** Deep-merges a partial update; persists locally at once and to the server debounced. */
  update: (patch: unknown) => void
  reset: () => void
  /** Pull from the server (call after session changes). Server wins when it has data. */
  hydrate: () => Promise<void>
}

let saveTimer: number | undefined

export const usePreferences = create<PreferencesStore>((set, get) => {
  const persist = () => {
    const { prefs } = get()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      api.savePreferences(prefs as unknown as Record<string, unknown>).catch(() => undefined)
    }, SAVE_DEBOUNCE_MS)
  }
  return {
    prefs: loadLocal(),
    update: (patch) => { set({ prefs: deepMerge(get().prefs, patch) }); persist() },
    reset: () => { set({ prefs: DEFAULT_PREFERENCES }); persist() },
    hydrate: async () => {
      const remote = await api.preferences().catch(() => null)
      if (!remote?.data) return
      const prefs = deepMerge(DEFAULT_PREFERENCES, remote.data)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
      set({ prefs })
    },
  }
})
