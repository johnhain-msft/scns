import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, statSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const DASH_ROOT = resolve(__dirname, '../..')
const SCRIPT = resolve(DASH_ROOT, 'scripts/capture-pages.ts')
const OUT = resolve(DASH_ROOT, 'screenshots')
const BASE = process.env.DASHBOARD_URL ?? 'http://localhost:3001'

async function isDashboardUp(): Promise<boolean> {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

describe('dashboard screenshot helper', () => {
  let dashboardUp = false
  beforeAll(async () => {
    dashboardUp = await isDashboardUp()
  })

  it('capture-pages.ts exists and is runnable', () => {
    expect(existsSync(SCRIPT)).toBe(true)
  })

  it('captures /suggestions as a PNG > 10KB', async () => {
    if (!dashboardUp) {
      console.warn(`skipping: dashboard not reachable at ${BASE}`)
      return
    }
    const target = resolve(OUT, 'suggestions.png')
    if (existsSync(target)) rmSync(target)
    const result = spawnSync(
      'npx',
      ['tsx', SCRIPT, '/suggestions'],
      {
        cwd: DASH_ROOT,
        env: { ...process.env, DASHBOARD_URL: BASE },
        encoding: 'utf-8',
        timeout: 60_000,
      },
    )
    expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0)
    expect(existsSync(target)).toBe(true)
    const size = statSync(target).size
    expect(size).toBeGreaterThan(10 * 1024)
  }, 90_000)
})
