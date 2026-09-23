import { expect, test } from '@playwright/test'

test('renders the profile and interactive scene', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || /WebGL/.test(message.text()))
      consoleErrors.push(message.text())
  })

  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await expect(page.getByRole('link', { name: /GitHub/ })).toHaveAttribute(
    'href',
    'https://github.com/loeck',
  )
  const canvas = page.locator('canvas')
  await expect(canvas).toBeVisible()
  // Canvas creation precedes shader compilation and the first reflected frame.
  await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
  const bounds = await canvas.boundingBox()
  if (!bounds) throw new Error('Missing landscape bounds')
  await page.mouse.move(bounds.width * 0.4, bounds.height * 0.78)
  await page.mouse.down()
  await page.mouse.move(bounds.width * 0.6, bounds.height * 0.82, { steps: 8 })
  await page.mouse.up()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(page.getByRole('button')).toHaveCount(0)
  expect(consoleErrors).toEqual([])
})

test('renders and resizes the lit scene with reduced motion', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || /WebGL/.test(message.text())) errors.push(message.text())
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?seed=42')
  const canvas = page.locator('canvas')
  await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
  const previousWidth = await canvas.getAttribute('width')
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: viewport.width - 40, height: viewport.height - 40 })
  await expect(canvas).not.toHaveAttribute('width', previousWidth!)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  expect(errors).toEqual([])
})

test('keeps the profile available with JavaScript disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(8, 10, 13)')
  await expect(page.locator('canvas')).toHaveCount(0)
  await context.close()
})
