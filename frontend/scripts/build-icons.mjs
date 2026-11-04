// Rasterises public/icon.svg into the PNGs the manifest and iOS need: node scripts/build-icons.mjs
// Uses the Playwright Chromium already present for e2e, so no image dependency enters the project.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const publicDir = resolve(import.meta.dirname, '../public')
const svg = await readFile(resolve(publicDir, 'icon.svg'), 'utf8')

const targets = [
  { file: 'icon-192.png', size: 192, scale: 1, radius: 0.22 },
  { file: 'icon-512.png', size: 512, scale: 1, radius: 0.22 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.8, radius: 0 }, // art inside the 80% safe zone
  { file: 'apple-touch-icon.png', size: 180, scale: 1, radius: 0 }, // iOS rounds it; must be opaque
  { file: 'favicon-32.png', size: 32, scale: 1, radius: 0.22 },
]

const browser = await chromium.launch()
for (const { file, size, scale, radius } of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  const inner = size * scale
  await page.setContent(`<!doctype html><style>
    html, body { margin: 0; background: transparent; }
    #bg { width: ${size}px; height: ${size}px; background: #0b0c0e; border-radius: ${size * radius}px; display: grid; place-items: center; overflow: hidden; }
    svg { width: ${inner}px; height: ${inner}px; display: block; }
  </style><div id="bg">${svg}</div>`)
  await page.screenshot({ path: resolve(publicDir, file), omitBackground: radius > 0 })
  await page.close()
}
await browser.close()
