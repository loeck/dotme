import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { build } from 'vite'

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
  await page.route('**/water-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="scene" style="width:100vw;height:100vh"></div></body></html>',
    }),
  )
  await page.route('**/water-harness.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: harness }),
  )
  await page.goto('/water-test')
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
  expect(result.spread.propagated).toBeGreaterThan(0.0001)
  expect(result.spread.beyond).toBe(0)
  expect(result.settled.beyond).toBe(0)
  expect(result.settled.energy).toBeLessThan(result.initial.energy * 0.06)
  expect(result.settled.peak).toBeLessThan(0.22)
  expect(result.reset.energy).toBe(0)
  expect(result.edgeEnergy[0]).toBeLessThan(result.edgeEnergy[1] * 0.1)
  expect(result.sampled[0]).toBeCloseTo(result.sampled[1], 7)
  expect(result.sampled[1]).toBeCloseTo(result.sampled[2], 7)
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
  await page.mouse.move(point.x + 15, point.y - 4)
  await page.waitForTimeout(100)
  await page.mouse.move(point.x + 30, point.y - 8, { steps: 10 })
  await page.waitForTimeout(250)
  const moving = await page.evaluate(async () => {
    const url = '/water-harness.js'
    return (await import(url)).diagnostics()
  })
  expect(moving.impulses).toBeGreaterThan(1)
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

test('reduced motion stays static and unavailable float targets use analytic water', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.evaluate(async () => {
    const url = '/water-harness.js'
    ;(await import(url)).startEngine(12, true)
  })
  await page.waitForTimeout(250)
  const before = await page.locator('canvas').screenshot()
  await page.mouse.move(250, 500)
  await page.mouse.down()
  await page.mouse.move(300, 550)
  await page.mouse.up()
  await page.waitForTimeout(200)
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
