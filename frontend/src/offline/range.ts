export interface ByteRange { start: number; end: number } // inclusive

/**
 * Parses a single-range `Range` header against a resource of `size` bytes.
 * null: no usable header, serve the whole file. 'unsatisfiable': answer 416.
 */
export function parseRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, first = '', last = ''] = match
  if (first === '' && last === '') return null
  if (first === '') {
    const suffix = Number(last)
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (start >= size) return 'unsatisfiable'
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  return end < start ? 'unsatisfiable' : { start, end }
}

/** Which chunks hold the bytes of `range`, with the slice wanted from each. */
export function chunkSlices(range: ByteRange, chunkSize: number): { index: number; from: number; to: number }[] {
  const out: { index: number; from: number; to: number }[] = []
  for (let index = Math.floor(range.start / chunkSize); index * chunkSize <= range.end; index++) {
    const base = index * chunkSize
    out.push({ index, from: Math.max(range.start - base, 0), to: Math.min(range.end + 1 - base, chunkSize) })
  }
  return out
}
