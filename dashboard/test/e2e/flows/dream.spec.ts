import { test, expect } from '@playwright/test'
import { mockBrokerApi } from '../helpers/mock-api'

test.describe('Dream flow', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
    await page.goto('/dream')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Dream')
  })

  test('displays dream status', async ({ page }) => {
    await expect(page.getByText('Memories Consolidated')).toBeVisible()
    await expect(page.getByText('150')).toBeVisible()
    await expect(page.getByText('42')).toBeVisible()
  })

  test('displays gate status', async ({ page }) => {
    await expect(page.getByText('idle-check')).toBeVisible()
    await expect(page.getByText('Pass')).toBeVisible()
    await expect(page.getByText('memory-threshold')).toBeVisible()
    await expect(page.getByText('Fail')).toBeVisible()
  })

  test('force run opens confirm dialog and can be cancelled', async ({ page }) => {
    await page.getByRole('button', { name: /Force Run/i }).click()

    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByText('Confirm Force Run')).toBeVisible()
    await expect(page.getByText(/bypassing gate checks/i)).toBeVisible()

    await page.getByRole('button', { name: /Cancel/i }).click()
    await expect(dialog).not.toBeVisible()
  })

  test('force run confirm triggers the mutation', async ({ page }) => {
    await page.getByRole('button', { name: /Force Run/i }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()

    await page.getByRole('button', { name: /Confirm/i }).click()
    await expect(page.getByRole('alertdialog')).not.toBeVisible()
  })
})
