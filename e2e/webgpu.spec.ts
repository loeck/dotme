import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { build } from 'vite'

test('experimental GPU-resident compute agrees with WebGL physics', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium',
    'WebGPU prototype tested in Chromium; production keeps WebGL fallback',
  )
  test.setTimeout(120_000)
  const directory = await mkdtemp(join(tmpdir(), 'dotme-compute-'))
  try {
    await build({
      configFile: false,
      logLevel: 'error',
      build: {
        outDir: directory,
        lib: { entry: 'e2e/webgpu-harness.ts', formats: ['es'], fileName: () => 'harness.js' },
      },
    })
    const code = await readFile(join(directory, 'harness.js'), 'utf8')
    await page.route('**/compute-test', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
    )
    await page.route('**/compute.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: code }),
    )
    await page.goto('/compute-test')
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    const result = await page.evaluate(async () => {
      const url = '/compute.js'
      return (await import(url)).exerciseCompute()
    })
    console.log(JSON.stringify(result))
    test.skip(!result, 'No WebGPU adapter available')
    await testInfo.attach('compute-comparison.json', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    })
    expect([...new Set(errors)].slice(0, 3)).toEqual([])
    for (const scenario of [result.impulse, result.wind]) {
      expect(scenario.finite).toBe(true)
      expect(scenario.energy).toBeGreaterThan(0.001)
      expect(scenario.maxError).toBeLessThan(0.005)
      expect(Math.abs(scenario.energy / scenario.originalEnergy - 1)).toBeLessThan(0.02)
    }
    expect(result.impulse.beyond).toBe(0)
    expect(result.reset.energy).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
