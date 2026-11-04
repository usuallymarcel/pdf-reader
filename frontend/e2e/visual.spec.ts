// Screenshots of every screen in every theme, for looking at. Run with SHOTS_DIR=<dir>; skipped otherwise.
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { resetMock, setMock, setTheme, signIn } from './helpers'

const dir = process.env.SHOTS_DIR
test.skip(!dir, 'set SHOTS_DIR to take screenshots')

const themes = (process.env.SHOTS_THEMES ?? 'dark,oled,light,sepia').split(',')

async function settled(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => undefined)
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].filter((i) => !i.complete && i.loading !== 'lazy').map((i) => i.decode().catch(() => undefined)))
  })
  await page.waitForTimeout(350)
}

for (const theme of themes) {
  test(`screens in ${theme}`, async ({ page, request }, info) => {
    const shot = async (name: string, fullPage = false) => {
      await settled(page)
      await page.screenshot({ path: resolve(dir as string, `${info.project.name}-${theme}-${name}.png`), fullPage })
    }
    await setTheme(page, theme)
    await resetMock(request, { authStatus: 'unavailable' })

    await page.goto('/')
    await page.locator('.grid .card').first().waitFor()
    await shot('library')
    await page.locator('.card', { hasText: 'Paper Moon Courier' }).first().locator('a').click({ button: 'right' })
    await expect(page.getByRole('dialog')).toBeVisible()
    await shot('sheet')
    await page.getByRole('dialog').getByRole('button', { name: 'Edit details' }).click()
    await shot('edit')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Select' }).click()
    await page.locator('.grid').getByRole('link', { name: 'Iron Garden' }).click()
    await shot('select')
    await page.getByRole('button', { name: 'Stop selecting' }).click()

    await page.getByPlaceholder('Search titles, series, authors').fill('lantern')
    await page.locator('.inside-snippet').first().waitFor()
    await shot('search')
    await page.getByRole('button', { name: 'Clear search' }).click()

    await page.goto('/series/Tidewater')
    await page.locator('.grid .card').first().waitFor()
    await shot('series')
    await page.goto('/stats')
    await page.locator('.chart').waitFor()
    await shot('stats')
    await page.goto('/settings')
    await page.getByRole('heading', { name: 'Reading defaults' }).waitFor()
    await shot('settings', true)

    await resetMock(request, { library: 'empty' })
    await page.goto('/')
    await page.getByRole('heading', { name: 'Your shelf is empty' }).waitFor()
    await shot('empty')

    await resetMock(request, { mode: 'scoped', authStatus: 'ok' })
    await page.goto('/')
    await page.getByLabel('Password').waitFor()
    await shot('login')
    await signIn(page)
    await page.getByRole('heading', { name: 'Library' }).waitFor()
    await setMock(request, { delayMs: 0 })
  })
}
