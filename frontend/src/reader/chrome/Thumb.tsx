import { useEffect, useRef } from 'react'
import type { PageRenderer } from '../pdf/renderer'

/** A page thumbnail, copied out of the thumbnail cache. Unmounting withdraws the render. */
export function Thumb({ renderer, page, urgent = false, label }: {
  renderer: PageRenderer
  page: number
  urgent?: boolean
  label?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ac = new AbortController()
    const known = renderer.thumbEntry(page)
    const paint = (src: { canvas: HTMLCanvasElement; width: number; height: number }) => {
      canvas.width = src.width
      canvas.height = src.height
      canvas.getContext('2d', { alpha: false })?.drawImage(src.canvas, 0, 0)
    }
    if (known) paint(known)
    else {
      // Debounced so sweeping past a page does not even queue it.
      const t = window.setTimeout(() => {
        void renderer.thumb(page, urgent, ac.signal).then((e) => { if (e && !ac.signal.aborted) paint(e) })
      }, urgent ? 40 : 90)
      ac.signal.addEventListener('abort', () => window.clearTimeout(t))
    }
    return () => {
      ac.abort()
      canvas.width = 0
      canvas.height = 0
    }
  }, [renderer, page, urgent])
  return <canvas ref={ref} className="thumb" aria-label={label} />
}
