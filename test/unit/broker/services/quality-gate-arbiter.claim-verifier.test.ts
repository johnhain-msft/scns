/**
 * Track 1 / 1B — claim-evidence verifier wired into the quality-gate arbiter.
 *
 * Two branches (see quality-gate-arbiter.ts):
 *   (A) No-diff ANALYSIS/research completion (a scns-researcher member): judged
 *       by the claim-evidence verifier (its OWN rule) instead of the code-diff
 *       no-diff auto-fail. Measure is default-ON; killable via
 *       SCNS_QG_CLAIM_VERIFIER=0.
 *   (B) Code PASS branch: the verifier runs on the combined build/test/lint
 *       output (measure, default-ON, advisory) and only DOWNGRADES PASS→FAIL
 *       when SCNS_QG_CLAIM_ENFORCE=1.
 *
 * All git is mocked via an injected runCommand (NO real git, NO spawn).
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
import type {
  ClaimVerifierBackend,
  ClaimReverifyVerdict,
} from '../../../../src/broker/services/claim-verifier-backend.js'

function ok(stdout = '', stderr = ''): RunResult {
  return { ok: true, stdout, stderr }
}

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qg-claim-proj-'))
  const binDir = join(root, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  for (const bin of ['vitest', 'eslint']) {
    writeFileSync(join(binDir, bin), '#!/usr/bin/env node\n', { mode: 0o755 })
  }
  return root
}

interface Recorded {
  cmds: string[]
}

function makeRunCommand(
  recorded: Recorded,
  overrides: Partial<{ build: RunResult; test: RunResult; lint: RunResult }> = {},
): (cmd: string, cwd: string) => RunResult {
  return (cmd: string, _cwd: string): RunResult => {
    recorded.cmds.push(cmd)
    if (cmd.startsWith('git worktree add')) {
      const m = cmd.match(/git worktree add -b \S+ "([^"]+)" HEAD/)
      if (m) {
        mkdirSync(m[1]!, { recursive: true })
        // npm-project fixture shape (G2 non-npm probe reads the worktree).
        writeFileSync(join(m[1]!, 'package.json'), '{"name":"fixture","version":"0.0.0"}')
      }
      return ok()
    }
    if (cmd.startsWith('git apply')) return ok()
    if (cmd.startsWith('npm run build')) return overrides.build ?? ok()
    if (cmd.startsWith('npm test')) return overrides.test ?? ok()
    if (cmd.startsWith('npm run lint')) return overrides.lint ?? ok()
    if (cmd.startsWith('git rev-parse')) return ok('deadbeef\n')
    return ok()
  }
}

const DIFF =
  'diff --git a/foo.md b/foo.md\n--- a/foo.md\n+++ b/foo.md\n@@ -1 +1,2 @@\n line\n+new\n'

function analysisCompletion(tail: string): TeamCompletionData {
  return {
    teamId: 'team-analysis-a',
    memberSessionIds: ['r1'],
    stagedDiff: '',
    artifacts: [
      {
        sessionId: 'r1',
        name: 'brain-researcher-x',
        role: 'scns-researcher',
        launchMethod: 'acp',
        exitReason: 'completed',
        logPath: null,
        logSizeBytes: null,
      },
    ],
    logs: [{ sessionId: 'r1', name: 'brain-researcher-x', tail }],
    aggregateOutcome: 'success',
    completedAt: new Date().toISOString(),
  }
}

function codeCompletion(): TeamCompletionData {
  return {
    teamId: 'team-code-a',
    memberSessionIds: ['d1'],
    stagedDiff: DIFF,
    artifacts: [
      {
        sessionId: 'd1',
        name: 'brain-dev-x',
        role: 'scns-dev',
        launchMethod: 'acp',
        exitReason: 'completed',
        logPath: null,
        logSizeBytes: null,
      },
    ],
    logs: [],
    aggregateOutcome: 'success',
    completedAt: new Date().toISOString(),
  }
}

function lastVerdictEvent(
  eventLog: ReturnType<typeof createEventLog>,
): Record<string, unknown> {
  const evts = eventLog.since(0).filter((e) => e.event_type === 'quality_gate_verdict')
  return JSON.parse(evts[evts.length - 1]!.payload) as Record<string, unknown>
}

// Output an analyst might produce: a runtime claim asserted with NO evidence label.
const OVERCLAIM =
  'Findings: the rotation-watchdog is unwired and these scheduler rows are vestigial.'
// Output that follows the §3a discipline: labeled + quoted evidence.
const EVIDENCED =
  'Findings: heartbeat runs live via startHeartbeatPoller (488 `zombie_cleaned` ' +
  'events) [live-confirmed]. The watchdog is unwired: no caller of ' +
  '`createWatchdogDaemon` in source [code-only].'

describe('QualityGateArbiter — claim-evidence verifier (Track 1 / 1B)', () => {
  let testDb: TestDb
  let tmpRoot: string
  let projectRoot: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    tmpRoot = mkdtempSync(join(tmpdir(), 'qg-claim-wt-'))
    projectRoot = makeProjectRoot()
  })
  afterEach(() => {
    testDb.close()
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true })
  })

  function arbiterWith(claimEnv: Record<string, string>, recorded: Recorded) {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded),
      worktreeBase: tmpRoot,
      claimVerifier: { env: env(claimEnv) },
    })
    return { arbiter, eventLog }
  }

  // ── Branch A: no-diff analysis/research completion ──────────────────────────

  it('A1: no-diff research completion with an UNLABELED runtime claim ⇒ FAIL (claim-verifier)', async () => {
    const recorded: Recorded = { cmds: [] }
    const { arbiter, eventLog } = arbiterWith({}, recorded) // measure default-ON
    const verdict = await arbiter.handleTeamCompletion(analysisCompletion(OVERCLAIM))
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('claim-verifier:fail')
    expect(verdict.claimVerifier?.kind).toBe('fail')
    // It did NOT fall through to the generic no-diff failure.
    expect(verdict.reason).not.toBe('no-diff')
    const evt = lastVerdictEvent(eventLog)
    expect(evt.claimVerifierKind).toBe('fail')
    // No git worktree was created — the analysis branch returns before it.
    expect(recorded.cmds.some((c) => c.startsWith('git worktree add'))).toBe(false)
  })

  it('A2: no-diff research completion that is properly labeled + evidenced ⇒ PASS', async () => {
    const recorded: Recorded = { cmds: [] }
    const { arbiter } = arbiterWith({}, recorded)
    const verdict = await arbiter.handleTeamCompletion(analysisCompletion(EVIDENCED))
    arbiter.stop()

    expect(verdict.passed).toBe(true)
    expect(verdict.reason).toBe('claim-verifier:pass')
    expect(verdict.claimVerifier?.kind).toBe('pass')
  })

  it('A3: kill-switch SCNS_QG_CLAIM_VERIFIER=0 ⇒ legacy no-diff FAIL even for research', async () => {
    const recorded: Recorded = { cmds: [] }
    const { arbiter } = arbiterWith({ SCNS_QG_CLAIM_VERIFIER: '0' }, recorded)
    const verdict = await arbiter.handleTeamCompletion(analysisCompletion(OVERCLAIM))
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('no-diff')
    expect(verdict.claimVerifier).toBeUndefined()
  })

  it('A4: NON-analysis team (no researcher) with no diff ⇒ legacy no-diff FAIL (unchanged)', async () => {
    const recorded: Recorded = { cmds: [] }
    const { arbiter } = arbiterWith({}, recorded)
    const noDiffCode: TeamCompletionData = {
      ...codeCompletion(),
      stagedDiff: '',
      logs: [{ sessionId: 'd1', name: 'brain-dev-x', tail: OVERCLAIM }],
    }
    const verdict = await arbiter.handleTeamCompletion(noDiffCode)
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('no-diff')
    expect(verdict.claimVerifier).toBeUndefined()
  })

  // ── Branch B: code PASS branch ──────────────────────────────────────────────

  it('B1b: code PASS, measure-only, overclaim in test output ⇒ PASS preserved + claimVerifier=fail (advisory)', async () => {
    const recorded: Recorded = { cmds: [] }
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded, { test: ok('ok\n' + OVERCLAIM) }),
      worktreeBase: tmpRoot,
      claimVerifier: { env: env({}) }, // measure ON, enforce OFF
    })
    const verdict = await arbiter.handleTeamCompletion(codeCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(true)
    expect(verdict.claimVerifier?.kind).toBe('fail')
    // committed (PASS path completed)
    expect(recorded.cmds.some((c) => c.startsWith('git -c user.name=scns-auto'))).toBe(true)
  })

  it('B2: code PASS + ENFORCE + overclaim in test output ⇒ DOWNGRADED to FAIL (claim-verifier)', async () => {
    const recorded: Recorded = { cmds: [] }
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded, { test: ok('ok\n' + OVERCLAIM) }),
      worktreeBase: tmpRoot,
      claimVerifier: { env: env({ SCNS_QG_CLAIM_ENFORCE: '1' }) },
    })
    const verdict = await arbiter.handleTeamCompletion(codeCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('claim-verifier:fail')
    // NOT committed — the downgrade prevents the commit.
    expect(recorded.cmds.some((c) => c.startsWith('git -c user.name=scns-auto'))).toBe(false)
  })

  it('B3: code PASS + ENFORCE + CLEAN output (no runtime claims) ⇒ PASS preserved (no false veto)', async () => {
    const recorded: Recorded = { cmds: [] }
    const { arbiter } = arbiterWith({ SCNS_QG_CLAIM_ENFORCE: '1' }, recorded)
    const verdict = await arbiter.handleTeamCompletion(codeCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(true)
    expect(verdict.claimVerifier?.kind).toBe('pass')
  })
})

// ── Track 1 / 1B — the producer≠verifier spawn seam (default-OFF) ──────────────

/** A fake backend that records the input it was asked to re-verify + dispose. */
function fakeBackend(
  verdict: ClaimReverifyVerdict,
  spy: { calls: number; disposed: number; lastOutput?: string },
): ClaimVerifierBackend {
  return {
    reverify: async (input) => {
      spy.calls += 1
      spy.lastOutput = input.output
      return verdict
    },
    dispose: () => {
      spy.disposed += 1
    },
  }
}

const REVERIFY_FAIL: ClaimReverifyVerdict = {
  verdict: 'fail',
  findings: ['re-ran `curl /api/health`: actual uptime 5s contradicts the quoted 30260s'],
  perClaim: [{ claim: 'uptime 30260s', probe: 'curl /api/health', reran: true, corroborated: false }],
}
const REVERIFY_PASS: ClaimReverifyVerdict = {
  verdict: 'pass',
  findings: [],
  perClaim: [{ claim: 'x', probe: 'curl', reran: true, corroborated: true }],
}

describe('QualityGateArbiter — producer≠verifier spawn seam (Track 1 / 1B)', () => {
  let testDb: TestDb
  let tmpRoot: string
  let projectRoot: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    tmpRoot = mkdtempSync(join(tmpdir(), 'qg-reverify-wt-'))
    projectRoot = makeProjectRoot()
  })
  afterEach(() => {
    testDb.close()
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true })
  })

  function build(
    claimEnv: Record<string, string>,
    recorded: Recorded,
    backend?: ClaimVerifierBackend,
    testOut?: RunResult,
  ) {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded, testOut ? { test: testOut } : {}),
      worktreeBase: tmpRoot,
      claimVerifier: {
        env: env(claimEnv),
        ...(backend ? { makeVerifierBackend: () => backend } : {}),
      },
    })
    return { arbiter, eventLog }
  }

  // ── Default-OFF inertness ─────────────────────────────────────────────────

  it('S0: backend WIRED but SCNS_QG_CLAIM_SPAWN unset ⇒ backend NEVER called (byte-identical to core)', async () => {
    const recorded: Recorded = { cmds: [] }
    const spy = { calls: 0, disposed: 0 }
    const { arbiter } = build({}, recorded, fakeBackend(REVERIFY_FAIL, spy)) // measure ON, spawn OFF
    // An EVIDENCED analysis the core passes; the (fail-returning) backend must not run.
    const verdict = await arbiter.handleTeamCompletion(analysisCompletion(EVIDENCED))
    arbiter.stop()

    expect(spy.calls).toBe(0)
    expect(verdict.passed).toBe(true)
    expect(verdict.reason).toBe('claim-verifier:pass')
    expect(verdict.claimReverify).toBeUndefined()
  })

  it('S0b: spawn ON but NO backend wired ⇒ core governs (seam is inert without a backend)', async () => {
    const recorded: Recorded = { cmds: [] }
    const { arbiter } = build({ SCNS_QG_CLAIM_SPAWN: '1' }, recorded) // no backend
    const verdict = await arbiter.handleTeamCompletion(analysisCompletion(OVERCLAIM))
    arbiter.stop()

    expect(verdict.reason).toBe('claim-verifier:fail') // core, not reverify
    expect(verdict.claimReverify).toBeUndefined()
  })

  // ── Analysis (no-diff) branch: spawn governs ──────────────────────────────

  it('S1: analysis + spawn ON + backend FAIL ⇒ governs FAIL even though the core PASSED the discipline', async () => {
    const recorded: Recorded = { cmds: [] }
    const spy = { calls: 0, disposed: 0 }
    const { arbiter, eventLog } = build(
      { SCNS_QG_CLAIM_SPAWN: '1' },
      recorded,
      fakeBackend(REVERIFY_FAIL, spy),
    )
    // EVIDENCED passes the deterministic core, but the independent re-run contradicts a row.
    const verdict = await arbiter.handleTeamCompletion(analysisCompletion(EVIDENCED))
    arbiter.stop()

    expect(spy.calls).toBe(1)
    expect(spy.disposed).toBe(1)
    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('claim-reverify:fail')
    expect(verdict.claimVerifier?.kind).toBe('pass') // core pre-filter still recorded
    expect(verdict.claimReverify?.verdict).toBe('fail')
    const evt = lastVerdictEvent(eventLog)
    expect(evt.claimVerifierKind).toBe('pass')
    expect(evt.claimReverifyKind).toBe('fail')
  })

  it('S2: analysis + spawn ON + backend PASS ⇒ PASS (probes re-ran + corroborated)', async () => {
    const recorded: Recorded = { cmds: [] }
    const spy = { calls: 0, disposed: 0 }
    const { arbiter } = build({ SCNS_QG_CLAIM_SPAWN: '1' }, recorded, fakeBackend(REVERIFY_PASS, spy))
    const verdict = await arbiter.handleTeamCompletion(analysisCompletion(OVERCLAIM))
    arbiter.stop()

    expect(spy.calls).toBe(1)
    expect(verdict.passed).toBe(true)
    expect(verdict.reason).toBe('claim-reverify:pass')
  })

  it('S3: analysis + spawn ON but core found 0 claims ⇒ backend NOT called (pre-filter short-circuit)', async () => {
    const recorded: Recorded = { cmds: [] }
    const spy = { calls: 0, disposed: 0 }
    const { arbiter } = build({ SCNS_QG_CLAIM_SPAWN: '1' }, recorded, fakeBackend(REVERIFY_FAIL, spy))
    const clean = analysisCompletion('The investigation summarized three files. Nothing to report.')
    const verdict = await arbiter.handleTeamCompletion(clean)
    arbiter.stop()

    expect(spy.calls).toBe(0)
    expect(verdict.passed).toBe(true)
    expect(verdict.reason).toBe('claim-verifier:pass')
  })

  it('S4: analysis + spawn ON + backend degrades to needs-evidence ⇒ FAIL (never silent pass)', async () => {
    const recorded: Recorded = { cmds: [] }
    const spy = { calls: 0, disposed: 0 }
    const degraded: ClaimReverifyVerdict = {
      verdict: 'needs-evidence',
      findings: ['verifier timed out after 120000ms'],
      perClaim: [],
      degradedReason: 'verifier-timeout',
    }
    const { arbiter, eventLog } = build(
      { SCNS_QG_CLAIM_SPAWN: '1' },
      recorded,
      fakeBackend(degraded, spy),
    )
    const verdict = await arbiter.handleTeamCompletion(analysisCompletion(EVIDENCED))
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('claim-reverify:needs-evidence')
    expect(verdict.claimReverify?.degradedReason).toBe('verifier-timeout')
    expect(lastVerdictEvent(eventLog).claimReverifyDegraded).toBe('verifier-timeout')
  })

  // ── Code PASS branch: spawn feeds the enforce-gated downgrade ─────────────

  it('S5: code PASS + spawn ON + ENFORCE + backend FAIL ⇒ DOWNGRADE (claim-reverify:fail), not committed', async () => {
    const recorded: Recorded = { cmds: [] }
    const spy = { calls: 0, disposed: 0 }
    const { arbiter } = build(
      { SCNS_QG_CLAIM_SPAWN: '1', SCNS_QG_CLAIM_ENFORCE: '1' },
      recorded,
      fakeBackend(REVERIFY_FAIL, spy),
      ok('ok\n' + OVERCLAIM), // combined output carries a runtime claim ⇒ pre-filter finds it
    )
    const verdict = await arbiter.handleTeamCompletion(codeCompletion())
    arbiter.stop()

    expect(spy.calls).toBe(1)
    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('claim-reverify:fail')
    expect(recorded.cmds.some((c) => c.startsWith('git -c user.name=scns-auto'))).toBe(false)
  })

  it('S6: code PASS + spawn ON + MEASURE-only + backend FAIL ⇒ PASS preserved + claimReverify recorded (advisory)', async () => {
    const recorded: Recorded = { cmds: [] }
    const spy = { calls: 0, disposed: 0 }
    const { arbiter } = build(
      { SCNS_QG_CLAIM_SPAWN: '1' }, // enforce OFF
      recorded,
      fakeBackend(REVERIFY_FAIL, spy),
      ok('ok\n' + OVERCLAIM),
    )
    const verdict = await arbiter.handleTeamCompletion(codeCompletion())
    arbiter.stop()

    expect(spy.calls).toBe(1)
    expect(verdict.passed).toBe(true)
    expect(verdict.claimReverify?.verdict).toBe('fail')
    expect(recorded.cmds.some((c) => c.startsWith('git -c user.name=scns-auto'))).toBe(true)
  })

  // ── The independent judge's caveat: spawn PASS must OVERRIDE a core FAIL ──────

  it('S7: analysis + spawn ON, core FAILs (unlabeled) but spawn PASSES ⇒ governing PASS (spawn overrides pre-filter)', async () => {
    const recorded: Recorded = { cmds: [] }
    const spy = { calls: 0, disposed: 0 }
    const { arbiter, eventLog } = build(
      { SCNS_QG_CLAIM_SPAWN: '1' },
      recorded,
      fakeBackend(REVERIFY_PASS, spy),
    )
    // OVERCLAIM is an unlabeled runtime claim ⇒ the deterministic core returns fail;
    // the independent re-run corroborated it ⇒ the spawn (governing) says pass.
    const verdict = await arbiter.handleTeamCompletion(analysisCompletion(OVERCLAIM))
    arbiter.stop()

    expect(spy.calls).toBe(1)
    expect(verdict.passed).toBe(true)
    expect(verdict.reason).toBe('claim-reverify:pass')
    expect(verdict.claimVerifier?.kind).toBe('fail') // core pre-filter FAIL recorded…
    expect(verdict.claimReverify?.verdict).toBe('pass') // …but the spawn overrides it
    const evt = lastVerdictEvent(eventLog)
    expect(evt.claimVerifierKind).toBe('fail')
    expect(evt.claimReverifyKind).toBe('pass')
  })

  it('S8: code PASS + spawn ON + ENFORCE, core FAILs but spawn PASSES ⇒ NO downgrade, committed (spawn overrides)', async () => {
    const recorded: Recorded = { cmds: [] }
    const spy = { calls: 0, disposed: 0 }
    const { arbiter } = build(
      { SCNS_QG_CLAIM_SPAWN: '1', SCNS_QG_CLAIM_ENFORCE: '1' },
      recorded,
      fakeBackend(REVERIFY_PASS, spy),
      ok('ok\n' + OVERCLAIM), // core finds an unlabeled claim ⇒ core fail
    )
    const verdict = await arbiter.handleTeamCompletion(codeCompletion())
    arbiter.stop()

    expect(spy.calls).toBe(1)
    expect(verdict.passed).toBe(true) // spawn PASS ⇒ no enforce downgrade
    expect(verdict.claimReverify?.verdict).toBe('pass')
    expect(recorded.cmds.some((c) => c.startsWith('git -c user.name=scns-auto'))).toBe(true)
  })
})
