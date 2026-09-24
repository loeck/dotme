import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { build } from 'vite'

test.use({ video: 'on' })

let directory: string
let harness: string

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dotme-water-'))
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: directory,
      lib: { entry: 'e2e/water-harness.ts', formats: ['es'], fileName: () => 'harness.js' },
    },
  })
  harness = await readFile(join(directory, 'harness.js'), 'utf8')
})
test.afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test.beforeEach(async ({ page }) => {
  await page.route('**/water-test?time=00:00', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="scene" style="width:100vw;height:100vh"></div></body></html>',
    }),
  )
  await page.route('**/water-harness.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: harness }),
  )
  await page.goto('/water-test?time=00:00')
})

test('GPU propagation, damping, shore barriers, stability, reset and frame independence', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const result = await page.evaluate(async () => {
    const url = '/water-harness.js'
    const { exerciseSimulation } = await import(/* @vite-ignore */ url)
    return exerciseSimulation()
  })
  expect(result.initial.peak).toBeGreaterThan(0.001)
  expect(result.initial.volumeImbalance).toBeLessThan(0.02)
  expect(result.spread.propagated).toBeGreaterThan(0.0001)
  expect(result.spread.beyond).toBe(0)
  expect(result.settled.beyond).toBe(0)
  expect(result.settled.energy).toBeLessThan(result.initial.energy * 0.06)
  expect(result.settled.peak).toBeLessThan(0.22)
  expect(result.reset.energy).toBe(0)
  expect(result.edgeEnergy[0]).toBeLessThan(result.edgeEnergy[1] * 0.1)
  expect(result.sampled[0]).toBeCloseTo(result.sampled[1], 7)
  expect(result.sampled[1]).toBeCloseTo(result.sampled[2], 7)
  expect(result.windContact.energy).toBeGreaterThan(0.001)
  expect(result.windContact.peak).toBeLessThan(0.15)
  expect(result.openWind.energy).toBe(0)
  expect(result.windSampled[0]).toBeCloseTo(result.windSampled[1], 5)
  expect(result.windSampled[1]).toBeCloseTo(result.windSampled[2], 5)
  for (const scenario of result.windScenarios) {
    expect(scenario.energy).toBeGreaterThan(0.001)
    expect(scenario.peak).toBeLessThan(0.15)
  }
  expect(result.windScenarios[1].energy).toBeGreaterThan(result.windScenarios[0].energy)
})

test('visible water receives gestures, stationary pointers and UI do not; resize and cancellation recover', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.evaluate(async () => {
    const url = '/water-harness.js'
    ;(await import(url)).startEngine(9182, false)
  })
  await page.waitForTimeout(400)
  const point = await page.evaluate(async () => {
    const url = '/water-harness.js'
    return (await import(url)).findWater()
  })
  await page.mouse.move(point.x, point.y)
  await page.waitForTimeout(100)
  await page.mouse.down()
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    window.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 99, pointerType: 'touch', isPrimary: false }),
    )
  })
  expect(
    (
      await page.evaluate(async () => {
        const url = '/water-harness.js'
        return (await import(url)).diagnostics()
      })
    ).dragging,
  ).toBe(true)
  await page.mouse.move(point.x + 15, point.y - 4)
  await page.waitForTimeout(100)
  await page.mouse.move(point.x + 30, point.y - 8, { steps: 10 })
  await page.waitForTimeout(250)
  const moving = await page.evaluate(async () => {
    const url = '/water-harness.js'
    return (await import(url)).diagnostics()
  })
  expect(moving.impulses).toBeGreaterThan(1)
  expect(
    await page.evaluate(async ({ x, y }) => {
      const url = '/water-harness.js'
      return (await import(url)).hit(x + 30, y - 8)
    }, point),
  ).toBe(true)
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const url = '/water-harness.js'
        return (await import(url)).diagnostics().reveal
      }),
    )
    .toBeGreaterThan(0.1)
  await page.mouse.up()
  await page.waitForTimeout(100)
  const stopped = await page.evaluate(async () => {
    const url = '/water-harness.js'
    return (await import(url)).diagnostics()
  })
  await page.waitForTimeout(350)
  const idle = await page.evaluate(async () => {
    const url = '/water-harness.js'
    return (await import(url)).diagnostics()
  })
  expect(idle.impulses).toBe(stopped.impulses)
  await page.evaluate(({ x, y }) => {
    const button = document.createElement('button')
    button.textContent = 'Interface'
    button.style.cssText = `position:fixed;left:${x - 50}px;top:${y - 30}px;width:150px;height:80px;z-index:10`
    document.body.append(button)
  }, point)
  await page.mouse.move(point.x + 10, point.y)
  await page.waitForTimeout(150)
  expect(
    await page.evaluate(async ({ x, y }) => {
      const url = '/water-harness.js'
      return (await import(url)).hit(x, y)
    }, point),
  ).toBe(false)
  expect(
    (
      await page.evaluate(async () => {
        const url = '/water-harness.js'
        return (await import(url)).diagnostics()
      })
    ).impulses,
  ).toBe(idle.impulses)
  await page.evaluate(() => document.querySelector('button')?.remove())
  await page
    .locator('canvas')
    .dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' })
  await page.locator('canvas').dispatchEvent('pointerleave')
  await page.waitForTimeout(400)
  const cancelled = await page.evaluate(async () => {
    const url = '/water-harness.js'
    return (await import(url)).diagnostics()
  })
  expect(cancelled.active).toBe(false)
  expect(cancelled.reveal).toBeLessThan(0.1)
  const bank = await page.evaluate(async () => {
    const url = '/water-harness.js'
    return (await import(url)).findBank()
  })
  await page.mouse.click(bank.x, bank.y)
  await page.waitForTimeout(100)
  expect(
    (
      await page.evaluate(async () => {
        const url = '/water-harness.js'
        return (await import(url)).diagnostics()
      })
    ).impulses,
  ).toBe(cancelled.impulses)
  if (testInfo.project.name === 'mobile') {
    await page.touchscreen.tap(point.x, point.y)
    await page.waitForTimeout(150)
    const touch = await page.evaluate(async () => {
      const url = '/water-harness.js'
      return (await import(url)).diagnostics()
    })
    expect(touch.impulses).toBeGreaterThan(cancelled.impulses)
    expect(touch.active).toBe(false)
  }
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const hidden = await page.evaluate(async () => {
    const url = '/water-harness.js'
    return (await import(url)).diagnostics()
  })
  await page.waitForTimeout(300)
  expect(
    (
      await page.evaluate(async () => {
        const url = '/water-harness.js'
        return (await import(url)).diagnostics()
      })
    ).elapsed,
  ).toBe(hidden.elapsed)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.setViewportSize({ width: 500, height: 740 })
  await page.evaluate(async () => {
    const url = '/water-harness.js'
    ;(await import(url)).resizeEngine()
  })
  await expect(page.locator('canvas')).toHaveAttribute(
    'width',
    testInfo.project.name === 'mobile' ? '750' : '500',
  )
  await page.evaluate(async () => {
    const url = '/water-harness.js'
    ;(await import(url)).stopEngine()
  })
  await expect(page.locator('canvas')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('reduced motion freezes simulation but permits pointer lighting; analytic fallback works', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.evaluate(async () => {
    const url = '/water-harness.js'
    ;(await import(url)).startEngine(12, true)
  })
  await page.waitForTimeout(250)
  const before = await page.locator('canvas').screenshot()
  const point = await page.evaluate(async () => {
    const url = '/water-harness.js'
    return (await import(url)).findWater()
  })
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 15, point.y)
  await page.mouse.up()
  await page.waitForTimeout(200)
  const lit = await page.locator('canvas').screenshot()
  expect(lit).not.toEqual(before)
  await page.waitForTimeout(200)
  expect(await page.locator('canvas').screenshot()).toEqual(lit)
  await page.locator('canvas').dispatchEvent('pointerleave')
  await page.waitForTimeout(100)
  expect(await page.locator('canvas').screenshot()).toEqual(before)
  const state = await page.evaluate(async () => {
    const url = '/water-harness.js'
    return (await import(url)).diagnostics()
  })
  expect(state.elapsed).toBe(0)
  expect(state.impulses).toBe(0)
  await page.evaluate(async () => {
    const url = '/water-harness.js'
    const module = await import(url)
    module.stopEngine()
    const original = WebGL2RenderingContext.prototype.getExtension
    WebGL2RenderingContext.prototype.getExtension = function (name: string) {
      return name === 'EXT_color_buffer_float' ? null : original.call(this, name)
    }
    module.startEngine(0, true)
  })
  await expect(page.locator('canvas')).toHaveAttribute('data-water-mode', 'analytic')
  await page.evaluate(async () => {
    const url = '/water-harness.js'
    ;(await import(url)).stopEngine()
  })
})

test('shared wind agrees on CPU/GPU; cloud captures are continuous, periodic and volumetric', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const result = await page.evaluate(async (mobile) => {
    const url = '/water-harness.js'
    return (await import(url)).exerciseAtmosphere(mobile)
  }, testInfo.project.name === 'mobile')
  await testInfo.attach('atmosphere-measurements', {
    body: JSON.stringify(result),
    contentType: 'application/json',
  })
  expect(result.maximumError).toBeLessThan(0.0002)
  expect(result.interpolationError).toBeLessThanOrEqual(1)
  expect(result.continuityError).toBeLessThanOrEqual(1)
  expect(result.repeatError).toBe(0)
  expect(result.motion).toBeGreaterThan(1)
  expect(result.minTransmission).toBeLessThan(50)
  expect(result.maxTransmission).toBeGreaterThan(245)
  expect(result.seamError).toBeLessThanOrEqual(2)
  expect(errors).toEqual([])
})

test('controlled wind and lunar attenuation captures, anchored independently of the camera', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  for (const scenario of ['weak', 'strong', 'reverse']) {
    // Each experiment owns and releases its renderer and textures.
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(
      async ({ mobile, scenario: name }) => {
        const url = '/water-harness.js'
        ;(await import(url)).startCloudExperiment(mobile, name)
      },
      { mobile: testInfo.project.name === 'mobile', scenario },
    )
    // eslint-disable-next-line no-await-in-loop
    const before = await page
      .locator('canvas')
      .screenshot({ path: testInfo.outputPath(`${scenario}-0.png`) })
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(async () => {
      const url = '/water-harness.js'
      ;(await import(url)).renderCloudExperiment(0, true)
    })
    // eslint-disable-next-line no-await-in-loop
    expect((await page.locator('canvas').screenshot()).equals(before)).toBe(true)
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(async () => {
      const url = '/water-harness.js'
      ;(await import(url)).renderCloudExperiment(15)
    })
    // eslint-disable-next-line no-await-in-loop
    const after = await page
      .locator('canvas')
      .screenshot({ path: testInfo.outputPath(`${scenario}-15.png`) })
    expect(after.equals(before)).toBe(false)
    // Record a continuous segment at real simulation speed after the timed capture.
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(async () => {
      const url = '/water-harness.js'
      const module = await import(url)
      await new Promise<void>((resolve) => {
        const started = performance.now()
        const frame = (now: number) => {
          const elapsed = (now - started) / 1000
          module.renderCloudExperiment(15 + elapsed)
          if (elapsed < 4) requestAnimationFrame(frame)
          else resolve()
        }
        requestAnimationFrame(frame)
      })
    })
  }
  await page.evaluate(async () => {
    const url = '/water-harness.js'
    ;(await import(url)).stopCloudExperiment()
  })
  expect(errors).toEqual([])
})

test('cloud shadows follow volume and moon projection while preserving local light', async ({
  page,
}, info) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const result = await page.evaluate(async (mobile) => {
    const url = '/water-harness.js'
    return (await import(url)).exerciseCloudShadows(mobile)
  }, info.project.name === 'mobile')
  await info.attach('cloud-shadow-measurements', {
    body: JSON.stringify(result),
    contentType: 'application/json',
  })
  expect(result.referenceError).toBeLessThan(0.045)
  expect(result.heightError).toBeLessThan(0.002)
  expect(result.interpolationError).toBeLessThan(0.002)
  expect(result.repeatError).toBe(0)
  expect(result.motion).toBeGreaterThan(0.01)
  expect(result.relativeMotion).toBeGreaterThan(0.01)
  expect(result.min).toBeLessThan(0.6)
  expect(result.max).toBeGreaterThan(0.99)
  expect(result.moonDarkening).toBeGreaterThan(1)
  expect(result.ambientDarkening).toBeGreaterThan(1)
  expect(result.localDifference).toBe(0)
  expect(result.cursorLight).toBeGreaterThan(1)
  expect(result.cursorDifference).toBe(0)
  await page.evaluate(async () => {
    const url = '/water-harness.js'
    ;(await import(url)).startEngine(9182, true)
  })
  await page.waitForTimeout(100)
  for (const enabled of [false, true]) {
    // Same time and camera, varying only cloud shadow strength.
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(async (on) => {
      const url = '/water-harness.js'
      ;(await import(url)).renderCloudShadowComparison(18, on)
    }, enabled)
    // eslint-disable-next-line no-await-in-loop
    await page.screenshot({
      path: info.outputPath(enabled ? 'cloud-shadows.png' : 'no-cloud-shadows.png'),
    })
  }
  await page.evaluate(async () => {
    const url = '/water-harness.js'
    ;(await import(url)).stopEngine()
  })
  expect(errors).toEqual([])
})
