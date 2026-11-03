/**
 * Track 1 / 1B — LIVE end-to-end: the producer≠verifier spawn through the REAL
 * dispatcher → arbiter subscription, with a REAL copilot spawn re-running a real
 * probe. GATED behind SCNS_LIVE_REVERIFY=1 (never runs in CI — it forks copilot
 * and hits an isolated broker on :3477).
 *
 * This closes the gap the previous session left: a REAL `team_completed` event
 * dispatched into a running arbiter, whose analysis branch consults the spawn
 * seam, whose backend spawns a real independent verifier that RE-RUNS the cited
 * probe and contradicts a FALSE quoted row ⇒ the verdict event carries
 * claimReverifyKind=fail. Validates (b) the 1B gate plumbing live and (c) the new
 * producer≠verifier spawn, end-to-end, on the real code path.
 *
 * Preconditions (set up by the operator before running):
 *   - an isolated broker is listening on :3477 (SCNS_HOME/BROKER_DB_PATH isolated),
 *   - `dist/` is freshly built,
 *   - SCNS_LIVE_REVERIFY=1.
 * Run: SCNS_LIVE_REVERIFY=1 SCNS_QG_CLAIM_SPAWN=1 npx vitest run <thisfile>
 */
import { describe, it, expect } from 'vitest'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../../src/broker/event-dispatcher.js'
import { createQualityGateArbiter } from '../../../../src/broker/services/quality-gate-arbiter.js'
import {
  createSpawnVerifierBackend,
  createDefaultVerifierSpawner,
} from '../../../../src/broker/services/claim-verifier-backend.js'
import type { TeamCompletionData } from '../../../../src/broker/services/team-lifecycle.js'

const LIVE = process.env.SCNS_LIVE_REVERIFY === '1'
const BROKER = process.env.SCNS_ISO_BROKER_URL ?? 'http://127.0.0.1:3477'

function analysisCompletion(teamId: string, tail: string): TeamCompletionData {
  return {
    teamId,
    memberSessionIds: ['r1'],
    stagedDiff: '',
    artifacts: [
      {
        sessionId: 'r1',
        name: 'brain-researcher-live',
        role: 'scns-researcher',
        launchMethod: 'acp',
        exitReason: 'completed',
        logPath: null,
        logSizeBytes: null,
      },
    ],
    logs: [{ sessionId: 'r1', name: 'brain-researcher-live', tail }],
    aggregateOutcome: 'success',
    completedAt: new Date().toISOString(),
  }
}

describe.skipIf(!LIVE)('LIVE producer≠verifier spawn — real dispatcher → arbiter → real spawn', () => {
  it('a FALSE runtime claim is caught by an independent re-run (claim-reverify:fail)', async () => {
    const testDb = createBrokerTestDb()
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot: process.cwd(),
      claimVerifier: {
        env: { ...process.env, SCNS_QG_CLAIM_SPAWN: '1' } as NodeJS.ProcessEnv,
        makeVerifierBackend: () =>
          createSpawnVerifierBackend({
            spawnVerifier: createDefaultVerifierSpawner({
              command: 'copilot',
              args: ['--allow-all-tools', '-p'],
              env: { ...process.env, SCNS_BROKER_URL: BROKER } as NodeJS.ProcessEnv,
            }),
            timeoutMs: 170_000,
          }),
      },
    })

    const teamId = `live-reverify-${Date.now().toString(36)}`
    // A researcher output whose quoted row is DURABLY FALSE: it claims the
    // embeddings component runs live and is "ready" — the isolated broker's
    // embeddings are "idle" (empty vault ⇒ they never populate). The
    // deterministic core PASSES this (it has a [live-confirmed] label + a quoted
    // "ready"); only an independent re-run of the cited probe catches the lie.
    const falseOutput =
      `The isolated SCNS broker's embeddings component runs live and is fully "ready" ` +
      `[live-confirmed] — verified with \`curl -s ${BROKER}/api/health\`.`

    // Drive the REAL dispatcher subscription (not handleTeamCompletion directly).
    eventLog.teamCompleted(null, analysisCompletion(teamId, falseOutput) as unknown as Record<string, unknown>)

    // Poll the event log for the arbiter's verdict (the spawn takes ~30-90s).
    const deadline = Date.now() + 180_000
    let verdictEvt: Record<string, unknown> | null = null
    while (Date.now() < deadline) {
      const evts = eventLog
        .since(0)
        .filter((e) => e.event_type === 'quality_gate_verdict')
      if (evts.length > 0) {
        verdictEvt = JSON.parse(evts[evts.length - 1]!.payload) as Record<string, unknown>
        break
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    arbiter.stop()
    testDb.close()

    expect(verdictEvt).not.toBeNull()
    // The core pre-filter recorded the claim; the independent re-run governs.
    expect(verdictEvt!.claimReverifyKind).toBe('fail')
    expect(verdictEvt!.passed).toBe(false)
    expect(String(verdictEvt!.reason)).toMatch(/claim-reverify/)
  }, 200_000)
})
