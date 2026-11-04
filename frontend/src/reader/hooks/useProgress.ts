import { useCallback, useEffect, useRef } from 'react'
import type { DocDetail } from '../../api/types'
import { saveProgress } from '../../offline/progress'
import { toast } from '../../ui/primitives'
import type { Position } from '../layout/position'

const SAVE_DEBOUNCE_MS = 1000
const IDLE_LIMIT_MS = 2 * 60 * 1000
const SECONDS_FLUSH_EVERY = 30

/**
 * Debounced progress saves, flushed with keepalive when the page hides. Counts active seconds: paused
 * while hidden or after two idle minutes. Also notices a newer position from another device.
 */
export function useProgress(doc: DocDetail, onJump: (pos: Position) => void) {
  const pending = useRef<Position | null>(null)
  const last = useRef<Position>({ page: doc.state.page, offset: doc.state.offset })
  const lastTs = useRef(doc.state.client_ts)
  const offered = useRef(doc.state.client_ts)
  const seconds = useRef(0)
  const lastActive = useRef(Date.now())
  const timer = useRef<number | undefined>(undefined)
  const id = doc.id

  const flush = useCallback((keepalive: boolean) => {
    window.clearTimeout(timer.current)
    const pos = pending.current ?? last.current
    const secs = seconds.current
    if (!pending.current && !secs) return
    pending.current = null
    seconds.current = 0
    const client_ts = Date.now()
    lastTs.current = client_ts
    saveProgress(id, { page: pos.page, offset: pos.offset, seconds: secs, client_ts }, keepalive)
  }, [id])

  const report = useCallback((pos: Position) => {
    if (pos.page === last.current.page && Math.abs(pos.offset - last.current.offset) < 0.005) return
    last.current = pos
    pending.current = pos
    lastActive.current = Date.now()
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => flush(false), SAVE_DEBOUNCE_MS)
  }, [flush])

  useEffect(() => {
    const tick = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || Date.now() - lastActive.current > IDLE_LIMIT_MS) return
      seconds.current += 1
      if (seconds.current >= SECONDS_FLUSH_EVERY) flush(false)
    }, 1000)
    const active = () => { lastActive.current = Date.now() }
    const hide = () => { if (document.visibilityState === 'hidden') flush(true) }
    const pagehide = () => flush(true)
    window.addEventListener('pointerdown', active, { passive: true })
    window.addEventListener('keydown', active)
    window.addEventListener('wheel', active, { passive: true })
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', pagehide)
    return () => {
      window.clearInterval(tick)
      window.removeEventListener('pointerdown', active)
      window.removeEventListener('keydown', active)
      window.removeEventListener('wheel', active)
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', pagehide)
      flush(true)
    }
  }, [flush])

  // Another device moved on: offer the jump, never take it.
  const { client_ts, page, offset } = doc.state
  useEffect(() => {
    if (client_ts <= offered.current || client_ts <= lastTs.current) return
    offered.current = client_ts
    if (page > last.current.page) {
      toast(`Continue from page ${page}?`, { label: 'Jump', run: () => onJump({ page, offset }) }, 10000)
    }
  }, [client_ts, page, offset, onJump])

  return report
}
