import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mockBrokerApi } from '../e2e/helpers/mock-api'

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

type AxeViolation = Awaited<ReturnType<InstanceType<typeof AxeBuilder>['analyze']>>['violations'][number]

function formatViolations(violations: AxeViolation[]) {
  return violations.map((v) => {
    const nodes = v.nodes.map((n) => `    - ${n.target.join(' > ')}: ${n.failureSummary}`).join('\n')
    return `  [${v.impact}] ${v.id}: ${v.description}\n    Help: ${v.helpUrl}\n${nodes}`
  }).join('\n\n')
}

// ─── WCAG 2.1 AA full axe-core scan ────────────────────────

test.describe('WCAG 2.1 AA compliance', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  for (const { path, name } of ALL_PAGES) {
    test(`${name} (${path}) passes WCAG 2.1 AA`, async ({ page }) => {
      await page.goto(path)
      await page.waitForLoadState('networkidle')

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()

      const violations = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      )

      if (violations.length > 0) {
        const report = formatViolations(violations)
        expect(violations, `WCAG 2.1 AA violations on ${name}:\n${report}`).toHaveLength(0)
      }
    })
  }
})

// ─── Semantic HTML structure ────────────────────────────────

test.describe('Semantic HTML', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  for (const { path, name } of ALL_PAGES) {
    test(`${name} has exactly one visible h1`, async ({ page }) => {
      await page.goto(path)
      await page.waitForLoadState('networkidle')

      const h1Elements = page.getByRole('heading', { level: 1 })
      const count = await h1Elements.count()
      expect(count, `${name} should have exactly one h1, found ${count}`).toBe(1)
    })
  }

  test('all form inputs have accessible names', async ({ page }) => {
    // Test pages with form controls: memory, otel-settings, suggestions
    const pagesWithForms = ['/memory', '/settings/otel', '/suggestions']

    for (const path of pagesWithForms) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')

      const inputs = page.locator('input, select, textarea')
      const count = await inputs.count()

      for (let i = 0; i < count; i++) {
        const input = inputs.nth(i)
        const isVisible = await input.isVisible()
        if (!isVisible) continue

        const ariaLabel = await input.getAttribute('aria-label')
        const ariaLabelledBy = await input.getAttribute('aria-labelledby')
        const id = await input.getAttribute('id')
        const title = await input.getAttribute('title')

        // Check if it has an accessible name via label, aria-label, or aria-labelledby
        let hasLabel = !!(ariaLabel || ariaLabelledBy || title)
        if (!hasLabel && id) {
          const associatedLabel = page.locator(`label[for="${id}"]`)
          hasLabel = (await associatedLabel.count()) > 0
        }

        expect(
          hasLabel,
          `Input at index ${i} on ${path} has no accessible name`,
        ).toBe(true)
      }
    }
  })

  test('switch controls have accessible names', async ({ page }) => {
    const pagesWithSwitches = ['/scheduler', '/observers', '/settings/otel']

    for (const path of pagesWithSwitches) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')

      const switches = page.getByRole('switch')
      const count = await switches.count()

      for (let i = 0; i < count; i++) {
        const sw = switches.nth(i)
        const ariaLabel = await sw.getAttribute('aria-label')
        const ariaLabelledBy = await sw.getAttribute('aria-labelledby')
        const id = await sw.getAttribute('id')

        let hasLabel = !!(ariaLabel || ariaLabelledBy)
        if (!hasLabel && id) {
          hasLabel = (await page.locator(`label[for="${id}"]`).count()) > 0
        }

        expect(
          hasLabel,
          `Switch at index ${i} on ${path} has no accessible name`,
        ).toBe(true)
      }
    }
  })
})

// ─── Color contrast (full scan) ─────────────────────────────

test.describe('Color contrast', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  for (const { path, name } of ALL_PAGES) {
    test(`${name} has no critical contrast violations`, async ({ page }) => {
      await page.goto(path)
      await page.waitForLoadState('networkidle')

      const results = await new AxeBuilder({ page })
        .withRules(['color-contrast'])
        .analyze()

      const critical = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      )

      if (critical.length > 0) {
        const report = formatViolations(critical)
        expect(
          critical,
          `Color contrast violations on ${name}:\n${report}`,
        ).toHaveLength(0)
      }
    })
  }
})

// ─── Document-level a11y ────────────────────────────────────

test.describe('Document-level accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  test('html element has lang attribute', async ({ page }) => {
    await page.goto('/')
    const lang = await page.locator('html').getAttribute('lang')
    expect(lang).toBeTruthy()
  })

  test('page has a title', async ({ page }) => {
    await page.goto('/')
    const title = await page.title()
    expect(title).toBeTruthy()
  })

  test('skip-to-content link targets main content', async ({ page }) => {
    await page.goto('/')

    const skipLink = page.getByRole('link', { name: /Skip to content/i })
    const href = await skipLink.getAttribute('href')
    expect(href).toBe('#main-content')

    const mainContent = page.locator('#main-content')
    await expect(mainContent).toBeVisible()
  })
})
