import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { build } from 'vite'

test('backdrop query preserves contrast without copying GPU pixels', async ({ page }) => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'dotme-backdrop-'))
  try {
    await build({
      configFile: false,
      logLevel: 'error',
      build: {
        outDir: directory,
        lib: {
          entry: 'e2e/profile-luminance-harness.ts',
          formats: ['es'],
          fileName: () => 'meter.js',
        },
      },
    })
    const code = await readFile(join(directory, 'meter.js'), 'utf8')
    await page.route('**/meter-test', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<body></body>' }),
    )
    await page.route('**/meter.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: code }),
    )
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/meter-test')
    const result = await page.evaluate(async () => {
      const url = '/meter.js'
      return (await import(url)).verify()
    })
    expect(errors).toEqual([])
    expect(result.error).toBe(0)
    expect(result.copies).toBe(0)
    expect(result.cases).toHaveLength(80)
    for (const sample of result.cases)
      expect(sample.actual, JSON.stringify(sample)).toBe(sample.expected)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (const time of ['08:30', '00:00']) {
  test(`the complete page meters ${time} lighting without periodic buffer copies`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const counters = { copies: 0, queries: 0 }
      Object.assign(window, { backdropCounters: counters })
      const prototype = WebGL2RenderingContext.prototype
      const copy = prototype.getBufferSubData
      prototype.getBufferSubData = function (...args) {
        counters.copies++
        return copy.apply(this, args)
      }
      const begin = prototype.beginQuery
      prototype.beginQuery = function (target, query) {
        if (target === this.ANY_SAMPLES_PASSED) counters.queries++
        return begin.call(this, target, query)
      }
    })
    await page.goto(`/?seed=9182&time=${time}&rain=heavy&weather=partly-cloudy`)
    await expect(page.locator('#landscape')).toHaveClass(/opacity-100/)
    const read = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              backdropCounters: { copies: number; queries: number }
            }
          ).backdropCounters,
      )
    const initial = await read()
    await expect
      .poll(async () => (await read()).queries, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(initial.queries + 3)
    expect((await read()).copies).toBe(initial.copies)
  })
}
