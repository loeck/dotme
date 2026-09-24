import { chromium, expect, test } from '@playwright/test'

import { chromiumLaunchOptions } from './browser-options'
import { mockSceneWeather } from './weather-fixture'

test('starts by default when browser autoplay is allowed, with a working stop button', async ({
  browserName,
}, info) => {
  test.skip(
    browserName !== 'chromium',
    'Explicit browser autoplay policy is a Chromium launch option',
  )
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', ...(chromiumLaunchOptions().args ?? [])],
  })
  try {
    const page = await browser.newPage()
    await mockSceneWeather(page, 'clear')
    await page.addInitScript(() => {
      const Original = window.AudioContext
      const contexts: AudioContext[] = []
      Object.assign(window, { testAudioContexts: contexts })
      window.AudioContext = class extends Original {
        constructor(options?: AudioContextOptions) {
          super(options)
          contexts.push(this)
        }
      }
    })
    const requests: string[] = []
    page.on('request', (r) => {
      if (r.url().endsWith('.ogg')) requests.push(r.url())
    })
    await page.goto(`${info.project.use.baseURL}/?seed=42&startTime=12:00`)
    const button = page.locator('.scene-sound-trigger')
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(button).toHaveAttribute('aria-busy', 'false')
    expect(requests).toHaveLength(5)
    expect(
      await page.evaluate(() => {
        const contexts = window.testAudioContexts ?? []
        const context = contexts[0]
        if (!context) throw new Error('Expected an initialized audio context')
        return {
          count: contexts.length,
          state: context.state,
        }
      }),
    ).toEqual({ count: 1, state: 'running' })
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await page.waitForTimeout(600)
    await expect(button).toHaveAttribute('aria-pressed', 'false')
  } finally {
    await browser.close()
  }
})
