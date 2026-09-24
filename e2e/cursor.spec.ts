import { expect, test } from '@playwright/test'

import { deferred } from './deferred'
import { mockParisWeather } from './weather-fixture'

const nativePoint = /data:image\/svg\+xml.*4 4, none/

test.beforeEach(async ({ page }) => {
  await mockParisWeather(page)
})

test('outlined point stays on controls and grows above the dialog', async ({ page }, info) => {
  await page.goto('/?seed=42')
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  const main = page.locator('main')
  const desktop = info.project.name === 'chromium'
  if (desktop) await expect(main).toHaveCSS('cursor', nativePoint)
  else await expect(main).toHaveCSS('cursor', 'auto')
  const trigger = page.getByRole('button', { name: 'About this landscape' })
  await trigger.hover()
  if (desktop) {
    await expect(trigger).toHaveCSS('cursor', 'none')
    await expect(page.locator('.scene-cursor')).toHaveAttribute('data-interactive', 'true')
    await expect(page.locator('.scene-cursor > span')).toHaveCSS('scale', '1.65')
    await expect(trigger.locator('svg')).toHaveCSS('cursor', 'none')
  }
  await trigger.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  if (desktop) {
    await expect(dialog).toHaveCSS('cursor', 'none')
    await dialog.getByRole('link', { name: 'Three.js' }).hover()
    await expect(dialog.getByRole('link', { name: 'Three.js' })).toHaveCSS('cursor', 'none')
    await expect(page.locator('.scene-cursor')).toBeVisible()
    expect(await dialog.evaluate((element) => getComputedStyle(element, '::backdrop').cursor)).toBe(
      'none',
    )
  }
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

test('strain follows movement without shifting the hit point and settles at rest', async ({
  page,
}) => {
  await page.goto('/?seed=42')
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  const cursor = page.locator('.scene-cursor')
  const shape = cursor.locator('span')
  const measure = async (deltaX: number, deltaY: number) =>
    page.evaluate(
      ({ dx, dy }) => {
        const target = document.querySelector('main')
        const point = document.querySelector<HTMLElement>('.scene-cursor > span')
        if (!target || !point) throw new Error('Cursor elements are missing')
        window.dispatchEvent(new Event('blur'))
        for (const [x, y, time] of [
          [400, 400, 1000],
          [400 + dx, 400 + dy, 1016],
        ] as const) {
          const event = new PointerEvent('pointermove', {
            bubbles: true,
            pointerType: 'mouse',
            clientX: x,
            clientY: y,
          })
          Object.defineProperty(event, 'timeStamp', { value: time })
          target.dispatchEvent(event)
        }
        const rect = point.getBoundingClientRect()
        const strain = new DOMMatrixReadOnly(point.style.transform)
        return {
          width: rect.width,
          height: rect.height,
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          stretchX: strain.a,
          stretchY: strain.d,
        }
      },
      { dx: deltaX, dy: deltaY },
    )
  // Each direction starts after the previous deformation has visibly settled.
  /* eslint-disable no-await-in-loop */
  for (const [dx, dy] of [
    [80, 0],
    [-80, 0],
    [0, 80],
    [0, -80],
  ] as const) {
    const rect = await measure(dx, dy)
    expect(rect.x).toBeCloseTo(400 + dx, 2)
    expect(rect.y).toBeCloseTo(400 + dy, 2)
    expect(dx ? rect.stretchX : rect.stretchY).toBeGreaterThan(2)
    expect(Math.max(rect.stretchX, rect.stretchY)).toBeLessThanOrEqual(2.8)
    await expect(shape).toHaveCSS('transform', 'none')
  }
  /* eslint-enable no-await-in-loop */
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const still = await measure(80, 0)
  expect(still.width).toBeCloseTo(6, 2)
  expect(still.height).toBeCloseTo(6, 2)
  await page.getByRole('link', { name: /GitHub/ }).hover()
  await expect(cursor).toBeVisible()
  await expect(cursor).toHaveAttribute('data-interactive', 'true')
  await expect(page.getByRole('link', { name: /GitHub/ })).toHaveCSS('cursor', 'none')
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

test('equal pointer speeds produce equal strain at different event rates', async ({ page }) => {
  await page.goto('/?seed=42')
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  const strains = await page.evaluate(() => {
    const target = document.querySelector('main')
    const shape = document.querySelector<HTMLElement>('.scene-cursor > span')
    if (!target || !shape) throw new Error('Cursor elements are missing')
    const sample = (interval: number) => {
      window.dispatchEvent(new Event('blur'))
      for (const [x, time] of [
        [400, 1000],
        [400 + interval * 0.2, 1000 + interval],
      ] as const) {
        const event = new PointerEvent('pointermove', {
          bubbles: true,
          pointerType: 'mouse',
          clientX: x,
          clientY: 400,
        })
        Object.defineProperty(event, 'timeStamp', { value: time })
        target.dispatchEvent(event)
      }
      return new DOMMatrixReadOnly(shape.style.transform).a
    }
    return [sample(16), sample(8), sample(4), sample(2)]
  })
  const baseline = strains[0]
  if (baseline === undefined) throw new Error('No cursor strain samples were recorded')
  expect(baseline).toBeGreaterThan(1.5)
  for (const strain of strains) expect(strain).toBeCloseTo(baseline, 4)
})
