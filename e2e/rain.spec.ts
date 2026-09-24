import { resolve } from 'node:path'

import { expect, test } from '@playwright/test'
import type { WebGLRenderer, WebGLRenderTarget } from 'three'
import { build } from 'vite'

// Exercise the public engine API in an isolated document, without exposing a debug API in the site.
// A separate entry avoids the application entry's hydration side effects from shared chunks.
let engineScript: string
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: resolve('src/scene/VoxelLandscapeEngine.ts'), formats: ['es'] },
    },
  })
  const bundle = Array.isArray(result) ? result[0]! : result
  if (!('output' in bundle)) throw new Error('Missing engine bundle')
  const entry = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing engine entry')
  engineScript = entry.code
})

test('changes rain and wind at runtime, pauses when hidden, and releases the canvas', async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || /WebGL/.test(message.text())) errors.push(message.text())
  })
  await page.route('**/rain-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>canvas{display:block;width:100%;height:100%}</style></head><body style="margin:0"><div id="host" style="width:100vw;height:100vh"></div></body></html>',
    }),
  )
  await page.route('**/rain-test-engine.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: engineScript,
    }),
  )
  await page.goto('/rain-test')
  await page.evaluate(async () => {
    const moduleUrl = '/rain-test-engine.js'
    const { VoxelLandscapeEngine } = await import(moduleUrl)
    const context = window as typeof window & {
      rainEngine: {
        setRainState: (state: unknown) => void
        resize: () => void
        dispose: () => void
      }
      rainFrameCosts: number[]
      rainReady: boolean
    }
    context.rainFrameCosts = []
    const requestFrame = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (callback) =>
      requestFrame((now) => {
        const start = performance.now()
        callback(now)
        context.rainFrameCosts.push(performance.now() - start)
      })
    context.rainEngine = new VoxelLandscapeEngine({
      container: document.querySelector('#host'),
      seed: 42,
      // This fixture isolates rainfall; shore splashes share the same normal buffer.
      sceneDetails: false,
      rain: { intensity: 0, wind: { x: 2, z: 0.5 } },
      onFirstFrame: () => {
        context.rainReady = true
      },
      onContextFailure: () => {
        throw new Error('WebGL context lost')
      },
    })
  })
  await page.waitForFunction(() => (window as typeof window & { rainReady: boolean }).rainReady)
  const measure = async (intensity: number) => {
    await page.evaluate((value) => {
      const context = window as typeof window & {
        rainEngine: { setRainState: (state: unknown) => void }
        rainFrameCosts: number[]
      }
      context.rainEngine.setRainState({ intensity: value, wind: { x: -5, z: 3 } })
      context.rainFrameCosts.length = 0
    }, intensity)
    await page.waitForTimeout(intensity ? 6500 : 2500)
    const timings = await page.evaluate(() =>
      (window as typeof window & { rainFrameCosts: number[] }).rainFrameCosts
        .slice(-60)
        .toSorted((a, b) => a - b),
    )
    expect(timings.length).toBeGreaterThan(20)
    testInfo.annotations.push({
      type: 'cpu-frame-time',
      description: `${intensity ? 'heavy' : 'off'}: median ${timings[Math.floor(timings.length / 2)]!.toFixed(2)} ms; p95 ${timings[Math.floor(timings.length * 0.95)]!.toFixed(2)} ms (CPU submission, excludes GPU execution)`,
    })
  }
  await measure(0)
  const readImpactField = () =>
    page.evaluate(() => {
      const { renderer, rain } = (
        window as typeof window & {
          rainEngine: { renderer: WebGLRenderer; rain: { slopeTarget: WebGLRenderTarget } }
        }
      ).rainEngine
      const target = rain.slopeTarget
      const pixels = new Uint16Array(target.width * target.height * 4)
      renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels)
      let positive = 0
      let negative = 0
      let variance = 0
      let invalid = 0
      // Read the actual half-float GPU output. Count contributions above 0.0001,
      // retaining signs, and reject NaN/Infinity (all exponent bits set).
      for (let i = 0; i < pixels.length; i += 4) {
        for (let channel = 0; channel < 3; channel++) {
          const bits = pixels[i + channel]!
          if ((bits & 0x7c00) === 0x7c00) invalid++
          if ((bits & 0x7fff) < 0x068e) continue
          if (channel === 2) variance++
          else if (bits & 0x8000) negative++
          else positive++
        }
      }
      return { positive, negative, variance, invalid }
    })
  expect(await readImpactField()).toEqual({ positive: 0, negative: 0, variance: 0, invalid: 0 })
  await measure(1)
  const field = await readImpactField()
  expect(field.positive).toBeGreaterThan(10)
  expect(field.negative).toBeGreaterThan(10)
  expect(field.variance).toBeGreaterThan(10)
  expect(field.invalid).toBe(0)
  testInfo.annotations.push({ type: 'rain-impact-field', description: JSON.stringify(field) })
  await page.evaluate(() => {
    const engine = (
      window as typeof window & {
        rainEngine: { setRainState: (state: unknown) => void; resize: () => void }
      }
    ).rainEngine
    engine.setRainState({ intensity: 0.25, wind: { x: 6, z: -4 } })
    document.querySelector<HTMLElement>('#host')!.style.width = '80vw'
    engine.resize()
  })
  const viewport = page.viewportSize()!
  await expect(page.locator('canvas')).toHaveJSProperty(
    'clientWidth',
    Math.round(viewport.width * 0.8),
  )
  await page.waitForTimeout(500)
  // Dispatch the actual lifecycle event with controlled visibility; no browser debug globals in production.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const before = await page.locator('canvas').screenshot()
  await page.waitForTimeout(250)
  expect(await page.locator('canvas').screenshot()).toEqual(before)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(250)
  expect(await page.locator('canvas').screenshot()).not.toEqual(before)
  await page.evaluate(() => {
    const engine = (window as typeof window & { rainEngine: { dispose: () => void } }).rainEngine
    engine.dispose()
    engine.dispose()
  })
  await expect(page.locator('canvas')).toHaveCount(0)
  expect(errors).toEqual([])
})
