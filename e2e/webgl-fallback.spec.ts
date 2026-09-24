import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

import { mockSceneWeather } from './weather-fixture'

const SCENARIOS = [
  { name: 'clear noon', weather: 'clear', rain: 0, startTime: '12:00' },
  { name: 'cloudy dusk', weather: 'cloudy', rain: 0, startTime: '19:30' },
  { name: 'rainy night', weather: 'overcast', rain: 1, startTime: '00:00' },
] as const

type Scenario = (typeof SCENARIOS)[number]

async function renderScene(browser: Browser, scenario: Scenario, backend: 'webgpu' | 'webgl') {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text())
  })
  if (backend === 'webgl')
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', {
        configurable: true,
        get: () => undefined,
      })
    })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mockSceneWeather(page, scenario.weather, scenario.rain)
  await page.clock.install({ time: new Date('2026-06-21T10:00:00Z') })
  await page.goto(`/?seed=1&startTime=${scenario.startTime}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  await expect(page.locator('#scene-canvas')).toHaveAttribute('data-backend', backend)
  await expect(page.locator('#scene-canvas')).toHaveAttribute('data-water-mode', 'gpu')
  // Both backends present the same simulated instant.
  await page.clock.pauseAt(new Date('2026-06-21T10:00:30Z'))
  await page.clock.runFor(100)
  const image = await page.locator('#scene-canvas').screenshot()
  expect(failures.filter((message) => !message.includes('net::ERR_FAILED'))).toEqual([])
  return { page, image }
}

function compare(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(
    async ([left, right]) => {
      async function decode(encoded: string) {
        const image = new Image()
        image.src = `data:image/png;base64,${encoded}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Cannot inspect rendered screenshot')
        context.drawImage(image, 0, 0)
        return context.getImageData(0, 0, image.width, image.height)
      }
      const [x, y] = await Promise.all([decode(left), decode(right)])
      if (x.width !== y.width || x.height !== y.height) throw new Error('Size mismatch')
      let total = 0
      let different = 0
      for (let i = 0; i < x.data.length; i += 4) {
        let worst = 0
        for (let c = 0; c < 3; c++) {
          const delta = Math.abs((x.data[i + c] ?? 0) - (y.data[i + c] ?? 0))
          total += delta
          worst = Math.max(worst, delta)
        }
        if (worst > 24) different++
      }
      const pixels = x.width * x.height
      return { meanError: total / (pixels * 3), differentFraction: different / pixels }
    },
    [a.toString('base64'), b.toString('base64')] as const,
  )
}

for (const scenario of SCENARIOS)
  test(`WebGL 2 fallback matches WebGPU: ${scenario.name}`, async ({ browser }, info) => {
    const webgpu = await renderScene(browser, scenario, 'webgpu')
    await webgpu.page.close()
    const webgl = await renderScene(browser, scenario, 'webgl')
    await info.attach('webgpu', { body: webgpu.image, contentType: 'image/png' })
    await info.attach('webgl', { body: webgl.image, contentType: 'image/png' })
    const difference = await compare(webgl.page, webgpu.image, webgl.image)
    await webgl.page.close()
    await info.attach('difference.json', {
      body: JSON.stringify(difference, null, 2),
      contentType: 'application/json',
    })
    expect(difference.meanError).toBeLessThan(0.5)
    expect(difference.differentFraction).toBeLessThan(0.002)
  })
