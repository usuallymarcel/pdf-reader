import { expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface Open { id?: string; profile?: Record<string, unknown>; overrides?: Record<string, unknown>; start?: number }

const MOCK = 'http://localhost:8123'
export const shotDir = process.env.SHOTS ?? join(process.cwd(), '.shots')

export async function openBook(page: Page, { id = 'manga', profile = {}, overrides, start }: Open = {}) {
  await fetch(`${MOCK}/__reset`)
  const state: Record<string, unknown> = {}
  if (start) { state.page = start; state.client_ts = 1 }
  if (overrides) state.overrides = overrides
  if (Object.keys(state).length) {
    await fetch(`${MOCK}/__set`, { method: 'POST', body: JSON.stringify({ id, state }) })
  }
  await page.addInitScript((p) => {
    const kinds = { manga: p, novel: p }
    localStorage.setItem('shelf.preferences', JSON.stringify({ profiles: kinds }))
    for (const l of ['sides', 'kindle', 'edges']) localStorage.setItem(`shelf.tapHint.${l}`, '1')
  }, profile)
  await page.goto(`/e2e/harness/index.html?id=${id}`)
  await expect(page.locator('.reader')).toBeVisible()
}

export const stats = async () => (await fetch(`${MOCK}/__stats`)).json()

export const currentPage = (page: Page) =>
  page.evaluate(() => window.__shelf?.stage()?.position().page ?? -1)

export const waitPage = (page: Page, n: number) =>
  expect.poll(() => currentPage(page), { timeout: 5000 }).toBe(n)

/** Pages actually painted: the page numbers of slots showing a full canvas in the viewport. */
export const shownPages = (page: Page) => page.evaluate(() => {
  const out: number[] = []
  document.querySelectorAll<HTMLElement>('.pslot').forEach((s) => {
    const r = s.getBoundingClientRect()
    const onScreen = r.left < innerWidth - 1 && r.right > 1 && r.top < innerHeight && r.bottom > 0
    if (onScreen && s.querySelector('canvas:not(.pslot-thumb)')) out.push(Number(s.dataset.page))
  })
  return out.sort((a, b) => a - b)
})

export const waitShown = (page: Page, pages: number[]) =>
  expect.poll(() => shownPages(page), { timeout: 15000 }).toEqual(pages)

export const rendererStats = (page: Page) => page.evaluate(() => window.__shelf?.renderer?.stats())

export async function shot(page: Page, name: string, project: string) {
  mkdirSync(shotDir, { recursive: true })
  await page.screenshot({ path: join(shotDir, `${project}-${name}.png`) })
}

const stage = (page: Page) => page.locator('.reader-stage')

/** Tap or click at a fraction of the stage. */
export async function tapAt(page: Page, fx: number, fy: number, project: string) {
  const box = (await stage(page).boundingBox())!
  const x = box.x + box.width * fx
  const y = box.y + box.height * fy
  if (project === 'desktop' || project === 'firefox') await page.mouse.click(x, y)
  else await page.touchscreen.tap(x, y)
}

/** Dispatch synthetic pointer events, for browsers without a real multi-touch driver. */
export async function pointerGesture(page: Page, tracks: { x: number; y: number }[][], stepMs = 16) {
  await page.evaluate(async ({ tracks, stepMs }) => {
    const el = document.querySelector('.reader-stage') as HTMLElement
    const fire = (type: string, id: number, p: { x: number; y: number }) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, pointerId: id + 10, pointerType: 'touch', clientX: p.x, clientY: p.y,
      button: 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: id === 0,
    }))
    const steps = tracks[0]!.length
    tracks.forEach((t, id) => fire('pointerdown', id, t[0]!))
    for (let i = 1; i < steps; i++) {
      tracks.forEach((t, id) => fire('pointermove', id, t[i]!))
      await new Promise((r) => setTimeout(r, stepMs))
    }
    tracks.forEach((t, id) => fire('pointerup', id, t[steps - 1]!))
  }, { tracks, stepMs })
}

export const line = (from: [number, number], to: [number, number], steps = 12) =>
  Array.from({ length: steps + 1 }, (_, i) => ({
    x: from[0] + ((to[0] - from[0]) * i) / steps,
    y: from[1] + ((to[1] - from[1]) * i) / steps,
  }))

/** Real multi-touch on Chromium via CDP. Each frame lists the touch points. */
export async function cdpTouch(page: Page, frames: { x: number; y: number }[][], stepMs = 16) {
  const cdp = await page.context().newCDPSession(page)
  const send = (type: string, touchPoints: { x: number; y: number; id: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', { type: type as 'touchStart', touchPoints })
  const pts = (f: { x: number; y: number }[]) => f.map((p, id) => ({ ...p, id }))
  await send('touchStart', pts(frames[0]!))
  for (const f of frames.slice(1)) {
    await send('touchMove', pts(f))
    await new Promise((r) => setTimeout(r, stepMs))
  }
  await send('touchEnd', [])
  await cdp.detach()
}

export const zoomOf = (page: Page) => page.evaluate(() => {
  const leaves = [...document.querySelectorAll<HTMLElement>('.leaf')]
  const current = leaves.find((l) => {
    const r = l.getBoundingClientRect()
    return Math.abs(r.left) < 2
  })
  const t = current?.querySelector<HTMLElement>('.leaf-zoom')?.style.transform ?? ''
  return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? 1)
})
