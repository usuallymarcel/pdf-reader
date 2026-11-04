import type { APIRequestContext, Page } from '@playwright/test'

export interface MockOptions {
  mode?: 'global' | 'scoped'
  authStatus?: 'disabled' | 'unavailable' | 'ok'
  library?: 'seed' | 'empty' | 'big'
  maxUploadMb?: number
  allowSignup?: boolean
}

export const resetMock = (request: APIRequestContext, options: MockOptions = {}) =>
  request.post('/__mock/reset', { data: options })

export const setMock = (request: APIRequestContext, patch: Record<string, unknown>) =>
  request.post('/__mock/set', { data: patch })

export async function mockLog(request: APIRequestContext) {
  const res = await request.get('/__mock/log')
  return await res.json() as {
    log: { method: string; path: string; range: string | null }[]
    progress: { id: string; page: number; seconds?: number }[]
  }
}

export async function setTheme(page: Page, theme: string) {
  await page.addInitScript((t) => {
    const stored = JSON.parse(localStorage.getItem('shelf.preferences') ?? '{}') as Record<string, unknown>
    localStorage.setItem('shelf.preferences', JSON.stringify({ ...stored, theme: t }))
  }, theme)
}

export async function signIn(page: Page, name = 'alice', password = 'pw-12345678') {
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

/** Resolves once the service worker controls the page. */
export const swReady = (page: Page) => page.evaluate(async () => {
  await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller) {
    await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }))
  }
})

export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < 900
