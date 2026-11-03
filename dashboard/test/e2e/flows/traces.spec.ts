import { test, expect } from '@playwright/test'
import { mockBrokerApi } from '../helpers/mock-api'

test.describe('Traces flow', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
    await page.goto('/traces')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Traces')
  })

  test('displays trace list in a table', async ({ page }) => {
    await expect(page.getByText('invoke_agent')).toBeVisible()
    await expect(page.getByText('memory.search')).toBeVisible()
    // Table headers
    await expect(page.getByText('Root Span')).toBeVisible()
    await expect(page.getByText('Duration')).toBeVisible()
  })

  test('clicking a trace row navigates to detail view', async ({ page }) => {
    const traceRow = page.getByRole('button', { name: /View trace trace-ab/i })
    await expect(traceRow).toBeVisible()
    await traceRow.click()

    // Detail view should show
    await expect(page.getByRole('button', { name: /Back to traces list/i })).toBeVisible()
    // Trace ID should be in heading
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Trace')
    // Span tree should show the root span
    await expect(page.getByText('invoke_agent')).toBeVisible()
  })

  test('trace row can be activated with keyboard Enter', async ({ page }) => {
    const traceRow = page.getByRole('button', { name: /View trace trace-ab/i })
    await traceRow.focus()
    await page.keyboard.press('Enter')

    // Should navigate to detail view
    await expect(page.getByRole('button', { name: /Back to traces list/i })).toBeVisible()
  })

  test('trace row can be activated with keyboard Space', async ({ page }) => {
    const traceRow = page.getByRole('button', { name: /View trace trace-ab/i })
    await traceRow.focus()
    await page.keyboard.press('Space')

    await expect(page.getByRole('button', { name: /Back to traces list/i })).toBeVisible()
  })

  test('back button returns to trace list', async ({ page }) => {
    // Navigate to detail
    await page.getByRole('button', { name: /View trace trace-ab/i }).click()
    await expect(page.getByRole('button', { name: /Back to traces list/i })).toBeVisible()

    // Click back
    await page.getByRole('button', { name: /Back to traces list/i }).click()

    // Should be back at list
    await expect(page.getByText('invoke_agent')).toBeVisible()
    await expect(page.getByText('memory.search')).toBeVisible()
  })

  test('detail view shows span tree with child spans', async ({ page }) => {
    await page.getByRole('button', { name: /View trace trace-ab/i }).click()

    // Root span
    await expect(page.getByText('invoke_agent')).toBeVisible()
    // Child span is collapsed by default — expand it
    const expandBtn = page.getByRole('button', { name: /Expand invoke_agent/i })
    await expandBtn.click()
    await expect(page.getByText('tool_call')).toBeVisible()
  })
})
