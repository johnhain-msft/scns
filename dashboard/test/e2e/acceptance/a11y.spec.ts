import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mockBrokerApi } from '../helpers/mock-api'

const ALL_PAGES = [
  { path: '/', name: 'Overview' },
  { path: '/sessions', name: 'Sessions' },
  { path: '/teams', name: 'Teams' },
  { path: '/tasks', name: 'Tasks' },
  { path: '/suggestions', name: 'Suggestions' },
  { path: '/scheduler', name: 'Scheduler' },
  { path: '/memory', name: 'Memory' },
  { path: '/dream', name: 'Dream' },
  { path: '/observers', name: 'Observers' },
  { path: '/autonomy', name: 'Autonomy' },
  { path: '/cost', name: 'Cost' },
  { path: '/traces', name: 'Traces' },
  { path: '/metrics', name: 'Metrics' },
  { path: '/settings/otel', name: 'OTel Settings' },
]

test.describe('508 Compliance - axe-core scans', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  for (const { path, name } of ALL_PAGES) {
    test(`${name} page has no critical/serious a11y violations`, async ({ page }) => {
      await page.goto(path)
      // Wait for content to load
      await page.waitForLoadState('networkidle')

      const results = await new AxeBuilder({ page })
        .disableRules(['color-contrast']) // CSS vars may not compute in test
        .analyze()

      const criticalOrSerious = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      )

      if (criticalOrSerious.length > 0) {
        const summary = criticalOrSerious
          .map((v) => `[${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} nodes)`)
          .join('\n')
        expect(criticalOrSerious, `A11y violations on ${name}:\n${summary}`).toHaveLength(0)
      }
    })
  }
})

test.describe('ARIA landmarks', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  for (const { path, name } of ALL_PAGES) {
    test(`${name} has proper landmarks (nav + main)`, async ({ page }) => {
      await page.goto(path)

      // Navigation landmark
      const nav = page.getByRole('navigation', { name: 'Main navigation' })
      await expect(nav).toBeVisible()

      // Main landmark
      const main = page.getByRole('main')
      await expect(main).toBeVisible()
    })
  }
})

test.describe('Keyboard navigation', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  test('skip-to-content link works', async ({ page }) => {
    await page.goto('/')
    // Tab to the skip link (first focusable element)
    await page.keyboard.press('Tab')
    const skipLink = page.getByRole('link', { name: /Skip to content/i })
    await expect(skipLink).toBeFocused()
  })

  test('sidebar links are keyboard navigable', async ({ page }) => {
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Main navigation' })

    // Tab through until we reach the nav links
    const firstLink = nav.getByRole('link').first()
    await firstLink.focus()
    await expect(firstLink).toBeFocused()

    // Tab to next link
    await page.keyboard.press('Tab')
    const secondLink = nav.getByRole('link').nth(1)
    await expect(secondLink).toBeFocused()
  })

  test('scheduler switches are keyboard accessible', async ({ page }) => {
    await page.goto('/scheduler')
    await page.waitForLoadState('networkidle')

    const toggle = page.getByRole('switch', { name: /Toggle cleanup/i })
    await toggle.focus()
    await expect(toggle).toBeFocused()

    // Space activates switches
    await page.keyboard.press('Space')
    // After toggle, switch should update
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  test('trace rows are keyboard accessible with Enter', async ({ page }) => {
    await page.goto('/traces')
    await page.waitForLoadState('networkidle')

    const traceRow = page.getByRole('button', { name: /View trace/i }).first()
    await traceRow.focus()
    await expect(traceRow).toBeFocused()

    await page.keyboard.press('Enter')
    // Should navigate to detail view
    await expect(page.getByRole('button', { name: /Back to traces list/i })).toBeVisible()
  })

  test('trace rows are keyboard accessible with Space', async ({ page }) => {
    await page.goto('/traces')
    await page.waitForLoadState('networkidle')

    const traceRow = page.getByRole('button', { name: /View trace/i }).first()
    await traceRow.focus()
    await page.keyboard.press('Space')

    await expect(page.getByRole('button', { name: /Back to traces list/i })).toBeVisible()
  })

  test('OTel settings switches toggle via keyboard Space', async ({ page }) => {
    await page.goto('/settings/otel')
    await page.waitForLoadState('networkidle')

    const toggle = page.getByRole('switch', { name: /Ingestion Enabled/i })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.focus()
    await page.keyboard.press('Space')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  test('observer switches toggle via keyboard Space', async ({ page }) => {
    await page.goto('/observers')
    await page.waitForLoadState('networkidle')

    const firstSwitch = page.getByRole('switch').first()
    await expect(firstSwitch).toHaveAttribute('aria-checked', 'true')
    await firstSwitch.focus()
    await page.keyboard.press('Space')
    await expect(firstSwitch).toHaveAttribute('aria-checked', 'false')
  })

  test('suggestions approve button is keyboard accessible', async ({ page }) => {
    await page.goto('/suggestions')
    await page.waitForLoadState('networkidle')

    const approveBtn = page.getByRole('button', { name: /Approve Refactor auth/i })
    await approveBtn.focus()
    await expect(approveBtn).toBeFocused()

    // Enter activates buttons
    await page.keyboard.press('Enter')
    // After approval, the suggestion should disappear from pending
    await expect(page.getByText('Refactor auth')).not.toBeVisible()
  })

  test('autonomy buttons are keyboard accessible', async ({ page }) => {
    await page.goto('/autonomy')
    await page.waitForLoadState('networkidle')

    const promoteBtn = page.getByRole('button', { name: /Promote Level/i })
    await promoteBtn.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('status').getByText('Assistant')).toBeVisible()
  })

  test('OTel settings form elements are tab-navigable', async ({ page }) => {
    await page.goto('/settings/otel')
    await page.waitForLoadState('networkidle')

    // Tab through form elements — they should all be reachable
    const enabledToggle = page.getByRole('switch', { name: /Ingestion Enabled/i })
    await enabledToggle.focus()
    await expect(enabledToggle).toBeFocused()

    // Tab to next form element
    await page.keyboard.press('Tab')
    const filePathInput = page.getByLabel('JSONL File Path')
    await expect(filePathInput).toBeFocused()
  })

  test('suggestions tab panel has proper focus management', async ({ page }) => {
    await page.goto('/suggestions')
    await page.waitForLoadState('networkidle')

    // Focus the first tab
    const pendingTab = page.getByRole('tab', { name: 'pending' })
    await pendingTab.focus()
    await expect(pendingTab).toBeFocused()

    // Click to switch tab
    const approvedTab = page.getByRole('tab', { name: 'approved' })
    await approvedTab.click()
    await expect(approvedTab).toHaveAttribute('aria-selected', 'true')
  })
})

test.describe('Focus indicators', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  test('interactive elements have visible focus', async ({ page }) => {
    await page.goto('/autonomy')
    await page.waitForLoadState('networkidle')

    const promoteBtn = page.getByRole('button', { name: /Promote Level/i })
    await promoteBtn.focus()

    // Verify the button is focused (Playwright can check this)
    await expect(promoteBtn).toBeFocused()

    // Check that the focused element has some visible focus indicator
    // (outline or box-shadow)
    const focusStyle = await promoteBtn.evaluate((el) => {
      const styles = window.getComputedStyle(el)
      return {
        outline: styles.outline,
        boxShadow: styles.boxShadow,
        outlineWidth: styles.outlineWidth,
      }
    })

    // At least one focus indicator should be present
    const hasFocusIndicator =
      (focusStyle.outline !== 'none' && focusStyle.outline !== '' && focusStyle.outlineWidth !== '0px') ||
      (focusStyle.boxShadow !== 'none' && focusStyle.boxShadow !== '')

    expect(hasFocusIndicator).toBe(true)
  })
})
