import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { mockSceneWeather } from './weather-fixture'

async function requireSceneOrStaticMobileProfile(page: Page) {
  const supported = await page.evaluate(async () => {
    if (!navigator.gpu) return false
    return Boolean(await navigator.gpu.requestAdapter().catch(() => null))
  })
  if (test.info().project.name === 'mobile' && !supported) {
    await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'failed')
    await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
    await expect(page.locator('#scene-canvas')).toBeHidden()
    const github = page.getByRole('link', { name: /GitHub/ })
    await github.focus()
    await expect(github).toBeFocused()
    return false
  }
  expect(supported, 'Rendering journeys require a WebGPU adapter').toBe(true)
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  await expect(page.locator('#scene-canvas')).toHaveAttribute('data-backend', 'webgpu')
  return true
}

test('daylight scene supports interaction, resizing, credits and navigation restoration', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await mockSceneWeather(page, 'clear')
  await page.goto('/?seed=42&startTime=12:00')
  if (!(await requireSceneOrStaticMobileProfile(page))) {
    expect(errors).toEqual([])
    return
  }
  const canvas = page.locator('#landscape canvas')
  await expect(canvas).toHaveCount(1)
  await expect(canvas).toHaveAttribute('data-scene-rendered', 'true')
  const bounds = await canvas.boundingBox()
  if (!bounds) throw new Error('Missing scene bounds')
  await page.mouse.move(bounds.width * 0.45, bounds.height * 0.8)
  await page.mouse.down()
  await page.mouse.move(bounds.width * 0.6, bounds.height * 0.75, { steps: 5 })
  await page.mouse.up()
  const trigger = page.getByRole('button', { name: 'About this landscape' })
  await trigger.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Open-Meteo', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  const width = await canvas.getAttribute('width')
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('Missing viewport')
  await page.setViewportSize({ width: viewport.width - 20, height: viewport.height - 20 })
  await expect(canvas).not.toHaveAttribute('width', width ?? '')
  await page.goto('/missing-page')
  await expect(page.getByRole('heading', { name: 'Nothing here.' })).toBeVisible()
  await page.goBack()
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  await expect(canvas).toHaveCount(1)
  expect(errors).toEqual([])
})

test('night and rain render with reduced motion and retain an accessible profile', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mockSceneWeather(page, 'overcast', 1)
  await page.goto('/?seed=42&startTime=00:00')
  if (!(await requireSceneOrStaticMobileProfile(page))) {
    expect(errors).toEqual([])
    return
  }
  await expect(page.locator('canvas[data-scene-rendered="true"]')).toHaveCount(1)
  await expect(page.locator('#landscape')).toHaveAttribute('data-rain-intensity', '1')
  const profile = page.getByRole('link', { name: /GitHub/ })
  await profile.focus()
  await expect(profile).toBeFocused()
  expect(errors).toEqual([])
})
