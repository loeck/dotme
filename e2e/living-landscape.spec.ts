import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, expect } from '@playwright/test'
import { build } from 'vite'
let directory: string, harness: string

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'living-landscape-'))
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
  await rm(directory, { recursive: true, force: true })
})

for (const [time, weather] of [
  ['12:00', 'clear'],
  ['18:25', 'clear'],
  ['05:35', 'clear'],
  ['00:00', 'clear'],
  ['00:00', 'overcast'],
  ['12:00', 'cloudy'],
]) {
  test(`stars at ${time} in ${weather}`, async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    await page.route('**/living-test*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="scene" style="width:100vw;height:100vh"></div>',
      }),
    )
    await page.route('**/living-harness.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: harness }),
    )
    await page.goto(`/living-test?startTime=${time}&weather=${weather}`)
    const result = await page.evaluate(
      async ({ weather: preset }) => {
        const module = await import('/living-harness.js')
        await module.start(42, true, true, preset === 'cloudy' ? 0.7 : 0)
        return module.stellarProbe()
      },
      { weather },
    )
    if (time === '12:00' || time === '18:25' || time === '05:35')
      expect(result.skyDifference).toBe(0)
    if (weather === 'overcast') expect(result.skyDifference).toBeLessThan(50)
    if (time === '00:00' && weather === 'clear') expect(result.skyDifference).toBeGreaterThan(500)
    await page.screenshot({ path: info.outputPath(`${time.replace(':', '')}-${weather}.png`) })
    await info.attach('capture-metrics.json', {
      body: JSON.stringify(result),
      contentType: 'application/json',
    })
    if (time === '00:00' && weather === 'clear') {
      const meteor = await page.evaluate(async () =>
        (await import('/living-harness.js')).meteorProbe(),
      )
      expect(meteor.age).toBeCloseTo(0.4)
      expect(meteor.attempts).toBe(1)
      await page.screenshot({ path: info.outputPath('meteor.png') })
    }

    await page.evaluate(async () => {
      ;(await import('/living-harness.js')).stop()
    })
    expect(errors).toEqual([])
  })
}
