import { expect, test } from '@playwright/test'

import { deferred } from './deferred'
import { mockParisWeather } from './weather-fixture'

test.beforeEach(async ({ page }) => {
  await mockParisWeather(page)
})

test('keeps profile links and SEO available without JavaScript', async ({
  browser,
  request,
}, info) => {
  const response = await request.get('/')
  const html = await response.text()
  expect(response.status()).toBe(200)
  expect(html).toContain('Hi, I’m Loëck.')
  expect(html).not.toMatch(/react|tanstack|nitro/i)
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: info.project.use.viewport ?? null,
  })
  try {
    const page = await context.newPage()
    await page.goto('/')
    await expect(page).toHaveTitle('Loëck | Building some stuff in Paris')
    await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(8, 10, 13)')
    await expect(page.getByRole('link', { name: /GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/loeck',
    )
    await expect(page.getByRole('link', { name: /LinkedIn/ })).toHaveAttribute(
      'href',
      'https://linkedin.com/in/lo%C3%ABck-v%C3%A9zien-19a0a550',
    )
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://loeck.me/')
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      'Loëck builds some stuff in Paris.',
    )
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      'content',
      'https://loeck.me/',
    )
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      'Loëck | Building some stuff in Paris',
    )
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary')
    await expect(page.locator('canvas')).toHaveCount(1)
    await expect(page.locator('#scene-canvas')).not.toHaveAttribute('data-loader-rendered')
  } finally {
    await context.close()
  }
})

test('unknown paths return the static 404 with a home link', async ({ page }) => {
  const response = await page.goto('/missing/nested-page?test=1')
  expect(response?.status()).toBe(404)
  await expect(page).toHaveTitle('404 | Loëck')
  await expect(page.getByRole('heading', { name: 'Nothing here.' })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex')
  await expect(page.locator('script')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Return home' })).toHaveAttribute('href', '/')
})

test('unavailable graphics leave keyboard profile access and do not request the landscape', async ({
  page,
}) => {
  const errors: string[] = []
  const landscapeRequests: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (/\/landscape-.*\.js/.test(request.url())) landscapeRequests.push(request.url())
  })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true })
    HTMLCanvasElement.prototype.getContext = () => null
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'failed')
  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await expect(page.locator('#scene-canvas')).toBeHidden()
  const github = page.getByRole('link', { name: /GitHub/ })
  await github.focus()
  await expect(github).toBeFocused()
  expect(landscapeRequests).toEqual([])
  expect(errors).toEqual([])
})

test('page lifecycle restores one scene on the same canvas and seed', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?seed=42&startTime=00:00')
  const canvas = page.locator('#scene-canvas')
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  await canvas.evaluate((element) => element.setAttribute('data-original-canvas', 'true'))
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
  )
  await expect(canvas).toHaveCount(1)
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  })
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  await expect(canvas).toHaveCount(1)
  await expect(canvas).toHaveAttribute('data-original-canvas', 'true')
  await expect(canvas).toHaveAttribute('data-seed', '42')
})

test('cancels a pending landscape import and can restore after it resolves', async ({ page }) => {
  const barrier = deferred()
  await page.route('**/assets/landscape-*.js', async (route) => {
    await barrier.promise
    await route.continue()
  })
  const requested = page.waitForRequest('**/assets/landscape-*.js')
  await page.goto('/?seed=42', { waitUntil: 'domcontentloaded' })
  await requested
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
  )
  barrier.resolve()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('#scene-canvas')).not.toHaveAttribute('data-scene-rendered', 'true')
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  )
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', 'ready')
  await expect(page.locator('canvas')).toHaveCount(1)
})
