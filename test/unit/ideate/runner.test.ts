/**
 * D1 — runIdeation orchestrator, driven with an INJECTED FAKE backend so the
 * suite NEVER spawns a real copilot process. Verifies the default-OFF gate, the
 * gather→prompt→backend→parse→inbox pipeline, K request + cap, model stamping,
 * dropped-entry accounting, and that a backend error writes NOTHING.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runIdeation, ideationEnabledFromEnv, memGapsEnabledFromEnv } from '../../../src/ideate/runner.js'
import { createIdeationInbox } from '../../../src/ideate/inbox.js'
import type { IdeationBackend } from '../../../src/ideate/backend.js'
import type { IdeationSignalSources } from '../../../src/ideate/signals.js'

const sources: IdeationSignalSources = {
  telemetry: () => null,
  codebase: () => ({ modules: ['ideate'], description: 'SCNS' }),
  recentOutcomes: () => ({ implemented: [], rejected: [], failed: [], pendingCount: 0 }),
  openGaps: () => [],
  now: () => new Date('2026-06-23T00:00:00.000Z'),
}

const proposal = (n: number) => ({
  title: `Idea ${n}`,
  rationale: `r${n}`,
  expectedValue: `v${n}`,
  implementationSketch: `s${n}`,
  testableSuccessCriterion: `t${n}`,
})

function fakeBackend(output: string | (() => Promise<string>)): {
  backend: IdeationBackend
  prompts: string[]
  calls: number
} {
  const prompts: string[] = []
  let calls = 0
  const backend: IdeationBackend = {
    async ideate(prompt: string) {
      calls++
      prompts.push(prompt)
      return typeof output === 'string' ? output : output()
    },
  }
  return {
    backend,
    prompts,
    get calls() {
      return calls
    },
  }
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scns-ideate-runner-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('runIdeation', () => {
  it('is default-OFF: enabled=false returns ran:false and never calls the backend', async () => {
    const inbox = createIdeationInbox(root)
    const fb = fakeBackend(JSON.stringify([proposal(1)]))
    const res = await runIdeation(
      { sources, backend: fb.backend, inbox },
      { enabled: false },
    )
    expect(res.ran).toBe(false)
    expect(res.skipReason).toBe('disabled')
    expect(fb.calls).toBe(0)
    expect(inbox.list()).toHaveLength(0)
  })

  it('runs the full pipeline and writes proposals to the inbox', async () => {
    const inbox = createIdeationInbox(root)
    const fb = fakeBackend(JSON.stringify([proposal(1), proposal(2)]))
    const res = await runIdeation(
      { sources, backend: fb.backend, inbox, model: 'claude-opus-4.8' },
      { enabled: true, k: 5 },
    )
    expect(res.ran).toBe(true)
    expect(res.requested).toBe(5)
    expect(res.received).toBe(2)
    expect(res.written).toHaveLength(2)
    expect(inbox.list()).toHaveLength(2)
    // the agent received the real built prompt
    expect(fb.prompts[0]).toContain('SCNS Ideation Engine')
    expect(fb.prompts[0]).toContain('ideate') // codebase module signal flowed in
    // records carry the model
    expect(inbox.list()[0].model).toBe('claude-opus-4.8')
  })

  it('requests K and caps received proposals at K', async () => {
    const inbox = createIdeationInbox(root)
    const fb = fakeBackend(JSON.stringify([1, 2, 3, 4, 5].map(proposal)))
    const res = await runIdeation({ sources, backend: fb.backend, inbox }, { enabled: true, k: 3 })
    expect(res.requested).toBe(3)
    expect(res.received).toBe(3)
    expect(inbox.list()).toHaveLength(3)
  })

  it('surfaces dropped malformed entries without writing them', async () => {
    const inbox = createIdeationInbox(root)
    const fb = fakeBackend(JSON.stringify([proposal(1), { title: 'incomplete' }]))
    const res = await runIdeation({ sources, backend: fb.backend, inbox }, { enabled: true, k: 5 })
    expect(res.received).toBe(1)
    expect(res.dropped).toBe(1)
    expect(inbox.list()).toHaveLength(1)
  })

  it('on a backend error: ran:false, error surfaced, NOTHING written', async () => {
    const inbox = createIdeationInbox(root)
    const fb = fakeBackend(async () => {
      throw new Error('spawn failed')
    })
    const res = await runIdeation({ sources, backend: fb.backend, inbox }, { enabled: true, k: 3 })
    expect(res.ran).toBe(false)
    expect(res.skipReason).toBe('backend-error')
    expect(res.error).toContain('spawn failed')
    expect(res.written).toHaveLength(0)
    expect(inbox.list()).toHaveLength(0)
  })

  it('writes nothing (but ran:true) when the agent returns no usable proposals', async () => {
    const inbox = createIdeationInbox(root)
    const fb = fakeBackend('I have no ideas.')
    const res = await runIdeation({ sources, backend: fb.backend, inbox }, { enabled: true, k: 3 })
    expect(res.ran).toBe(true)
    expect(res.received).toBe(0)
    expect(res.written).toHaveLength(0)
  })
})

describe('ideationEnabledFromEnv', () => {
  it('is OFF by default and only ON for "1"', () => {
    expect(ideationEnabledFromEnv({})).toBe(false)
    expect(ideationEnabledFromEnv({ SCNS_IDEATION: '0' })).toBe(false)
    expect(ideationEnabledFromEnv({ SCNS_IDEATION: 'true' })).toBe(false)
    expect(ideationEnabledFromEnv({ SCNS_IDEATION: '1' })).toBe(true)
  })
})

describe('memGapsEnabledFromEnv', () => {
  it('is OFF by default and only ON for "1"', () => {
    expect(memGapsEnabledFromEnv({})).toBe(false)
    expect(memGapsEnabledFromEnv({ SCNS_IDEATE_MEMGAPS: '0' })).toBe(false)
    expect(memGapsEnabledFromEnv({ SCNS_IDEATE_MEMGAPS: '1' })).toBe(true)
  })
})
