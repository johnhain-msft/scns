import { test, expect } from '@playwright/test'
import { mockBrokerApi } from './helpers/mock-api'

const PAGES: Array<{ path: string; heading: string | RegExp }> = [
  { path: '/', heading: 'Overview' },
  { path: '/sessions', heading: 'Sessions' },
  { path: '/teams', heading: 'Teams' },
  { path: '/tasks', heading: 'Tasks' },
  { path: '/suggestions', heading: 'Suggestions' },
  { path: '/scheduler', heading: 'Scheduler' },
  { path: '/memory', heading: 'Memory' },
  { path: '/dream', heading: 'Dream' },
  { path: '/observers', heading: 'Observers' },
  { path: '/autonomy', heading: 'Autonomy' },
  { path: '/cost', heading: 'Cost' },
  { path: '/traces', heading: 'Traces' },
  { path: '/metrics', heading: 'Metrics' },
  { path: '/settings/otel', heading: 'OpenTelemetry Settings' },
]

test.describe('Page loads', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  for (const { path, heading } of PAGES) {
    test(`${path} loads with heading "${heading}"`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (err) => errors.push(err.message))

      await page.goto(path)

      const h1 = page.getByRole('heading', { level: 1 })
      await expect(h1).toContainText(heading)

      expect(errors).toEqual([])
    })
  }

  test('no unhandled JavaScript errors across all pages', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    for (const { path } of PAGES) {
      await page.goto(path)
      // Wait for initial render
      await page.waitForLoadState('networkidle')
    }

    expect(errors).toEqual([])
  })

  test('main landmark exists on every page', async ({ page }) => {
    for (const { path } of PAGES) {
      await page.goto(path)
      const main = page.getByRole('main')
      await expect(main).toBeVisible()
    }
  })
})
