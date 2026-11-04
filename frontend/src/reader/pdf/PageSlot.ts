import { NO_CROP, type Crop } from '../layout/fit'
import type { PageRenderer } from './renderer'

export interface SlotBox { x: number; y: number; w: number; h: number }

/**
 * One page on screen, at a known size before anything is rendered. Shows the best thing available, the
 * cached canvas itself, else a stretched thumbnail, else a quiet placeholder, and upgrades in place.
 */
export class PageSlot {
  readonly el = document.createElement('div')
  private canvas: HTMLCanvasElement | null = null
  private placeholder: HTMLCanvasElement | null = null
  private retryBtn: HTMLButtonElement | null = null
  private box: SlotBox = { x: 0, y: 0, w: 0, h: 0 }
  private crop: Crop = NO_CROP
  private unsubscribe: () => void

  constructor(private renderer: PageRenderer, readonly page: number) {
    this.el.className = 'pslot'
    this.el.dataset.page = String(page)
    renderer.pin(page)
    this.unsubscribe = renderer.subscribe(page, () => this.refresh())
    this.refresh()
  }

  layout(box: SlotBox, crop: Crop = NO_CROP) {
    this.box = box
    this.crop = crop
    const s = this.el.style
    s.width = `${box.w}px`
    s.height = `${box.h}px`
    s.left = `${box.x}px`
    s.top = `${box.y}px`
    if (this.canvas) this.place(this.canvas)
    if (this.placeholder) this.place(this.placeholder)
  }

  /** Width in device px this slot would need to be pin-sharp at the given extra scale. */
  wantedWidth(dpr: number, zoom = 1) {
    return (this.box.w / Math.max(0.05, 1 - this.crop.left - this.crop.right)) * dpr * zoom
  }

  private place(c: HTMLCanvasElement) {
    const { box, crop } = this
    const fullW = box.w / Math.max(0.05, 1 - crop.left - crop.right)
    const fullH = box.h / Math.max(0.05, 1 - crop.top - crop.bottom)
    c.style.width = `${fullW}px`
    c.style.height = `${fullH}px`
    c.style.left = `${-crop.left * fullW}px`
    c.style.top = `${-crop.top * fullH}px`
  }

  private refresh() {
    const entry = this.renderer.entry(this.page)
    if (entry) {
      if (entry.canvas !== this.canvas) {
        this.canvas?.remove()
        this.canvas = entry.canvas
        this.place(entry.canvas)
        this.el.appendChild(entry.canvas)
      }
      this.clearPlaceholder()
      this.clearRetry()
      return
    }
    this.canvas?.remove()
    this.canvas = null
    const thumb = this.renderer.thumbEntry(this.page)
    if (thumb && !this.placeholder) {
      const c = document.createElement('canvas')
      c.width = thumb.width
      c.height = thumb.height
      c.getContext('2d', { alpha: false })?.drawImage(thumb.canvas, 0, 0)
      c.className = 'pslot-thumb'
      this.placeholder = c
      this.place(c)
      this.el.appendChild(c)
    }
    if (this.renderer.isFailed(this.page)) this.showRetry()
    else this.clearRetry()
    this.el.classList.toggle('loading', !this.renderer.isFailed(this.page))
  }

  private clearPlaceholder() {
    this.el.classList.remove('loading')
    if (!this.placeholder) return
    const p = this.placeholder
    this.placeholder = null
    p.remove()
    p.width = 0
    p.height = 0
  }

  private showRetry() {
    if (this.retryBtn) return
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'pslot-retry'
    b.textContent = `Page ${this.page} did not load. Retry`
    b.addEventListener('pointerdown', (e) => e.stopPropagation())
    b.addEventListener('click', (e) => { e.stopPropagation(); this.renderer.retry(this.page) })
    this.retryBtn = b
    this.el.appendChild(b)
  }

  private clearRetry() {
    this.retryBtn?.remove()
    this.retryBtn = null
  }

  destroy() {
    this.unsubscribe()
    this.canvas?.remove()
    this.canvas = null
    this.clearPlaceholder()
    this.clearRetry()
    this.renderer.unpin(this.page)
    this.el.remove()
  }
}
