import { expect, test, type Page } from '@playwright/test'
import { mockLog, resetMock, signIn, swReady } from './helpers'
import { FILE_SIZE } from './mock-data.mjs'

test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'service worker suite runs on desktop chromium')

const byteAt = (i: number) => (i * 31 + (i >> 8)) & 255

const rangeFetch = (page: Page, url: string, range?: string) => page.evaluate(async ({ url, range }) => {
  const res = await fetch(url, range ? { headers: { Range: range } } : {})
  const bytes = new Uint8Array(await res.arrayBuffer())
  return {
    status: res.status,
    contentRange: res.headers.get('Content-Range'),
    acceptRanges: res.headers.get('Accept-Ranges'),
    contentLength: res.headers.get('Content-Length'),
    length: bytes.length,
    head: [...bytes.slice(0, 8)],
    tail: [...bytes.slice(-8)],
  }
}, { url, range })

async function download(page: Page, title: string) {
  await page.locator('.card', { has: page.getByRole('link', { name: title }) }).first().locator('a').click({ button: 'right' })
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: 'Download for offline' }).click()
  await expect(sheet.getByRole('button', { name: /Remove download/ })).toBeVisible({ timeout: 20_000 })
  await page.keyboard.press('Escape')
}

test('offline: a downloaded book answers Range from the worker, the app boots and shows it', async ({ page, context, request }) => {
  await resetMock(request)
  await page.goto('/')
  await swReady(page)
  await page.reload()
  await page.locator('.grid .card').first().waitFor()
  await download(page, 'Iron Garden')

  await context.setOffline(true)
  const url = '/api/documents/one2/file'

  const cross = await rangeFetch(page, url, 'bytes=4194000-4195000') // straddles the first chunk boundary
  expect(cross.status).toBe(206)
  expect(cross.contentRange).toBe(`bytes 4194000-4195000/${FILE_SIZE}`)
  expect(cross.acceptRanges).toBe('bytes')
  expect(cross.contentLength).toBe('1001')
  expect(cross.length).toBe(1001)
  expect(cross.head).toEqual(Array.from({ length: 8 }, (_, i) => byteAt(4194000 + i)))
  expect(cross.tail).toEqual(Array.from({ length: 8 }, (_, i) => byteAt(4195000 - 7 + i)))

  const open = await rangeFetch(page, url, `bytes=${FILE_SIZE - 10}-`)
  expect(open.status).toBe(206)
  expect(open.length).toBe(10)
  expect(open.tail.at(-1)).toBe(byteAt(FILE_SIZE - 1))

  const suffix = await rangeFetch(page, url, 'bytes=-100')
  expect(suffix.contentRange).toBe(`bytes ${FILE_SIZE - 100}-${FILE_SIZE - 1}/${FILE_SIZE}`)

  const beyond = await rangeFetch(page, url, `bytes=${FILE_SIZE}-`)
  expect(beyond.status).toBe(416)
  expect(beyond.contentRange).toBe(`bytes */${FILE_SIZE}`)

  const whole = await rangeFetch(page, url)
  expect(whole.status).toBe(200)
  expect(whole.length).toBe(FILE_SIZE)
  expect(whole.contentLength).toBe(String(FILE_SIZE))
  expect(whole.tail.at(-1)).toBe(byteAt(FILE_SIZE - 1))

  // Full boot with no network: cached session, shell from precache, only the downloaded book.
  await page.reload()
  await expect(page.getByText('Showing downloaded books')).toBeVisible()
  await expect(page.locator('.grid .card-title')).toHaveText(['Iron Garden'])
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await context.setOffline(false)
})

test('books that are not downloaded pass straight through to the network', async ({ page, request }) => {
  await resetMock(request)
  await page.goto('/')
  await swReady(page)
  await page.reload()
  await page.locator('.grid .card').first().waitFor()
  await download(page, 'Iron Garden')
  const res = await rangeFetch(page, '/api/documents/one3/file', 'bytes=100-199')
  expect(res.status).toBe(206)
  expect(res.head[0]).toBe(byteAt(100))
  const { log } = await mockLog(request)
  expect(log.filter((l) => l.path === '/api/documents/one3/file').map((l) => l.range)).toEqual(['bytes=100-199'])
  const cached = await page.evaluate(async () => {
    const hits: string[] = []
    for (const name of await caches.keys()) {
      for (const key of await (await caches.open(name)).keys()) if (key.url.includes('one3/file')) hits.push(key.url)
    }
    return hits
  })
  expect(cached).toEqual([])
})

test('a worker that just woke up still reaches the network without buffering', async ({ page, request, context }) => {
  await resetMock(request)
  await page.goto('/')
  await swReady(page)
  await page.reload()
  await page.locator('.grid .card').first().waitFor()
  const cdp = await context.newCDPSession(page)
  await cdp.send('ServiceWorker.enable')
  await cdp.send('ServiceWorker.stopAllWorkers')
  const res = await rangeFetch(page, '/api/documents/one4/file', 'bytes=0-9')
  expect(res.status).toBe(206)
  expect(res.length).toBe(10)
})

test('downloads and api caches never cross users', async ({ page, request }) => {
  await resetMock(request, { mode: 'scoped', authStatus: 'ok' })
  await page.goto('/')
  await swReady(page)
  await signIn(page, 'alice')
  await page.locator('.grid .card').first().waitFor()
  await download(page, 'Private Sketchbook')
  const before = await page.evaluate(() => caches.keys())
  expect(before.some((n) => n === 'shelf-dl-u1')).toBe(true)

  await page.goto('/settings')
  await page.getByRole('button', { name: 'Sign out' }).last().click()
  await expect(page.getByLabel('Password')).toBeVisible()
  await expect.poll(() => page.evaluate(() => caches.keys()).then((k) => k.filter((n) => n.endsWith('-u1')))).toEqual([])

  await signIn(page, 'bob')
  await page.locator('.grid .card').first().waitFor()
  await expect(page.locator('.grid').getByRole('link', { name: 'Private Sketchbook' })).toHaveCount(0)
  const res = await rangeFetch(page, '/api/documents/private1/file', 'bytes=0-9')
  expect(res.status).toBe(404) // the server decides: nothing is answered from a cache
})

test('a different user signing in removes the previous user even after a session expiry', async ({ page, context, request }) => {
  await resetMock(request, { mode: 'scoped', authStatus: 'ok' })
  await page.goto('/')
  await swReady(page)
  await signIn(page, 'alice')
  await page.locator('.grid .card').first().waitFor()
  await download(page, 'Iron Garden')
  await context.clearCookies()
  await page.reload()
  await expect(page.getByLabel('Password')).toBeVisible()
  await signIn(page, 'bob')
  await page.locator('.grid .card').first().waitFor()
  await expect.poll(() => page.evaluate(() => caches.keys()).then((k) => k.filter((n) => n.endsWith('-u1')))).toEqual([])
})

test('reader works offline on a downloaded book; progress queues, coalesces and flushes', async ({ page, context, request }) => {
  await resetMock(request)
  await page.goto('/')
  await swReady(page)
  await page.reload()
  await page.locator('.grid .card').first().waitFor()
  await download(page, 'Real Sample')

  await context.setOffline(true)
  await page.goto('/read/real1')
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20_000 })

  const stored = () => page.evaluate(() => new Promise<{ page: number; seconds: number }[]>((resolve, reject) => {
    const open = indexedDB.open('shelf', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const all = open.result.transaction('progress').objectStore('progress').getAll()
      all.onsuccess = () => { open.result.close(); resolve(all.result as { page: number; seconds: number }[]) }
    }
  }))

  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await stored()).at(0)?.page, { timeout: 6_000 }).toBe(2)
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await stored()).at(0)?.page, { timeout: 6_000 }).toBe(3)
  expect(await stored()).toHaveLength(1)
  expect((await mockLog(request)).progress).toEqual([])

  await context.setOffline(false)
  await expect.poll(async () => (await mockLog(request)).progress.at(-1)?.page, { timeout: 8_000 }).toBe(3)
  await expect.poll(async () => (await stored()).length).toBe(0)
})
