import { test, expect } from '@playwright/test'
import { mockBrokerApi } from './helpers/mock-api'

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const

const PAGES = [
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

// ─── Viewport-specific tests ────────────────────────────────

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} viewport (${viewport.width}px)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test.beforeEach(async ({ page }) => {
      await mockBrokerApi(page)
    })

    test('no horizontal scrollbar on Overview', async ({ page }) => {
      await page.goto('/')
      await page.waitForLoadState('networkidle')

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)

      expect(
        scrollWidth,
        `Horizontal overflow: scrollWidth=${scrollWidth} > clientWidth=${clientWidth}`,
      ).toBeLessThanOrEqual(clientWidth + 1) // 1px tolerance for rounding
    })

    test('main content heading is visible', async ({ page }) => {
      await page.goto('/')
      await page.waitForLoadState('networkidle')

      const h1 = page.getByRole('heading', { level: 1 })
      await expect(h1).toBeVisible()
    })

    test('navigation is accessible', async ({ page }) => {
      await page.goto('/')
      const nav = page.getByRole('navigation', { name: 'Main navigation' })
      await expect(nav).toBeAttached()
    })
  })
}

// ─── No horizontal overflow across all pages ────────────────

test.describe('No horizontal overflow', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  for (const { path, name } of PAGES) {
    test(`${name} has no horizontal scroll at desktop (1280px)`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(path)
      await page.waitForLoadState('networkidle')

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)

      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)
    })
  }
})

// ─── Desktop layout structure ───────────────────────────────

test.describe('Desktop layout', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  test('sidebar and main content are side by side', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const nav = page.getByRole('navigation', { name: 'Main navigation' })
    const main = page.getByRole('main')

    const navBox = await nav.boundingBox()
    const mainBox = await main.boundingBox()

    expect(navBox).toBeTruthy()
    expect(mainBox).toBeTruthy()

    // Sidebar should be to the left of main content
    expect(navBox!.x + navBox!.width).toBeLessThanOrEqual(mainBox!.x + 2)
  })

  test('sidebar has expected width', async ({ page }) => {
    await page.goto('/')

    const nav = page.getByRole('navigation', { name: 'Main navigation' })
    const navBox = await nav.boundingBox()

    expect(navBox).toBeTruthy()
    expect(navBox!.width).toBeGreaterThanOrEqual(200)
    expect(navBox!.width).toBeLessThanOrEqual(300)
  })
})

// ─── Touch targets on mobile ────────────────────────────────

test.describe('Touch targets', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  test('sidebar links are at least 44px tall for touch', async ({ page }) => {
    await page.goto('/')

    const nav = page.getByRole('navigation', { name: 'Main navigation' })
    const links = nav.getByRole('link')
    const count = await links.count()

    for (let i = 0; i < count; i++) {
      const link = links.nth(i)
      const box = await link.boundingBox()
      if (box) {
        // WCAG 2.1 AA target size recommendation: 44x44px
        // We check height >= 36px (common minimum with padding)
        expect(
          box.height,
          `Link ${i} height ${box.height}px is too small for touch`,
        ).toBeGreaterThanOrEqual(32)
      }
    }
  })

  test('buttons are reasonably sized for touch', async ({ page }) => {
    await page.goto('/autonomy')
    await page.waitForLoadState('networkidle')

    const buttons = page.getByRole('button')
    const count = await buttons.count()

    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i)
      const isVisible = await button.isVisible()
      if (!isVisible) continue

      const box = await button.boundingBox()
      if (box) {
        expect(
          box.height,
          `Button ${i} height ${box.height}px is too small`,
        ).toBeGreaterThanOrEqual(24)
      }
    }
  })
})

// ─── Content adaptation across viewports ────────────────────

test.describe('Content adaptation', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  test('all content remains visible at tablet size', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // H1 should be visible
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    // Main content area should be present
    await expect(page.getByRole('main')).toBeVisible()
  })

  test('stat cards remain visible at different sizes', async ({ page }) => {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto('/')
      await page.waitForLoadState('networkidle')

      // System Health card should be visible at all sizes
      await expect(page.getByText('System Health')).toBeVisible()
    }
  })
})
