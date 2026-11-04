import { create } from 'zustand'
import { api } from '../api/client'
import { currentScope } from '../offline/scope'
import { DEFAULT_PREFERENCES, deepMerge, type Preferences } from './schema'

const STORAGE_KEY = 'shelf.preferences'
const UNSAVED_KEY = 'shelf.preferences.unsaved' // which scope has changes the server hasn't seen
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
  const send = (prefs: Preferences) => api.savePreferences(prefs as unknown as Record<string, unknown>).then(
    () => { if (get().prefs === prefs) localStorage.removeItem(UNSAVED_KEY) },
    () => undefined,
  )
  const persist = () => {
    const { prefs } = get()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
    localStorage.setItem(UNSAVED_KEY, currentScope())
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => void send(prefs), SAVE_DEBOUNCE_MS)
  }
  return {
    prefs: loadLocal(),
    update: (patch) => { set({ prefs: deepMerge(get().prefs, patch) }); persist() },
    reset: () => { set({ prefs: DEFAULT_PREFERENCES }); persist() },
    hydrate: async () => {
      // Changed here and never sent, say by reloading straight away: this device has the newer copy.
      if (localStorage.getItem(UNSAVED_KEY) === currentScope()) return void send(get().prefs)
      // Someone else's leftovers: they must not reach this account, now or on their next sign-in.
      window.clearTimeout(saveTimer)
      localStorage.removeItem(UNSAVED_KEY)
      const remote = await api.preferences().catch(() => null)
      if (!remote?.data) return
      const prefs = deepMerge(DEFAULT_PREFERENCES, remote.data)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
      set({ prefs })
    },
  }
})
