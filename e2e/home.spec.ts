import { expect, test } from '@playwright/test'

import { mockParisWeather } from './weather-fixture'

test.beforeEach(async ({ page }) => {
  await mockParisWeather(page)
})

function trackSmokeFrames() {
  const draw = WebGL2RenderingContext.prototype.drawElements
  WebGL2RenderingContext.prototype.drawElements = function (...args: Parameters<typeof draw>) {
    const canvas = this.canvas
    if (canvas instanceof HTMLCanvasElement && canvas.classList.contains('scene-cursor__smoke'))
      canvas.dataset.frames = String(Number(canvas.dataset.frames ?? 0) + 1)
    return draw.apply(this, args)
  }
}

test('renders the profile and interactive scene', async ({ page }) => {
  const consoleErrors: string[] = []
  const weatherRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('open-meteo')) weatherRequests.push(request.url())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || /WebGL/.test(message.text()))
      consoleErrors.push(message.text())
  })

  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await expect(page.getByRole('link', { name: /GitHub/ })).toHaveAttribute(
    'href',
    'https://github.com/loeck',
  )
  const canvas = page.locator('canvas[data-water-mode]')
  await expect(canvas).toBeVisible()
  // Canvas creation precedes shader compilation and the first reflected frame.
  await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
  const bounds = await canvas.boundingBox()
  if (!bounds) throw new Error('Missing landscape bounds')
  await page.mouse.move(bounds.width * 0.4, bounds.height * 0.78)
  await page.mouse.down()
  await page.mouse.move(bounds.width * 0.6, bounds.height * 0.82, { steps: 8 })
  await page.mouse.up()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(page.getByRole('button', { name: 'About this landscape' })).toBeVisible()
  expect(consoleErrors).toEqual([])
  expect(weatherRequests).toHaveLength(1)
})

test('renders and resizes the lit scene with reduced motion', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || /WebGL/.test(message.text())) errors.push(message.text())
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?seed=42')
  const canvas = page.locator('canvas[data-water-mode]')
  await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
  const previousWidth = await canvas.getAttribute('width')
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: viewport.width - 40, height: viewport.height - 40 })
  await expect(canvas).not.toHaveAttribute('width', previousWidth!)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  expect(errors).toEqual([])
})

test('keeps the profile available with JavaScript disabled', async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: testInfo.project.use.viewport,
    isMobile: testInfo.project.use.isMobile,
    hasTouch: testInfo.project.use.hasTouch,
  })
  const page = await context.newPage()
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(8, 10, 13)')
  await expect(page.locator('canvas[data-water-mode]')).toHaveCount(0)
  await context.close()
})

test('cursor lights terrain and water with reduced motion', async ({ page }) => {
  const mobile = page.viewportSize()!.width < 768
  await page.setViewportSize(mobile ? { width: 390, height: 664 } : { width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?seed=9182&time=00:00')
  const canvas = page.locator('canvas[data-water-mode]')
  await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
  const surfaces = mobile
    ? [
        [80, 350],
        [270, 520],
      ]
    : [
        [200, 578],
        [900, 760],
      ]
  // Compare scene illumination, excluding the decorative cursor overlay itself.
  await page.addStyleTag({ content: '.scene-cursor { visibility: hidden !important; }' })
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
  // The same pointer and canvas must be sampled sequentially.
  /* eslint-disable no-await-in-loop */
  for (const [x, y] of surfaces) {
    await page.mouse.move(mobile ? 300 : 950, 180)
    await settle()
    const unlit = await canvas.screenshot()
    await page.mouse.move(x!, y!)
    await settle()
    expect((await canvas.screenshot()).equals(unlit), `No light at ${x},${y}`).toBe(false)
  }
  /* eslint-enable no-await-in-loop */
})

test('cursor smoke starts after lazy loading and pauses when hidden or motion is reduced', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'mobile', 'The custom cursor is mouse-only')
  await page.addInitScript(trackSmokeFrames)
  // A slow module response must still start smoke without requiring another pointer move.
  await page.route('**/assets/cursor-smoke-*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350))
    await route.continue()
  })
  await page.goto('/?seed=9182&time=08:30')
  const scene = page.locator('canvas[data-water-mode]')
  await expect(scene.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
  const cursor = page.locator('.scene-cursor')
  const smoke = cursor.locator('canvas')
  const frames = async () => Number((await smoke.getAttribute('data-frames')) ?? 0)
  await expect(smoke).not.toHaveAttribute('data-frames')
  await page.mouse.move(400, 300)
  await expect(cursor).toHaveAttribute('data-visible', 'true')
  await expect.poll(frames).toBeGreaterThan(2)
  await expect(cursor).toHaveCSS('width', '40px')

  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(cursor).toHaveAttribute('data-visible', 'false')
  const hidden = await frames()
  await page.waitForTimeout(250)
  expect(await frames()).toBe(hidden)
  await expect(cursor.locator('.scene-cursor__halo')).toHaveCSS('animation-play-state', 'paused')

  const previousScene = await scene.elementHandle()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction((old) => !old?.isConnected, previousScene)
  await expect(scene.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
  await page.mouse.move(401, 300)
  await expect(cursor).toHaveAttribute('data-visible', 'true')
  await expect.poll(frames).toBeGreaterThan(hidden)
  const still = await frames()
  await page.waitForTimeout(250)
  expect(await frames()).toBe(still)
  await expect(cursor.locator('.scene-cursor__halo')).toHaveCSS('animation-name', 'none')
})

for (const rain of ['off', 'light', 'moderate', 'heavy']) {
  test(`renders ${rain} rain without shader errors`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' || /WebGL/.test(message.text())) errors.push(message.text())
    })
    await page.goto(`/?seed=42&rain=${rain}&windX=-3&windZ=1`)
    const canvas = page.locator('canvas[data-water-mode]')
    await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
    // Let the intro settle and impacts cover a full lifecycle before sampling.
    await page.waitForTimeout(3500)
    const timings = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const samples: number[] = []
          let previous = performance.now()
          const sample = (now: number) => {
            samples.push(now - previous)
            previous = now
            if (samples.length < 60) requestAnimationFrame(sample)
            else resolve(samples.slice(5).toSorted((a, b) => a - b))
          }
          requestAnimationFrame(sample)
        }),
    )
    testInfo.annotations.push({
      type: 'frame-time',
      description: `${rain}: median ${timings[Math.floor(timings.length / 2)]!.toFixed(1)} ms; p95 ${timings[Math.floor(timings.length * 0.95)]!.toFixed(1)} ms`,
    })
    await testInfo.attach(`rain-${rain}`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    })
    expect(errors).toEqual([])
  })
}
test('serves profile links and SEO directly in HTML', async ({ page, request }) => {
  const response = await request.get('/')
  const html = await response.text()
  expect(response.status()).toBe(200)
  expect(html).toContain('Hi, I’m Loëck.')
  expect(html).not.toMatch(/react|tanstack|nitro/i)
  await page.goto('/')
  await expect(page).toHaveTitle('Loëck | Building some stuff in Paris')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'Loëck builds some stuff in Paris.',
  )
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://loeck.me/')
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    'content',
    'https://loeck.me/',
  )
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    'Loëck | Building some stuff in Paris',
  )
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary')
  await expect(page.getByRole('link', { name: /LinkedIn/ })).toHaveAttribute(
    'href',
    'https://linkedin.com/in/lo%C3%ABck-v%C3%A9zien-19a0a550',
  )
})

test('unknown paths return the static 404 with a home link', async ({ page }) => {
  const response = await page.goto('/missing/nested-page?test=1')
  expect(response?.status()).toBe(404)
  await expect(page).toHaveTitle('404 | Loëck')
  await expect(page.getByRole('heading', { name: 'Nothing here.' })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex')
  await expect(page.locator('script')).toHaveCount(0)
  await page.getByRole('link', { name: 'Return home' }).click()
  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
})

test('without WebGL the profile and pointer remain usable after weather preload', async ({
  page,
}) => {
  const weatherRequests: string[] = []
  const errors: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('open-meteo')) weatherRequests.push(request.url())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (...args: Parameters<typeof original>) {
      if (String(args[0]).includes('webgl')) return null
      return original.apply(this, args)
    } as typeof original
  })
  await page.goto('/')
  // Wait for the lazy engine request to finish, including the rejected WebGL initialization.
  await page.waitForLoadState('networkidle')
  await expect(page.locator('#landscape')).toHaveCSS('opacity', '0')
  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await page.getByRole('link', { name: /GitHub/ }).focus()
  await expect(page.getByRole('link', { name: /GitHub/ })).toBeFocused()
  await page.mouse.move(200, 300)
  // The CSS cursor remains usable even when the scene and smoke cannot initialize.
  if (test.info().project.name === 'chromium') {
    await expect(page.locator('.scene-cursor')).toHaveCSS('opacity', '1')
    await expect(page.locator('main')).toHaveAttribute('data-cursor-active', 'true')
    await expect(page.getByRole('link', { name: /GitHub/ })).toHaveCSS('cursor', 'none')
  } else {
    await expect(page.locator('.scene-cursor')).toHaveCSS('opacity', '0')
    await expect(page.locator('main')).not.toHaveAttribute('data-cursor-active')
    await expect(page.getByRole('link', { name: /GitHub/ })).not.toHaveCSS('cursor', 'none')
  }
  expect(weatherRequests).toHaveLength(1)
  expect(errors).toEqual([])
})

test('page lifecycle disposes and restores the scene once', async ({ page }) => {
  await page.addInitScript(trackSmokeFrames)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?time=00:00')
  const canvas = page.locator('canvas[data-water-mode]')
  await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
  const seed = await canvas.getAttribute('data-seed')
  const smoke = page.locator('.scene-cursor__smoke')
  const frames = async () => Number((await smoke.getAttribute('data-frames')) ?? 0)
  const desktop = test.info().project.name === 'chromium'
  if (desktop) {
    await page.mouse.move(400, 300)
    await expect.poll(frames).toBeGreaterThan(0)
  }
  const previousFrames = await frames()
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
  )
  await expect(canvas).toHaveCount(0)
  await expect(page.locator('main')).not.toHaveAttribute('data-cursor-active')
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  })
  await expect(canvas).toHaveCount(1)
  await expect(canvas).toHaveAttribute('data-seed', seed!)
  await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
  if (desktop) {
    await page.mouse.move(401, 300)
    await expect.poll(frames).toBeGreaterThan(previousFrames)
  }
})

test('leaving during a lazy import does not create a disposed scene', async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/assets/VoxelLandscapeEngine-*.js', async (route) => {
    await pending
    await route.continue()
  })
  const requested = page.waitForRequest('**/assets/VoxelLandscapeEngine-*.js')
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await requested
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
  )
  release()
  await page.waitForLoadState('networkidle')
  const canvas = page.locator('canvas[data-water-mode]')
  await expect(canvas).toHaveCount(0)
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  )
  await expect(canvas).toHaveCount(1)
  await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
})
