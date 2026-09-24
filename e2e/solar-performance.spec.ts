import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, expect } from '@playwright/test'
import { build } from 'vite'

// Opt-in: bundle the committed pre-change water harness separately, then pass its
// absolute path. Keeping both builds in one browser isolates scheduling noise.
test('alternating before/after solar rendering frame timings', async ({ page }, info) => {
  test.skip(!process.env.SOLAR_BASELINE_BUNDLE, 'Requires an independently bundled baseline')
  test.setTimeout(180_000)
  const directory = await mkdtemp(join(tmpdir(), 'dotme-solar-perf-'))
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir: directory,
        lib: { entry: 'e2e/water-harness.ts', formats: ['es'], fileName: () => 'after.js' },
      },
    })
    const before = await readFile(process.env.SOLAR_BASELINE_BUNDLE!, 'utf8')
    const after = await readFile(join(directory, 'after.js'), 'utf8')
    await page.route('**/solar-benchmark?*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="scene" style="width:100vw;height:100vh"></div></body></html>',
      }),
    )
    await page.route('**/before.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: before }),
    )
    await page.route('**/after.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: after }),
    )
    await page.goto('/solar-benchmark?time=12:00&weather=partly-cloudy')
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const result = await page.evaluate(async () => {
      const results: Array<{ build: string; medianMs: number; p95Ms: number }> = []
      for (const buildName of ['before', 'after', 'after', 'before']) {
        // Each trial has a fresh engine and an identical warmup.
        // eslint-disable-next-line no-await-in-loop
        const module = await import(`/${buildName}.js`)
        module.startEngine(9182, false)
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 3000))
        // eslint-disable-next-line no-await-in-loop
        const frames = await new Promise<number[]>((resolve) => {
          let last = performance.now()
          const samples: number[] = []
          const tick = (now: number) => {
            samples.push(now - last)
            last = now
            if (samples.length === 181) resolve(samples.slice(1).toSorted((a, b) => a - b))
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        results.push({ build: buildName, medianMs: frames[90]!, p95Ms: frames[171]! })
        module.stopEngine()
      }
      return results
    })
    await info.attach('alternating-frame-timings', {
      body: JSON.stringify(result),
      contentType: 'application/json',
    })
    expect(errors).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
