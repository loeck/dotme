import type { Page } from '@playwright/test'

import { parisWeatherFixture } from '../src/weather/paris.fixture'

export async function mockParisWeather(page: Page) {
  await page.route('https://api.open-meteo.com/**', (route) =>
    route.fulfill({ json: parisWeatherFixture() }),
  )
}
