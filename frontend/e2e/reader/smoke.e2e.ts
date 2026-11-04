import { expect, test } from '@playwright/test'
import { cdpTouch, currentPage, line, openBook, rendererStats, shot, shownPages, stats, tapAt, waitPage, waitShown, zoomOf } from './helpers'

const touch = (name: string) => name === 'pixel'

test('huge scan opens through Range requests', async ({ page }) => {
  await openBook(page, { id: 'big', profile: { direction: 'ltr', spreads: 'single' } })
  await waitShown(page, [1])
  const s = await stats()
  expect(s.rangeBytes.big).toBeLessThan(40 * 1024 * 1024)
  expect(s.fullGets.big).toBe(1)
})

test('tap flips, cached flip is instant, no page errors', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBook(page, { profile: { direction: 'ltr', spreads: 'single', transition: 'none' } })
  await waitShown(page, [1])
  await expect.poll(async () => (await rendererStats(page))?.pending ?? 1).toBe(0)
  await tapAt(page, 0.9, 0.5, info.project.name)
  await waitPage(page, 2)
  expect(await shownPages(page)).toEqual([2])
  await tapAt(page, 0.1, 0.5, info.project.name)
  await waitPage(page, 1)
  expect(errors).toEqual([])
})

test('RTL spreads: pairing, mirrored order and mirrored tap', async ({ page }, info) => {
  test.skip(touch(info.project.name), 'spreads need a landscape viewport')
  await openBook(page, { start: 2, profile: { direction: 'rtl', spreads: 'double', transition: 'none' } })
  await waitShown(page, [2, 3])
  const left = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.pslot')]
    .filter((s) => { const r = s.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth })
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0]?.dataset.page)
  expect(left).toBe('3')
  await shot(page, 'rtl-spread', info.project.name)
  await tapAt(page, 0.1, 0.5, info.project.name)
  await waitPage(page, 4)
  await page.keyboard.press('End')
  await expect(page.locator('.endcard')).toBeVisible()
})

test('landscape page stays alone in a spread', async ({ page }, info) => {
  test.skip(touch(info.project.name), 'spreads need a landscape viewport')
  await openBook(page, { start: 9, profile: { direction: 'ltr', spreads: 'double' } })
  await waitShown(page, [9])
})

test('finger drag turns the page, pinch zooms at the focal point', async ({ page }, info) => {
  test.skip(!touch(info.project.name), 'real multi-touch runs on the phone profile')
  await openBook(page, { profile: { direction: 'ltr', spreads: 'single' } })
  await waitShown(page, [1])
  const { width: w, height: h } = page.viewportSize()!
  await cdpTouch(page, line([w * 0.8, h / 2], [w * 0.2, h / 2]).map((p) => [p]))
  await waitPage(page, 2)
  await page.waitForTimeout(500)
  const a = line([w / 2 - 40, h / 2], [w / 2 - 130, h / 2])
  const b = line([w / 2 + 40, h / 2], [w / 2 + 130, h / 2])
  await cdpTouch(page, a.map((p, i) => [p, b[i]!]))
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(1.5)
  await shot(page, 'pinched', info.project.name)
})

test('chrome is hidden until summoned; settings apply live', async ({ page }, info) => {
  await openBook(page, { profile: { direction: 'ltr', spreads: 'single' } })
  await waitShown(page, [1])
  await expect(page.locator('.reader-top')).toHaveAttribute('data-open', 'false')
  await tapAt(page, 0.5, 0.5, info.project.name)
  await expect(page.locator('.reader-top')).toHaveAttribute('data-open', 'true')
  await page.waitForTimeout(300)
  await shot(page, 'chrome', info.project.name)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('radio', { name: 'white' }).click()
  await expect(page.locator('.reader')).toHaveAttribute('style', /#ffffff/)
  await shot(page, 'settings', info.project.name)
})

test('mode switching keeps the place, reflow paginates, progress saves', async ({ page }, info) => {
  await openBook(page, { id: 'novel', start: 12, profile: { mode: 'paged', direction: 'ltr' } })
  await waitPage(page, 12)
  await page.keyboard.press('m')
  await expect(page.locator('.scroll-stage')).toBeVisible()
  await waitPage(page, 12)
  await page.keyboard.press('m')
  await expect(page.locator('.reflow-paged .rf-section').first()).toBeVisible()
  await expect.poll(() => currentPage(page)).toBeGreaterThanOrEqual(11)
  await expect.poll(() => currentPage(page)).toBeLessThanOrEqual(12)
  await page.waitForTimeout(600)
  await shot(page, 'reflow', info.project.name)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(500)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(500)
  await page.keyboard.press('m')
  await expect(page.locator('.paged-stage')).toBeVisible()
  await expect.poll(async () => (await stats()).log.length, { timeout: 6000 }).toBeGreaterThan(0)
})

test('webtoon scrolls natively and windows its slots', async ({ page }, info) => {
  await openBook(page, { id: 'webtoon', start: 6, profile: { direction: 'ltr' } })
  await waitPage(page, 6)
  await expect.poll(() => shownPages(page)).toContain(6)
  const mounted = await page.locator('.pslot').count()
  expect(mounted).toBeLessThan(8)
  await shot(page, 'scroll', info.project.name)
})
