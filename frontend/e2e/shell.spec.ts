import { expect, test, type Page } from '@playwright/test'
import { isMobile, mockLog, resetMock, setMock, signIn } from './helpers'

async function openMenu(page: Page, title: string) {
  const card = page.locator('.card', { has: page.getByRole('link', { name: title, exact: false }) }).first()
  await card.locator('a').click({ button: 'right' })
}

const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test.describe('global mode', () => {
  test.beforeEach(async ({ request }) => { await resetMock(request) })

  test('boots straight to the library with no account UI', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Continue reading' })).toBeVisible()
    await expect(page.getByLabel('Password')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
    expect(await noHorizontalOverflow(page)).toBe(true)
  })

  test('continue shelf is most recent first, series collapse to a stack', async ({ page }) => {
    await page.goto('/')
    const titles = page.locator('.continue-rail .card-title')
    await expect(titles.first()).toHaveText('Tidewater')
    await expect(page.locator('.card-series')).toHaveCount(2)
    await page.locator('.card-series a').first().click()
    await expect(page).toHaveURL(/\/series\//)
  })

  test('series page: natural order, progress and continue target', async ({ page }) => {
    await page.goto('/series/Tidewater')
    await expect(page.getByRole('heading', { name: 'Tidewater' })).toBeVisible()
    await expect(page.locator('.grid .card-title')).toHaveText(['Tidewater Vol. 1', 'Tidewater Vol. 2', 'Tidewater Vol. 3', 'Tidewater Vol. 4', 'Tidewater Vol. 10'])
    await expect(page.getByText('2 of 5 read')).toBeVisible()
    await expect(page.getByRole('link', { name: /Continue Vol\. 3/ })).toHaveAttribute('href', '/read/tide3')
  })

  test('filters, sort and search', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('radio', { name: 'Favorites' }).click()
    await expect(page.locator('.grid .card-title')).toHaveCount(2)
    await page.getByRole('radio', { name: 'All', exact: true }).click()
    await page.getByRole('textbox', { name: /Search|titles/ }).or(page.getByPlaceholder('Search titles')).first().fill('lantern')
    await expect(page.locator('.grid .card-title')).toHaveText(['The Lantern Keeper of Nine Rivers'])
    const hit = page.locator('.inside-snippet').first()
    await expect(hit.locator('mark')).toHaveText('lantern')
    await expect(hit).toContainText('<north>')
    await expect(hit).toContainText('& said')
  })

  test('details sheet: favorite, edit metadata, delete with undo', async ({ page, request }) => {
    await page.goto('/')
    await openMenu(page, 'Iron Garden')
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('button', { name: 'Add to favorites' }).click()
    await expect(sheet.getByRole('button', { name: 'Remove from favorites' })).toBeVisible()
    await sheet.getByRole('button', { name: 'Edit details' }).click()
    await sheet.getByLabel('Title').fill('Iron Garden Redux')
    await sheet.getByRole('button', { name: 'Save' }).click()
    await expect(sheet.getByRole('button', { name: 'Delete' })).toBeVisible()
    await expect(page.locator('.card-title', { hasText: 'Iron Garden Redux' }).first()).toBeAttached()
    await sheet.getByRole('button', { name: 'Delete' }).click()
    await expect(page.locator('.grid').getByRole('link', { name: 'Iron Garden Redux' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator('.grid').getByRole('link', { name: 'Iron Garden Redux' })).toBeVisible()
    const { log } = await mockLog(request)
    expect(log.some((l) => l.method === 'DELETE')).toBe(false)
  })

  test('multi-select bulk marks finished', async ({ page, request }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Select' }).click()
    await page.locator('.grid').getByRole('link', { name: 'Iron Garden' }).click()
    await page.locator('.grid').getByRole('link', { name: 'Glass Sparrow' }).click()
    await expect(page.getByText('2 selected')).toBeVisible()
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Mark finished' }).click()
    await expect(page.getByText('2 selected')).toHaveCount(0)
    await expect.poll(async () => (await mockLog(request)).log.filter((l) => l.path.endsWith('/state')).length).toBe(2)
  })

  test('two spellings of a series become one, and that can be undone', async ({ page, request }) => {
    await page.goto('/')
    await expect(page.locator('.card-series')).toHaveCount(2)
    await page.locator('.card-series', { hasText: 'Ashen Crown' }).locator('a').click({ button: 'right' })
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('button', { name: 'Merge into another series' }).click()
    await sheet.getByRole('button', { name: /^Tidewater/ }).click()
    await expect(page.locator('.card-series')).toHaveCount(1)
    await expect(page.locator('.card-series .cover-count')).toHaveText('8')
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator('.card-series')).toHaveCount(2)
    expect((await mockLog(request)).log.filter((l) => l.path === '/api/documents/bulk-update')).toHaveLength(2)
  })

  test('renaming from the series page follows the new name', async ({ page }) => {
    await page.goto('/series/Ashen%20Crown')
    await page.getByRole('button', { name: 'Manage series' }).click()
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('button', { name: 'Rename and edit' }).click()
    await sheet.getByLabel('Series name').fill('Ashen Throne')
    await sheet.getByRole('button', { name: 'Save' }).click()
    await expect(page).toHaveURL(/\/series\/Ashen%20Throne$/)
    await expect(page.getByRole('heading', { name: 'Ashen Throne' })).toBeVisible()
    await expect(page.locator('.grid .card')).toHaveCount(3)
  })

  test('renaming onto an existing series says it will merge', async ({ page }) => {
    await page.goto('/series/Ashen%20Crown')
    await page.getByRole('button', { name: 'Manage series' }).click()
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('button', { name: 'Rename and edit' }).click()
    await sheet.getByLabel('Series name').fill('tidewater')
    await expect(sheet.getByText('Tidewater already exists')).toBeVisible()
    await sheet.getByRole('button', { name: 'Merge' }).click()
    await expect(page).toHaveURL(/\/series\/Tidewater$/)
    await expect(page.locator('.grid .card')).toHaveCount(8)
  })

  test('ungrouping leaves the books in the library', async ({ page }) => {
    await page.goto('/series/Ashen%20Crown')
    await page.getByRole('button', { name: 'Manage series' }).click()
    await page.getByRole('dialog').getByRole('button', { name: /^Ungroup/ }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('.card-series')).toHaveCount(1)
    await expect(page.locator('.grid').getByRole('link', { name: 'Ashen Crown Vol. 2' })).toBeVisible()
  })

  test('a single book moves to a series, a new one or none', async ({ page }) => {
    await page.goto('/')
    await openMenu(page, 'Iron Garden')
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('button', { name: 'Move to series' }).click()
    await sheet.getByPlaceholder('Find a series, or name a new one').fill('Tide')
    await expect(sheet.getByRole('button', { name: /^Ashen/ })).toHaveCount(0)
    await sheet.getByPlaceholder('Find a series, or name a new one').fill('Metal Stories')
    await sheet.getByRole('button', { name: /New series/ }).click()
    await expect(sheet.locator('.book-series')).toContainText('Metal Stories')
    await sheet.getByRole('button', { name: 'Move to series' }).click()
    await sheet.getByRole('button', { name: 'Take out of series' }).click()
    await expect(sheet.locator('.book-series')).toHaveCount(0)
  })

  test('several books move together', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Select' }).click()
    await page.locator('.grid').getByRole('link', { name: 'Iron Garden' }).click()
    await page.locator('.grid').getByRole('link', { name: 'Glass Sparrow' }).click()
    await page.getByRole('button', { name: 'Move to series' }).click()
    await page.getByRole('dialog').getByRole('button', { name: /^Tidewater/ }).click()
    await expect(page.getByText('selected')).toHaveCount(0)
    await expect(page.locator('.card-series', { hasText: 'Tidewater' }).locator('.cover-count')).toHaveText('7')
  })

  test('collections: make one, fill it, filter by it, rename, delete', async ({ page }) => {
    await page.goto('/')
    await openMenu(page, 'Iron Garden')
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('button', { name: 'Collections' }).click()
    await sheet.getByPlaceholder('New collection').fill('Comfort reads')
    await sheet.getByRole('button', { name: 'Add' }).click()
    await expect(sheet.getByRole('checkbox', { name: /Comfort reads/ })).toBeChecked()
    await sheet.getByRole('button', { name: 'Close' }).click()

    await page.getByRole('button', { name: 'Select' }).click()
    await page.locator('.grid').getByRole('link', { name: 'Glass Sparrow' }).click()
    await page.getByRole('toolbar').getByRole('button', { name: 'Collections' }).click()
    await page.getByRole('dialog').getByRole('checkbox', { name: /Comfort reads/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await page.getByRole('button', { name: 'Stop selecting' }).click()

    await page.getByRole('radio', { name: 'Comfort reads' }).click()
    await expect(page.locator('.grid .card-title')).toHaveCount(2)
    await page.reload()
    await expect(page.locator('.grid .card-title')).toHaveCount(2)

    await page.locator('.chip-manage').click()
    const manage = page.getByRole('dialog')
    await manage.getByRole('button', { name: 'Rename Comfort reads' }).click()
    await manage.getByLabel('Collection name').fill('Rainy days')
    await manage.getByRole('button', { name: 'Save name' }).click()
    await expect(page.getByRole('radio', { name: 'Rainy days' })).toBeAttached()
    await manage.getByRole('button', { name: 'Delete Rainy days' }).click()
    await manage.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Rainy days' })).toHaveCount(0)
    await expect(page.getByRole('radio', { name: 'All', exact: true })).toBeChecked()
    await expect(page.locator('.grid').getByRole('link', { name: 'Iron Garden' })).toBeAttached()
  })

  test('a book can be in several collections', async ({ page }) => {
    await page.goto('/')
    await openMenu(page, 'Iron Garden')
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('button', { name: 'Collections' }).click()
    for (const name of ['One', 'Two']) {
      await sheet.getByPlaceholder('New collection').fill(name)
      await sheet.getByRole('button', { name: 'Add' }).click()
      await expect(sheet.getByRole('checkbox', { name: new RegExp(name) })).toBeChecked()
    }
    await sheet.getByRole('checkbox', { name: /One/ }).click()
    await expect(sheet.getByRole('checkbox', { name: /One/ })).not.toBeChecked()
    await expect(sheet.getByRole('checkbox', { name: /Two/ })).toBeChecked()
  })

  test('every preset theme and a custom one apply, and survive a reload', async ({ page }) => {
    await page.goto('/settings')
    const background = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())
    const seen = new Set<string>()
    for (const name of ['Dark', 'Black', 'Slate', 'Midnight', 'Forest', 'Plum', 'Ember', 'Light', 'Paper', 'Sepia', 'Sage', 'Sky', 'Blush']) {
      await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name, exact: true }).click()
      seen.add(await background())
    }
    expect(seen.size).toBe(13)
    await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Custom', exact: true }).click()
    await page.getByLabel('Background').first().fill('#203040')
    await page.getByLabel('Text', { exact: true }).first().fill('#f0e0d0')
    expect(await background()).toBe('#203040')
    await page.getByRole('radio', { name: 'Round' }).click()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    expect(await background()).toBe('#203040')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--radius-m').trim())).toBe('18px')
    expect(await noHorizontalOverflow(page)).toBe(true)
  })

  test('failed book retries', async ({ page, request }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(async () => (await mockLog(request)).log.some((l) => l.path.endsWith('/reprocess'))).toBe(true)
  })

  test('empty state tells how to begin', async ({ page, request }) => {
    await resetMock(request, { library: 'empty' })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Your shelf is empty' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add PDFs' }).last()).toBeVisible()
  })

  test('upload queue: duplicate toast, failure with retry, survives navigation', async ({ page }) => {
    await page.goto('/')
    await page.locator('.grid .card').first().waitFor()
    const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.alloc(2000, 37) })
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add PDFs' }).locator('visible=true').first().click()
    await (await chooser).setFiles([pdf('New Book.pdf'), pdf('dup copy.pdf'), pdf('broken.pdf')])
    await page.getByRole('link', { name: 'Stats' }).locator('visible=true').click()
    await expect(page.getByText(/already in your library/)).toBeVisible()
    const tray = page.getByRole('region', { name: 'Uploads' })
    await expect(tray.getByText('Not a PDF')).toBeVisible()
    await expect(tray.getByRole('button', { name: 'Retry broken.pdf' })).toBeVisible()
    await tray.getByRole('button', { name: 'Cancel broken.pdf' }).click()
    await page.getByRole('link', { name: 'Library' }).locator('visible=true').click()
    await expect(page.locator('.grid').getByRole('link', { name: /New Book/ })).toBeVisible()
    await expect(page.locator('.card', { hasText: 'New Book' }).getByText('Processing')).toHaveCount(0, { timeout: 10_000 })
  })

  test('keyboard: slash focuses search, arrows walk the grid', async ({ page }) => {
    test.skip(isMobile(page), 'desktop only')
    await page.goto('/')
    await page.locator('.grid .card').first().waitFor()
    await page.keyboard.press('/')
    await expect(page.getByPlaceholder('Search titles, series, authors')).toBeFocused()
    await page.keyboard.press('Escape')
    const first = page.locator('[data-card-link]').first()
    await first.focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-card-link]').nth(1)).toBeFocused()
  })

  test('drop anywhere shows the target and queues files', async ({ page }) => {
    test.skip(isMobile(page), 'desktop only')
    await page.goto('/')
    await page.locator('.grid .card').first().waitFor()
    const transfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['%PDF-1.7 hello'], 'Dropped.pdf', { type: 'application/pdf' }))
      return dt
    })
    await page.dispatchEvent('main', 'dragenter', { dataTransfer: transfer })
    await expect(page.getByText('Drop to add to your library')).toBeVisible()
    await page.dispatchEvent('main', 'drop', { dataTransfer: transfer })
    await expect(page.getByText('Drop to add to your library')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Uploads' })).toBeVisible()
    await expect(page.locator('.grid').getByRole('link', { name: /Dropped/ })).toBeVisible()
  })

  test('over-limit files are refused before upload', async ({ page, request }) => {
    await resetMock(request, { maxUploadMb: 0 })
    await page.goto('/')
    await page.locator('.grid .card').first().waitFor()
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['%PDF-1.7 hello'], 'Huge.pdf', { type: 'application/pdf' }))
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }))
    })
    await expect(page.getByText(/over the 0 MB limit/)).toBeVisible()
  })

  test('stats and settings render, theme applies without reload', async ({ page }) => {
    await page.goto('/stats')
    await expect(page.getByText('Day streak')).toBeVisible()
    await expect(page.locator('.chart-slot')).toHaveCount(30)
    await page.goto('/settings')
    await page.getByRole('radio', { name: /Sepia/ }).first().click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sepia')
    await expect(page.locator('meta[name=theme-color]')).toHaveAttribute('content', '#f3ead9')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sepia')
    expect(await noHorizontalOverflow(page)).toBe(true)
  })
})

test.describe('scoped mode', () => {
  test.beforeEach(async ({ request }) => { await resetMock(request, { mode: 'scoped', authStatus: 'ok' }) })

  test('logged out sees login; wrong password stays; correct signs in', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Shelf' })).toBeVisible()
    await signIn(page, 'alice', 'wrong')
    await expect(page.getByRole('alert')).toContainText('don’t match')
    await signIn(page)
    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible()
  })

  test('share toggle shows only for private editable books; logout returns to login', async ({ page }) => {
    await page.goto('/')
    await signIn(page)
    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible()
    await openMenu(page, 'Private Sketchbook')
    await expect(page.getByRole('dialog').getByRole('switch', { name: 'Share with everyone' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Sign out' }).last().click()
    await expect(page.getByLabel('Password')).toBeVisible()
  })

  test('a deep link to the reader asks for login first', async ({ page }) => {
    await page.goto('/read/tide3')
    await expect(page.getByLabel('Password')).toBeVisible()
  })
})

test.describe('mode flip without reload', () => {
  test('global to scoped: shows login, then library again when back to global', async ({ page, request }) => {
    await resetMock(request)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible()
    await page.evaluate(() => { (window as unknown as { marker: boolean }).marker = true })
    await setMock(request, { mode: 'scoped', authStatus: 'ok' })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
    await expect(page.getByLabel('Password')).toBeVisible()
    await setMock(request, { mode: 'global', authStatus: 'unavailable' })
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker)).toBe(true)
  })
})

test.describe('reader route', () => {
  test('a mode flip never unmounts an open reader; login waits for the next library visit', async ({ page, request }) => {
    await resetMock(request)
    await page.goto('/')
    await page.locator('.grid .card').first().waitFor()
    await page.goto('/read/real1')
    await expect(page.locator('canvas').first()).toBeVisible()
    await page.evaluate(() => document.querySelector('canvas')?.setAttribute('data-marker', 'same'))
    await setMock(request, { mode: 'scoped', authStatus: 'ok' })
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
    await expect.poll(async () => (await mockLog(request)).log.filter((l) => l.path === '/api/session').length).toBeGreaterThan(1)
    await expect(page.getByLabel('Password')).toHaveCount(0)
    await expect(page.locator('canvas[data-marker=same]')).toHaveCount(1)
    await page.goBack()
    await expect(page.getByLabel('Password')).toBeVisible()
  })

  test('the library bundle stays free of pdf.js', async ({ page, request }) => {
    await resetMock(request)
    const scripts: string[] = []
    page.on('request', (r) => { if (/\.m?js/.test(r.url())) scripts.push(r.url()) })
    await page.goto('/')
    await page.locator('.grid .card').first().waitFor()
    expect(scripts.filter((u) => /pdf/i.test(u))).toEqual([])
  })
})
