import { expect, test } from '@playwright/test'

test('lake visual and frame timing sample', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (
      message.type() === 'error' ||
      /GL_INVALID|GL_INVALID_FRAMEBUFFER|Shader Error/.test(message.text())
    )
      errors.push(message.text())
  })
  await page.goto('/?seed=9182')
  const canvas = page.locator('canvas')
  await expect(canvas).toBeVisible()
  await expect(canvas.locator('..')).toHaveCSS('opacity', '1', { timeout: 60_000 })
  await testInfo.attach('motion', {
    body: JSON.stringify(
      await page.evaluate(() => ({
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        mode: document.querySelector('canvas')?.dataset.waterMode,
      })),
    ),
    contentType: 'application/json',
  })
  await page.waitForTimeout(2500)
  const intervals = await page.evaluate(async () => {
    return new Promise<number[]>((resolve) => {
      const frames: number[] = []
      let previous = performance.now()
      const sample = (now: number) => {
        frames.push(now - previous)
        previous = now
        if (frames.length === 31) resolve(frames.slice(1).toSorted((a, b) => a - b))
        else requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
  })
  await testInfo.attach('frame-timing', {
    body: JSON.stringify({ medianMs: intervals[15], p95Ms: intervals[28] }),
    contentType: 'application/json',
  })
  await page.screenshot({ path: testInfo.outputPath('rest.png') })
  const size = page.viewportSize()!
  await page.mouse.move(size.width * 0.65, size.height * 0.88)
  await page.mouse.down()
  await page.mouse.move(size.width * 0.4, size.height * 0.82, { steps: 24 })
  await page.waitForTimeout(400)
  await page.mouse.up()
  await page.waitForTimeout(100)
  await page.screenshot({ path: testInfo.outputPath('wake.png') })
  expect(errors).toEqual([])
})

for (const seed of [0, 12]) {
  test(`seed ${seed} renders without WebGL errors`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.goto(`/?seed=${seed}`)
    await expect(page.locator('canvas').locator('..')).toHaveCSS('opacity', '1', {
      timeout: 30_000,
    })
    await page.waitForTimeout(2300)
    await page.screenshot({ path: testInfo.outputPath(`seed-${seed}.png`) })
    expect(errors).toEqual([])
  })
}
