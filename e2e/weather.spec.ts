import { expect, test } from '@playwright/test'

import { required } from '../src/invariant'
import { parisWeatherFixture } from '../src/weather/paris.fixture'
import { deferred } from './deferred'
import { mockParisWeather } from './weather-fixture'

test('preloads Paris weather and keeps credits inside the information dialog', async ({ page }) => {
  const data = parisWeatherFixture()
  Object.assign(data.current, {
    weather_code: 63,
    cloud_cover: 70,
    rain: 1.1,
    wind_speed_10m: 5,
    wind_direction_10m: 90,
  })
  const { promise: pending, resolve: release } = deferred()
  await page.route('https://api.open-meteo.com/**', async (route) => {
    await pending
    await route.fulfill({ json: data })
  })
  await page.goto('/?seed=42', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.scene-loader')).toBeVisible()
  await expect(page.locator('.profile-panel').first()).toBeHidden()
  release()
  await expect(page.locator('.scene-loader')).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('#landscape')).toHaveAttribute('data-weather-source', 'live')
  await expect(page.locator('canvas[data-water-mode]')).toHaveAttribute('data-weather', 'cloudy')
  await expect(page.locator('#landscape')).toHaveAttribute('data-rain-intensity', '0.55')
  await expect(page.getByRole('link', { name: 'Open-Meteo', exact: true })).toBeHidden()
  const trigger = page.getByRole('button', { name: 'About this landscape' })
  await trigger.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Open-Meteo', exact: true })).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Three.js', exact: true })).toBeVisible()
  await test
    .info()
    .attach('about-landscape', { body: await page.screenshot(), contentType: 'image/png' })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toBeHidden()
})

test('times out and retains random weather after a late API reply', async ({ page }) => {
  const { promise: pending, resolve: release } = deferred()
  await page.route('https://api.open-meteo.com/**', async (route) => {
    await pending
    // The browser may already have cancelled this request after the deadline.
    await route.fulfill({ json: parisWeatherFixture() }).catch(() => {})
  })
  await page.goto('/?seed=42', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.scene-loader')).toBeHidden({ timeout: 30_000 })
  const scene = page.locator('#landscape')
  await expect(scene).toHaveAttribute('data-weather-source', 'random')
  const selected = await scene.getAttribute('data-weather')
  release()
  await expect(scene).toHaveAttribute('data-weather-source', 'random')
  await expect(scene).toHaveAttribute('data-weather', required(selected))
  await page.getByRole('button', { name: 'About this landscape' }).click()
  await expect(page.locator('[data-weather-credit]')).toBeHidden()
})

test('HTTP errors fall back and unsupported URL controls cannot override live weather', async ({
  page,
}) => {
  let requests = 0
  await page.route('https://api.open-meteo.com/**', (route) => {
    requests++
    return route.fulfill({ status: 503, body: 'Unavailable' })
  })
  await page.goto('/?seed=42')
  await expect(page.locator('#landscape')).toHaveAttribute('data-weather-source', 'random')
  expect(requests).toBe(1)
  await page.goto('/?seed=42&weather=clear&rain=off')
  await expect(page.locator('.scene-loader')).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('#landscape')).toHaveAttribute('data-weather-source', 'random')
  expect(new URL(page.url()).searchParams.has('weather')).toBe(false)
  expect(new URL(page.url()).searchParams.has('rain')).toBe(false)
  expect(requests).toBe(2)
})

test('GPS selects the weather location while time independently selects night', async ({
  page,
}) => {
  const requests: URL[] = []
  await page.route('https://api.open-meteo.com/**', (route) => {
    requests.push(new URL(route.request().url()))
    return route.fulfill({
      json: { ...parisWeatherFixture(), timezone: 'Asia/Singapore', utc_offset_seconds: 28800 },
    })
  })
  await page.goto('/?seed=42&coordinates=1.3521,103.8198&startTime=23:00')
  await expect(page.locator('#landscape')).toHaveAttribute('data-weather-source', 'live')
  await expect(page.locator('.scene-loader')).toBeHidden({ timeout: 30_000 })
  expect(requests).toHaveLength(1)
  const weatherRequest = required(requests[0])
  expect(weatherRequest.searchParams.get('latitude')).toBe('1.3521')
  expect(weatherRequest.searchParams.get('longitude')).toBe('103.8198')
  await expect(page.locator('main')).toHaveAttribute('data-local-lights', 'true')
})

test('keeps daylight at 18:26 when the live sunset is later', async ({ page }) => {
  await mockParisWeather(
    page,
    {
      time: Date.UTC(2026, 8, 25, 16, 26) / 1000,
      weather_code: 0,
      cloud_cover: 0,
      is_day: 1,
    },
    {
      time: [Date.UTC(2026, 8, 24, 22, 0) / 1000],
      sunrise: [Date.UTC(2026, 8, 25, 4, 42) / 1000],
      sunset: [Date.UTC(2026, 8, 25, 17, 44) / 1000],
    },
  )
  await page.goto('/?seed=42')
  await expect(page.locator('#landscape')).toHaveAttribute('data-weather-source', 'live')
  await expect(page.locator('.scene-loader')).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('main')).toHaveAttribute('data-local-lights', 'false')
})
