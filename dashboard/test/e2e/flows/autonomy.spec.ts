import { test, expect } from '@playwright/test'
import { mockBrokerApi } from '../helpers/mock-api'

test.describe('Autonomy flow', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
    await page.goto('/autonomy')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Autonomy')
  })

  test('displays current autonomy level', async ({ page }) => {
    const status = page.getByRole('status')
    await expect(status.getByText('Advisor')).toBeVisible()
    await expect(status.getByText('L1')).toBeVisible()
  })

  test('promote button increases level', async ({ page }) => {
    const promoteBtn = page.getByRole('button', { name: /Promote Level/i })
    await expect(promoteBtn).toBeVisible()
    await promoteBtn.click()

    await expect(page.getByRole('status').getByText('Assistant')).toBeVisible()
  })

  test('demote button decreases level', async ({ page }) => {
    const demoteBtn = page.getByRole('button', { name: /Demote Level/i })
    await expect(demoteBtn).toBeVisible()
    await demoteBtn.click()

    await expect(page.getByRole('status').getByText('Observer')).toBeVisible()
  })

  test('promote then demote returns to original level', async ({ page }) => {
    await page.getByRole('button', { name: /Promote Level/i }).click()
    await expect(page.getByRole('status').getByText('Assistant')).toBeVisible()

    await page.getByRole('button', { name: /Demote Level/i }).click()
    await expect(page.getByRole('status').getByText('Advisor')).toBeVisible()
  })

  test('level indicator cards are displayed', async ({ page }) => {
    await expect(page.getByText('L0')).toBeVisible()
    await expect(page.getByText('L2')).toBeVisible()
    await expect(page.getByText('L3')).toBeVisible()
  })
})
