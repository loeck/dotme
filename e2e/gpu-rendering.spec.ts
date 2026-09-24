import { expect, test } from '@playwright/test'

import { mockSceneWeather } from './weather-fixture'

test('renders a visible production scene with a procedural waterfall using WebGPU', async ({
  page,
}) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text())
  })
  await mockSceneWeather(page, 'clear')
  await page.goto('/?seed=1&startTime=12:00', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready', {
    timeout: 20_000,
  })
  await expect(page.locator('#scene-canvas')).toHaveAttribute('data-backend', 'webgpu')
  await expect(page.locator('#scene-canvas')).toHaveAttribute('data-water-mode', 'gpu')
  const width = await page.locator('#scene-canvas').getAttribute('width')
  await page.setViewportSize({ width: 1200, height: 760 })
  await expect(page.locator('#scene-canvas')).not.toHaveAttribute('width', width ?? '')
  await page.mouse.move(680, 540)
  await page.mouse.down()
  await page.mouse.move(760, 590, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('canvas')).toHaveCount(1)
  const screenshot = await page.screenshot()
  const skyLuminance = await page.evaluate(async (encoded) => {
    const image = new Image()
    image.src = `data:image/png;base64,${encoded}`
    await image.decode()
    const sample = document.createElement('canvas')
    sample.width = image.width
    sample.height = image.height
    const context = sample.getContext('2d')
    if (!context) throw new Error('Cannot inspect rendered screenshot')
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(
      Math.floor(image.width * 0.55),
      Math.floor(image.height * 0.1),
      32,
      32,
    ).data
    let total = 0
    for (let i = 0; i < pixels.length; i += 4)
      total +=
        (pixels[i] ?? 0) * 0.2126 + (pixels[i + 1] ?? 0) * 0.7152 + (pixels[i + 2] ?? 0) * 0.0722
    return total / (pixels.length / 4)
  }, screenshot.toString('base64'))
  // A successful submission with NaN sky values or a stale loader is not a ready landscape.
  expect(skyLuminance).toBeGreaterThan(40)
  expect(failures.filter((message) => !message.includes('net::ERR_FAILED'))).toEqual([])
})

declare global {
  interface Window {
    loseSceneGpu?: () => void
  }
}

test('a lost WebGPU device leaves the profile usable on the same canvas', async ({ page }) => {
  await page.addInitScript(() => {
    const gpu = navigator.gpu
    if (!gpu) return
    const requestAdapter = gpu.requestAdapter.bind(gpu)
    gpu.requestAdapter = async (options) => {
      const adapter = await requestAdapter(options)
      if (adapter) {
        const requestDevice = adapter.requestDevice.bind(adapter)
        adapter.requestDevice = async (descriptor) => {
          const device = await requestDevice(descriptor)
          window.loseSceneGpu = () => device.destroy()
          return device
        }
      }
      return adapter
    }
  })
  await mockSceneWeather(page, 'clear')
  await page.goto('/?seed=42&startTime=12:00', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  const canvas = page.locator('#scene-canvas')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu')
  await canvas.evaluate((element) => {
    element.dataset.originalCanvas = 'true'
  })
  await page.evaluate(() => {
    if (!window.loseSceneGpu) throw new Error('No real WebGPU device was created')
    window.loseSceneGpu()
  })
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'failed')
  await expect(canvas).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await expect(canvas).toHaveAttribute('data-original-canvas', 'true')
  await expect(page.locator('canvas')).toHaveCount(1)
})

test('renders active rain on WebGPU without shader or validation errors', async ({
  page,
}, info) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text())
  })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await mockSceneWeather(page, 'overcast', 1)
  await page.goto('/?seed=42&startTime=00:00', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  await expect(page.locator('#scene-canvas')).toHaveAttribute('data-backend', 'webgpu')
  await expect(page.locator('#landscape')).toHaveAttribute('data-rain-intensity', '1')
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  await info.attach('active-rain', { body: await page.screenshot(), contentType: 'image/png' })
  expect(failures).toEqual([])
})
