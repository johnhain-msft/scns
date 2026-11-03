#!/usr/bin/env node
/**
 * Dashboard screenshot helper.
 *
 * Launches headless Chromium, navigates each dashboard page, captures a
 * full-page PNG, and fails non-zero if any page logs a console error or
 * renders a visible React error boundary.
 *
 * Usage:
 *   npm run screenshots                 # uses http://localhost:3001
 *   DASHBOARD_URL=... npm run screenshots
 *   npm run screenshots -- /suggestions # only capture specific routes
 */
import { chromium, type ConsoleMessage, type Page } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DEFAULT_ROUTES = [
  '/',
  '/suggestions',
  '/tasks',
  '/teams',
  '/orchestrator',
  '/sessions',
  '/memory',
  '/metrics',
  '/dream',
  '/observers',
  '/autonomy',
  '/cost',
  '/scheduler',
  '/traces',
  '/settings/otel',
]

const BASE = process.env.DASHBOARD_URL ?? 'http://localhost:3001'
const OUT_DIR = resolve(__dirname, '..', 'screenshots')

type RouteResult = {
  route: string
  file: string
  bytes: number
  errors: string[]
  boundaryMatches: string[]
}

function routeToFileName(route: string): string {
  if (route === '/') return 'home.png'
  return route.replace(/^\//, '').replace(/\//g, '-') + '.png'
}

async function capture(page: Page, route: string): Promise<RouteResult> {
  const errors: string[] = []
  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(msg.text())
  }
  const onPageError = (err: Error) => errors.push(`pageerror: ${err.message}`)
  const onRequestFailed = (req: import('playwright').Request) => {
    errors.push(`request-failed: ${req.method()} ${req.url()} (${req.failure()?.errorText ?? 'unknown'})`)
  }
  const onResponse = (res: import('playwright').Response) => {
    if (res.status() >= 400) {
      errors.push(`http-${res.status()}: ${res.url()}`)
    }
  }
  page.on('console', onConsole)
  page.on('pageerror', onPageError)
  page.on('requestfailed', onRequestFailed)
  page.on('response', onResponse)

  const url = `${BASE}${route}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  // Wait for React hydration + a brief settle period. Using load/networkidle
  // trips up pages with long-poll endpoints (e.g. /sessions).
  await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(1500)

  const fileName = routeToFileName(route)
  const outPath = resolve(OUT_DIR, fileName)
  const buffer = await page.screenshot({ fullPage: true, type: 'png' })
  await writeFile(outPath, buffer)

  // Detect visible React error boundary / Next.js error overlays.
  // Use evaluate() so we inspect rendered DOM rather than the serialized RSC
  // payload (which embeds framework strings like "404: This page could not be
  // found." in every page).
  const boundaryMatches: string[] = await page.evaluate(() => {
    const hits: string[] = []
    const errorKeywords = [
      'Application error',
      'Unhandled Runtime Error',
      'Objects are not valid as a React child',
      'Server Error',
      'Failed to compile',
    ]
    // Next.js dev error overlay: only flag if it contains an error keyword
    // (the portal also hosts the dev-tools indicator in normal operation).
    const overlay = document.querySelector('nextjs-portal')
    if (overlay && overlay.shadowRoot) {
      const text = overlay.shadowRoot.textContent ?? ''
      for (const k of errorKeywords) {
        if (text.includes(k)) {
          hits.push(`nextjs-overlay: ${k}`)
          break
        }
      }
    }
    if (/^404[:\s]/i.test(document.title)) hits.push(`title-404: ${document.title}`)
    const visibleText = document.body.innerText ?? ''
    for (const k of errorKeywords) {
      if (visibleText.includes(k)) hits.push(k)
    }
    return hits
  })

  page.off('console', onConsole)
  page.off('pageerror', onPageError)
  page.off('requestfailed', onRequestFailed)
  page.off('response', onResponse)

  return { route, file: fileName, bytes: buffer.length, errors, boundaryMatches }
}

async function main(): Promise<void> {
  const cliRoutes = process.argv.slice(2)
  const routes = cliRoutes.length > 0 ? cliRoutes : DEFAULT_ROUTES

  await mkdir(OUT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })

  const results: RouteResult[] = []
  try {
    for (const route of routes) {
      const page = await context.newPage()
      try {
        const r = await capture(page, route)
        results.push(r)
        const tag =
          r.errors.length > 0 || r.boundaryMatches.length > 0 ? 'FAIL' : 'OK  '
        console.log(
          `[${tag}] ${route.padEnd(16)} → ${r.file.padEnd(22)} ${r.bytes} bytes` +
            (r.errors.length ? ` | console errors: ${r.errors.length}` : '') +
            (r.boundaryMatches.length
              ? ` | boundary: ${r.boundaryMatches.join(', ')}`
              : ''),
        )

        // Extra capture: /suggestions Blocked tab. Validates the 13.12.2
        // blocked-autonomy status surface.
        if (route === '/suggestions') {
          try {
            await page.getByRole('tab', { name: /^Blocked$/ }).click({ timeout: 5_000 })
            await page.waitForTimeout(500)
            const blockedPath = resolve(OUT_DIR, 'suggestions-blocked.png')
            const buf = await page.screenshot({ fullPage: true, type: 'png' })
            await writeFile(blockedPath, buf)
            console.log(
              `[OK  ] ${'/suggestions [Blocked]'.padEnd(16)} → ${'suggestions-blocked.png'.padEnd(22)} ${buf.length} bytes`,
            )
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.log(`[WARN] /suggestions Blocked tab capture skipped: ${msg}`)
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({
          route,
          file: routeToFileName(route),
          bytes: 0,
          errors: [`navigation failed: ${msg}`],
          boundaryMatches: [],
        })
        console.log(`[FAIL] ${route} → navigation failed: ${msg}`)
      } finally {
        await page.close()
      }
    }
  } finally {
    await context.close()
    await browser.close()
  }

  const failed = results.filter(
    (r) => r.errors.length > 0 || r.boundaryMatches.length > 0 || r.bytes === 0,
  )

  console.log(
    `\n${results.length} routes captured, ${failed.length} failed. Output: ${OUT_DIR}`,
  )

  if (failed.length > 0) {
    console.error('\nFailures:')
    for (const f of failed) {
      console.error(
        `  ${f.route}: errors=${f.errors.join('; ') || '(none)'} boundary=${f.boundaryMatches.join('; ') || '(none)'}`,
      )
    }
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
