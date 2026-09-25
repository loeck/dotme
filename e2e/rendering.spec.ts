import { expect, test } from '@playwright/test'

import { deferred } from './deferred'

test('presents the loader before requesting landscape and keeps its canvas', async ({ page }) => {
  const { promise: barrier, resolve: release } = deferred()
  await page.route('**/assets/landscape-*.js', async (route) => {
    await barrier
    await route.continue()
  })
  await page.route('**/api.open-meteo.com/**', (route) => route.abort())
  try {
    await page.goto('/?seed=42&startTime=12:00', { waitUntil: 'domcontentloaded' })
    const canvas = page.locator('#scene-canvas')
    await expect(canvas).toHaveAttribute('data-loader-rendered', 'true')
    await expect(page.locator('canvas')).toHaveCount(1)
    await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'loading')
    await expect(page.locator('.scene-info-trigger')).toBeHidden()
    await expect(page.locator('.scene-sound-trigger')).toBeHidden()
    const bounds = await canvas.boundingBox()
    await canvas.evaluate((element) => element.setAttribute('data-original-canvas', 'true'))
    release()
    await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready', {
      timeout: 30_000,
    })
    await expect(canvas).toHaveAttribute('data-original-canvas', 'true')
    await expect(canvas).toHaveAttribute('data-scene-rendered', 'true')
    await expect(page.locator('.scene-info-trigger')).toBeVisible()
    await expect(page.locator('.scene-sound-trigger')).toBeVisible()
    await expect(page.locator('canvas')).toHaveCount(1)
    expect(await canvas.boundingBox()).toEqual(bounds)
    const marks = await page.evaluate(() => ({
      loader: performance.getEntriesByName('loader-presented')[0]?.startTime,
      scene: performance.getEntriesByName('landscape-presented')[0]?.startTime,
      landscape: performance
        .getEntriesByType('resource')
        .find((entry) => /\/landscape-.*\.js/.test(entry.name))?.startTime,
    }))
    expect(marks.loader).toBeDefined()
    expect(marks.landscape).toBeGreaterThanOrEqual(marks.loader ?? Infinity)
    expect(marks.scene).toBeGreaterThan(marks.loader ?? Infinity)
  } finally {
    release()
  }
})

test('loading ends after the initialization deadline when the module and CSS fail', async ({
  page,
}) => {
  await page.clock.install()
  await page.route('**/assets/*.js', (route) => route.abort())
  await page.route('**/assets/*.css', (route) => route.abort())
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeHidden()
  await page.clock.fastForward(30_000)
  await expect(page.locator('.scene-loader').getByRole('link')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeHidden()
  await page.clock.fastForward(30_000)
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'failed')
  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Social links' })).toBeVisible()
  await expect(page.locator('.scene-loader')).toBeHidden()
})

test('landscape import failure releases the static profile', async ({ page }) => {
  await page.route('**/assets/landscape-*.js', (route) => route.abort())
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'failed')
  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await expect(page.locator('canvas')).toHaveCount(1)
})
