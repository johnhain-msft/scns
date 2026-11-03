import { test, expect } from '@playwright/test'
import { mockBrokerApi } from '../helpers/mock-api'

test.describe('Memory search flow', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
    await page.goto('/memory')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Memory')
  })

  test('displays vault stats', async ({ page }) => {
    await expect(page.getByText('Vault Stats')).toBeVisible()
    await expect(page.getByText('100')).toBeVisible()
  })

  test('search returns results', async ({ page }) => {
    const searchInput = page.getByLabel(/Search Memories/i)
    await searchInput.fill('auth')
    await page.getByRole('button', { name: /Search/i }).click()

    await expect(page.getByText('src/auth.ts')).toBeVisible()
    await expect(page.getByText('Auth module implementation')).toBeVisible()
    await expect(page.getByText(/Score: 0.95/)).toBeVisible()
  })

  test('search via Enter key works', async ({ page }) => {
    const searchInput = page.getByLabel(/Search Memories/i)
    await searchInput.fill('auth')
    await searchInput.press('Enter')

    await expect(page.getByText('src/auth.ts')).toBeVisible()
  })
})

test.describe('Observers toggle flow', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
    await page.goto('/observers')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Observers')
  })

  test('displays observer cards', async ({ page }) => {
    await expect(page.getByText('claude-hooks').or(page.getByText('Session Hooks'))).toBeVisible()
  })

  test('toggle switches are visible on observers', async ({ page }) => {
    await expect(page.getByRole('switch').first()).toBeVisible()
    const switches = page.getByRole('switch')
    const count = await switches.count()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test('toggling observer switch updates state on refetch', async ({ page }) => {
    await expect(page.getByRole('switch').first()).toBeVisible()
    const firstSwitch = page.getByRole('switch').first()
    await expect(firstSwitch).toHaveAttribute('aria-checked', 'true')
    await firstSwitch.click()
    await expect(firstSwitch).toHaveAttribute('aria-checked', 'false')
  })

  test('toggling disabled observer enables it', async ({ page }) => {
    await expect(page.getByRole('switch').first()).toBeVisible()
    const secondSwitch = page.getByRole('switch').nth(1)
    await expect(secondSwitch).toHaveAttribute('aria-checked', 'false')
    await secondSwitch.click()
    await expect(secondSwitch).toHaveAttribute('aria-checked', 'true')
  })
})
