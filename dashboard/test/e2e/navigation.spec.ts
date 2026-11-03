import { test, expect } from '@playwright/test'
import { mockBrokerApi } from './helpers/mock-api'

const NAV_ITEMS = [
  { href: '/', label: 'Overview' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/teams', label: 'Teams' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/suggestions', label: 'Suggestions' },
  { href: '/scheduler', label: 'Scheduler' },
  { href: '/memory', label: 'Memory' },
  { href: '/dream', label: 'Dream' },
  { href: '/observers', label: 'Observers' },
  { href: '/autonomy', label: 'Autonomy' },
  { href: '/cost', label: 'Cost' },
  { href: '/traces', label: 'Traces' },
  { href: '/metrics', label: 'Metrics' },
  { href: '/settings/otel', label: 'OTel Settings' },
] as const

test.describe('Sidebar navigation', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrokerApi(page)
  })

  for (const item of NAV_ITEMS) {
    test(`navigates to ${item.label} (${item.href})`, async ({ page }) => {
      await page.goto('/')
      const link = page.getByRole('link', { name: item.label })
      await expect(link).toBeVisible()
      await link.click()
      await expect(page).toHaveURL(item.href)
    })
  }

  test('all 14 sidebar links are present', async ({ page }) => {
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Main navigation' })
    await expect(nav).toBeVisible()
    const links = nav.getByRole('link')
    await expect(links).toHaveCount(14)
  })

  test('active nav item has aria-current="page"', async ({ page }) => {
    await page.goto('/sessions')
    const sessionsLink = page.getByRole('link', { name: 'Sessions' })
    await expect(sessionsLink).toHaveAttribute('aria-current', 'page')

    // Other links should NOT have aria-current
    const overviewLink = page.getByRole('link', { name: 'Overview' })
    await expect(overviewLink).not.toHaveAttribute('aria-current')
  })

  test('browser back/forward navigation works', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL('/')

    await page.getByRole('link', { name: 'Sessions' }).click()
    await expect(page).toHaveURL('/sessions')

    await page.getByRole('link', { name: 'Traces' }).click()
    await expect(page).toHaveURL('/traces')

    await page.goBack()
    await expect(page).toHaveURL('/sessions')

    await page.goBack()
    await expect(page).toHaveURL('/')

    await page.goForward()
    await expect(page).toHaveURL('/sessions')
  })
})
