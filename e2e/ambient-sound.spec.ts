import { expect, test } from '@playwright/test'

import { mockSceneWeather } from './weather-fixture'

test.beforeEach(async ({ page }, info) => {
  await mockSceneWeather(page, 'clear')
  await page.addInitScript((pendingAutoplay) => {
    const Original = window.AudioContext
    const contexts: AudioContext[] = []
    Object.assign(window, { testAudioContexts: contexts })
    window.AudioContext = class extends Original {
      // Model a browser refusing autoplay, while allowing real user gestures.
      resume() {
        if (!navigator.userActivation.isActive && !navigator.userActivation.hasBeenActive)
          return pendingAutoplay
            ? new Promise<void>(() => {})
            : Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'))
        return super.resume()
      }
      get state() {
        if (pendingAutoplay && !navigator.userActivation.hasBeenActive) return 'suspended' as const
        return super.state
      }
      constructor(options?: AudioContextOptions) {
        super(options)
        contexts.push(this)
      }
    }
  }, info.title.includes('pending autoplay'))
})

test('pending autoplay returns to off without downloading or starting later', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (r) => {
    if (r.url().endsWith('.mp3')) requests.push(r.url())
  })
  await page.goto('/?seed=42')
  const button = page.locator('.scene-sound-trigger')
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  expect(requests).toHaveLength(0)
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveAttribute('aria-busy', 'false')
  expect(requests).toHaveLength(5)
})

test('blocked autoplay loads nothing; a keyboard gesture decodes all MP3s and toggles playback', async ({
  page,
}) => {
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('.mp3')) requests.push(request.url())
  })
  await page.goto('/?seed=42&startTime=12:00')
  const button = page.locator('.scene-sound-trigger')
  await expect(page.locator('#landscape canvas')).toBeVisible()
  expect(requests).toHaveLength(0)
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveAttribute('aria-busy', 'false')
  expect(requests).toHaveLength(5)
  const context = await page.evaluate(() => {
    const c = (window as unknown as { testAudioContexts: AudioContext[] }).testAudioContexts
    return { count: c.length, state: c[0]!.state }
  })
  expect(context).toEqual({ count: 1, state: 'running' })
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { testAudioContexts: AudioContext[] }).testAudioContexts[0]!.state,
      ),
    )
    .toBe('suspended')
  await page.reload()
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  expect(requests).toHaveLength(5)
})

test('cancels a pending load without delayed playback and allows retry', async ({ page }) => {
  await page.route('**/audio/*.mp3', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600))
    await route.continue().catch(() => {})
  })
  await page.goto('/?seed=42')
  const button = page.locator('.scene-sound-trigger')
  await button.click()
  await expect(button).toHaveAttribute('aria-busy', 'true')
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await page.waitForTimeout(800)
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await button.click()
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  expect(
    await page.evaluate(
      () => (window as unknown as { testAudioContexts: AudioContext[] }).testAudioContexts.length,
    ),
  ).toBe(1)
})

test('keeps available layers on secondary errors, but base-water failures are accessible and retryable', async ({
  page,
}) => {
  await page.route('**/audio/wind.mp3', (route) => route.abort())
  await page.route('**/audio/water.mp3', (route) => route.abort())
  await page.goto('/?seed=42')
  const button = page.locator('.scene-sound-trigger')
  await button.click()
  await expect(page.locator('[data-sound-status]')).toContainText('Ambient sound is unavailable')
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await page.unroute('**/audio/water.mp3')
  await button.click()
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await expect(button).toHaveAttribute('aria-pressed', 'true')
})

test('pauses/resumes, retains activation over motion preference changes and destroys on pagehide', async ({
  page,
}) => {
  await page.goto('/?seed=42')
  const button = page.locator('.scene-sound-trigger')
  await button.click()
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { testAudioContexts: AudioContext[] }).testAudioContexts[0]!.state,
      ),
    )
    .toBe('suspended')
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { testAudioContexts: AudioContext[] }).testAudioContexts[0]!.state,
      ),
    )
    .toBe('running')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('#landscape canvas')).toHaveCount(1)
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  expect(
    await page.evaluate(
      () => (window as unknown as { testAudioContexts: AudioContext[] }).testAudioContexts.length,
    ),
  ).toBe(1)
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
  )
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { testAudioContexts: AudioContext[] }).testAudioContexts[0]!.state,
      ),
    )
    .toBe('closed')
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  )
  await expect(button).toHaveAttribute('aria-pressed', 'false')
})

test('decodes within the total buffer budget and draws both icons with GPU contrast', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/?seed=42&startTime=00:00')
  await expect(page.locator('main')).toHaveAttribute('data-ui-mask', 'gpu')
  const button = page.locator('.scene-sound-trigger')
  const bounds = await button.boundingBox()
  expect(bounds!.width).toBeGreaterThanOrEqual(44)
  expect(bounds!.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: info.outputPath('sound-off-night.png') })
  await button.click()
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await page.screenshot({ path: info.outputPath('sound-on-night.png') })
  const bytes = await page.evaluate(async () => {
    const context = new OfflineAudioContext(1, 1, 48000)
    const buffers = await Promise.all(
      ['water', 'wind', 'rain', 'insects', 'birds'].map(async (name) => {
        const response = await fetch(`/audio/${name}.mp3`)
        return context.decodeAudioData(await response.arrayBuffer())
      }),
    )
    return buffers.reduce((sum, buffer) => sum + buffer.length * buffer.numberOfChannels * 4, 0)
  })
  expect(bytes).toBeLessThan(24 * 1024 * 1024)
  expect(errors).toEqual([])
})

test('refused background resume turns sound off, and renderer failure disables it', async ({
  page,
}) => {
  await page.goto('/?seed=42')
  const button = page.locator('.scene-sound-trigger')
  await button.click()
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await page.evaluate(() => {
    const context = (window as unknown as { testAudioContexts: AudioContext[] })
      .testAudioContexts[0]!
    context.resume = () => Promise.reject(new Error('Resume denied'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('[data-sound-status]')).toContainText('Please try again')
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#landscape canvas')!
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
  })
  await expect(button).toBeDisabled()
})
