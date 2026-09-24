import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { build } from 'vite'

test('diagnostics and repeated disposal release scene resources', async ({ page }) => {
  test.setTimeout(120_000)
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
    const code = await readFile(join(directory, 'harness.js'), 'utf8')
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
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    const result = await page.evaluate(async () => {
      const url = '/lifetime.js',
        module = await import(url)
      module.start(12, true)
      const diagnostics = module.capture().diagnostics
      module.stop()
      return { diagnostics, lifetime: module.lifecycle() }
    })
    expect(errors).toEqual([])
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
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
