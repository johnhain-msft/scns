/**
 * Phase 1 wedge B — `runValidateLoss` CLI formatter. CI-safe: the injected env
 * has no opt-in, so the formatter exercises the default-OFF Mock path (no broker
 * config, no worktree, no spawn). Asserts the JSON + human shapes used as evidence.
 */
import { describe, it, expect } from 'vitest'
import { runValidateLoss } from '../../../src/cli/selfopt.js'

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv

describe('wedge B — runValidateLoss formatter (default-OFF)', () => {
  it('emits default-OFF JSON: backend mock, nSpawns 0, worktree null, delta 0', async () => {
    const out = await runValidateLoss({ projectRoot: '/tmp/repo', env: env({}) }, { json: true })
    const parsed = JSON.parse(out)
    expect(parsed.backendLabel).toBe('mock')
    expect(parsed.spawned).toBe(false)
    expect(parsed.nSpawns).toBe(0)
    expect(parsed.worktree).toBeNull()
    expect(parsed.headlineDelta).toBe(0)
    expect(parsed.readings).toHaveLength(2)
    for (const r of parsed.readings) expect(r.delta).toBe(0)
  })

  it('emits a human summary marking the default-OFF Mock measurement', async () => {
    const out = await runValidateLoss({ projectRoot: '/tmp/repo', env: env({}) })
    expect(out).toContain('backend: mock')
    expect(out).toContain('spawned: false')
    expect(out).toContain('nSpawns: 0')
    expect(out).toContain('HEADLINE')
  })
})
