import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reapStaleSessionStates } from '../../../src/retention/session-state-reaper.js'

let root: string
const DAY_MS = 24 * 60 * 60 * 1000

function makeSession(id: string, ageDays: number, files: Record<string, string> = {}): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  const t = (Date.now() - ageDays * DAY_MS) / 1000
  utimesSync(dir, t, t)
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scns-reaper-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('reapStaleSessionStates', () => {
  it('returns an empty result when the root does not exist', async () => {
    const result = await reapStaleSessionStates({
      rootDir: join(root, 'missing'),
      maxAgeMs: 14 * DAY_MS,
    })
    expect(result.scanned).toBe(0)
    expect(result.reaped).toEqual([])
  })

  it('only reaps directories older than maxAgeMs', async () => {
    const young = makeSession('young', 1, { 'plan.md': 'recent' })
    const stale = makeSession('stale', 30, { 'plan.md': 'old' })

    const result = await reapStaleSessionStates({
      rootDir: root,
      maxAgeMs: 14 * DAY_MS,
    })

    expect(result.scanned).toBe(2)
    expect(result.reaped).toEqual([stale])
    expect(existsSync(young)).toBe(true)
    expect(existsSync(stale)).toBe(false)
  })

  it('invokes the extract hook before deleting the stale directory', async () => {
    const stale = makeSession('stale', 30, { 'plan.md': 'durable signal' })
    const seen: string[] = []

    const result = await reapStaleSessionStates({
      rootDir: root,
      maxAgeMs: 14 * DAY_MS,
      extract: async (dir) => {
        // Hook must run while the directory still exists.
        expect(existsSync(dir)).toBe(true)
        seen.push(dir)
      },
    })

    expect(seen).toEqual([stale])
    expect(result.extracted).toEqual([stale])
    expect(existsSync(stale)).toBe(false)
  })

  it('records errors from the extract hook without aborting the sweep', async () => {
    const a = makeSession('a', 30)
    const b = makeSession('b', 30)

    const result = await reapStaleSessionStates({
      rootDir: root,
      maxAgeMs: 14 * DAY_MS,
      extract: (dir) => {
        if (dir === a) throw new Error('boom')
      },
    })

    expect(result.errors.length).toBe(1)
    expect(result.errors[0]?.path).toBe(a)
    expect(result.errors[0]?.message).toContain('boom')
    // 'a' is kept because extraction failed; 'b' is reaped normally.
    expect(existsSync(a)).toBe(true)
    expect(existsSync(b)).toBe(false)
    expect(result.reaped).toEqual([b])
  })
})
