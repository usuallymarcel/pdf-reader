import { useEffect, useState } from 'react'
import type { TapLayout } from '../../settings/schema'
import { tapZones, type TapAction } from '../input/tapZones'

const KEY = 'shelf.tapHint.'
const LABEL: Record<TapAction, string> = { prev: 'Back', next: 'Forward', menu: 'Menu' }

/** Shown once per tap layout: which part of the page does what. Any tap dismisses it. */
export function TapHint({ layout, rtl, invert, enabled }: { layout: TapLayout; rtl: boolean; invert: boolean; enabled: boolean }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!enabled || layout === 'off') { setShow(false); return }
    try {
      setShow(!localStorage.getItem(KEY + layout))
    } catch { setShow(false) }
  }, [layout, enabled])
  if (!show) return null
  const dismiss = () => {
    setShow(false)
    try { localStorage.setItem(KEY + layout, '1') } catch { /* private mode */ }
  }
  return (
    <div className="taphint" role="button" tabIndex={0} aria-label="Tap zones. Tap to dismiss" onPointerDown={dismiss} onKeyDown={dismiss}>
      {tapZones(layout, rtl, invert).map((z) => (
        <div key={`${z.action}${z.x}${z.y}`} className={`taphint-zone taphint-${z.action}`}
          style={{ left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%` }}>
          <span>{LABEL[z.action]}</span>
        </div>
      ))}
    </div>
  )
}
