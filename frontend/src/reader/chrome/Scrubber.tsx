import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { PageRenderer } from '../pdf/renderer'
import { useReaderUi } from '../store'
import { Thumb } from './Thumb'

/** Page scrubber. Dragging only previews; the page changes on release, so a fast sweep stays cheap. */
export function Scrubber({ total, rtl, renderer, onSeek, thumbnails = true }: {
  total: number
  rtl: boolean
  renderer: PageRenderer | null
  onSeek: (page: number) => void
  thumbnails?: boolean
}) {
  const page = useReaderUi((s) => s.position.page)
  const [drag, setDrag] = useState<number | null>(null)
  const track = useRef<HTMLDivElement>(null)
  const shown = drag ?? page
  const fraction = total > 1 ? (shown - 1) / (total - 1) : 0
  const atX = rtl ? 1 - fraction : fraction

  const pageAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect()
    if (!r) return page
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return Math.round((rtl ? 1 - f : f) * (total - 1)) + 1
  }

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag(pageAt(e.clientX))
  }
  const move = (e: PointerEvent) => { if (drag !== null) setDrag(pageAt(e.clientX)) }
  const up = (e: PointerEvent) => {
    if (drag === null) return
    const target = pageAt(e.clientX)
    setDrag(null)
    onSeek(target)
  }
  const key = (e: KeyboardEvent) => {
    const dir = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: 1, ArrowDown: -1 }[e.key]
    if (!dir) return
    e.preventDefault()
    e.stopPropagation()
    onSeek(Math.max(1, Math.min(total, page + dir)))
  }

  return (
    <div ref={track} className="scrubber" role="slider" tabIndex={0} aria-label="Page" aria-valuemin={1} aria-valuemax={total} aria-valuenow={shown}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)} onKeyDown={key}>
      <div className="scrubber-rail">
        <div className="scrubber-fill" style={rtl ? { right: 0, width: `${fraction * 100}%` } : { left: 0, width: `${fraction * 100}%` }} />
        <div className="scrubber-knob" style={{ left: `${atX * 100}%` }} />
      </div>
      {drag !== null && (
        <div className="scrubber-bubble" style={{ left: `clamp(70px, ${atX * 100}%, calc(100% - 70px))` }}>
          {renderer && thumbnails && <Thumb renderer={renderer} page={drag} urgent />}
          <span>{drag}</span>
        </div>
      )}
    </div>
  )
}
