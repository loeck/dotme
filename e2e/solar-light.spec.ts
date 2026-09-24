import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { build } from 'vite'

import { mockSceneWeather } from './weather-fixture'

let directory: string
let harness: string

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dotme-solar-'))
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: directory,
      lib: { entry: 'e2e/solar-harness.ts', formats: ['es'], fileName: () => 'harness.js' },
    },
  })
  harness = await readFile(join(directory, 'harness.js'), 'utf8')
})
test.afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('air volume stops at scene depth, receives terrain shadows and converges at 16/32 samples', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/solar-test', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
  )
  await page.route('**/solar-harness.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: harness }),
  )
  await page.goto('/solar-test')
  const result = await page.evaluate(async () => {
    const url = '/solar-harness.js'
    return (await import(url)).exerciseSunVolume()
  })
  await info.attach('volume-measurements', {
    body: JSON.stringify(result),
    contentType: 'application/json',
  })
  expect(errors).toEqual([])
  expect(result.finite).toBe(true)
  expect(result.clearTransmission).toBe(true)
  expect(result.relativeErrors[0]).toBeLessThan(0.06)
  expect(result.relativeErrors[1]).toBeLessThan(0.035)
  expect(result.homogeneousRelativeError).toBeLessThan(0.003)
  expect(result.shadowed).toBeLessThan(result.unoccluded * 0.98)
  expect(result.nearRadiance).toBeGreaterThan(0)
  expect(result.nearRadiance).toBeLessThan(result.unoccluded * 0.3)
  expect(result.nearTransmission).toBeGreaterThan(result.farTransmission)
})

for (const weather of ['clear', 'partly-cloudy', 'cloudy', 'overcast']) {
  test(`deterministic solar cycle, ${weather}`, async ({ page }, info) => {
    test.setTimeout(120_000)
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await mockSceneWeather(page, weather)
    for (const time of ['08:30', '12:00', '17:30', '00:00']) {
      // Freeze each separate artistic time and capture the profile plus its reflection.
      // eslint-disable-next-line no-await-in-loop
      await page.goto(`/?seed=9182&startTime=${time}`)
      const canvas = page.locator('canvas[data-water-mode]')
      // eslint-disable-next-line no-await-in-loop
      await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
      // eslint-disable-next-line no-await-in-loop
      await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
      // Glyph ink is composited per pixel by the GPU. DOM text stays available
      // to selection/accessibility, with transparent paint to avoid duplication.
      // eslint-disable-next-line no-await-in-loop
      await expect(page.locator('main')).toHaveAttribute('data-ui-mask', 'gpu')
      // eslint-disable-next-line no-await-in-loop
      await expect(page.getByRole('heading')).toHaveCSS('color', 'rgba(0, 0, 0, 0)')
      // eslint-disable-next-line no-await-in-loop
      await page.screenshot({ path: info.outputPath(`${weather}-${time.replace(':', '-')}.png`) })
    }
    expect(errors).toEqual([])
  })
}

test('hidden sun keeps identical air scattering; water and horizon radiance stay finite', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/solar-test?*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
  )
  await page.route('**/solar-harness.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: harness }),
  )
  await page.goto('/solar-test?startTime=12:00')
  const result = await page.evaluate(async () => {
    const url = '/solar-harness.js'
    return (await import(url)).exerciseSceneLighting()
  })
  await info.attach('scene-measurements', {
    body: JSON.stringify(result),
    contentType: 'application/json',
  })
  expect(errors).toEqual([])
  expect(result.hiddenError).toBe(0)
  expect(result.visibleIntensity).toBe(4.5)
  expect(result.finite).toBe(true)
  expect(result.daytimeLamps).toEqual({ visible: 0, energy: 0 })
  expect(result.returnedDaytimeLamps).toEqual({ visible: 0, energy: 0 })
  expect(result.nighttimeLamps.visible).toBeGreaterThan(0)
  expect(result.nighttimeLamps.energy).toBeGreaterThan(0)
  expect(result.transparentLamps).toBe(true)
  expect(result.lampTravel[0]).toEqual(result.lampTravel[4])
  expect(result.lampTravel[1]).toEqual(result.lampTravel[3])
  for (let lamp = 0; lamp < result.lampTravel[0].length; lamp++) {
    expect(result.lampTravel[0][lamp]).toBeLessThan(0)
    expect(result.lampTravel[1][lamp]).toBeGreaterThan(result.lampTravel[0][lamp])
    expect(result.lampTravel[2][lamp]).toBeGreaterThan(result.lampTravel[1][lamp])
    expect(result.lampTravel[2][lamp]).toBeGreaterThan(0.4)
  }
  expect(result.twilightOpacity[0]).toBe(0)
  expect(result.twilightOpacity.at(-1)).toBe(1)
  expect(
    result.twilightOpacity.filter((value: number) => value > 0 && value < 1).length,
  ).toBeGreaterThan(1)
  for (const change of result.boundaryChanges) expect(change).toBeLessThan(0.003)
})

test('daylight, clouds and atmosphere survive the RGBA8 fallback and resize', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.getExtension
    WebGL2RenderingContext.prototype.getExtension = function (name: string) {
      return name === 'EXT_color_buffer_float' ? null : original.call(this, name)
    }
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mockSceneWeather(page, 'partly-cloudy')
  await page.goto('/?seed=9182&startTime=12:00')
  const canvas = page.locator('canvas[data-water-mode]')
  await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
  await expect(canvas).toHaveAttribute('data-water-mode', 'analytic')
  await page.screenshot({ path: info.outputPath('daylight-rgba8-before-resize.png') })
  await page.setViewportSize({ width: 600, height: 500 })
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(canvas.locator('..')).toHaveCSS('opacity', '1')
  await page.screenshot({ path: info.outputPath('daylight-rgba8.png') })
  expect(errors).toEqual([])
})

test('daylight keeps the cursor without lighting the scene, including overcast weather', async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mockSceneWeather(page, 'overcast')
  await page.goto('/?seed=9182&startTime=08:30')
  const canvas = page.locator('canvas[data-water-mode]')
  await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
  await expect(page.locator('main')).toHaveAttribute('data-local-lights', 'false')
  await expect(page.getByRole('heading')).toHaveCSS('-webkit-text-stroke-width', '0px')
  await expect(page.getByRole('heading')).toHaveCSS('text-shadow', 'none')
  expect(
    await page
      .locator('.profile-panel')
      .evaluate((element) => getComputedStyle(element, '::before').content),
  ).toBe('none')
  const width = page.viewportSize()!.width
  const height = page.viewportSize()!.height
  // Screenshots include DOM overlays; isolate scene illumination from the point.
  const hideCursor = await page.addStyleTag({
    content: '.scene-cursor { visibility: hidden !important; }',
  })
  await page.mouse.move(width * 0.8, height * 0.1)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  const unlit = await canvas.screenshot()
  await page.mouse.move(width * 0.65, height * 0.88)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  expect((await canvas.screenshot()).equals(unlit)).toBe(true)
  await hideCursor.evaluate((element) => element.remove())
  await page.mouse.move(width * 0.65 + 1, height * 0.88)
  await expect(page.locator('main')).toHaveAttribute('data-ui-mask', 'gpu')
  if (info.project.name === 'chromium')
    await expect(page.locator('main')).toHaveCSS('cursor', 'none')
  else await expect(page.locator('main')).toHaveCSS('cursor', 'auto')
  await page.screenshot({ path: info.outputPath('daylight-no-local-lights.png') })
})

for (const time of ['07:30', '08:30', '12:00']) {
  test(`cloud openings shape god rays at ${time}, including an offscreen sun`, async ({
    page,
  }, info) => {
    await page.route('**/solar-test?*', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
    )
    await page.route('**/solar-harness.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: harness }),
    )
    await page.goto(`/solar-test?startTime=${time}`)
    const result = await page.evaluate(async () => {
      const url = '/solar-harness.js'
      return (await import(url)).captureCloudShafts()
    })
    for (const name of ['scene', 'air'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await info.attach(name, {
        body: Buffer.from(result[name].split(',')[1], 'base64'),
        contentType: 'image/png',
      })
    }
    await info.attach('shaft-measurements', {
      body: JSON.stringify({
        shadowLoss: result.shadowLoss,
        strongestShadow: result.strongestShadow,
      }),
      contentType: 'application/json',
    })
    expect(result.shadowLoss).toBeGreaterThan(0.05)
    expect(result.strongestShadow).toBeGreaterThan(0.3)
  })
}

test('URL timeScale advances solar lighting at the requested multiplier', async ({ page }) => {
  await page.route('**/solar-test?*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
  )
  await page.route('**/solar-harness.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: harness }),
  )
  await page.goto('/solar-test?startTime=08:00&timeScale=20')
  const result = await page.evaluate(async () => {
    const url = '/solar-harness.js'
    return (await import(url)).exerciseTimeScale()
  })
  expect(result.scale).toBe(20)
  expect(result.seconds).toBe(8 * 3600 + 30 * 20)
  expect(result.directionError).toBeLessThan(0.00001)
})

test('distant hills block sunrise and moonrise illumination without extinguishing the sky fill', async ({
  page,
}, info) => {
  await page.route('**/solar-test', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
  )
  await page.route('**/solar-harness.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: harness }),
  )
  await page.goto('/solar-test')
  const samples = await page.evaluate(async () => {
    const url = '/solar-harness.js'
    return (await import(url)).exerciseCelestialHorizon()
  })
  await info.attach('horizon-visibility', {
    body: JSON.stringify(samples),
    contentType: 'application/json',
  })
  for (const index of [0, 4]) expect(samples[index].direct).toBe(0)
  for (const index of [2, 3, 6, 7]) expect(samples[index].direct).toBe(1)
  for (const sample of samples) expect(sample.cloud).toBe(1)
})

for (const time of ['05:45', '18:15']) {
  test(`cursor light stays off during overcast twilight at ${time}`, async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'The light follows a mouse pointer')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await mockSceneWeather(page, 'overcast')
    await page.goto(`/?seed=42&startTime=${time}`)
    const canvas = page.locator('canvas[data-water-mode]')
    await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
    await page.addStyleTag({ content: '.scene-cursor { visibility: hidden !important; }' })
    const captureAt = async (x: number, y: number) => {
      await page.mouse.move(x, y)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      return canvas.screenshot()
    }
    const sky = await captureAt(950, 180)
    const stone = await captureAt(200, 840)
    expect(stone.equals(sky)).toBe(true)
    const water = await captureAt(900, 760)
    expect(water.equals(sky)).toBe(true)
  })
}

test('a soft pointer light reveals stone and water at night, then clears over sky and controls', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'chromium', 'The light follows a mouse pointer')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mockSceneWeather(page, 'overcast')
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/?seed=42&startTime=00:00')
  const canvas = page.locator('canvas[data-water-mode]')
  await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
  await page.addStyleTag({ content: '.scene-cursor { visibility: hidden !important; }' })
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
  await page.mouse.move(950, 180)
  await settle()
  const unlit = await canvas.screenshot()
  // One camera and pointer: compare each surface against the same frozen scene.
  /* eslint-disable no-await-in-loop */
  for (const [name, x, y] of [
    ['near-stone', 200, 840],
    ['stone', 180, 600],
    ['water', 900, 760],
  ] as const) {
    await page.mouse.move(x, y)
    await settle()
    const lit = await canvas.screenshot()
    expect(lit.equals(unlit), name).toBe(false)
    if (name === 'near-stone') {
      const gains = await page.evaluate(
        async ({ before, after, x: sampleX, y: sampleY }) => {
          const sample = async (png: string) => {
            const image = new Image()
            image.src = 'data:image/png;base64,' + png
            await image.decode()
            const patch = document.createElement('canvas')
            patch.width = patch.height = 24
            const ctx = patch.getContext('2d')!
            ctx.drawImage(image, sampleX - 12, sampleY - 12, 24, 24, 0, 0, 24, 24)
            const data = ctx.getImageData(0, 0, 24, 24).data
            let luminance = 0
            for (let i = 0; i < data.length; i += 4)
              luminance += data[i]! * 0.2126 + data[i + 1]! * 0.7152 + data[i + 2]! * 0.0722
            return luminance / (24 * 24)
          }
          return Promise.all([sample(before), sample(after)])
        },
        { before: unlit.toString('base64'), after: lit.toString('base64'), x, y },
      )
      expect(gains[1]! - gains[0]!).toBeGreaterThan(4)
    }
    await info.attach(`pointer-light-${name}`, { body: lit, contentType: 'image/png' })
  }
  /* eslint-enable no-await-in-loop */
  await page.mouse.move(950, 180)
  await settle()
  expect((await canvas.screenshot()).equals(unlit)).toBe(true)
  // A transparent control covers a previously lit bank: it must block picking.
  await page.evaluate(() => {
    const control = document.createElement('button')
    control.style.cssText =
      'position:fixed;left:160px;top:580px;width:40px;height:40px;opacity:0;z-index:9999'
    document.body.append(control)
  })
  await page.mouse.move(180, 600)
  await settle()
  expect((await canvas.screenshot()).equals(unlit)).toBe(true)
  expect(errors).toEqual([])
})
