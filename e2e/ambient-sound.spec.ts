import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

import { required } from '../src/invariant'
import { mockSceneWeather } from './weather-fixture'

async function waitForScene(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  await expect
    .poll(() => page.evaluate(() => window.testAudioContexts?.length ?? 0))
    .toBeGreaterThan(0)
  await expect(page.locator('.scene-sound-trigger')).toHaveAttribute('aria-busy', 'false')
}

function audioState() {
  const context = window.testAudioContexts?.[0]
  if (!context) throw new Error('Expected an audio context')
  return context.state
}

test.beforeEach(async ({ page }, info) => {
  await mockSceneWeather(page, 'clear')
  await page.addInitScript((pendingAutoplay) => {
    const Original = window.AudioContext
    const contexts: AudioContext[] = []
    let activated = false
    window.audioEnabledDuringAutoplay = false
    new MutationObserver((records) => {
      if (activated) return
      for (const record of records) {
        const button = record.target
        if (
          button instanceof Element &&
          button.matches('.scene-sound-trigger') &&
          (record.oldValue === 'true' || button.getAttribute('aria-pressed') === 'true')
        )
          window.audioEnabledDuringAutoplay = true
      }
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-pressed'],
      attributeOldValue: true,
    })
    const observeGesture = (event: Event) => {
      if (
        event.isTrusted &&
        event.target instanceof Element &&
        event.target.closest('.scene-sound-trigger')
      )
        activated = true
    }
    document.addEventListener('click', observeGesture, true)
    document.addEventListener('keydown', observeGesture, true)
    Object.assign(window, { testAudioContexts: contexts })
    window.AudioContext = class extends Original {
      // Model a browser refusing autoplay, while allowing real user gestures.
      override resume() {
        if (!activated)
          return pendingAutoplay
            ? new Promise<void>(() => {})
            : Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'))
        return super.resume()
      }
      override get state() {
        if (pendingAutoplay && !activated) return 'suspended' as const
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
  await waitForScene(page)
  const button = page.locator('.scene-sound-trigger')
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  expect(await page.evaluate(() => window.audioEnabledDuringAutoplay)).toBe(false)
  expect(requests).toHaveLength(0)
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveAttribute('aria-busy', 'false')
  expect(requests).toHaveLength(5)
})

for (const { seed, waterfall } of [
  { seed: 0, waterfall: false },
  { seed: 9182, waterfall: true },
])
  test(`blocked autoplay loads nothing; keyboard activation loads only present scene audio (seed=${seed})`, async ({
    page,
  }) => {
    const requests: string[] = []
    page.on('request', (request) => {
      if (request.url().endsWith('.mp3')) requests.push(request.url())
    })
    await page.goto(`/?seed=${seed}&startTime=12:00`)
    await waitForScene(page)
    const button = page.locator('.scene-sound-trigger')
    expect(requests).toHaveLength(0)
    await button.focus()
    await page.keyboard.press('Enter')
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(button).toHaveAttribute('aria-busy', 'false')
    await expect.poll(() => requests.length).toBe(waterfall ? 6 : 5)
    expect(requests.some((url) => url.endsWith('/audio/waterfall.mp3'))).toBe(waterfall)
    const snapshot = await page.evaluate(() => {
      const c = window.testAudioContexts ?? []
      const context = c[0]
      if (!context) throw new Error('Expected an audio context')
      return { count: c.length, state: context.state }
    })
    expect(snapshot).toEqual({ count: 1, state: 'running' })
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => page.evaluate(audioState)).toBe('suspended')
    expect(await page.evaluate(() => window.testAudioContexts?.length)).toBe(1)
    await page.reload()
    await waitForScene(page)
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(requests).toHaveLength(waterfall ? 6 : 5)
  })

test('cancels a pending load without delayed playback and allows retry', async ({ page }) => {
  const pendingRoutes: Route[] = []
  const failedRequests: string[] = []
  page.on('requestfailed', (request) => {
    if (request.url().endsWith('.mp3')) failedRequests.push(request.url())
  })
  await page.route('**/audio/*.mp3', (route) => {
    pendingRoutes.push(route)
  })
  await page.goto('/?seed=42')
  await waitForScene(page)
  const button = page.locator('.scene-sound-trigger')
  await button.click()
  await expect(button).toHaveAttribute('aria-busy', 'true')
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await expect(button).toHaveAttribute('aria-label', 'Cancel ambient sound loading')
  await expect.poll(() => pendingRoutes.length).toBe(5)
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await Promise.all(pendingRoutes.map((route) => route.continue().catch(() => {})))
  await expect.poll(() => failedRequests.length).toBe(5)
  await expect.poll(() => page.evaluate(audioState)).toBe('suspended')
  await page.unroute('**/audio/*.mp3')
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => (window.testAudioContexts ?? []).length)).toBe(1)
})

test('keeps available layers on secondary errors, but base-water failures are accessible and retryable', async ({
  page,
}) => {
  await page.route('**/audio/wind.mp3', (route) => route.abort())
  await page.route('**/audio/water.mp3', (route) => route.abort())
  await page.goto('/?seed=42')
  await waitForScene(page)
  const button = page.locator('.scene-sound-trigger')
  await button.click()
  await expect(page.locator('[data-sound-status]')).toContainText('Ambient sound is unavailable')
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await page.unroute('**/audio/water.mp3')
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await expect(button).toHaveAttribute('aria-pressed', 'true')
})

test('pauses/resumes, retains activation over motion preference changes and destroys on pagehide', async ({
  page,
}) => {
  await page.goto('/?seed=42')
  await waitForScene(page)
  const button = page.locator('.scene-sound-trigger')
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => page.evaluate(audioState)).toBe('suspended')
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => page.evaluate(audioState)).toBe('running')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('#landscape canvas')).toHaveCount(1)
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => (window.testAudioContexts ?? []).length)).toBe(1)
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
  )
  await expect.poll(() => page.evaluate(audioState)).toBe('closed')
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  )
  await waitForScene(page)
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
  await waitForScene(page)
  await expect(page.locator('main')).toHaveAttribute('data-ui-mask', 'gpu')
  const button = page.locator('.scene-sound-trigger')
  const bounds = required(await button.boundingBox())
  expect(bounds.width).toBeGreaterThanOrEqual(44)
  expect(bounds.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: info.outputPath('sound-off-night.png') })
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await page.screenshot({ path: info.outputPath('sound-on-night.png') })
  const bytes = await page.evaluate(async () => {
    const context = new OfflineAudioContext(1, 1, 32000)
    const buffers = await Promise.all(
      ['water', 'wind', 'rain', 'insects', 'birds', 'waterfall'].map(async (name) => {
        const response = await fetch(`/audio/${name}.mp3`)
        return context.decodeAudioData(await response.arrayBuffer())
      }),
    )
    return buffers.reduce((sum, buffer) => sum + buffer.length * buffer.numberOfChannels * 4, 0)
  })
  expect(bytes).toBeLessThan(24 * 1024 * 1024)
  expect(errors).toEqual([])
})

test('refused background resume turns sound off, and scene failure releases audio', async ({
  page,
}) => {
  await page.goto('/?seed=42')
  await waitForScene(page)
  const button = page.locator('.scene-sound-trigger')
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await page.evaluate(() => {
    const context = window.testAudioContexts?.[0]
    if (!context) throw new Error('Expected an audio context')
    context.resume = () => Promise.reject(new Error('Resume denied'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('[data-sound-status]')).toContainText('Please try again')
  await page.evaluate(() => window.dispatchEvent(new Event('scene-timeout')))
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'failed')
  await expect(button).toBeHidden()
  await expect.poll(() => page.evaluate(audioState)).toBe('closed')
})

test('a late background-suspension failure cannot disable a newer activation', async ({ page }) => {
  await page.goto('/?seed=42')
  await waitForScene(page)
  const button = page.locator('.scene-sound-trigger')
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await page.evaluate(() => {
    const context = window.testAudioContexts?.[0]
    if (!context) throw new Error('Expected an audio context')
    const suspend = context.suspend.bind(context)
    context.suspend = () =>
      new Promise<void>((_resolve, reject) => {
        Object.assign(window, { rejectOldSuspension: () => reject(new Error('Late refusal')) })
        context.suspend = suspend
      })
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => page.evaluate(() => 'rejectOldSuspension' in window)).toBe(true)
  await page.evaluate(() =>
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }),
  )
  await button.click()
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await page.evaluate(async () => {
    const reject = window.rejectOldSuspension
    if (!reject) throw new Error('Expected a pending suspension')
    reject()
    await Promise.resolve()
  })
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-sound-status]')).toBeEmpty()
})
