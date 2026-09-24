import { resolve } from 'node:path'

import { expect, test } from '@playwright/test'
import { build } from 'vite'

let script: string
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: resolve('e2e/rain-optics-harness.ts'), formats: ['es'] },
    },
  })
  const bundle = Array.isArray(result) ? result[0]! : result
  if (!('output' in bundle)) throw new Error('Missing rain optics bundle')
  const entry = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing rain optics entry')
  script = entry.code
})

test('millimetre rain stays thin, dims with distance, and resolves more finely at high DPI', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.route('**/rain-optics', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
  )
  await page.route('**/rain-optics.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: script }),
  )
  await page.goto('/rain-optics')
  const { near, far, retina, cloudy, contact, expired, reflected } = await page.evaluate(
    async () => {
      const url = '/rain-optics.js'
      const { sampleDrop } = await import(url)
      return {
        near: sampleDrop(8, 1),
        far: sampleDrop(16, 1),
        retina: sampleDrop(8, 2),
        cloudy: [0, 0.25, 0.5, 0.75].map((offset) => sampleDrop(8, 1, 0.3, offset)),
        contact: sampleDrop(8, 1, 0, 0, 1 / 180),
        expired: sampleDrop(8, 1, 0, 0, 1 / 90),
        reflected: [0, 0.25, 0.5, 0.75].map((offset) => sampleDrop(8, 1, 0.3, offset, -1, true)),
      }
    },
  )
  expect(near.energy).toBeGreaterThan(10)
  expect(near.width).toBeLessThanOrEqual(2)
  expect(near.length).toBeGreaterThan(near.width * 2)
  expect(near.length).toBeLessThan(16)
  expect(far.energy).toBeGreaterThan(0)
  expect(far.energy).toBeLessThan(near.energy)
  expect(far.length).toBeLessThan(near.length)
  expect(retina.width).toBeLessThan(near.width)
  expect(retina.energy).toBeGreaterThan(0)
  expect(contact.energy).toBeGreaterThan(0)
  expect(contact.energy).toBeLessThan(near.energy)
  expect(contact.length).toBeLessThan(near.length)
  expect(expired.energy).toBe(0)
  // A narrow drop must remain visible against grey sky between pixel centres.
  for (const drop of cloudy) expect(drop.peak).toBeGreaterThanOrEqual(8)
  const energies = cloudy.map((drop: { energy: number }) => drop.energy)
  expect(Math.max(...energies) / Math.min(...energies)).toBeLessThan(2)
  // Reflection texels integrate the physical line instead of expanding a Gaussian.
  // Even between texels, energy remains visible and stable without a wide halo.
  for (const drop of reflected) {
    expect(drop.width).toBeLessThanOrEqual(2)
    expect(drop.peak).toBeGreaterThanOrEqual(8)
  }
  const reflectedEnergy = reflected.map((drop: { energy: number }) => drop.energy)
  expect(Math.max(...reflectedEnergy) / Math.min(...reflectedEnergy)).toBeLessThan(1.3)
  expect(errors).toEqual([])
})

test('rain remains reflected and switches back to overlay resolution after nested rendering and resize', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.route('**/rain-optics', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
  )
  await page.route('**/rain-optics.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: script }),
  )
  await page.goto('/rain-optics')
  const result = await page.evaluate(async () => {
    const url = '/rain-optics.js'
    const { sampleReflectedRain } = await import(url)
    return sampleReflectedRain()
  })
  for (const sample of Object.values(result)) {
    expect(sample.reflectionEnergy).toBeGreaterThan(0.001)
    expect(sample.overlayDifference).toBeGreaterThan(10)
    expect(sample.passes).toHaveLength(2)
  }
  expect(result.first.passes).toEqual([
    { reflection: true, width: 256, height: 192, pixelRatio: 0.8 },
    { reflection: false, width: 640, height: 480, pixelRatio: 2 },
  ])
  expect(result.resized.passes).toEqual([
    { reflection: true, width: 192, height: 144, pixelRatio: 0.48 },
    { reflection: false, width: 800, height: 600, pixelRatio: 2 },
  ])
  expect(result.restored).toEqual(result.first)
  expect(errors).toEqual([])
})
