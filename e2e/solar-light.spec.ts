import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { build } from 'vite'

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
    for (const time of ['08:30', '12:00', '17:30', '00:00']) {
      // Freeze each separate artistic time and capture the profile plus its reflection.
      // eslint-disable-next-line no-await-in-loop
      await page.goto(`/?seed=9182&time=${time}&weather=${weather}`)
      const canvas = page.locator('canvas[data-water-mode]')
      // eslint-disable-next-line no-await-in-loop
      await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
      // eslint-disable-next-line no-await-in-loop
      await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
      // Both palettes follow the rendered backdrop, including dark daytime clouds.
      if (time === '00:00' || weather === 'overcast' || weather === 'clear') {
        // eslint-disable-next-line no-await-in-loop
        await expect(page.locator('main')).toHaveAttribute(
          'data-scene-tone',
          time === '00:00' || weather === 'overcast' ? 'dark' : 'light',
        )
      }
      // Broken cloud cover can put either a bright opening or a shaded cloud
      // behind the profile; don't prescribe its palette by the clock alone.
      // eslint-disable-next-line no-await-in-loop
      const dark = (await page.locator('main').getAttribute('data-scene-tone')) === 'dark'
      // eslint-disable-next-line no-await-in-loop
      await expect(page.getByRole('heading')).toHaveCSS(
        'color',
        dark ? 'rgb(228, 232, 237)' : 'rgb(23, 35, 45)',
      )
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
  await page.goto('/solar-test?time=12:00')
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
  expect(result.daytimeCursor).toBe(0)
  expect(result.nighttimeLamps.visible).toBeGreaterThan(0)
  expect(result.nighttimeLamps.energy).toBeGreaterThan(0)
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
  await page.goto('/?seed=9182&time=12:00&weather=partly-cloudy')
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

test('daylight has no profile veil or cursor light, including overcast weather', async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?seed=9182&time=08:30&weather=overcast')
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
  await page.mouse.move(width * 0.8, height * 0.1)
  const unlit = await canvas.screenshot()
  await page.mouse.move(width * 0.65, height * 0.88)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(page.locator('.scene-cursor')).not.toHaveAttribute('data-visible', 'true')
  await expect(page.locator('main')).not.toHaveAttribute('data-cursor-active', 'true')
  expect((await canvas.screenshot()).equals(unlit)).toBe(true)
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
    await page.goto(`/solar-test?time=${time}&weather=partly-cloudy&sun=hidden`)
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
