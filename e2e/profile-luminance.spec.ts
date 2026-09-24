import { expect, test } from '@playwright/test'

import { mockSceneWeather } from './weather-fixture'

test('GPU text and information button retain DOM keyboard interaction', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mockSceneWeather(page, 'clear')
  await page.goto('/?seed=42&startTime=12:00')
  await expect(page.locator('.scene-loader')).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('main')).toHaveAttribute('data-ui-mask', 'gpu')
  await expect(page.locator('#profile-title')).toHaveCSS('color', 'rgba(0, 0, 0, 0)')
  const trigger = page.getByRole('button', { name: 'About this landscape' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await info.attach('per-pixel-contrast', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
})
