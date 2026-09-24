import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'The custom cursor is mouse-only')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // Keep the UI tests independent of landscape generation and live weather.
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

test('custom cursor covers controls, modal content and backdrop, and follows scene contrast', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/?weather=clear')
  await expect(page.locator('.scene-loader')).toBeHidden()
  const cursor = page.locator('.scene-cursor')
  const trigger = page.getByRole('button', { name: 'About this landscape' })
  await page.evaluate(() => {
    document.querySelector('main')!.dataset.sceneTone = 'light'
  })
  await expect(trigger).toHaveCSS('cursor', /dark-cursor\.svg.*none/)
  await trigger.hover()
  await expect(trigger).toHaveCSS('cursor', 'none')
  await expect(trigger.locator('svg')).toHaveCSS('cursor', 'none')
  await expect(cursor).toHaveAttribute('data-interactive', 'true')
  await expect(cursor).toHaveCSS('filter', 'brightness(0.2) saturate(0.6)')
  await expect(cursor).toBeVisible()

  await trigger.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(cursor).toHaveCSS('filter', 'none')
  const link = dialog.getByRole('link', { name: 'Three.js' })
  await link.hover()
  await expect(link).toHaveCSS('cursor', 'none')
  await expect(cursor).toBeVisible()
  expect(await cursor.evaluate((element) => element.matches(':popover-open'))).toBe(true)
  const bounds = await cursor.boundingBox()
  const linkBounds = await link.boundingBox()
  expect(bounds!.x + bounds!.width / 2).toBeCloseTo(linkBounds!.x + linkBounds!.width / 2, 0)
  expect(bounds!.y + bounds!.height / 2).toBeCloseTo(linkBounds!.y + linkBounds!.height / 2, 0)
  await info.attach('modal-cursor', { body: await page.screenshot(), contentType: 'image/png' })
  await page.mouse.move(20, 20)
  expect(await dialog.evaluate((element) => getComputedStyle(element, '::backdrop').cursor)).toBe(
    'none',
  )
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
  await expect(cursor).toHaveCSS('filter', 'brightness(0.2) saturate(0.6)')
  await page.evaluate(() => {
    document.querySelector('main')!.dataset.sceneTone = 'dark'
  })
  await expect(cursor).toHaveCSS('filter', 'none')
  await trigger.click()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(errors).toEqual([])
})

test('loader and inactive pointer retain a custom cursor', async ({ page }) => {
  await page.goto('/?loader=loop')
  const loader = page.locator('.scene-loader')
  await expect(loader).toBeVisible()
  await expect(loader).toHaveCSS('cursor', /light-cursor\.svg.*none/)
  await page.mouse.move(200, 200)
  await expect(loader).toHaveCSS('cursor', 'none')
  await expect(page.locator('.scene-cursor')).toBeVisible()
  await expect(page.locator('.scene-cursor')).toHaveCSS('filter', 'none')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(loader).toHaveCSS('cursor', /light-cursor\.svg.*none/)
})
