import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

/**
 * Deliberately small. While opening, pdf.js walks the page tree, and scanner-made PDFs keep a page object
 * between every pair of images, so each step costs one chunk: at 1 MiB a 300-page scan fetched its whole
 * file just to open. Contiguous chunks are merged into one request, so image reads do not suffer.
 */
const RANGE_CHUNK = 64 * 1024
const ASSETS = '/pdfjs/'

/** The pdfjs module is heavy, so load it once, only when a reader opens. */
const pdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
  m.GlobalWorkerOptions.workerSrc = workerUrl
  return m
})

/**
 * One open PDF. Layout never needs this (page_sizes come from the API), so opening is lazy and a 500MB
 * scan costs only the Range chunks actually touched.
 *
 * pdf.js keeps every downloaded chunk in the worker for the life of the document. On a phone reading a big
 * scan cover-to-cover that alone can be fatal, so `recycle()` quietly reopens the document when it has
 * retained too much: rendered canvases are unaffected and the HTTP cache makes the reopen cheap.
 */
export class PdfEngine {
  private task: PDFDocumentLoadingTask | null = null
  private doc: Promise<PDFDocumentProxy> | null = null
  private pages = new Map<number, Promise<PDFPageProxy>>()
  private destroyed = false
  /** Bytes pdf.js holds right now, as reported by its progress callback. */
  retainedBytes = 0
  /** Counts opens, for diagnostics. */
  opens = 0

  constructor(private url: string) {}

  private open(): Promise<PDFDocumentProxy> {
    if (this.doc) return this.doc
    const opening = pdfjs().then(async (m) => {
      if (this.destroyed) throw new Error('destroyed')
      const task = m.getDocument({
        url: this.url,
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: RANGE_CHUNK,
        cMapUrl: `${ASSETS}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${ASSETS}standard_fonts/`,
        wasmUrl: `${ASSETS}wasm/`,
        iccUrl: `${ASSETS}iccs/`,
        enableXfa: false,
        enableHWA: true,
        verbosity: 0,
      })
      task.onProgress = (p: { loaded: number }) => { this.retainedBytes = p.loaded }
      this.task = task
      this.opens++
      return task.promise
    })
    opening.catch(() => {
      if (this.doc === opening) { this.doc = null; this.task = null }
    })
    this.doc = opening
    return opening
  }

  /** Warm up: parse the xref so the first page is quick. */
  preload() { this.open().catch(() => undefined) }

  page(n: number): Promise<PDFPageProxy> {
    const known = this.pages.get(n)
    if (known) return known
    const loading = this.open().then((d) => d.getPage(n))
    loading.catch(() => this.pages.delete(n))
    this.pages.set(n, loading)
    return loading
  }

  /** Free worker-side image and glyph caches. Only valid when nothing is rendering. */
  async trim() {
    const d = await this.doc?.catch(() => null)
    await d?.cleanup(true).catch(() => undefined)
  }

  /** Reopen to release retained Range chunks. Only call when nothing is rendering. */
  async recycle() {
    const old = this.task
    this.task = null
    this.doc = null
    this.pages.clear()
    this.retainedBytes = 0
    await old?.destroy().catch(() => undefined)
  }

  destroy() {
    this.destroyed = true
    const task = this.task
    this.task = null
    this.doc = null
    this.pages.clear()
    task?.destroy().catch(() => undefined)
  }
}
