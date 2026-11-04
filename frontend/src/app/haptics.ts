import { usePreferences } from '../settings/store'

export function haptic(ms = 10) {
  if (usePreferences.getState().prefs.haptics) navigator.vibrate?.(ms)
}
