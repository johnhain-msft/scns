import { test, expect } from '@playwright/test'
import { mockBrokerApi } from '../helpers/mock-api'

test.describe('OTel Settings flow', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
    await page.goto('/settings/otel')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('OpenTelemetry Settings')
  })

  test('displays current configuration', async ({ page }) => {
    // Status indicator
    await expect(page.getByText('Ingestion Disabled')).toBeVisible()
    // Form elements present
    await expect(page.getByLabel('Ingestion Enabled')).toBeVisible()
    await expect(page.getByLabel('JSONL File Path')).toBeVisible()
    await expect(page.getByLabel('Retention Days')).toBeVisible()
    await expect(page.getByLabel('Content Capture')).toBeVisible()
  })

  test('toggle ingestion enabled switch', async ({ page }) => {
    const toggle = page.getByRole('switch', { name: /Ingestion Enabled/i })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  test('change retention days and file path', async ({ page }) => {
    const retentionInput = page.getByLabel('Retention Days')
    await retentionInput.fill('30')
    await expect(retentionInput).toHaveValue('30')

    const filePathInput = page.getByLabel('JSONL File Path')
    await filePathInput.fill('/var/log/otel/traces.jsonl')
    await expect(filePathInput).toHaveValue('/var/log/otel/traces.jsonl')
  })

  test('save button triggers mutation and shows success', async ({ page }) => {
    // Change a value
    const retentionInput = page.getByLabel('Retention Days')
    await retentionInput.fill('14')

    const saveButton = page.getByRole('button', { name: 'Save' })
    await expect(saveButton).toBeVisible()
    await saveButton.click()

    // Success message should appear
    await expect(page.getByText('Settings saved successfully')).toBeVisible()
  })

  test('saved config persists after refetch', async ({ page }) => {
    // Enable ingestion and set file path
    const toggle = page.getByRole('switch', { name: /Ingestion Enabled/i })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')

    const filePathInput = page.getByLabel('JSONL File Path')
    await filePathInput.fill('/opt/otel/data.jsonl')

    const retentionInput = page.getByLabel('Retention Days')
    await retentionInput.fill('30')

    // Save
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Settings saved successfully')).toBeVisible()

    // Navigate away and come back — config should be persisted in stateful mock
    await page.getByRole('link', { name: 'Overview' }).click()
    await expect(page).toHaveURL('/')
    await page.getByRole('link', { name: 'OTel Settings' }).click()
    await expect(page).toHaveURL('/settings/otel')

    // Values should reflect what was saved
    await expect(page.getByRole('switch', { name: /Ingestion Enabled/i })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByLabel('Retention Days')).toHaveValue('30')
    await expect(page.getByLabel('JSONL File Path')).toHaveValue('/opt/otel/data.jsonl')
  })

  test('content capture toggle shows privacy warning', async ({ page }) => {
    const toggle = page.getByRole('switch', { name: /Content Capture/i })
    await toggle.click()

    await expect(page.getByText(/Privacy Warning/i)).toBeVisible()
    await expect(page.getByText(/sensitive data/i)).toBeVisible()
  })

  test('info callout about restart is visible', async ({ page }) => {
    await expect(page.getByText(/Changes require restart/i)).toBeVisible()
  })
})
