export interface Cached {
  pixels: number
  free(): void
}

/** LRU keyed by page, bounded by total pixels. Pinned (on-screen) entries are never evicted. */
export class PageCache<E extends Cached> {
  private map = new Map<number, E>()
  private pins = new Map<number, number>()
  used = 0
  /** High-water mark, for tests and diagnostics. */
  peak = 0

  constructor(public budget: number) {}

  get size() { return this.map.size }
  has(page: number) { return this.map.has(page) }
  peek(page: number) { return this.map.get(page) }

  /** Mark as most recently used. */
  touch(page: number): E | undefined {
    const e = this.map.get(page)
    if (e) { this.map.delete(page); this.map.set(page, e) }
    return e
  }

  /** Insert or replace. Returns the replaced entry so the caller can free it once nothing shows it. */
  put(page: number, entry: E): E | undefined {
    const old = this.map.get(page)
    if (old) { this.used -= old.pixels; this.map.delete(page) }
    this.map.set(page, entry)
    this.used += entry.pixels
    this.evict()
    this.peak = Math.max(this.peak, this.used)
    return old
  }

  pin(page: number) { this.pins.set(page, (this.pins.get(page) ?? 0) + 1) }

  unpin(page: number) {
    const n = (this.pins.get(page) ?? 0) - 1
    if (n > 0) this.pins.set(page, n)
    else this.pins.delete(page)
    this.evict()
  }

  isPinned(page: number) { return this.pins.has(page) }

  drop(page: number) {
    const e = this.map.get(page)
    if (!e) return
    this.map.delete(page)
    this.used -= e.pixels
    e.free()
  }

  private evict() {
    if (this.used <= this.budget) return
    for (const [page, e] of this.map) {
      if (this.used <= this.budget) break
      if (this.pins.has(page)) continue
      this.map.delete(page)
      this.used -= e.pixels
      e.free()
    }
  }

  clear() {
    for (const e of this.map.values()) e.free()
    this.map.clear()
    this.pins.clear()
    this.used = 0
  }
}
