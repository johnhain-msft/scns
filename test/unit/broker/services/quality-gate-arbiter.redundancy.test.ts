import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../../src/broker/event-dispatcher.js'
import {
  createQualityGateArbiter,
  resolveRedundancyMode,
  type RunResult,
  type QualityGateSuggestionStore,
} from '../../../../src/broker/services/quality-gate-arbiter.js'
import type { TeamCompletionData } from '../../../../src/broker/services/team-lifecycle.js'
import type { RedundancyVerifierBackend } from '../../../../src/broker/services/redundancy-verifier-backend.js'
import type { Suggestion } from '../../../../src/suggest/types.js'

function ok(stdout = '', stderr = ''): RunResult {
  return { ok: true, stdout, stderr }
}

// A run stub where build/test/lint/commit all succeed ⇒ flow reaches the
// redundancy gate on the code-PASS path.
function passingRun(): (cmd: string, cwd: string) => RunResult {
  return () => ok()
}

function makeCompletion(tail: string): TeamCompletionData {
  return {
    teamId: 'team-task-sugg-red01',
    memberSessionIds: ['s1'],
    stagedDiff:
      'diff --git a/foo.md b/foo.md\n--- a/foo.md\n+++ b/foo.md\n@@ -1 +1,2 @@\n line\n+new\n',
    artifacts: [],
    logs: tail ? [{ sessionId: 's1', name: 'scns-dev', tail }] : [],
    aggregateOutcome: 'success',
    completedAt: new Date().toISOString(),
  }
}

function makeSuggestion(id: string): Suggestion {
  return {
    id,
    type: 'prompt',
    title: 'Example',
    description: 'test',
    status: 'approved',
    confidence: 0.9,
    evidence: [],
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    actionable: true,
    estimatedComplexity: 'solo',
  }
}

function makeStore(seed: Suggestion): QualityGateSuggestionStore {
  const map = new Map<string, Suggestion>([[seed.id, seed]])
  return {
    get: (id) => map.get(id) ?? null,
    updateStatus: (id, status, reason) => {
      const cur = map.get(id)
      if (!cur) return null
      const next = { ...cur, status, reviewReason: reason }
      map.set(id, next)
      return next
    },
  }
}

const CLEAN = 'Implemented the feature with new tests. All green.'
const TRIPPED_UNADDRESSED =
  'Added a research-role-classifier that duplicates assignRole and re-implements the same regex.'
const TRIPPED_ADDRESSED =
  'This looked similar to the existing assignRole, so I reused it instead of duplicating; deleted the redundant helper.'

function backend(verdict: 'pass' | 'fail' | 'needs-explanation'): RedundancyVerifierBackend {
  return { judge: vi.fn(async () => ({ verdict, findings: verdict === 'fail' ? ['real duplicate'] : [] })) }
}

describe('resolveRedundancyMode', () => {
  it('scan + spawn default ON (Dev-default-ON)', () => {
    expect(resolveRedundancyMode({})).toEqual({ scan: true, spawn: true })
  })
  it('SCNS_QG_REDUNDANCY=0 disables scan (and implicitly spawn)', () => {
    expect(resolveRedundancyMode({ SCNS_QG_REDUNDANCY: '0' })).toEqual({ scan: false, spawn: false })
  })
  it('SCNS_QG_REDUNDANCY_SPAWN=0 keeps scan, disables the model spawn', () => {
    expect(resolveRedundancyMode({ SCNS_QG_REDUNDANCY_SPAWN: 'off' })).toEqual({
      scan: true,
      spawn: false,
    })
  })
})

describe('QG arbiter — anti-redundant-build hook', () => {
  let testDb: TestDb
  let tmpRoot: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    tmpRoot = mkdtempSync(join(tmpdir(), 'qg-redundancy-'))
  })
  afterEach(() => {
    testDb.close()
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function build(over: {
    tail: string
    redundancyVerifier?: { env?: NodeJS.ProcessEnv; makeVerifierBackend?: () => RedundancyVerifierBackend }
  }) {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const sugg = makeSuggestion('red01')
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot: tmpRoot,
      suggestionStore: makeStore(sugg),
      executor: { generatePlan: () => ({ steps: [] }), execute: () => ({ success: true, errors: [] }) },
      runCommand: passingRun(),
      worktreeBase: tmpRoot,
      // Default: scan ON, spawn ON, but NO backend wired unless the test provides one.
      redundancyVerifier: over.redundancyVerifier ?? { env: {} },
    })
    return { arbiter, tail: over.tail }
  }

  it('NO-OP on clean output (no redundancy signal) → PASS', async () => {
    const { arbiter } = build({ tail: CLEAN })
    const v = await arbiter.handleTeamCompletion(makeCompletion(CLEAN))
    arbiter.stop()
    expect(v.passed).toBe(true)
    expect(v.reason).toBe('ok')
  })

  it('PASS when a flag trips BUT the output addresses it (deterministic clears, no spawn)', async () => {
    const be = backend('fail') // would fail IF consulted…
    const { arbiter } = build({
      tail: TRIPPED_ADDRESSED,
      redundancyVerifier: { env: {}, makeVerifierBackend: () => be },
    })
    const v = await arbiter.handleTeamCompletion(makeCompletion(TRIPPED_ADDRESSED))
    arbiter.stop()
    expect(v.passed).toBe(true)
    expect(v.reason).toBe('ok')
    expect(be.judge).not.toHaveBeenCalled() // deterministic addressing ⇒ model never consulted
  })

  it('HARD-FAIL when a flag trips unaddressed and no model is wired (never silent pass)', async () => {
    const { arbiter } = build({ tail: TRIPPED_UNADDRESSED, redundancyVerifier: { env: {} } })
    const v = await arbiter.handleTeamCompletion(makeCompletion(TRIPPED_UNADDRESSED))
    arbiter.stop()
    expect(v.passed).toBe(false)
    expect(v.reason).toBe('redundancy-unexplained:needs-explanation')
    expect(v.findings.join(' ')).toMatch(/redundancy signal/i)
  })

  it('model CONFIRMS the duplicate → HARD-FAIL redundancy-unexplained:fail', async () => {
    const be = backend('fail')
    const { arbiter } = build({
      tail: TRIPPED_UNADDRESSED,
      redundancyVerifier: { env: {}, makeVerifierBackend: () => be },
    })
    const v = await arbiter.handleTeamCompletion(makeCompletion(TRIPPED_UNADDRESSED))
    arbiter.stop()
    expect(be.judge).toHaveBeenCalledTimes(1) // single-shot spawn, only because the scanner tripped
    expect(v.passed).toBe(false)
    expect(v.reason).toBe('redundancy-unexplained:fail')
    expect(v.findings).toContain('real duplicate')
  })

  it('model CLEARS a false positive → PASS', async () => {
    const be = backend('pass')
    const { arbiter } = build({
      tail: TRIPPED_UNADDRESSED,
      redundancyVerifier: { env: {}, makeVerifierBackend: () => be },
    })
    const v = await arbiter.handleTeamCompletion(makeCompletion(TRIPPED_UNADDRESSED))
    arbiter.stop()
    expect(be.judge).toHaveBeenCalledTimes(1)
    expect(v.passed).toBe(true)
    expect(v.reason).toBe('ok')
  })

  it('SCNS_QG_REDUNDANCY=0 disables the hook entirely → PASS despite an unaddressed flag', async () => {
    const be = backend('fail')
    const { arbiter } = build({
      tail: TRIPPED_UNADDRESSED,
      redundancyVerifier: { env: { SCNS_QG_REDUNDANCY: '0' }, makeVerifierBackend: () => be },
    })
    const v = await arbiter.handleTeamCompletion(makeCompletion(TRIPPED_UNADDRESSED))
    arbiter.stop()
    expect(v.passed).toBe(true)
    expect(be.judge).not.toHaveBeenCalled()
  })
})
