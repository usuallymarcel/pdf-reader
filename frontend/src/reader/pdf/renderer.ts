import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { capRenderWidth, NO_CROP, type Crop } from '../layout/fit'
import type { PageSize } from '../layout/spreads'
import { detectCrop } from './crop'
import type { DeviceLimits } from './device'
import type { PdfEngine } from './engine'
import { PageCache, type Cached } from './pageCache'
import { RenderQueue, type RenderJob } from './renderQueue'

export interface RenderedPage extends Cached {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

export interface PlanItem { page: number; width: number }

const THUMB_WIDTH = 180
const THUMB_MAX_SIDE = 360
const MAX_ATTEMPTS = 3
const TRIM_EVERY = 12

function freeCanvas(canvas: HTMLCanvasElement) {
  canvas.width = 0
  canvas.height = 0
}

function wrap(canvas: HTMLCanvasElement): RenderedPage {
  const { width, height } = canvas
  return { canvas, width, height, pixels: width * height, free: () => freeCanvas(canvas) }
}

const isCancel = (e: unknown) => e instanceof Error && e.name === 'RenderingCancelledException'

/**
 * Turns pages into canvases. Views describe what they want with `plan()` (priority order) and subscribe
 * to the pages they show; the cache hands out the very same canvas element, so a flip to a cached page
 * is a DOM append in the same frame.
 */
export class PageRenderer {
  readonly cache: PageCache<RenderedPage>
  readonly thumbs: PageCache<RenderedPage>
  private queue: RenderQueue
  private listeners = new Map<number, Set<() => void>>()
  private attempts = new Map<number, number>()
  private failed = new Set<number>()
  private crops = new Map<number, Crop>()
  private cropWaits = new Map<number, Promise<Crop>>()
  private lastPlan: PlanItem[] = []
  private retryTimer: number | undefined
  private sinceTrim = 0
  private recycling = false
  private destroyed = false
  /** Pages rendered at full size so far, for tests. */
  rendered = 0

  constructor(
    private engine: PdfEngine,
    private sizes: readonly PageSize[],
    readonly limits: DeviceLimits,
  ) {
    this.cache = new PageCache<RenderedPage>(limits.pixels)
    this.thumbs = new PageCache<RenderedPage>(limits.thumbPixels)
    this.queue = new RenderQueue(limits.concurrency)
    this.queue.onIdle = () => this.onIdle()
  }

  private aspect(page: number) {
    const s = this.sizes[page - 1]
    return s ? s[0] / s[1] : 0.7
  }

  /** Width the page will actually render at, after the canvas caps. */
  capWidth(page: number, width: number) {
    const stepped = Math.ceil(width / 8) * 8
    return capRenderWidth(stepped, this.aspect(page), this.limits.maxCanvasPixels)
  }

  entry(page: number) { return this.cache.peek(page) }
  thumbEntry(page: number) { return this.thumbs.peek(page) }
  isFailed(page: number) { return this.failed.has(page) }
  cropOf(page: number) { return this.crops.get(page) }
  pin(page: number) { this.cache.pin(page) }
  unpin(page: number) { this.cache.unpin(page) }

  subscribe(page: number, fn: () => void): () => void {
    let set = this.listeners.get(page)
    if (!set) this.listeners.set(page, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
      if (!set.size) this.listeners.delete(page)
    }
  }

  private notify(page: number) {
    for (const fn of this.listeners.get(page) ?? []) fn()
  }

  /** Declare what should be rendered, most urgent first. Replaces the previous plan. */
  plan(items: PlanItem[]) {
    if (this.destroyed) return
    this.lastPlan = items
    const jobs: RenderJob[] = []
    let pixels = 0
    const wanted: PlanItem[] = []
    for (const item of items) {
      const width = this.capWidth(item.page, item.width)
      pixels += (width * width) / this.aspect(item.page)
      // Never plan more than the budget can hold, or pages would evict each other forever.
      if (wanted.length && pixels > this.cache.budget * 0.9) break
      wanted.push({ page: item.page, width })
    }
    for (let i = wanted.length - 1; i >= 0; i--) this.cache.touch((wanted[i] as PlanItem).page)
    for (const { page, width } of wanted) {
      if (this.failed.has(page)) continue
      const have = this.cache.peek(page)
      if (have && have.width >= width * 0.92) continue
      jobs.push(this.mainJob(page, width))
    }
    this.queue.replace(jobs)
  }

  private mainJob(page: number, width: number): RenderJob {
    return { key: `m:${page}:${width}`, run: (signal) => this.renderMain(page, width, signal) }
  }

  private async draw(proxy: PDFPageProxy, width: number, signal: AbortSignal): Promise<HTMLCanvasElement | null> {
    const base = proxy.getViewport({ scale: 1 })
    const viewport = proxy.getViewport({ scale: width / base.width })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const task = proxy.render({ canvas, viewport })
    const abort = () => task.cancel()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await task.promise
      return canvas
    } catch (e) {
      freeCanvas(canvas)
      if (isCancel(e)) return null
      throw e
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  private async renderMain(page: number, width: number, signal: AbortSignal) {
    try {
      const proxy = await this.engine.page(page)
      if (signal.aborted || this.destroyed) return
      const canvas = await this.draw(proxy, width, signal)
      proxy.cleanup()
      if (!canvas) return
      if (this.destroyed) { freeCanvas(canvas); return }
      this.attempts.delete(page)
      this.sinceTrim++
      this.rendered++
      this.storeThumb(page, canvas)
      const old = this.cache.put(page, wrap(canvas))
      this.notify(page)
      old?.free()
    } catch (e) {
      if (signal.aborted || this.destroyed) return
      console.warn(`Page ${page} failed to render`, e)
      const n = (this.attempts.get(page) ?? 0) + 1
      this.attempts.set(page, n)
      if (n >= MAX_ATTEMPTS) {
        this.failed.add(page)
        this.notify(page)
      } else {
        window.clearTimeout(this.retryTimer)
        this.retryTimer = window.setTimeout(() => this.plan(this.lastPlan), 400 * n)
      }
    }
  }

  /** User asked to try a failed page again. */
  retry(page: number) {
    this.failed.delete(page)
    this.attempts.delete(page)
    this.notify(page)
    this.plan(this.lastPlan)
  }

  private thumbSize(page: number) {
    const a = this.aspect(page)
    return a >= THUMB_WIDTH / THUMB_MAX_SIDE ? THUMB_WIDTH : Math.floor(THUMB_MAX_SIDE * a)
  }

  private storeThumb(page: number, source: HTMLCanvasElement) {
    if (this.thumbs.has(page)) return
    const w = this.thumbSize(page)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = Math.max(1, Math.round((w * source.height) / source.width))
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.imageSmoothingQuality = 'medium'
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
    this.thumbs.put(page, wrap(canvas))
  }

  /**
   * Low-res page image. Cached thumbnails resolve at once; missing ones queue on the side lane.
   * Aborting the signal withdraws the request, which is how a fast scrub stays cheap.
   */
  thumb(page: number, urgent: boolean, signal?: AbortSignal): Promise<RenderedPage | null> {
    const have = this.thumbs.touch(page)
    if (have) return Promise.resolve(have)
    return new Promise((resolve) => {
      const key = `t:${page}`
      const run = async (sig: AbortSignal) => {
        try {
          const proxy = await this.engine.page(page)
          if (sig.aborted) { resolve(null); return }
          const canvas = await this.draw(proxy, this.thumbSize(page), sig)
          proxy.cleanup()
          if (canvas) {
            this.sinceTrim++
            this.thumbs.put(page, wrap(canvas))
          }
          resolve(canvas ? (this.thumbs.peek(page) ?? null) : null)
        } catch {
          resolve(null)
        }
      }
      signal?.addEventListener('abort', () => { this.queue.cancel(key); resolve(null) }, { once: true })
      this.queue.pushSide({ key, run }, urgent)
    })
  }

  /** Margin detection from a thumbnail; cached per page. */
  crop(page: number): Promise<Crop> {
    const known = this.crops.get(page)
    if (known) return Promise.resolve(known)
    const waiting = this.cropWaits.get(page)
    if (waiting) return waiting
    const work = this.thumb(page, false).then((t) => {
      const ctx = t?.canvas.getContext('2d', { willReadFrequently: true })
      let crop = NO_CROP
      if (t && ctx) {
        crop = detectCrop(ctx.getImageData(0, 0, t.width, t.height).data, t.width, t.height)
      }
      this.crops.set(page, crop)
      this.cropWaits.delete(page)
      return crop
    })
    this.cropWaits.set(page, work)
    return work
  }

  private onIdle() {
    if (this.destroyed || this.recycling) return
    if (this.engine.retainedBytes > this.limits.recycleBytes) {
      this.recycling = true
      this.engine.recycle().finally(() => { this.recycling = false })
    } else if (this.sinceTrim >= TRIM_EVERY) {
      this.sinceTrim = 0
      void this.engine.trim()
    }
  }

  stats() {
    return {
      used: this.cache.used,
      peak: this.cache.peak,
      budget: this.cache.budget,
      entries: this.cache.size,
      thumbs: this.thumbs.size,
      thumbUsed: this.thumbs.used,
      rendered: this.rendered,
      running: this.queue.runningCount,
      pending: this.queue.pendingCount,
    }
  }

  destroy() {
    this.destroyed = true
    window.clearTimeout(this.retryTimer)
    this.queue.destroy()
    this.cache.clear()
    this.thumbs.clear()
    this.listeners.clear()
  }
}
