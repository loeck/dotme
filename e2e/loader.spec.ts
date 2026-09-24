import { expect, test } from '@playwright/test'

import { mockParisWeather } from './weather-fixture'

test.beforeEach(async ({ page }) => {
  await mockParisWeather(page)
})

test('the full-screen voxel loader reveals the scene and profile together', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/assets/VoxelLandscapeEngine-*.js', async (route) => {
    // Delay creation rather than the network: WebKit screenshots wait for pending loads.
    await route.fulfill({
      contentType: 'application/javascript',
      body: `export class VoxelLandscapeEngine {
        static async create(...args) {
          document.documentElement.dataset.testSceneWaiting = 'true';
          await new Promise(resolve => addEventListener('test:release-scene', resolve, { once: true }));
          const real = await import(${JSON.stringify(`${route.request().url()}?real=1`)});
          return real.VoxelLandscapeEngine.create(...args);
        }
      }`,
    })
  })
  await page.goto('/?seed=42', { waitUntil: 'domcontentloaded' })
  const loader = page.locator('.scene-loader')
  await expect(loader).toBeVisible()
  await expect(loader).toHaveAttribute('data-rendered', 'true')
  await expect(page.locator('main')).toHaveAttribute('inert', '')
  await expect(page.locator('.profile-panel')).toBeHidden()
  const bounds = await loader.boundingBox()
  expect(bounds?.width).toBe(page.viewportSize()!.width)
  expect(bounds?.height).toBe(page.viewportSize()!.height)
  await test
    .info()
    .attach('voxel-loader', { body: await page.screenshot(), contentType: 'image/png' })
  await expect(page.locator('html')).toHaveAttribute('data-test-scene-waiting', 'true')
  await page.evaluate(() => window.dispatchEvent(new Event('test:release-scene')))
  await expect(loader).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('#landscape')).toHaveCSS('opacity', '1')
  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await expect(page.locator('main')).not.toHaveAttribute('inert')
  await expect
    .poll(() => page.workers().filter((worker) => worker.url().includes('voxel-loader')).length)
    .toBe(0)
  expect(errors).toEqual([])
})

test('reduced motion is still and failed scene creation releases the profile', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/assets/VoxelLandscapeEngine-*.js', async (route) => {
    await route.fulfill({
      contentType: 'application/javascript',
      body: `export class VoxelLandscapeEngine {
        static async create() {
          document.documentElement.dataset.testSceneWaiting = 'true';
          await new Promise(resolve => addEventListener('test:release-scene', resolve, { once: true }));
          throw new Error('Simulated graphics failure');
        }
      }`,
    })
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const loader = page.locator('.scene-loader')
  await expect(loader).toHaveAttribute('data-rendered', 'true')
  const first = await loader.screenshot()
  await page.waitForTimeout(200)
  expect((await loader.screenshot()).equals(first)).toBe(true)
  await expect(page.locator('html')).toHaveAttribute('data-test-scene-waiting', 'true')
  await page.evaluate(() => window.dispatchEvent(new Event('test:release-scene')))
  await expect(loader).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await page.getByRole('link', { name: /GitHub/ }).focus()
  await expect(page.getByRole('link', { name: /GitHub/ })).toBeFocused()
})

test('the loader falls back when offscreen canvas is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      value: undefined,
    })
  })
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/assets/VoxelLandscapeEngine-*.js', async (route) => {
    await pending
    await route.abort()
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.scene-loader')).toHaveAttribute('data-rendered', 'true')
  expect(page.workers().filter((worker) => worker.url().includes('voxel-loader'))).toHaveLength(0)
  release()
  await expect(page.locator('.scene-loader')).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
})

for (const fallback of [false, true]) {
  test(`the ${fallback ? 'main-thread' : 'worker'} loader pauses without focus`, async ({
    page,
  }) => {
    if (fallback)
      await page.addInitScript(() => {
        Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
          value: undefined,
        })
      })
    await page.goto('/?loader=loop')
    const loader = page.locator('.scene-loader')
    await expect(loader).toHaveAttribute('data-rendered', 'true')
    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false })
      window.dispatchEvent(new Event('blur'))
    })
    await expect(loader).toHaveAttribute('data-paused', 'true')
    await page.waitForTimeout(100)
    const still = await loader.screenshot()
    await page.waitForTimeout(200)
    expect((await loader.screenshot()).equals(still)).toBe(true)
    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
      window.dispatchEvent(new Event('focus'))
    })
    await expect(loader).toHaveAttribute('data-paused', 'false')
    await page.waitForTimeout(200)
    expect((await loader.screenshot()).equals(still)).toBe(false)
  })
}
