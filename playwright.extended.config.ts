import { defineConfig, devices } from '@playwright/test'

import { chromiumLaunchOptions } from './e2e/browser-options'
import base from './playwright.config'
export default defineConfig({
  ...base,
  globalTimeout: 0,
  projects: [
    {
      name: 'chromium',
      testMatch: ['ambient-*.spec.ts', 'audio-audit.spec.ts', 'weather.spec.ts', 'cursor.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromiumLaunchOptions(),
      },
    },
  ],
})
