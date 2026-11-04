import { useEffect, useState } from 'react'

/** Keep the screen on while reading; the lock is released whenever the tab hides, so take it again. */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let stopped = false
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || lock) return
      try {
        const got = await navigator.wakeLock.request('screen')
        if (stopped) { void got.release(); return }
        lock = got
        got.addEventListener('release', () => { lock = null })
      } catch { /* denied or low battery: reading still works */ }
    }
    void acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', acquire)
      void lock?.release()
    }
  }, [enabled])
}

/** Make the browser UI and overscroll areas blend into the page; restored on exit. */
export function useThemeColor(color: string) {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    const prevMeta = meta?.content
    const prevBody = document.body.style.background
    return () => {
      if (meta && prevMeta !== undefined) meta.content = prevMeta
      document.body.style.background = prevBody
    }
  }, [])
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (meta) meta.content = color
    document.body.style.background = color
  }, [color])
}

export const fullscreenAvailable = () => !!document.documentElement.requestFullscreen

export function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
  else void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => undefined)
}

export function useIsFullscreen() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const f = () => setOn(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', f)
    return () => document.removeEventListener('fullscreenchange', f)
  }, [])
  return on
}
