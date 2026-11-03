/**
 * D1 — `scns ideate` CLI logic, driven through `runIdeate` with INJECTED deps
 * and a FAKE backend so no real copilot process is ever spawned. Covers the
 * dry-run default (prints prompt, spawns/writes nothing), the SCNS_IDEATION
 * master gate on `--spawn`, and the gated spawn path (writes to a temp inbox,
 * tears down the worktree).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runIdeate, DEFAULT_OPEN_GAPS } from '../../../src/cli/ideate.js'
import type { IdeateDeps } from '../../../src/cli/ideate.js'
import type { IdeationSignalSources } from '../../../src/ideate/signals.js'
import type { IdeationBackend } from '../../../src/ideate/backend.js'

const sources: IdeationSignalSources = {
  telemetry: () => null,
  codebase: () => ({ modules: ['ideate', 'brain'], description: 'SCNS' }),
  recentOutcomes: () => ({ implemented: [], rejected: [], failed: [], pendingCount: 0 }),
  openGaps: () => [...DEFAULT_OPEN_GAPS],
  now: () => new Date('2026-06-23T00:00:00.000Z'),
}

const validJson = JSON.stringify([
  {
    title: 'Add a telemetry-anomaly agent',
    rationale: 'r',
    expectedValue: 'v',
    implementationSketch: 's',
    testableSuccessCriterion: 't',
  },
])

let inboxDir: string
let printed: string[]

beforeEach(() => {
  inboxDir = mkdtempSync(join(tmpdir(), 'scns-ideate-cli-'))
  printed = []
})
afterEach(() => rmSync(inboxDir, { recursive: true, force: true }))

function baseDeps(over: Partial<IdeateDeps> = {}): IdeateDeps {
  return {
    sources,
    inboxDir,
    projectRoot: '/repo',
    env: {},
    print: (l) => printed.push(l),
    ...over,
  }
}

describe('runIdeate — dry run (default)', () => {
  it('prints the prompt and spawns / writes nothing', async () => {
    let madeWorktree = false
    let madeBackend = false
    const res = await runIdeate(
      baseDeps({
        makeWorktree: () => {
          madeWorktree = true
          return { cwd: '/x', cleanup: () => {} }
        },
        makeBackend: () => {
          madeBackend = true
          return { ideate: async () => validJson }
        },
      }),
      { k: 4, spawn: false, json: false },
    )
    expect(res.mode).toBe('dry-run')
    expect(res.written).toBe(0)
    expect(madeWorktree).toBe(false)
    expect(madeBackend).toBe(false)
    expect(printed.join('\n')).toContain('SCNS Ideation Engine')
    expect(printed.join('\n')).toContain('DRY RUN')
    expect(readdirSync(inboxDir)).toHaveLength(0)
  })

  it('emits JSON (including the prompt) when --json is set', async () => {
    const res = await runIdeate(baseDeps(), { k: 3, spawn: false, json: true })
    expect(res.mode).toBe('dry-run')
    const parsed = JSON.parse(printed.join('\n'))
    expect(parsed.mode).toBe('dry-run')
    expect(parsed.prompt).toContain('SCNS Ideation Engine')
  })
})

describe('runIdeate — spawn gate', () => {
  it('refuses the real spawn unless SCNS_IDEATION=1', async () => {
    let madeWorktree = false
    const res = await runIdeate(
      baseDeps({
        env: {},
        makeWorktree: () => {
          madeWorktree = true
          return { cwd: '/x', cleanup: () => {} }
        },
        makeBackend: () => ({ ideate: async () => validJson }),
      }),
      { k: 3, spawn: true, json: false },
    )
    expect(res.mode).toBe('refused')
    expect(madeWorktree).toBe(false)
    expect(printed.join('\n').toLowerCase()).toContain('scns_ideation=1')
  })

  it('runs the gated spawn path with a fake backend and writes to the inbox', async () => {
    let cleanedUp = false
    const fake: IdeationBackend = { ideate: async () => validJson }
    const res = await runIdeate(
      baseDeps({
        env: { SCNS_IDEATION: '1' },
        makeWorktree: () => ({ cwd: '/isolated/wt', cleanup: () => (cleanedUp = true) }),
        makeBackend: (cwd) => {
          expect(cwd).toBe('/isolated/wt')
          return fake
        },
      }),
      { k: 3, spawn: true, json: false },
    )
    expect(res.mode).toBe('spawned')
    expect(res.written).toBe(1)
    expect(res.worktree).toBe('/isolated/wt')
    expect(cleanedUp).toBe(true)
    expect(readdirSync(inboxDir).filter((f) => f.endsWith('.json'))).toHaveLength(1)
  })

  it('tears down the worktree even if the backend throws', async () => {
    let cleanedUp = false
    const res = await runIdeate(
      baseDeps({
        env: { SCNS_IDEATION: '1' },
        makeWorktree: () => ({ cwd: '/isolated/wt', cleanup: () => (cleanedUp = true) }),
        makeBackend: () => ({
          ideate: async () => {
            throw new Error('spawn failed')
          },
        }),
      }),
      { k: 3, spawn: true, json: false },
    )
    expect(cleanedUp).toBe(true)
    expect(res.written).toBe(0)
    expect(readdirSync(inboxDir).filter((f) => f.endsWith('.json'))).toHaveLength(0)
  })

  it('persists the raw response and prints a preview when 0 proposals parse', async () => {
    const res = await runIdeate(
      baseDeps({
        env: { SCNS_IDEATION: '1' },
        makeWorktree: () => ({ cwd: '/isolated/wt', cleanup: () => {} }),
        makeBackend: () => ({ ideate: async () => 'I could not produce JSON, sorry.' }),
      }),
      { k: 3, spawn: true, json: false },
    )
    expect(res.mode).toBe('spawned')
    expect(res.written).toBe(0)
    // raw response saved for inspection
    const saved = readFileSync(join(inboxDir, '.last-response.txt'), 'utf-8')
    expect(saved).toContain('could not produce JSON')
    // and a preview surfaced to the user (not a silent zero)
    expect(printed.join('\n')).toContain('raw preview')
  })
})

describe('runIdeate — synth (deterministic, no ACP)', () => {
  it('writes evidence-first synth proposals on --spawn without any worktree/agent', async () => {
    let madeWorktree = false
    let madeBackend = false
    const res = await runIdeate(
      baseDeps({
        env: { SCNS_IDEATE_SYNTH: '1' },
        makeWorktree: () => {
          madeWorktree = true
          return { cwd: '/x', cleanup: () => {} }
        },
        makeBackend: () => {
          madeBackend = true
          return { ideate: async () => validJson }
        },
      }),
      { k: 4, spawn: true, json: false },
    )
    expect(res.mode).toBe('spawned')
    expect(res.written).toBeGreaterThan(0)
    expect(madeWorktree).toBe(false) // no isolated worktree
    expect(madeBackend).toBe(false) // never touched the ACP backend
    const files = readdirSync(inboxDir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)
    const rec = JSON.parse(readFileSync(join(inboxDir, files[0]), 'utf-8'))
    expect(rec.source).toBe('synth-ideation') // provenance stamped
  })

  it('does NOT engage synth without SCNS_IDEATE_SYNTH=1 (falls through to ACP gate)', async () => {
    const res = await runIdeate(
      baseDeps({ env: {}, makeWorktree: () => ({ cwd: '/x', cleanup: () => {} }), makeBackend: () => ({ ideate: async () => validJson }) }),
      { k: 3, spawn: true, json: false },
    )
    expect(res.mode).toBe('refused')
  })
})
