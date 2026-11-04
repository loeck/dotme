import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, expect } from '@playwright/test'
import { build } from 'vite'

for (const format of ['ogg', 'mp3'] as const) {
  test(`three-minute production mix has headroom and no silent loop gaps (${format})`, async ({
    page,
  }, info) => {
    const directory = await mkdtemp(join(tmpdir(), 'ambient-audit-'))
    try {
      await build({
        configFile: false,
        logLevel: 'silent',
        build: {
          outDir: directory,
          lib: {
            entry: 'e2e/audio-audit-harness.ts',
            formats: ['es'],
            fileName: () => 'audio-audit.js',
          },
        },
      })
      const harness = await readFile(join(directory, 'audio-audit.js'), 'utf8')
      await page.route('**/audio-audit-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<title>Audio audit</title>' }),
      )
      await page.route('**/audio-audit.js', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: harness }),
      )
      await page.goto('/audio-audit-test')
      const result = await page.evaluate(
        async (audioFormat) => (await import('/audio-audit.js')).auditAudio(audioFormat),
        format,
      )
      expect(result.seconds).toBe(180)
      expect(result.peak).toBeLessThan(0.25)
      expect(result.maxStep).toBeLessThan(0.1)
      expect(Math.min(...result.rms.slice(2))).toBeGreaterThan(0.0001)
      const flowing = [...result.waterfallRms.slice(40, 90), ...result.waterfallRms.slice(130, 150)]
      expect(Math.min(...flowing)).toBeGreaterThan(0.000001)
      const silent = [
        ...result.waterfallRms.slice(15, 30),
        ...result.waterfallRms.slice(110, 120),
        ...result.waterfallRms.slice(170),
      ]
      expect(Math.max(...silent)).toBeLessThan(Math.min(...flowing) * 0.001)
      await info.attach(`audio-audit-${format}.json`, {
        body: JSON.stringify(result, null, 2),
        contentType: 'application/json',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test(`production mix with wide beds, placed calls and splashes keeps headroom (${format})`, async ({
    page,
  }, info) => {
    const directory = await mkdtemp(join(tmpdir(), 'ambient-audit-'))
    try {
      await build({
        configFile: false,
        logLevel: 'silent',
        build: {
          outDir: directory,
          lib: {
            entry: 'e2e/audio-audit-harness.ts',
            formats: ['es'],
            fileName: () => 'audio-audit.js',
          },
        },
      })
      const harness = await readFile(join(directory, 'audio-audit.js'), 'utf8')
      await page.route('**/audio-audit-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<title>Audio audit</title>' }),
      )
      await page.route('**/audio-audit.js', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: harness }),
      )
      await page.goto('/audio-audit-test')
      const result = await page.evaluate(
        async (audioFormat) => (await import('/audio-audit.js')).auditAudio(audioFormat, true),
        format,
      )
      expect(result.seconds).toBe(180)
      expect(result.peak).toBeLessThan(0.25)
      expect(result.maxStep).toBeLessThan(0.1)
      expect(Math.min(...result.rms.slice(2))).toBeGreaterThan(0.0001)
      // The beds now differ between channels instead of collapsing to one centered signal.
      const side = result.waterfallRms.slice(2).reduce((a: number, b: number) => a + b, 0)
      const total = result.rms.slice(2).reduce((a: number, b: number) => a + b, 0)
      expect(side / total).toBeGreaterThan(0.2)
      await info.attach(`audio-audit-full-${format}.json`, {
        body: JSON.stringify(result, null, 2),
        contentType: 'application/json',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
