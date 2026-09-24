import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { build } from 'vite'

import type { FrameSample } from '../src/scene/render-diagnostics'

let code: string

test.beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dotme-lifecycle-'))
  try {
    await build({
      configFile: false,
      logLevel: 'error',
      build: {
        outDir: directory,
        lib: { entry: 'e2e/performance-harness.ts', formats: ['es'], fileName: () => 'harness.js' },
      },
    })
    code = await readFile(join(directory, 'harness.js'), 'utf8')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.beforeEach(async ({ page }) => {
  await page.route('**/lifetime-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="scene" style="width:100vw;height:100vh"></div>',
    }),
  )
  await page.route('**/lifetime.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: code }),
  )
  await page.goto('/lifetime-test')
})

test('diagnostics and repeated disposal release scene resources', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const result = await page.evaluate(async () => {
    const url = '/lifetime.js',
      module = await import(url)
    module.start(12, true)
    const full = module.capture()
    const reused = module.capture(18, false)
    let maxDifference = 0
    for (let i = 0; i < full.pixels.length; i++)
      maxDifference = Math.max(maxDifference, Math.abs(full.pixels[i] - reused.pixels[i]))
    module.stop()
    return {
      diagnostics: full.diagnostics,
      reused: reused.diagnostics,
      maxDifference,
      lifetime: module.lifecycle(),
    }
  })
  expect(errors).toEqual([])
  expect(result.maxDifference).toBeLessThanOrEqual(2)
  const reused = result.reused.frames.at(-1)
  expect(reused.passes.environment).toBeUndefined()
  expect(reused.passes.shadows.triangles).toBeGreaterThan(0)
  const frame = result.diagnostics.frames.at(-1)
  expect(frame.passes.shadows.triangles).toBeGreaterThan(0)
  expect(frame.passes.reflection.triangles).toBeGreaterThan(0)
  expect(frame.passes['depth-focus'].calls).toBe(1)
  for (const sample of result.lifetime) {
    expect(sample.canvases).toBe(0)
    // PMREM retains a small renderer-owned cache until renderer disposal.
    expect(sample.after.geometries).toBeLessThan(5)
    expect(sample.after.textures).toBeLessThan(5)
    expect(sample.before).toEqual(result.lifetime[0].before)
    expect(sample.after).toEqual(result.lifetime[0].after)
  }
})

test('inactive windows throttle, hidden pages sleep and focus resumes without catch-up', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const pacing = await page.evaluate(async () => {
    // Drive lifecycle events deterministically on both headless browser backends.
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => document.documentElement.dataset.testHidden === 'true',
    })
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => document.documentElement.dataset.testFocused !== 'false',
    })
    const url = '/lifetime.js',
      module = await import(url)
    module.start(12, true)
    const rates = module.pacing()
    module.animate()
    return rates
  })
  expect(pacing.delayed).toEqual([1000, 1110, 1194, 1278])
  for (const sample of pacing.rates) {
    if (sample.focused) expect(sample.fps).toBeCloseTo(60, 0)
    else {
      expect(sample.fps).toBeGreaterThanOrEqual(10)
      expect(sample.fps).toBeLessThanOrEqual(12.1)
    }
  }
  await page.waitForTimeout(2500)
  const sample = () =>
    page.evaluate(async () => {
      const url = '/lifetime.js',
        module = await import(url)
      return { ...module.activity(), frames: module.readDiagnostics().frames }
    })
  let before = await sample()
  await page.waitForTimeout(1200)
  const active = await sample()
  const activeFrames = active.frames.slice(before.frames.length)
  expect(activeFrames.length).toBeGreaterThan(5)
  expect(activeFrames.length).toBeLessThanOrEqual(76)
  expect(activeFrames.filter((f: FrameSample) => f.passes.environment).length).toBeLessThan(
    activeFrames.length,
  )
  expect(activeFrames.every((f: FrameSample) => f.passes.shadows!.triangles > 0)).toBe(true)

  await page.evaluate(() => {
    document.documentElement.dataset.testFocused = 'false'
    window.dispatchEvent(new Event('blur'))
  })
  await page.waitForTimeout(200)
  before = await sample()
  await page.waitForTimeout(1200)
  const inactive = await sample()
  const inactiveFrames = inactive.frames.slice(before.frames.length)
  expect(inactive.focused).toBe(false)
  expect(inactiveFrames.length).toBeGreaterThan(0)
  expect(inactiveFrames.length).toBeLessThanOrEqual(16)
  expect(inactiveFrames.every((f: FrameSample) => f.intervalMs >= 75)).toBe(true)
  expect(
    inactiveFrames.filter((f: FrameSample) => f.passes.environment).length,
  ).toBeLessThanOrEqual(4)

  await page.evaluate(async () => {
    document.documentElement.dataset.testHidden = 'true'
    document.dispatchEvent(new Event('visibilitychange'))
    const url = '/lifetime.js',
      module = await import(url)
    module.invalidate()
  })
  before = await sample()
  await page.waitForTimeout(400)
  const hidden = await sample()
  expect(hidden.frames.length).toBe(before.frames.length)
  expect(hidden.elapsed).toBe(before.elapsed)
  expect(hidden.frame).toBe(0)
  expect(hidden.timer).toBe(0)

  await page.evaluate(() => {
    document.documentElement.dataset.testHidden = 'false'
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(250)
  const resumed = await sample()
  expect(resumed.focused).toBe(false)
  expect(resumed.frames.length).toBeGreaterThan(hidden.frames.length)
  expect(resumed.frames[hidden.frames.length].passes.environment).toBeDefined()
  expect(resumed.elapsed - hidden.elapsed).toBeLessThan(0.4)

  await page.evaluate(async () => {
    const url = '/lifetime.js',
      module = await import(url)
    document.documentElement.dataset.testFocused = 'true'
    window.dispatchEvent(new Event('focus'))
    module.setReducedMotion(true)
  })
  await page.waitForTimeout(200)
  before = await sample()
  await page.waitForTimeout(200)
  const still = await sample()
  expect(still.frames.length).toBe(before.frames.length)
  expect(still.frame).toBe(0)
  expect(still.timer).toBe(0)
  const pending = await page.evaluate(async () => {
    const url = '/lifetime.js',
      module = await import(url)
    module.setReducedMotion(false)
    document.documentElement.dataset.testFocused = 'false'
    window.dispatchEvent(new Event('blur'))
    const scheduled = module.activity()
    module.stop()
    document.documentElement.dataset.testFocused = 'true'
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    return scheduled
  })
  expect(pending.timer).toBeGreaterThan(0)
  await page.waitForTimeout(150)
  expect(await page.locator('canvas').count()).toBe(0)
  expect(errors).toEqual([])
})
