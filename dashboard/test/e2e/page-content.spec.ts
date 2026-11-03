import { test, expect, type Page, type Route } from '@playwright/test'
import { mockBrokerApi } from './helpers/mock-api'

const BROKER = 'http://localhost:3456'

/**
 * Override specific broker routes with error responses.
 * Must be called AFTER mockBrokerApi to take precedence.
 */
async function mockErrorRoute(page: Page, pathPattern: string) {
  await page.route(`${BROKER}${pathPattern}*`, async (route: Route) => {
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Internal server error' }),
    })
  })
}

// ─── Page headings and sections ─────────────────────────────

test.describe('Page content - headings and sections', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  test('Overview displays stat cards', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const main = page.getByRole('main')
    await expect(main.getByText('System Health')).toBeVisible()
    await expect(main.getByText('Teams & Tasks')).toBeVisible()
    await expect(main.getByText('Dream')).toBeVisible()
  })

  test('Sessions page renders session table', async ({ page }) => {
    await page.goto('/sessions')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sessions')
    await expect(page.locator('th:has-text("ID")')).toBeVisible()
    await expect(page.locator('th:has-text("Status")')).toBeVisible()
    await expect(page.getByText('sess-1').first()).toBeVisible()
  })

  test('Cost page displays token breakdown', async ({ page }) => {
    await page.goto('/cost')
    await page.waitForLoadState('networkidle')

    const main = page.getByRole('main')
    await expect(main.getByText('Total Cost')).toBeVisible()
    await expect(main.getByText('Input Tokens').first()).toBeVisible()
    await expect(main.getByText('Output Tokens').first()).toBeVisible()
  })

  test('Scheduler page shows task table columns', async ({ page }) => {
    await page.goto('/scheduler')
    await page.waitForLoadState('networkidle')

    await expect(page.locator('th:has-text("Name")')).toBeVisible()
    await expect(page.locator('th:has-text("Category")')).toBeVisible()
    await expect(page.locator('th:has-text("Schedule")')).toBeVisible()
    await expect(page.locator('th:has-text("Actions")')).toBeVisible()
  })
})

// ─── Loading states ─────────────────────────────────────────

test.describe('Loading states', () => {
  test('Sessions shows loading indicator', async ({ page }) => {
    // Delay the API response to catch the loading state
    await page.route(`${BROKER}/api/sessions`, async (route) => {
      await new Promise((r) => setTimeout(r, 1000))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions: [] }),
      })
    })
    // Mock other routes normally
    await mockBrokerApi(page)

    await page.goto('/sessions')
    await expect(page.getByText('Loading…')).toBeVisible()
  })

  test('Dream shows loading text', async ({ page }) => {
    await page.route(`${BROKER}/api/dream/status`, async (route) => {
      await new Promise((r) => setTimeout(r, 1000))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ running: false }),
      })
    })
    await mockBrokerApi(page)

    await page.goto('/dream')
    await expect(page.getByText('Loading dream status…')).toBeVisible()
  })

  test('Autonomy shows loading text', async ({ page }) => {
    await page.route(`${BROKER}/api/autonomy`, async (route) => {
      await new Promise((r) => setTimeout(r, 1000))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ level: 1 }),
      })
    })
    await mockBrokerApi(page)

    await page.goto('/autonomy')
    await expect(page.getByText('Loading autonomy status…')).toBeVisible()
  })

  test('Scheduler shows loading text', async ({ page }) => {
    await page.route(`${BROKER}/api/scheduler/tasks`, async (route) => {
      await new Promise((r) => setTimeout(r, 1000))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: [] }),
      })
    })
    await mockBrokerApi(page)

    await page.goto('/scheduler')
    await expect(page.getByText('Loading...')).toBeVisible()
  })
})

// ─── Error states (only pages with error UI) ────────────────

test.describe('Error states', () => {
  test('Dream shows error when API fails', async ({ page }) => {
    await mockBrokerApi(page)
    await mockErrorRoute(page, '/api/dream/status')

    await page.goto('/dream')
    // React Query will retry once, then show error
    await expect(page.getByText('Dream daemon is not available')).toBeVisible({ timeout: 15000 })
  })

  test('Observers shows error when API fails', async ({ page }) => {
    await mockBrokerApi(page)
    await mockErrorRoute(page, '/api/observers')

    await page.goto('/observers')
    await expect(page.getByText('Observer system is not available')).toBeVisible({ timeout: 15000 })
  })

  test('Suggestions shows error when API fails', async ({ page }) => {
    await mockBrokerApi(page)
    await mockErrorRoute(page, '/api/suggestions')

    await page.goto('/suggestions')
    await expect(page.getByText('Suggestion system is not available')).toBeVisible({ timeout: 15000 })
  })

  test('Memory shows error when stats API fails', async ({ page }) => {
    await mockBrokerApi(page)
    await mockErrorRoute(page, '/api/memory/stats')

    await page.goto('/memory')
    await expect(page.getByText('Memory system is not available')).toBeVisible({ timeout: 15000 })
  })

  test('Overview shows alert when APIs fail', async ({ page }) => {
    await mockBrokerApi(page)
    await mockErrorRoute(page, '/api/health')

    await page.goto('/')
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Failed to load dashboard data')).toBeVisible()
  })
})

// ─── Empty states ───────────────────────────────────────────

test.describe('Empty states', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  test('Sessions shows empty message when no sessions', async ({ page }) => {
    await page.route(`${BROKER}/api/sessions`, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions: [] }),
      })
    })

    await page.goto('/sessions')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('No sessions found')).toBeVisible()
  })

  test('Teams shows empty message when no teams', async ({ page }) => {
    await page.route(`${BROKER}/api/teams`, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ teams: [] }),
      })
    })

    await page.goto('/teams')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('No teams found')).toBeVisible()
  })

  test('Tasks shows empty message when no tasks', async ({ page }) => {
    await page.route(`${BROKER}/api/teams`, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ teams: [] }),
      })
    })

    await page.goto('/tasks')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('No tasks found')).toBeVisible()
  })

  test('Traces shows empty message when no traces', async ({ page }) => {
    await page.route(`${BROKER}/api/otel/traces*`, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ traces: [] }),
      })
    })

    await page.goto('/traces')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('No traces found')).toBeVisible()
  })

  test('Suggestions shows empty message per tab', async ({ page }) => {
    await page.route(`${BROKER}/api/suggestions*`, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ suggestions: [] }),
      })
    })

    await page.goto('/suggestions')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('No pending suggestions')).toBeVisible()
  })

  test('Metrics shows empty message when no data', async ({ page }) => {
    await page.route(`${BROKER}/api/otel/metrics/summary*`, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total_spans: 0,
          total_metrics: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          avg_duration_ms: 0,
          top_tools: [],
          model_distribution: [],
          error_count: 0,
        }),
      })
    })

    await page.goto('/metrics')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('No data available')).toBeVisible()
  })
})
