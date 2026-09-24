import { defineConfig, devices } from '@playwright/test'

import { chromiumLaunchOptions } from './e2e/browser-options'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173)

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 20_000 },
  globalTimeout: process.env.CI ? 90_000 : 60_000,
  workers: 1,
  reporter: 'list',
  forbidOnly: Boolean(process.env.CI),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testMatch: ['home.spec.ts', 'rendering.spec.ts', 'functional.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromiumLaunchOptions(),
      },
    },
    {
      name: 'mobile',
      testMatch: ['functional.spec.ts'],
      use: { ...devices['iPhone 13'] },
    },
  ],
  webServer: {
    command: `pnpm preview --host 127.0.0.1 --port ${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: `http://127.0.0.1:${port}`,
  },
})
