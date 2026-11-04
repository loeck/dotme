import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { deferred } from './deferred'
import { mockParisWeather } from './weather-fixture'

const nativePoint = /data:image\/svg\+xml.*4 4, none/

test.beforeEach(async ({ page }) => {
  await mockParisWeather(page)
})

test('outlined point stays on controls and grows above the dialog', async ({ page }) => {
  await page.goto('/?seed=42')
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  await expect(page.locator('main')).toHaveCSS('cursor', nativePoint)
  const trigger = page.getByRole('button', { name: 'About this landscape' })
  await trigger.hover()
  await expect(trigger).toHaveCSS('cursor', 'none')
  await expect(page.locator('.scene-cursor')).toHaveAttribute('data-interactive', 'true')
  // The point opens into a hollow ring so the label under it stays legible.
  await expect(page.locator('.scene-cursor-ring')).toHaveCSS('opacity', '1')
  await expect(page.locator('.scene-cursor-ring')).toHaveCSS('scale', '1')
  await expect(page.locator('.scene-cursor-point')).toHaveCSS('scale', '0.5')
  await expect(trigger.locator('svg')).toHaveCSS('cursor', 'none')
  await trigger.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveCSS('cursor', 'none')
  await dialog.getByRole('link', { name: 'Three.js' }).hover()
  await expect(dialog.getByRole('link', { name: 'Three.js' })).toHaveCSS('cursor', 'none')
  await expect(page.locator('.scene-cursor')).toBeVisible()
  expect(await dialog.evaluate((element) => getComputedStyle(element, '::backdrop').cursor)).toBe(
    'none',
  )
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('native point remains during landscape loading and returns after blur', async ({ page }) => {
  const barrier = deferred()
  await page.route('**/assets/landscape-*.js', async (route) => {
    await barrier.promise
    await route.continue()
  })
  const requested = page.waitForRequest('**/assets/landscape-*.js')
  await page.goto('/?seed=42', { waitUntil: 'domcontentloaded' })
  await requested
  const root = page.locator('html')
  const canvas = page.locator('#scene-canvas')
  const cursor = page.locator('.scene-cursor')
  try {
    await expect(root).toHaveAttribute('data-scene-loading', 'loading')
    await expect(canvas).toHaveAttribute('data-loader-rendered', 'true')
    await page.mouse.move(200, 200)
    await expect(canvas).toHaveCSS('cursor', nativePoint)
    await expect(root).not.toHaveAttribute('data-cursor-active')
    await expect(cursor).toBeHidden()
  } finally {
    barrier.resolve()
  }
  await expect(root).toHaveAttribute('data-scene-loading', 'ready')
  await page.mouse.move(240, 200)
  await expect(cursor).toBeVisible()
  await expect(cursor).toHaveCSS('width', '6px')
  await expect(canvas).toHaveCSS('cursor', 'none')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(cursor).toBeHidden()
  await expect(root).not.toHaveAttribute('data-cursor-active')
  await expect(canvas).toHaveCSS('cursor', nativePoint)
})

/** Dispatches mouse moves on `main`, one batch per animation frame, and reads the point. */
const strainAfter = (page: Page, frames: (readonly (readonly [number, number])[])[]) =>
  page.evaluate(async (batches) => {
    const target = document.querySelector('main')
    const point = document.querySelector<HTMLElement>('.scene-cursor-point')
    if (!target || !point) throw new Error('Cursor elements are missing')
    window.dispatchEvent(new Event('blur'))
    for (const batch of batches) {
      for (const [x, y] of batch) {
        target.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerType: 'mouse',
            clientX: x,
            clientY: y,
          }),
        )
      }
      // eslint-disable-next-line no-await-in-loop -- one batch per rendered frame
      await new Promise(requestAnimationFrame)
    }
    const rect = point.getBoundingClientRect()
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      transform: point.style.transform,
      strain: new DOMMatrixReadOnly(point.style.transform),
    }
  }, frames)

test('the point trails a tail behind its motion and settles at rest', async ({ page }) => {
  await page.goto('/?seed=42')
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  const point = page.locator('.scene-cursor-point')
  // Each direction starts after the previous deformation has visibly settled.
  /* eslint-disable no-await-in-loop */
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const path = [0, 1, 2, 3].map((step) => [[400 + dx * 24 * step, 400 + dy * 24 * step]] as const)
    const shape = await strainAfter(page, path)
    const x = 400 + dx * 72
    const y = 400 + dy * 72
    // The hit point stays inside the drawn shape, at its leading edge.
    expect(shape.left).toBeLessThanOrEqual(x + 3.01)
    expect(shape.right).toBeGreaterThanOrEqual(x - 3.01)
    expect(shape.top).toBeLessThanOrEqual(y + 3.01)
    expect(shape.bottom).toBeGreaterThanOrEqual(y - 3.01)
    if (dx > 0) expect(shape.right).toBeCloseTo(x + 3, 0)
    if (dx < 0) expect(shape.left).toBeCloseTo(x - 3, 0)
    if (dy > 0) expect(shape.bottom).toBeCloseTo(y + 3, 0)
    if (dy < 0) expect(shape.top).toBeCloseTo(y - 3, 0)
    // Proportional to speed, so slow frames on a busy GPU still give a visible tail.
    const stretch = dx ? shape.strain.a : shape.strain.d
    expect(stretch).toBeGreaterThan(1.2)
    expect(stretch).toBeLessThanOrEqual(2.1)
    await expect(point).toHaveCSS('transform', 'none')
  }
  /* eslint-enable no-await-in-loop */
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const still = await strainAfter(page, [[[400, 400]], [[480, 400]], [[560, 400]]])
  expect(still.right - still.left).toBeCloseTo(6, 2)
  expect(still.bottom - still.top).toBeCloseTo(6, 2)
  expect(still.transform).toBe('none')
  await page.getByRole('link', { name: /GitHub/ }).hover()
  await expect(page.locator('.scene-cursor')).toBeVisible()
  await expect(page.locator('.scene-cursor')).toHaveAttribute('data-interactive', 'true')
  await expect(page.getByRole('link', { name: /GitHub/ })).toHaveCSS('cursor', 'none')
})

test('a press tightens the point and only the landscape releases an echo', async ({ page }) => {
  await page.goto('/?seed=42')
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  const cursor = page.locator('.scene-cursor')
  const echoes = () =>
    page.evaluate(() => document.querySelector('.scene-cursor-echo')?.getAnimations().length)
  await page.mouse.move(640, 160)
  await page.mouse.down()
  await expect(cursor).toHaveAttribute('data-pressed', '')
  await expect(page.locator('.scene-cursor-point')).toHaveCSS('scale', '0.72')
  expect(await echoes()).toBe(1)
  await page.mouse.up()
  await expect(cursor).not.toHaveAttribute('data-pressed')
  await expect.poll(echoes).toBe(0)
  const trigger = page.getByRole('button', { name: 'About this landscape' })
  await trigger.hover()
  await page.mouse.down()
  await expect(page.locator('.scene-cursor-ring')).toHaveCSS('scale', '0.84')
  expect(await echoes()).toBe(0)
  await page.mouse.up()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.mouse.move(640, 160)
  await page.mouse.down()
  await expect(cursor).toHaveAttribute('data-pressed', '')
  expect(await echoes()).toBe(0)
  await page.mouse.up()
})

test('native point is available before the main JavaScript starts', async ({ page }) => {
  await page.route('**/assets/index-*.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  )
  const requested = page.waitForRequest('**/assets/index-*.js')
  await page.goto('/')
  await requested
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'loading')
  await expect(page.locator('html')).not.toHaveAttribute('data-cursor-active')
  await expect(page.locator('#scene-canvas')).toHaveCSS('cursor', nativePoint)
  await expect(page.locator('.scene-cursor')).toBeHidden()
})
