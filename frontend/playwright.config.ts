import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 4173)

export default defineConfig({
  testDir: './e2e',
  // One mock server holds the state, so tests take turns.
  workers: 1,
  fullyParallel: false,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  outputDir: process.env.E2E_OUTPUT ?? 'test-results',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    command: 'node e2e/mock-server.mjs',
    env: { PORT: String(PORT) },
    port: PORT,
    reuseExistingServer: true,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'pixel7', use: { ...devices['Pixel 7'] } },
    { name: 'iphone14', use: { ...devices['iPhone 14'] } },
    { name: 'narrow', use: { ...devices['Pixel 7'], viewport: { width: 320, height: 640 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } }, testMatch: /shell\.spec/ },
  ],
})
