/** Small colour maths on #rrggbb strings: everything the themes and colourways derive from. */

const HEX = /^#([0-9a-f]{6})$/i

export const isHex = (value: unknown): value is string => typeof value === 'string' && HEX.test(value)

function channels(hex: string): [number, number, number] {
  const body = HEX.exec(hex)?.[1] ?? '000000'
  return [0, 2, 4].map((i) => parseInt(body.slice(i, i + 2), 16)) as [number, number, number]
}

/** `amount` of `a`, the rest `b`. */
export function mix(a: string, b: string, amount: number): string {
  const [ca, cb] = [channels(a), channels(b)]
  const out = ca.map((c, i) => Math.round(c * amount + (cb[i] ?? 0) * (1 - amount)))
  return `#${out.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Near-black or white, whichever reads better on `background`. */
export const readableOn = (background: string) =>
  contrast(background, '#0b0c0e') >= contrast(background, '#ffffff') ? '#0b0c0e' : '#ffffff'

export const toneOf = (background: string): 'light' | 'dark' => (luminance(background) > 0.3 ? 'light' : 'dark')
