import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { build } from 'vite'

import { mockSceneWeather } from './weather-fixture'

test('GPU text and information button retain DOM keyboard interaction', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mockSceneWeather(page, 'clear')
  await page.goto('/?seed=42&startTime=12:00')
  await expect(page.locator('.scene-loader')).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('main')).toHaveAttribute('data-ui-mask', 'gpu')
  await expect(page.locator('#profile-title')).toHaveCSS('color', 'rgba(0, 0, 0, 0)')
  const trigger = page.getByRole('button', { name: 'About this landscape' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await info.attach('per-pixel-contrast', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
})

test('one letter simultaneously contains black and white ink, following moving light', async ({
  page,
}) => {
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
    expect(result.rendererState).toBe(true)
    expect(result.cleaned).toBe(true)
    expect(result.initial.glyphTop.black).toBeGreaterThan(40)
    expect(result.initial.glyphBottom.white).toBeGreaterThan(40)
    expect(result.changed.glyphTop.white).toBeGreaterThan(40)
    expect(result.changed.glyphBottom.black).toBeGreaterThan(40)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (const time of ['08:30', '00:00']) {
  test(`the complete page shades ${time} UI without periodic buffer copies or luminance queries`, async ({
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
    await mockSceneWeather(page, 'partly-cloudy', 1)
    await page.goto(`/?seed=9182&startTime=${time}`)
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
    await page.waitForTimeout(350)
    const after = await read()
    expect(after.queries).toBe(0)
    expect(after.copies).toBe(initial.copies)
  })
}
