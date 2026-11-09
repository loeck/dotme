import { expect, test } from '@playwright/test'

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
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      'content',
      'summary_large_image',
    )
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      'https://loeck.me/og-image.jpg',
    )
    const person: unknown = JSON.parse(
      (await page.locator('script[type="application/ld+json"]').textContent()) ?? '',
    )
    expect(person).toMatchObject({ '@type': 'Person', name: 'Loëck Vézien' })
    // Without JavaScript nothing will ever finish loading.
    await expect(page.locator('main')).not.toHaveAttribute('aria-busy')
    await expect(page.locator('canvas')).toHaveCount(1)
    await expect(page.locator('#scene-canvas')).not.toHaveAttribute('data-loader-rendered')
  } finally {
    await context.close()
  }
})

test('serves the site files, icons and social image', async ({ request }) => {
  for (const [path, type] of [
    ['/og-image.jpg', 'image/jpeg'],
    ['/favicon.svg', 'image/svg+xml'],
    ['/favicon.ico', 'image/'],
    ['/apple-touch-icon.png', 'image/png'],
    ['/site.webmanifest', ''],
    ['/robots.txt', 'text/plain'],
    ['/sitemap.xml', 'xml'],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- a handful of sequential static requests
    const response = await request.get(path)
    expect(response.status(), path).toBe(200)
    expect(response.headers()['content-type'] ?? '', path).toContain(type)
  }
  expect(await (await request.get('/robots.txt')).text()).toContain(
    'Sitemap: https://loeck.me/sitemap.xml',
  )
})

test('loads under the production security headers without CSP violations', async ({ page }) => {
  const violations: string[] = []
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && /content.security.policy|CSP/i.test(message.text()))
      violations.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.exposeFunction('reportViolation', (violation: string) => violations.push(violation))
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report: unknown = Reflect.get(window, 'reportViolation')
      if (typeof report === 'function')
        Reflect.apply(report, window, [`${event.violatedDirective} ${event.blockedURI}`])
    })
  })
  const response = await page.goto('/?seed=42')
  const headers = response?.headers() ?? {}
  expect(headers['content-security-policy']).toContain("default-src 'self'")
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['cross-origin-opener-policy']).toBe('same-origin')
  // Readiness needs a graphics backend; the static profile is a valid end state elsewhere.
  await expect(page.locator('html')).toHaveAttribute('data-scene-loading', /ready|failed/, {
    timeout: 30_000,
  })
  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await expect(page.locator('main')).not.toHaveAttribute('aria-busy')
  expect(violations).toEqual([])
  expect(errors).toEqual([])
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
