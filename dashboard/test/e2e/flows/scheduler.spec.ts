import { test, expect } from '@playwright/test'
import { mockBrokerApi } from '../helpers/mock-api'

test.describe('Scheduler flow', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
    await page.goto('/scheduler')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Scheduler')
  })

  test('displays task table with tasks', async ({ page }) => {
    await expect(page.getByText('cleanup')).toBeVisible()
    await expect(page.getByText('dream-check')).toBeVisible()
  })

  test('toggle task enabled/disabled via switch', async ({ page }) => {
    const toggleSwitch = page.getByRole('switch', { name: /Toggle cleanup/i })
    await expect(toggleSwitch).toBeVisible()
    await expect(toggleSwitch).toHaveAttribute('aria-checked', 'true')

    await toggleSwitch.click()

    // After clicking, the page refetches. The mock updates state so the
    // switch reflects the new value on refetch.
    await expect(toggleSwitch).toHaveAttribute('aria-checked', 'false')
  })

  test('toggling disabled task enables it', async ({ page }) => {
    // dream-check starts disabled
    const toggleSwitch = page.getByRole('switch', { name: /Toggle dream-check/i })
    await expect(toggleSwitch).toHaveAttribute('aria-checked', 'false')

    await toggleSwitch.click()

    await expect(toggleSwitch).toHaveAttribute('aria-checked', 'true')
  })

  test('toggle state persists after page re-navigation', async ({ page }) => {
    // Disable cleanup
    const toggleSwitch = page.getByRole('switch', { name: /Toggle cleanup/i })
    await toggleSwitch.click()
    await expect(toggleSwitch).toHaveAttribute('aria-checked', 'false')

    // Navigate away and back
    await page.getByRole('link', { name: 'Overview' }).click()
    await expect(page).toHaveURL('/')
    await page.getByRole('link', { name: 'Scheduler' }).click()
    await expect(page).toHaveURL('/scheduler')

    // State should be persisted
    const refreshedSwitch = page.getByRole('switch', { name: /Toggle cleanup/i })
    await expect(refreshedSwitch).toHaveAttribute('aria-checked', 'false')
  })

  test('Run Now button triggers task', async ({ page }) => {
    const runNowButton = page.getByRole('button', { name: /Run Now cleanup/i })
    await expect(runNowButton).toBeVisible()
    await runNowButton.click()
    // After trigger, page refetches — task still visible
    await expect(page.getByText('cleanup')).toBeVisible()
  })

  test('Show/Hide History expands and collapses', async ({ page }) => {
    const historyBtn = page.getByRole('button', { name: /Show history for cleanup/i })
    await expect(historyBtn).toBeVisible()
    await expect(historyBtn).toHaveAttribute('aria-expanded', 'false')

    await historyBtn.click()
    await expect(historyBtn).toHaveAttribute('aria-expanded', 'true')
    // History table should be visible with "Run ID" header
    await expect(page.getByText('Run ID')).toBeVisible()

    await historyBtn.click()
    await expect(historyBtn).toHaveAttribute('aria-expanded', 'false')
  })

  test('switch activates via keyboard Space', async ({ page }) => {
    const toggleSwitch = page.getByRole('switch', { name: /Toggle cleanup/i })
    await toggleSwitch.focus()
    await page.keyboard.press('Space')
    await expect(toggleSwitch).toHaveAttribute('aria-checked', 'false')
  })
})
