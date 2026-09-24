import { expect, test } from '@playwright/test'

import { mockParisWeather } from './weather-fixture'

test.beforeEach(async ({ page }) => {
  await mockParisWeather(page)
  await page.route('**/assets/VoxelLandscapeEngine-*.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `export class VoxelLandscapeEngine {
        static async create(options) {
          options.onFirstFrame?.();
          return { dispose() {}, resize() {} };
        }
      }`,
    }),
  )
})

test('outlined point stays on controls and grows above the dialog', async ({ page }, info) => {
  await page.goto('/')
  await expect(page.locator('.scene-loader')).toBeHidden()
  const main = page.locator('main')
  const desktop = info.project.name === 'chromium'
  if (desktop) await expect(main).toHaveCSS('cursor', /data:image\/svg\+xml.*4 4, none/)
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

test('point works during loading without an engine and falls back on blur', async ({
  page,
}, info) => {
  await page.route('**/assets/VoxelLandscapeEngine-*.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: 'export class VoxelLandscapeEngine { static create() { return new Promise(() => {}); } }',
    }),
  )
  await page.goto('/')
  const loader = page.locator('.scene-loader')
  await expect(loader).toBeVisible()
  if (info.project.name === 'chromium')
    await expect(loader).toHaveCSS('cursor', /data:image\/svg\+xml.*4 4, none/)
  const cursor = page.locator('.scene-cursor')
  await page.mouse.move(200, 200)
  if (info.project.name === 'chromium') {
    await expect(cursor).toBeVisible()
    await expect(cursor).toHaveCSS('width', '6px')
    await expect(loader).toHaveCSS('cursor', 'none')
  } else await expect(cursor).toBeHidden()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  if (info.project.name === 'chromium')
    await expect(loader).toHaveCSS('cursor', /data:image\/svg\+xml.*4 4, none/)
})

test('strain follows movement without shifting the hit point and settles at rest', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'chromium', 'Mouse-only deformation')
  await page.goto('/')
  await expect(page.locator('.scene-loader')).toBeHidden()
  const cursor = page.locator('.scene-cursor')
  const shape = cursor.locator('span')
  const measure = async (deltaX: number, deltaY: number) =>
    page.evaluate(
      async ({ dx, dy }) => {
        const target = document.querySelector('main')!
        target.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerType: 'mouse',
            clientX: 400,
            clientY: 400,
          }),
        )
        await new Promise((resolve) => setTimeout(resolve, 16))
        target.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerType: 'mouse',
            clientX: 400 + dx,
            clientY: 400 + dy,
          }),
        )
        await new Promise((resolve) => setTimeout(resolve, 32))
        const rect = document.querySelector('.scene-cursor > span')!.getBoundingClientRect()
        return {
          width: rect.width,
          height: rect.height,
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        }
      },
      { dx: deltaX, dy: deltaY },
    )
  // A single pointer must settle before testing its next direction.
  /* eslint-disable no-await-in-loop */
  for (const [dx, dy] of [
    [80, 0],
    [-80, 0],
    [0, 80],
    [0, -80],
  ]) {
    const rect = await measure(dx!, dy!)
    expect(rect.x).toBeCloseTo(400 + dx!, 2)
    expect(rect.y).toBeCloseTo(400 + dy!, 2)
    expect(dx ? rect.width : rect.height).toBeGreaterThan(12)
    expect(Math.max(rect.width, rect.height)).toBeLessThanOrEqual(16.81)
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

test('the custom point is available before JavaScript starts, without a pointer move', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'chromium', 'Mouse-only cursor')
  await page.route('**/assets/index-*.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  )
  await page.goto('/')
  await expect(page.locator('.scene-loader')).toBeVisible()
  await expect(page.locator('html')).not.toHaveAttribute('data-cursor-active')
  const cursor = await page
    .locator('.scene-loader')
    .evaluate((element) => getComputedStyle(element).cursor)
  expect(cursor).toMatch(/^url\("data:image\/svg\+xml/)
  expect(cursor).toMatch(/4 4, none$/)
  expect(cursor).not.toContain('auto')
})

test('equal pointer speeds produce equal strain at different event rates', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'chromium', 'Mouse-only deformation')
  await page.goto('/')
  await expect(page.locator('.scene-loader')).toBeHidden()
  const strains = await page.evaluate(() => {
    const target = document.querySelector('main')!
    const shape = document.querySelector<HTMLElement>('.scene-cursor > span')!
    const sample = (interval: number) => {
      window.dispatchEvent(new Event('blur'))
      for (const [x, time] of [
        [400, 1000],
        [400 + interval * 0.2, 1000 + interval],
      ]) {
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
  expect(strains[0]).toBeGreaterThan(1.5)
  for (const strain of strains) expect(strain).toBeCloseTo(strains[0]!, 4)
})
