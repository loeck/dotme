import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { build } from 'vite'

let directory: string
let harness: string

async function visibleDifference(page: Page, first: Buffer, second: Buffer) {
  return page.evaluate(
    async ([a, b]) => {
      // This helper runs inside the browser, where Image and canvas are available.
      // eslint-disable-next-line unicorn/consistent-function-scoping
      const read = async (base64: string) => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0)
        return context.getImageData(0, 0, canvas.width, canvas.height).data
      }
      const [left, right] = await Promise.all([read(a!), read(b!)])
      let pixels = 0
      for (let i = 0; i < left.length; i += 4) {
        if (
          Math.max(
            Math.abs(left[i]! - right[i]!),
            Math.abs(left[i + 1]! - right[i + 1]!),
            Math.abs(left[i + 2]! - right[i + 2]!),
          ) >= 12
        )
          pixels++
      }
      return pixels
    },
    [first.toString('base64'), second.toString('base64')],
  )
}

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dotme-details-'))
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: directory,
      lib: { entry: 'e2e/scene-details-harness.ts', formats: ['es'], fileName: () => 'harness.js' },
    },
  })
  harness = await readFile(join(directory, 'harness.js'), 'utf8')
})

test.afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test.beforeEach(async ({ page }) => {
  await page.route('**/details-test*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="scene" style="width:100vw;height:100vh"></div></body></html>',
    }),
  )
  await page.route('**/details-harness.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: harness }),
  )
  await page.goto('/details-test?time=00:00')
})

test('details render with shared shadows, respond to rain, resize and dispose', async ({
  page,
}, info) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || /GL_INVALID|Shader Error/.test(message.text()))
      errors.push(message.text())
  })
  await page.evaluate(async () => (await import('/details-harness.js')).start(42))
  await page.waitForTimeout(2600)
  const initial = await page.evaluate(async () => (await import('/details-harness.js')).status())
  expect(initial.fish).toBeGreaterThan(0)
  expect(initial.fireflies).toBeGreaterThan(0)
  expect(initial.mist).toBeGreaterThan(0)
  const mobile = page.viewportSize()!.width < 768
  expect(initial.fish).toBeLessThanOrEqual(mobile ? 6 : 12)
  expect(initial.fireflies).toBeLessThanOrEqual(mobile ? 18 : 48)
  expect(initial.mist).toBeLessThanOrEqual(mobile ? 8 : 18)
  expect(initial.wetness).toBe(0)
  await page.screenshot({ path: info.outputPath('night-details.png') })
  await page.evaluate(async () =>
    (await import('/details-harness.js')).environment({ rainIntensity: 1 }),
  )
  const viewport = page.viewportSize()!
  await page.mouse.move(viewport.width * 0.62, viewport.height * 0.84)
  await page.mouse.down()
  await page.mouse.move(viewport.width * 0.42, viewport.height * 0.8, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(2000)
  const rainy = await page.evaluate(async () => {
    const scene = await import('/details-harness.js')
    scene.environment({ rainIntensity: 0, daylight: 1 })
    return scene.status()
  })
  expect(rainy.wetness).toBeGreaterThan(initial.wetness)
  await page.setViewportSize({ width: viewport.width - 24, height: viewport.height - 24 })
  await page.evaluate(async () => (await import('/details-harness.js')).resize())
  await page.waitForTimeout(500)
  const drying = await page.evaluate(async () => (await import('/details-harness.js')).status())
  expect(drying.wetness).toBeGreaterThan(0)
  expect(drying.wetness).toBeLessThan(rainy.wetness)
  await page.screenshot({ path: info.outputPath('wet-banks.png') })
  await info.attach('detail-status', {
    body: JSON.stringify({ initial, rainy, drying }),
    contentType: 'application/json',
  })
  await page.evaluate(async () => (await import('/details-harness.js')).stop())
  await expect(page.locator('canvas')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('reduced motion stays still and optional layer can be disabled', async ({ page }, info) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || /GL_INVALID|Shader Error/.test(message.text()))
      errors.push(message.text())
  })
  await page.evaluate(async () => (await import('/details-harness.js')).start(42, false, true))
  const baseline = await page.locator('canvas').screenshot()
  await info.attach('without-details', { body: baseline, contentType: 'image/png' })
  await page.evaluate(async () => (await import('/details-harness.js')).start(42, true, true))
  const enhanced = await page.locator('canvas').screenshot()
  expect(enhanced.equals(baseline)).toBe(false)
  await info.attach('with-details', { body: enhanced, contentType: 'image/png' })
  await page.waitForTimeout(300)
  expect((await page.locator('canvas').screenshot()).equals(enhanced)).toBe(true)
  const restingFish = await page.locator('canvas').screenshot({ scale: 'css' })
  await page.evaluate(async () => (await import('/details-harness.js')).fishProbe(false))
  await page.waitForTimeout(100)
  const noRestingFish = await page.locator('canvas').screenshot({ scale: 'css' })
  expect(
    await visibleDifference(page, restingFish, noRestingFish),
    'Foreground fish must be visible before hover',
  ).toBeGreaterThan(25)
  const probe = await page.evaluate(async () => (await import('/details-harness.js')).fishProbe())
  await page.mouse.move(probe.x, probe.y)
  await page.waitForTimeout(100)
  const fishVisible = await page.locator('canvas').screenshot({ scale: 'css' })
  await page.evaluate(async () => (await import('/details-harness.js')).fishProbe(false))
  await page.waitForTimeout(100)
  const fishHidden = await page.locator('canvas').screenshot({ scale: 'css' })
  const fishPixels = await visibleDifference(page, fishVisible, fishHidden)
  expect(
    fishPixels,
    'Fish need a readable silhouette, not a few nearly identical pixels',
  ).toBeGreaterThan(60)
  await info.attach('fish-visible-pixels', { body: String(fishPixels), contentType: 'text/plain' })
  await page
    .locator('canvas')
    .screenshot({ path: info.outputPath('fish-hidden.png'), scale: 'css' })
  await info.attach('fish-hover', { body: fishVisible, contentType: 'image/png' })
  await page.evaluate(async () => (await import('/details-harness.js')).fishProbe(true))
  await page.waitForTimeout(100)
  await page
    .locator('canvas')
    .screenshot({ path: info.outputPath('fish-visible.png'), scale: 'css' })
  const before = await page.evaluate(async () => (await import('/details-harness.js')).status())
  await page.evaluate(async () =>
    (await import('/details-harness.js')).environment({ rainIntensity: 1, daylight: 1 }),
  )
  await page.waitForTimeout(300)
  const after = await page.evaluate(async () => (await import('/details-harness.js')).status())
  expect(after.time).toBe(before.time)
  expect(before.wetness).toBe(0)
  expect(after.wetness).toBe(1)
  expect((await page.locator('canvas').screenshot()).equals(enhanced)).toBe(false)
  await page.evaluate(async () => (await import('/details-harness.js')).stop())
  expect(errors).toEqual([])
})

test('details follow solar and rain inputs while preserving explicit overrides', async ({
  page,
}) => {
  await page.goto('/details-test?time=08:30')
  await page.evaluate(async () => (await import('/details-harness.js')).start(42, true, true, 0.8))
  const environment = () =>
    page.evaluate(async () => (await import('/details-harness.js')).status().environment)
  await expect.poll(environment).toEqual({ rainIntensity: 0.8, daylight: 1 })
  await page.evaluate(async () => (await import('/details-harness.js')).rain(0))
  await expect.poll(environment).toEqual({ rainIntensity: 0, daylight: 1 })
  await page.evaluate(async () => {
    const scene = await import('/details-harness.js')
    scene.environment({ daylight: 0.25 })
    scene.rain(0.6)
  })
  await expect.poll(environment).toEqual({ rainIntensity: 0.6, daylight: 0.25 })
  await page.evaluate(async () => (await import('/details-harness.js')).stop())
})
