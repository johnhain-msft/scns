import { test, expect } from '@playwright/test'
import { mockBrokerApi } from '../helpers/mock-api'

test.describe('Suggestions flow', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
    await page.goto('/suggestions')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Suggestions')
  })

  test('shows pending tab by default with suggestions', async ({ page }) => {
    const pendingTab = page.getByRole('tab', { name: 'pending' })
    await expect(pendingTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('Refactor auth')).toBeVisible()
    await expect(page.getByText('Add caching')).toBeVisible()
  })

  test('switch tabs shows correct content', async ({ page }) => {
    // Click approved tab
    const approvedTab = page.getByRole('tab', { name: 'approved' })
    await approvedTab.click()
    await expect(approvedTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('Upgrade deps')).toBeVisible()

    // Click rejected tab
    const rejectedTab = page.getByRole('tab', { name: 'rejected' })
    await rejectedTab.click()
    await expect(rejectedTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('Remove logging')).toBeVisible()

    // Click implemented tab (empty)
    const implementedTab = page.getByRole('tab', { name: 'implemented' })
    await implementedTab.click()
    await expect(implementedTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('No implemented suggestions')).toBeVisible()
  })

  test('approve and reject buttons visible only on pending tab', async ({ page }) => {
    // Pending tab: approve/reject buttons should be present
    await expect(page.getByRole('button', { name: /Approve Refactor auth/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Reject Refactor auth/i })).toBeVisible()

    // Switch to approved tab: no approve/reject buttons
    await page.getByRole('tab', { name: 'approved' }).click()
    await expect(page.getByText('Upgrade deps')).toBeVisible()
    await expect(page.getByRole('button', { name: /Approve/i })).not.toBeVisible()
  })

  test('approving a suggestion removes it from pending list', async ({ page }) => {
    // Verify both pending suggestions visible
    await expect(page.getByText('Refactor auth')).toBeVisible()
    await expect(page.getByText('Add caching')).toBeVisible()

    // Approve the first one
    await page.getByRole('button', { name: /Approve Refactor auth/i }).click()

    // After approval + refetch, "Refactor auth" should disappear from pending
    await expect(page.getByText('Refactor auth')).not.toBeVisible()
    // "Add caching" should still be visible
    await expect(page.getByText('Add caching')).toBeVisible()

    // Switch to approved tab — "Refactor auth" should appear there now
    await page.getByRole('tab', { name: 'approved' }).click()
    await expect(page.getByText('Refactor auth')).toBeVisible()
  })

  test('rejecting a suggestion removes it from pending list', async ({ page }) => {
    await expect(page.getByText('Refactor auth')).toBeVisible()
    await page.getByRole('button', { name: /Reject Refactor auth/i }).click()

    // Should disappear from pending
    await expect(page.getByText('Refactor auth')).not.toBeVisible()

    // Should appear on rejected tab
    await page.getByRole('tab', { name: 'rejected' }).click()
    await expect(page.getByText('Refactor auth')).toBeVisible()
  })

  test('type filter works', async ({ page }) => {
    const filter = page.getByRole('combobox', { name: /Filter by type/i })
    await expect(filter).toBeVisible()
    await filter.selectOption('skill')
    // "Refactor auth" is type "skill", should still show
    await expect(page.getByText('Refactor auth')).toBeVisible()
  })
})
