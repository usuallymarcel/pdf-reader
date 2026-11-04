import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'

// Reader specs. Run: FIXTURES=<dir> npx playwright test -c e2e/reader.config.ts
const fixtures = process.env.FIXTURES ?? `${tmpdir()}/shelf-fixtures`
const PORT = 5199
const MOCK = 8123

export default defineConfig({
  testDir: './reader',
  testMatch: '**/*.e2e.ts', // kept apart from the shell specs, which run on a different mock
  outputDir: process.env.E2E_OUT ?? './.results',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'off' },
  webServer: [
    {
      command: 'node e2e/mock-api.mjs', cwd: '..', port: MOCK, reuseExistingServer: true,
      env: { FIXTURES: fixtures, MOCK_PORT: String(MOCK) },
    },
    {
      command: `npx vite --port ${PORT} --strictPort`, cwd: '..', port: PORT, reuseExistingServer: true,
      env: { API_PROXY: `http://localhost:${MOCK}` },
    },
  ],
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'pixel', use: { ...devices['Pixel 7'] } },
    { name: 'iphone', use: { ...devices['iPhone 14'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } }, grep: /@cross/ },
  ],
})
