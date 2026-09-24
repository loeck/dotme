import { defineConfig, devices } from '@playwright/test'

import { chromiumLaunchOptions } from './e2e/browser-options'
import base from './playwright.config'
const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173)
export default defineConfig({
  ...base,
  globalTimeout: 0,
  timeout: 45_000,
  projects: [
    {
      name: 'gpu',
      testMatch: ['gpu-rendering.spec.ts', 'gpu-water.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromiumLaunchOptions(),
      },
    },
  ],
  webServer: [
    {
      command: `pnpm preview --host 127.0.0.1 --port ${port}`,
      reuseExistingServer: !process.env.CI,
      url: `http://127.0.0.1:${port}`,
    },
    {
      command: 'pnpm dev --host 127.0.0.1 --port 4175',
      reuseExistingServer: !process.env.CI,
      url: 'http://127.0.0.1:4175',
    },
  ],
})
