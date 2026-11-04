import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { X } from 'lucide-react'

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)}>
      <span />
    </button>
  )
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: {
  value: T
  options: readonly { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="segmented">
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({ label, value, min, max, step, onChange, format }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  const id = useId()
  return (
    <div className="slider">
      <label htmlFor={id}>{label}</label>
      <output htmlFor={id}>{format ? format(value) : value}</output>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  )
}

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="color-field">
      <span className="color-chip" style={{ background: value }} />
      {label}
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

export const Spinner = () => <span className="spinner" aria-hidden="true" />

/** Full-screen stand-in while a book opens. Blank for a moment, so a quick open has no flash. */
export const Boot = ({ label }: { label: string }) => <div className="reader-boot" role="status" aria-label={label}><Spinner /></div>

/** Bottom sheet on phones (drag grip down to dismiss), side drawer on wide screens. */
export function Sheet({ title, onClose, children, actions, modal = true }: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  actions?: ReactNode
  /** false leaves the content behind interactive and undimmed (e.g. live-previewing reader settings) */
  modal?: boolean
}) {
  const panel = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startY: number; dy: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Modal sheets take focus, keep Tab inside and hand focus back on close.
  useEffect(() => {
    if (!modal) return
    const opener = document.activeElement as HTMLElement | null
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus({ preventScroll: true })
    return () => opener?.focus?.({ preventScroll: true })
  }, [modal])

  const trapTab = (e: ReactKeyboardEvent) => {
    if (!modal || e.key !== 'Tab' || !panel.current) return
    const items = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select, textarea, [tabindex="0"]')]
    const first = items[0]
    const last = items.at(-1)
    if (!first || !last) return
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === panel.current)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
  }

  return createPortal(
    <>
      {modal && <div className="sheet-backdrop" onClick={onClose} />}
      <div ref={panel} className="sheet" role="dialog" tabIndex={-1} onKeyDown={trapTab} aria-modal={modal} aria-label={typeof title === 'string' ? title : undefined}>
        <div
          className="sheet-grip"
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { startY: e.clientY, dy: 0 } }}
          onPointerMove={(e) => {
            if (!drag.current || !panel.current) return
            drag.current.dy = Math.max(0, e.clientY - drag.current.startY)
            panel.current.style.transform = `translateY(${drag.current.dy}px)`
          }}
          onPointerUp={() => {
            const dy = drag.current?.dy ?? 0
            drag.current = null
            if (dy > 90) onClose()
            else if (panel.current) panel.current.style.transform = ''
          }}
        />
        <div className="sheet-head">
          <h2>{title}</h2>
          {actions}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </>,
    document.body,
  )
}

interface Toast { id: number; message: string; action?: { label: string; run: () => void } }
const useToastStore = create<{ toasts: Toast[]; push: (t: Toast) => void; drop: (id: number) => void }>((set) => ({
  toasts: [],
  push: (t) => set((s) => ({ toasts: [...s.toasts.slice(-2), t] })),
  drop: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

let toastSeq = 0
export function toast(message: string, action?: Toast['action'], durationMs = 4000) {
  const id = ++toastSeq
  useToastStore.getState().push({ id, message, action })
  window.setTimeout(() => useToastStore.getState().drop(id), durationMs)
  return id
}

export const dismissToast = (id: number) => useToastStore.getState().drop(id)

export function Toasts() {
  const { toasts, drop } = useToastStore()
  return createPortal(
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          <span>{t.message}</span>
          {t.action && <button type="button" onClick={() => { t.action?.run(); drop(t.id) }}>{t.action.label}</button>}
        </div>
      ))}
    </div>,
    document.body,
  )
}
