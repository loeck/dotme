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
  await page.goto('/details-test?startTime=00:00')
})

test('shore foam remains visible in cloudy daylight and at night without pointer input', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  for (const time of ['14:00', '00:00']) {
    // Identical camera, simulation time and fish: only foam is removed for comparison.
    // eslint-disable-next-line no-await-in-loop
    await page.goto(`/details-test?startTime=${time}&weather=cloudy`)
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(async () => (await import('/details-harness.js')).start(0, true, true))
    // eslint-disable-next-line no-await-in-loop
    const visible = await page.locator('canvas').screenshot({ scale: 'css' })
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(async () => (await import('/details-harness.js')).hideFoam())
    // eslint-disable-next-line no-await-in-loop
    const hidden = await page.locator('canvas').screenshot({ scale: 'css' })
    // eslint-disable-next-line no-await-in-loop
    const pixels = await visibleDifference(page, visible, hidden)
    // eslint-disable-next-line no-await-in-loop
    await info.attach(`foam-${time}`, { body: visible, contentType: 'image/png' })
    // eslint-disable-next-line no-await-in-loop
    await info.attach(`foam-pixels-${time}`, { body: String(pixels), contentType: 'text/plain' })
    expect(pixels, 'The shoreline must remain legible after the final lens pass').toBeGreaterThan(
      100,
    )
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(async () => (await import('/details-harness.js')).stop())
  }
  expect(errors).toEqual([])
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
  const mobile = page.viewportSize()!.width < 768
  expect(initial.fish).toBe(mobile ? 15 : 26)
  expect(initial.fireflies).toBeLessThanOrEqual(mobile ? 18 : 48)
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

test('rain changes underwater visibility while fish remain readable in calm daylight', async ({
  page,
}, info) => {
  await page.goto('/details-test?startTime=12:00&weather=clear')
  await page.evaluate(async () => (await import('/details-harness.js')).start(0, true, true, 0))
  const calm = await page.evaluate(async () => (await import('/details-harness.js')).status())
  const visible = await page.locator('canvas').screenshot({ scale: 'css' })
  await page.evaluate(async () => (await import('/details-harness.js')).fishProbe(false))
  const hidden = await page.locator('canvas').screenshot({ scale: 'css' })
  const pixels = await visibleDifference(page, visible, hidden)
  expect(pixels, 'Fish should be readable without hover in calm daylight').toBeGreaterThan(
    info.project.name === 'mobile' ? 80 : 180,
  )
  await page.evaluate(async () => {
    const scene = await import('/details-harness.js')
    scene.fishProbe(true)
    scene.rain(1)
    scene.resize()
  })
  await expect
    .poll(async () =>
      page.evaluate(async () => (await import('/details-harness.js')).status().clarity),
    )
    .toBeLessThan(calm.clarity)
  const storm = await page.evaluate(async () => (await import('/details-harness.js')).status())
  expect(storm.clarity).toBeLessThan(calm.clarity)
  expect(storm.agitation).toBeGreaterThan(calm.agitation)
  const rainy = await page.locator('canvas').screenshot({ scale: 'css' })
  expect(await visibleDifference(page, visible, rainy)).toBeGreaterThan(500)
  await info.attach('calm-water', { body: visible, contentType: 'image/png' })
  await info.attach('rainy-water', { body: rainy, contentType: 'image/png' })
  await info.attach('daylight-fish-pixels', { body: String(pixels), contentType: 'text/plain' })
  await page.evaluate(async () => (await import('/details-harness.js')).stop())
})

test('details follow solar and rain inputs while preserving explicit overrides', async ({
  page,
}) => {
  await page.goto('/details-test?startTime=08:30')
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

test('fish GPU rig keeps the head stable while the articulated tail changes direction', async ({
  page,
}) => {
  const poses = await page.evaluate(async () =>
    (await import('/details-harness.js')).fishRigProbe(),
  )
  expect(poses[0]).toEqual(poses[1])
  expect(Math.abs(poses[2][0] - poses[3][0])).toBeGreaterThan(12)
  expect(poses.every((pose: number[]) => pose[3] === 255)).toBe(true)
})

test('tail articulation changes the visible lake silhouette even when fish travel is frozen', async ({
  page,
}, info) => {
  await page.goto('/details-test?startTime=12:00&weather=clear')
  await page.evaluate(async () => (await import('/details-harness.js')).start(0, true, true, 0))
  await page.evaluate(async () => (await import('/details-harness.js')).fishArticulationFrame(0))
  const left = await page.locator('canvas').screenshot({ scale: 'css' })
  await page.evaluate(async () =>
    (await import('/details-harness.js')).fishArticulationFrame(Math.PI),
  )
  const right = await page.locator('canvas').screenshot({ scale: 'css' })
  const difference = await visibleDifference(page, left, right)
  await info.attach('articulation-pixels', { body: String(difference), contentType: 'text/plain' })
  await info.attach('tail-left', { body: left, contentType: 'image/png' })
  await info.attach('tail-right', { body: right, contentType: 'image/png' })
  expect(difference).toBeGreaterThan(20)
  await page.evaluate(async () => (await import('/details-harness.js')).stop())
})

test('surface reflection occludes fish completely instead of drawing fish over water', async ({
  page,
}) => {
  await page.goto('/details-test?startTime=12:00&weather=clear')
  await page.evaluate(async () => (await import('/details-harness.js')).start(0, true, true, 0))
  await page.evaluate(async () => (await import('/details-harness.js')).opaqueWater())
  const withFish = await page.locator('canvas').screenshot({ scale: 'css' })
  await page.evaluate(async () => (await import('/details-harness.js')).fishProbe(false))
  const withoutFish = await page.locator('canvas').screenshot({ scale: 'css' })
  expect(
    await visibleDifference(page, withFish, withoutFish),
    'An opaque surface must cover the entire fish, including its specular highlights',
  ).toBe(0)
  await page.evaluate(async () => (await import('/details-harness.js')).stop())
})

test('windward wave impacts render rounded spray and breaking sheets without shader errors', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || /GL_INVALID|Shader Error/.test(message.text()))
      errors.push(message.text())
  })
  await page.goto('/details-test?startTime=12:00&weather=clear')
  await page.evaluate(async () =>
    (await import('/details-harness.js')).start(42, true, true, 0, 8, -2.2),
  )
  const status = await page.evaluate(async () =>
    (await import('/details-harness.js')).splashFrame(12, true),
  )
  expect(status.emitted).toBeGreaterThan(0)
  expect(status.active).toBeGreaterThan(0)
  if (info.project.name === 'mobile')
    await page.evaluate(async () => (await import('/details-harness.js')).inspectAirborneSpray())
  const withSpray = await page.locator('canvas').screenshot({ scale: 'css' })
  await page.evaluate(async () => (await import('/details-harness.js')).hideSplashes())
  const withoutSpray = await page.locator('canvas').screenshot({ scale: 'css' })
  const difference = await visibleDifference(page, withSpray, withoutSpray)
  await info.attach('impact-spray', { body: withSpray, contentType: 'image/png' })
  await info.attach('impact-pixels', { body: String(difference), contentType: 'text/plain' })
  expect(difference).toBeGreaterThan(0)
  expect(errors).toEqual([])
  await page.evaluate(async () => (await import('/details-harness.js')).stop())
})

test('falling splash drops leave visible surface impacts after airborne spray is hidden', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/details-test?startTime=12:00&weather=clear')
  await page.evaluate(async () =>
    (await import('/details-harness.js')).start(42, true, true, 0, 8, -2.2),
  )
  const status = await page.evaluate(async () =>
    (await import('/details-harness.js')).splashFrame(8),
  )
  expect(status.landed).toBeGreaterThan(0)
  expect(status.impacts).toBeGreaterThan(0)
  await page.evaluate(async () => (await import('/details-harness.js')).hideSplashes())
  await page.evaluate(async () => (await import('/details-harness.js')).landingFrame())
  await page.evaluate(async () => (await import('/details-harness.js')).hideLandingCrowns())
  const impacts = await page.locator('canvas').screenshot({ scale: 'css' })
  await page.evaluate(async () => (await import('/details-harness.js')).hideLandingImpacts())
  const hidden = await page.locator('canvas').screenshot({ scale: 'css' })
  const pixels = await visibleDifference(page, impacts, hidden)
  await info.attach('landing-impacts', { body: impacts, contentType: 'image/png' })
  await info.attach('landing-pixels', { body: String(pixels), contentType: 'text/plain' })
  expect(
    pixels,
    'Landing waves must change actual water reflections even without the crown mesh',
  ).toBeGreaterThan(5)
  expect(errors).toEqual([])
  await page.evaluate(async () => (await import('/details-harness.js')).stop())
})
