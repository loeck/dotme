import { expect, test } from '@playwright/test'

// Keep a playable sequence: still captures alone cannot validate moving water.
test.use({ video: 'on' })

test('water motion at rest, slow hover, fast drag and release', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/?seed=9182')
  await expect(page.locator('canvas').locator('..')).toHaveCSS('opacity', '1', { timeout: 30_000 })
  await page.waitForTimeout(2600)
  await page.screenshot({ path: testInfo.outputPath('wind-0.png') })
  await page.waitForTimeout(650)
  await page.screenshot({ path: testInfo.outputPath('wind-1.png') })
  const { width, height } = page.viewportSize()!
  // These samples must be sequential to represent real time and real pointer speed.
  for (let i = 0; i <= 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    await page.mouse.move(width * (0.52 + i * 0.009), height * (0.79 + Math.sin(i * 0.12) * 0.025))
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(80)
  }
  await page.screenshot({ path: testInfo.outputPath('hover.png') })
  await page.mouse.down()
  await page.mouse.move(width * 0.44, height * 0.85, { steps: 18 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  await page.screenshot({ path: testInfo.outputPath('wake.png') })
  await page.waitForTimeout(1800)
  await page.screenshot({ path: testInfo.outputPath('spread.png') })
  await page.mouse.move(0, 0)
  await page.waitForTimeout(1500)
  expect(errors).toEqual([])
})
