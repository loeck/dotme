import { expect, test } from '@playwright/test'

test('renders the profile and interactive scene', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await expect(page.getByRole('link', { name: /GitHub/ })).toHaveAttribute(
    'href',
    'https://github.com/loeck',
  )
  await expect(page.locator('canvas')).toBeVisible()

  const pause = page.getByRole('button', { name: 'Pause animation' })
  await pause.click()
  await expect(page.getByRole('button', { name: 'Resume animation' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(consoleErrors).toEqual([])
})

test('keeps the profile available with JavaScript disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Hi, I’m Loëck.' })).toBeVisible()
  await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(8, 10, 13)')
  await expect(page.locator('canvas')).toHaveCount(0)
  await context.close()
})
