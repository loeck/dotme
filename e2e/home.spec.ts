import { expect, test } from '@playwright/test'

test('renders the profile and interactive scene', async ({ page }) => {
  const consoleErrors: string[] = []
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
  await expect(page.getByRole('button')).toHaveCount(0)
  expect(consoleErrors).toEqual([])
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

test('keeps the profile available with JavaScript disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
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
  await page.addInitScript(() => {
    const draw = WebGL2RenderingContext.prototype.drawElements
    WebGL2RenderingContext.prototype.drawElements = function (...args: Parameters<typeof draw>) {
      const canvas = this.canvas
      if (canvas instanceof HTMLCanvasElement && canvas.classList.contains('scene-cursor__smoke'))
        canvas.dataset.frames = String(Number(canvas.dataset.frames ?? 0) + 1)
      return draw.apply(this, args)
    }
  })
  // A slow module response must still start smoke without requiring another pointer move.
  await page.route('**/assets/cursor-smoke-*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350))
    await route.continue()
  })
  await page.goto('/?seed=9182&time=00:00')
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
