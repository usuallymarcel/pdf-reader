import { useMemo, useRef, type MouseEvent, type PointerEvent } from 'react'
import { haptic } from '../app/haptics'

const LONG_PRESS_MS = 420
const MOVE_TOLERANCE_PX = 10

/** Long-press on touch, right-click and the Menu key elsewhere, all ending in `onMenu`. */
export function useCardPress(onMenu: () => void) {
  const timer = useRef<number | undefined>(undefined)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)

  return useMemo(() => {
    const cancel = () => { window.clearTimeout(timer.current); start.current = null }
    return {
      onPointerDown: (e: PointerEvent) => {
        fired.current = false
        if (e.pointerType === 'mouse') return
        start.current = { x: e.clientX, y: e.clientY }
        timer.current = window.setTimeout(() => {
          fired.current = true
          haptic()
          onMenu()
        }, LONG_PRESS_MS)
      },
      onPointerMove: (e: PointerEvent) => {
        if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > MOVE_TOLERANCE_PX) cancel()
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onContextMenu: (e: MouseEvent) => {
        e.preventDefault()
        if (!fired.current) onMenu()
      },
      /** A click that ends a long-press must not also open the book. */
      consumeLongPress: () => {
        const was = fired.current
        fired.current = false
        return was
      },
    }
  }, [onMenu])
}
