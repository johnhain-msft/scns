import { test, expect } from '@playwright/test'
import { mockBrokerApi } from '../helpers/mock-api'

test.describe('Metrics time-range flow', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
    await page.goto('/metrics')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Metrics')
  })

  test('displays metrics summary cards', async ({ page }) => {
    await expect(page.locator('div').filter({ hasText: /^Total Spans$/ }).first()).toBeVisible()
    await expect(page.locator('div').filter({ hasText: /^Total Tokens$/ }).first()).toBeVisible()
    await expect(page.locator('div').filter({ hasText: /^Avg Duration$/ }).first()).toBeVisible()
    await expect(page.locator('div').filter({ hasText: /^Error Rate$/ }).first()).toBeVisible()
  })

  test('time range buttons are present and toggle', async ({ page }) => {
    const timeRangeGroup = page.getByRole('group', { name: /Time range/i })
    await expect(timeRangeGroup).toBeVisible()

    const btn1h = timeRangeGroup.getByRole('button', { name: '1h' })
    await expect(btn1h).toHaveAttribute('aria-pressed', 'true')

    const btn24h = timeRangeGroup.getByRole('button', { name: '24h' })
    await btn24h.click()
    await expect(btn24h).toHaveAttribute('aria-pressed', 'true')
    await expect(btn1h).toHaveAttribute('aria-pressed', 'false')
  })

  test('switching time range refetches and still shows data', async ({ page }) => {
    await expect(page.locator('div').filter({ hasText: /^150$/ }).first()).toBeVisible()

    const timeRangeGroup = page.getByRole('group', { name: /Time range/i })
    await timeRangeGroup.getByRole('button', { name: '7d' }).click()

    await expect(page.locator('div').filter({ hasText: /^150$/ }).first()).toBeVisible()
  })

  test('top tools section is displayed', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Top Tools' })).toBeVisible()
    await expect(page.getByText('bash').first()).toBeVisible()
  })

  test('model distribution section is displayed', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Model Distribution' })).toBeVisible()
    await expect(page.getByText('claude-sonnet-4-20250514').first()).toBeVisible()
  })
})
