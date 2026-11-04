export interface RenderJob {
  key: string
  run(signal: AbortSignal): Promise<void>
}

interface Running { job: RenderJob; ac: AbortController }

/**
 * Priority queue with bounded concurrency. The main lane is replaced wholesale whenever the reader's
 * position changes: anything not wanted any more is dropped, and running work no longer wanted is aborted.
 * The side lane (thumbnails) only runs when the main lane is empty, unless pushed as urgent.
 */
export class RenderQueue {
  private main: RenderJob[] = []
  private side: RenderJob[] = []
  private running = new Map<string, Running>()
  private destroyed = false
  /** Called whenever the queue drains. */
  onIdle: (() => void) | null = null

  constructor(public concurrency: number) {}

  get runningCount() { return this.running.size }
  get pendingCount() { return this.main.length + this.side.length }
  isRunning(key: string) { return this.running.has(key) }

  /** Replace the main lane with `jobs`, in priority order. */
  replace(jobs: RenderJob[]) {
    const keep = new Set(jobs.map((j) => j.key))
    for (const [key, r] of this.running) {
      if (!keep.has(key) && !this.side.some((s) => s.key === key) && !key.startsWith('t:')) r.ac.abort()
    }
    this.main = jobs.filter((j) => !this.running.has(j.key))
    this.pump()
  }

  /** Add a side-lane job. Urgent jobs go first and may run before the main lane. */
  pushSide(job: RenderJob, urgent: boolean) {
    if (this.running.has(job.key)) return
    this.side = this.side.filter((j) => j.key !== job.key)
    if (urgent) this.side.unshift(job)
    else this.side.push(job)
    this.urgent = urgent || this.urgent
    this.pump()
  }

  private urgent = false

  /** Withdraw a queued or running side job. */
  cancel(key: string) {
    this.side = this.side.filter((j) => j.key !== key)
    this.main = this.main.filter((j) => j.key !== key)
    this.running.get(key)?.ac.abort()
    this.pump()
  }

  private next(): RenderJob | undefined {
    if (this.urgent && this.side.length) return this.side.shift()
    this.urgent = false
    return this.main.shift() ?? this.side.shift()
  }

  private pump() {
    if (this.destroyed) return
    while (this.running.size < this.concurrency) {
      const job = this.next()
      if (!job) break
      const ac = new AbortController()
      this.running.set(job.key, { job, ac })
      job.run(ac.signal).catch(() => undefined).finally(() => {
        const r = this.running.get(job.key)
        if (r?.ac === ac) this.running.delete(job.key)
        this.pump()
        if (!this.running.size && !this.pendingCount) this.onIdle?.()
      })
    }
  }

  destroy() {
    this.destroyed = true
    this.main = []
    this.side = []
    for (const r of this.running.values()) r.ac.abort()
    this.running.clear()
  }
}
