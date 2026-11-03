/**
 * Phase 13.12.32 — QG worktree_provisioning observability event.
 *
 * The QG arbiter creates an ephemeral git worktree per verdict, then
 * bridges node_modules so vitest/eslint resolve. Until now the bridge
 * outcome was visible only in the structured pino log (which is
 * destroyed with the broker on restart) — there was no audit trail
 * for the brain or operators to consume. This file pins the contract
 * that exactly one `worktree_provisioning` event fires per verdict,
 * carrying the full BridgeResult-derived payload, and that an emission
 * failure must NOT gate-fail the QG run.
 *
 * Acceptance:
 *   (a) Successful symlink bridge → exactly one `worktree_provisioning`
 *       event with linked:true, reason:'symlinked', vitestResolved:true,
 *       eslintResolved:true, fallbackAttempted:false.
 *   (b) strategy='none' → exactly one event with linked:false,
 *       reason:'strategy-none', fallbackAttempted:false.
 *   (c) A throwing eventLog.worktreeProvisioning must NOT propagate —
 *       the verdict still completes normally.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { itIfSymlink } from '../../../helpers/symlink-support.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../../src/broker/event-dispatcher.js'
import {
  createQualityGateArbiter,
  type RunResult,
} from '../../../../src/broker/services/quality-gate-arbiter.js'
import type { TeamCompletionData } from '../../../../src/broker/services/team-lifecycle.js'

function ok(stdout = '', stderr = ''): RunResult {
  return { ok: true, stdout, stderr }
}

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qg-prov-proj-'))
  const binDir = join(root, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  for (const bin of ['vitest', 'eslint']) {
    writeFileSync(join(binDir, bin), '#!/usr/bin/env node\n', { mode: 0o755 })
  }
  return root
}

function makeRunCommand(): (cmd: string, cwd: string) => RunResult {
  return (cmd: string, _cwd: string): RunResult => {
    if (cmd.startsWith('git worktree add')) {
      const m = cmd.match(/git worktree add -b \S+ "([^"]+)" HEAD/)
      if (m) mkdirSync(m[1], { recursive: true })
      return ok()
    }
    if (cmd.startsWith('git apply')) return ok()
    if (cmd.startsWith('git rev-parse')) return ok('deadbeef\n')
    return ok()
  }
}

function baseCompletion(): TeamCompletionData {
  return {
    teamId: 'team-provisioning',
    memberSessionIds: ['s1'],
    stagedDiff:
      'diff --git a/foo.md b/foo.md\n--- a/foo.md\n+++ b/foo.md\n@@ -1 +1,2 @@\n line\n+new\n',
    artifacts: [],
    logs: [],
    aggregateOutcome: 'success',
    completedAt: new Date().toISOString(),
  }
}

describe('QualityGateArbiter — worktree_provisioning event (Phase 13.12.32)', () => {
  let testDb: TestDb
  let tmpRoot: string
  let projectRoot: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    tmpRoot = mkdtempSync(join(tmpdir(), 'qg-prov-wt-'))
    projectRoot = makeProjectRoot()
  })
  afterEach(() => {
    testDb.close()
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true })
  })

  // Drives the real bridge end to end, so it asserts a genuine symlink.
  itIfSymlink(
    'a) successful symlink bridge emits exactly one event with linked:true, reason:symlinked',
    async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(),
      worktreeBase: tmpRoot,
      skipCommands: true,
    })
    await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    const rows = testDb.db
      .prepare<[], { payload: string }>(
        "SELECT payload FROM events WHERE event_type = 'worktree_provisioning'",
      )
      .all()
    expect(rows).toHaveLength(1)
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>
    expect(payload.team_id).toBe('team-provisioning')
    expect(payload.linked).toBe(true)
    expect(payload.reason).toBe('symlinked')
    expect(payload.vitestResolved).toBe(true)
    expect(payload.eslintResolved).toBe(true)
    expect(payload.fallbackAttempted).toBe(false)
    expect(payload.fallbackOk).toBe(false)
    expect(payload.npmStrategy).toBe('symlink')
    expect(typeof payload.worktreePath).toBe('string')
    expect(payload.binDirRealpath).toBeTruthy()
    },
  )

  it('b) npmStrategy="none" emits one event with linked:false, reason:strategy-none', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(),
      worktreeBase: tmpRoot,
      skipCommands: true,
      npmStrategy: 'none',
    })
    await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    const rows = testDb.db
      .prepare<[], { payload: string }>(
        "SELECT payload FROM events WHERE event_type = 'worktree_provisioning'",
      )
      .all()
    expect(rows).toHaveLength(1)
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>
    expect(payload.linked).toBe(false)
    expect(payload.reason).toBe('strategy-none')
    expect(payload.fallbackAttempted).toBe(false)
    expect(payload.vitestResolved).toBe(false)
    expect(payload.eslintResolved).toBe(false)
  })

  it('c) throwing eventLog.worktreeProvisioning is swallowed; the verdict still completes', async () => {
    const dispatcher = createEventDispatcher()
    const realLog = createEventLog(testDb.db, dispatcher)
    // Wrap only the provisioning emission to throw. The other channels
    // (qualityGateStarted, qualityGateVerdict, etc.) must keep working
    // so the verdict can persist.
    const trappedLog = {
      ...realLog,
      worktreeProvisioning: () => {
        throw new Error('synthetic emission failure')
      },
    }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog: trappedLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(),
      worktreeBase: tmpRoot,
      skipCommands: true,
    })

    // The promise must resolve, NOT reject — observability is fire-and-forget.
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    // Verdict has a real reason (e.g., baseline-clean) — not an error sentinel.
    expect(verdict.teamId).toBe('team-provisioning')
    expect(typeof verdict.reason).toBe('string')
    // No provisioning event was persisted (the throw aborted the insert).
    const rows = testDb.db
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM events WHERE event_type = 'worktree_provisioning'",
      )
      .get()
    expect(rows?.c ?? 0).toBe(0)
  })
})
