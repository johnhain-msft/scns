/**
 * Phase 10f — the quality-gate seam that inverted John's approval (FR-050c, FR-056 – FR-058).
 *
 * This drives the REAL arbiter against a REAL isolated suggestion store, because the defect is
 * in the seam between them, not in either one alone. Store-level arithmetic (backoff, ceiling,
 * escalation) is unit-tested separately in `test/unit/suggest/qg-failure-not-rejection.test.ts`;
 * what is pinned here is that `handleTeamCompletion`'s FAIL branch actually reaches that seam.
 *
 * The live inversion, measured 2026-08-04 on `~/.scns/suggestions/rejected/65a914f4-*.md`:
 *
 *     status:        "rejected"           ← the label meaning "John declined this"
 *     reviewReason:  "human:cheap-win:"   ← but John APPROVED it, 20 minutes earlier
 *     machineReason: "qg-fail:tests-failed"
 *     (no attemptCount field at all)      ← terminal on attempt one, zero retries
 *
 * Git is fully mocked through an injected `runCommand`; no agent is spawned; `~/.scns` is never
 * opened. Everything lives under `mkdtempSync` roots torn down in `afterEach`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../../src/broker/event-dispatcher.js'
import {
  createQualityGateArbiter,
  type RunResult,
} from '../../../../src/broker/services/quality-gate-arbiter.js'
import type { TeamCompletionData } from '../../../../src/broker/services/team-lifecycle.js'
import { createSuggestionStore } from '../../../../src/suggest/suggestion-store.js'
import { SuggestionType, type Suggestion, type SuggestionStatus } from '../../../../src/suggest/types.js'

const SUGGESTION_ID = '65a914f4-b229-4fde-874e-c46a44dd845f'
const TEAM_ID = `team-sugg-${SUGGESTION_ID.slice(0, 8)}`
/** John's actual words on the live item, minus the empty prose. */
const JOHN_APPROVED = 'human:cheap-win:small and unblocks the weekly loop'

function ok(stdout = '', stderr = ''): RunResult {
  return { ok: true, stdout, stderr }
}
function fail(stdout = '', stderr = ''): RunResult {
  return { ok: false, stdout, stderr, code: 1 }
}

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qg-failbranch-proj-'))
  const binDir = join(root, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  for (const bin of ['vitest', 'eslint']) {
    writeFileSync(join(binDir, bin), '#!/usr/bin/env node\n', { mode: 0o755 })
  }
  return root
}

/**
 * @param testsPass when false, `npm test` fails — the exact shape of the live incident, whose
 *                  machineReason was `qg-fail:tests-failed`.
 */
function makeRunCommand(testsPass: boolean): (cmd: string, cwd: string) => RunResult {
  return (cmd: string): RunResult => {
    if (cmd.startsWith('git worktree add')) {
      const m = cmd.match(/git worktree add -b \S+ "([^"]+)" HEAD/)
      if (m) {
        mkdirSync(m[1]!, { recursive: true })
        // npm-project fixture shape (G2 non-npm probe reads the worktree).
        writeFileSync(join(m[1]!, 'package.json'), '{"name":"fixture","version":"0.0.0"}')
      }
      return ok()
    }
    if (cmd.startsWith('npm test')) {
      return testsPass ? ok() : fail('', '1 failed | 0 passed')
    }
    if (cmd.startsWith('git rev-parse')) return ok('deadbeef\n')
    return ok()
  }
}

function completion(): TeamCompletionData {
  return {
    teamId: TEAM_ID,
    memberSessionIds: ['s1'],
    stagedDiff:
      'diff --git a/foo.md b/foo.md\n--- a/foo.md\n+++ b/foo.md\n@@ -1 +1,2 @@\n line\n+new\n',
    artifacts: [],
    logs: [],
    aggregateOutcome: 'success',
    completedAt: new Date().toISOString(),
  }
}

describe('QualityGateArbiter — a build failure is not the human’s refusal (Phase 10f)', () => {
  let testDb: TestDb
  let tmpRoot: string
  let projectRoot: string
  let storeRoot: string
  let store: ReturnType<typeof createSuggestionStore>

  beforeEach(() => {
    testDb = createBrokerTestDb()
    tmpRoot = mkdtempSync(join(tmpdir(), 'qg-failbranch-wt-'))
    projectRoot = makeProjectRoot()
    storeRoot = mkdtempSync(join(tmpdir(), 'qg-failbranch-store-'))
    store = createSuggestionStore({ rootDir: join(storeRoot, 'suggestions') })

    // Reconstruct the state 65a914f4 was in the instant before the gate ran: John approved it
    // with his own words AND an explicit verdict, and the brain moved it in-progress.
    store.save({
      id: SUGGESTION_ID,
      type: SuggestionType.Workflow,
      title: 'Log a structured event on every autonomy-level transition',
      description: 'a description',
      confidence: 0.9,
      status: 'pending',
      createdAt: '2026-08-04T16:30:00.000Z',
      updatedAt: '2026-08-04T16:30:00.000Z',
      evidence: [],
      tags: ['self-improvement'],
    } as Suggestion)
    store.updateStatus(SUGGESTION_ID, 'approved' as SuggestionStatus, JOHN_APPROVED, undefined, {
      reviewVerdict: 'approve',
    })
    store.markInProgress(SUGGESTION_ID, TEAM_ID)
  })

  afterEach(() => {
    testDb.close()
    for (const d of [tmpRoot, projectRoot, storeRoot]) {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true })
    }
  })

  function arbiterWith(testsPass: boolean) {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    return createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(testsPass),
      worktreeBase: tmpRoot,
      suggestionStore: store,
    })
  }

  /** Same arbiter, with the brain's outcome callback captured. */
  function arbiterSpying(testsPass: boolean) {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const outcomes: Array<{ passed: boolean; verdict?: string }> = []
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(testsPass),
      worktreeBase: tmpRoot,
      suggestionStore: store,
      onOutcome: (o: { passed: boolean; verdict?: string }) => {
        outcomes.push(o)
      },
    })
    return { arbiter, outcomes }
  }

  /**
   * RE-GRADE finding 4 — the behavioural half of the wiring guard.
   *
   * The suggestion FILE is only one of the two places a build failure was recorded as John's
   * refusal. The other is `proposal_outcomes`, reached through this callback, and it is what
   * `FAILED_VERDICTS` actually reads. An independent re-grade reverted the verdict wiring at both
   * ends and the entire suite stayed green, because every test filed under this finding asserted
   * on the store rather than on what the arbiter TELLS the learner.
   */
  it('re-grade F4: the FAIL branch tells the learner `failed`, never `rejected`', async () => {
    const { arbiter, outcomes } = arbiterSpying(false)
    await arbiter.handleTeamCompletion(completion())
    arbiter.stop()

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.passed).toBe(false)
    expect(outcomes[0]!.verdict).toBe('failed')
    expect(outcomes[0]!.verdict).not.toBe('rejected')
  })

  it('re-grade F4 positive control: the PASS branch still reports `implemented`', async () => {
    const { arbiter, outcomes } = arbiterSpying(true)
    await arbiter.handleTeamCompletion(completion())
    arbiter.stop()

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.verdict).toBe('implemented')
  })

  it('T142(a): the gate FAIL branch does not label a human approval `rejected`', async () => {
    const arbiter = arbiterWith(false)
    const verdict = await arbiter.handleTeamCompletion(completion())
    arbiter.stop()
    expect(verdict.passed).toBe(false)

    const after = store.get(SUGGESTION_ID)!
    // `rejected` is reserved for "John declined this" (FR-056). Writing it here is what made
    // the learner count his approval as his refusal, via `rejected ∈ FAILED_VERDICTS`.
    expect(after.status).not.toBe('rejected')
  })

  it('T142(b): the gate FAIL branch increments `attemptCount` and schedules a retry', async () => {
    const arbiter = arbiterWith(false)
    await arbiter.handleTeamCompletion(completion())
    arbiter.stop()

    const after = store.get(SUGGESTION_ID)!
    // The live file has no `attemptCount` field at all — it never got a second chance.
    expect(after.attemptCount).toBe(1)
    expect(after.nextRetryAt).toBeTruthy()
    expect(after.lastError ?? '').toContain('qg-fail:')
  })

  it('T142(c) / T131d: the gate FAIL branch leaves the human verdict and words intact', async () => {
    const arbiter = arbiterWith(false)
    await arbiter.handleTeamCompletion(completion())
    arbiter.stop()

    const after = store.get(SUGGESTION_ID)!
    // FR-050c / SC-028. Note this is also what makes the violation *visible*: today the same
    // write that mislabels the item also destroys the evidence that John approved it.
    expect(after.reviewVerdict).toBe('approve')
    expect(after.reviewReason).toBe(JOHN_APPROVED)
    // The machine's own verdict is still recorded — as the machine's (FR-048).
    expect(after.machineReason?.startsWith('qg-fail:')).toBe(true)
  })

  it('T144: the FAIL branch returns the proposal to `approved` so the brain retries it', async () => {
    const arbiter = arbiterWith(false)
    await arbiter.handleTeamCompletion(completion())
    arbiter.stop()

    // The brain's retry loop lists `approved` only. Leaving it `in-progress` would strand it.
    expect(store.get(SUGGESTION_ID)!.status).toBe('approved')
    expect(store.get(SUGGESTION_ID)!.inflightTeamId).toBeNull()
  })

  it('T142 positive control: a gate PASS still reaches `implemented` on the first attempt', async () => {
    const arbiter = arbiterWith(true)
    const verdict = await arbiter.handleTeamCompletion(completion())
    arbiter.stop()
    expect(verdict.passed).toBe(true)

    const after = store.get(SUGGESTION_ID)!
    // This is what stops the fix from degenerating into "disable the gate". The PASS path is
    // not defective and must not move.
    expect(after.status).toBe('implemented')
    expect(after.attemptCount).toBe(0)
    expect(after.reviewVerdict).toBe('approve')
  })
})
