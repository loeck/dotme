import type { Page } from '@playwright/test'

import { parisWeatherFixture } from '../src/weather/paris.fixture'

export async function mockParisWeather(
  page: Page,
  current: Partial<ReturnType<typeof parisWeatherFixture>['current']> = {},
  daily: Partial<ReturnType<typeof parisWeatherFixture>['daily']> = {},
) {
  const data = parisWeatherFixture()
  Object.assign(data.current, current)
  Object.assign(data.daily, daily)
  await page.route('https://api.open-meteo.com/**', (route) => route.fulfill({ json: data }))
}

export async function mockSceneWeather(page: Page, weather: string, rainIntensity = 0) {
  const cloud_cover = { clear: 0, 'partly-cloudy': 40, cloudy: 70, overcast: 95 }[weather] ?? 40
  await mockParisWeather(page, {
    cloud_cover,
    weather_code: cloud_cover >= 85 ? 3 : cloud_cover ? 2 : 0,
    rain: rainIntensity * 2,
  })
}
