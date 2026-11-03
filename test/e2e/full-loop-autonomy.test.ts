/**
 * Phase 13.8 — Full-loop autonomy regression.
 *
 * Drives the complete autonomous pipeline on a fresh isolated broker with a
 * synthetic forcing function:
 *
 *   seed Suggestion → promoter picks it up as a PendingTask → team_completed
 *   event dispatched with a staged diff → quality-gate arbiter arbitrates →
 *   PASS commits on scns/auto/<slug> and marks suggestion `implemented`
 *   OR FAIL records a negative-memory and marks suggestion `rejected`.
 *
 * The test runs with `skipCommands: true` on the QG arbiter so it is fast and
 * deterministic (no real `npm test` / `npm run lint` inside the worktree). The
 * real command path is already covered by Phase 13.5 quality-gate-arbiter tests.
 *
 * Live verification against a real launchd broker is performed separately via
 * scripts/verify-phase-13-8.sh — this test is the forcing function.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'
import {
  createQualityGateArbiter,
  type QualityGateArbiter,
} from '../../src/broker/services/quality-gate-arbiter.js'
import { createSuggestionStore } from '../../src/suggest/suggestion-store.js'
import { createVault } from '../../src/memory/vault.js'
import { createNegativeMemoryStore } from '../../src/memory/negative-memory-store.js'
import { promoteSuggestions } from '../../src/brain/suggestion-promoter.js'
import type { Suggestion } from '../../src/suggest/types.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeSuggestion(partial: Partial<Suggestion> = {}): Suggestion {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    type: 'skill',
    title: partial.title ?? 'auto-format-markdown-on-save',
    description:
      partial.description ??
      'Format markdown files automatically on save using prettier --parser markdown.',
    status: 'pending',
    confidence: partial.confidence ?? 0.92,
    evidence: partial.evidence ?? [
      {
        source: 'pattern-detector',
        detail: 'User manually runs prettier on markdown ≥3×/week',
        observedAt: now,
        weight: 0.8,
      },
    ],
    tags: partial.tags ?? ['phase-13-8', 'synthetic'],
    createdAt: now,
    updatedAt: now,
    actionable: partial.actionable ?? true,
    estimatedComplexity: partial.estimatedComplexity ?? 'solo',
    ...partial,
  } as Suggestion
}

function initProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scns-full-loop-root-'))
  execSync('git init --quiet -b main', { cwd: dir })
  execSync('git config user.email "scns-test@localhost"', { cwd: dir })
  execSync('git config user.name "scns-test"', { cwd: dir })
  execSync('git commit --quiet --allow-empty -m "initial"', { cwd: dir })
  return dir
}

/**
 * Build a `git apply --index`-able diff that adds a new file to the worktree.
 * The diff targets a file that does NOT exist on HEAD so the worktree (which
 * branches from HEAD) has a clean apply path.
 */
function makeNewFileDiff(filename: string, body: string): string {
  const bodyLines = body.split('\n')
  const count = bodyLines.length
  const plusLines = bodyLines.map((l) => '+' + l).join('\n')
  return [
    `diff --git a/${filename} b/${filename}`,
    `new file mode 100644`,
    `index 0000000..1111111`,
    `--- /dev/null`,
    `+++ b/${filename}`,
    `@@ -0,0 +1,${count} @@`,
    plusLines,
    '',
  ].join('\n')
}

function listBranches(projectRoot: string): string[] {
  const out = execSync('git branch --list', { cwd: projectRoot, encoding: 'utf8' })
  return out
    .split('\n')
    .map((l) => l.replace(/^\*?\s*/, '').trim())
    .filter(Boolean)
}

function cleanupAutoBranches(projectRoot: string): void {
  for (const b of listBranches(projectRoot)) {
    if (b.startsWith('scns/auto/')) {
      try {
        execSync(`git branch -D ${b}`, { cwd: projectRoot, stdio: 'ignore' })
      } catch {
        /* ignore */
      }
    }
  }
}

// ── Test setup ───────────────────────────────────────────────────────

describe('Phase 13.8 full-loop autonomy regression', () => {
  let tmpRoot: string
  let projectRoot: string
  let suggestionsDir: string
  let vaultDir: string
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string
  let dispatcher: ReturnType<typeof createEventDispatcher>
  let eventLog: ReturnType<typeof createEventLog>
  let suggestionStore: ReturnType<typeof createSuggestionStore>
  let vault: ReturnType<typeof createVault>
  let negMemStore: ReturnType<typeof createNegativeMemoryStore>
  let arbiter: QualityGateArbiter

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'scns-full-loop-'))
    suggestionsDir = join(tmpRoot, 'suggestions')
    vaultDir = join(tmpRoot, 'vault')
    projectRoot = initProjectRoot()

    db = openDatabase(':memory:')
    dispatcher = createEventDispatcher()
    eventLog = createEventLog(db, dispatcher)
    broker = createBrokerServer(db, eventLog, undefined, dispatcher, { authToken: null })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`

    suggestionStore = createSuggestionStore({ rootDir: suggestionsDir })
    vault = createVault({ rootDir: vaultDir })
    negMemStore = createNegativeMemoryStore(vault)

    arbiter = createQualityGateArbiter({
      db,
      eventLog,
      dispatcher,
      projectRoot,
      suggestionStore: {
        get: (id) => suggestionStore.get(id),
        updateStatus: (id, status, reason) =>
          suggestionStore.updateStatus(id, status, reason),
      },
      // Intentionally omit executor: PASS path still commits, we just don't
      // want the real artifact generator touching the test's home directory.
      negativeMemoryStore: negMemStore,
      skipCommands: true,
      worktreeBase: tmpRoot,
    })
  })

  afterAll(async () => {
    arbiter.stop()
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
    try {
      cleanupAutoBranches(projectRoot)
    } catch {
      /* best effort */
    }
    rmSync(tmpRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  // ── Bridge 1: suggestion → task promotion ──────────────────────────

  it('promoter bridges: high-confidence actionable suggestion becomes a PendingTask at L2', () => {
    const sugg = makeSuggestion({ title: 'promoter-bridge-proof', confidence: 0.9 })
    suggestionStore.save(sugg)

    const pending = suggestionStore.list('pending')
    expect(pending.find((s) => s.id === sugg.id)).toBeDefined()

    const result = promoteSuggestions({
      autonomyLevel: 2,
      maxConcurrentSessions: 10,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: pending,
    })

    const match = result.promoted.find((p) => p.sourceSuggestionId === sugg.id)
    expect(match).toBeDefined()
    expect(match!.task.id).toBe(`task-sugg-${sugg.id}`)
    expect(result.autoApprovedIds).toContain(sugg.id)

    // Cleanup: mark implemented so it doesn't leak into subsequent tests.
    suggestionStore.updateStatus(sugg.id, 'implemented', 'bridge-proof-done')
  })

  // ── PASS loop ──────────────────────────────────────────────────────

  it('PASS: team_completed with valid diff → commits scns/auto/<slug>, marks suggestion implemented', async () => {
    const sugg = makeSuggestion({ title: 'pass-loop-proof' })
    suggestionStore.save(sugg)

    const teamId = `team-task-sugg-${sugg.id}`
    const stagedDiff = makeNewFileDiff(
      `phase-13-8-${sugg.id.slice(0, 8)}.txt`,
      `Synthetic PASS artifact for suggestion ${sugg.id}.\nGenerated by full-loop-autonomy test.`,
    )

    const branchesBefore = listBranches(projectRoot).filter((b) => b.startsWith('scns/auto/'))

    // Drive via the real event log so team_completed is persisted + dispatched.
    const verdictPromise = new Promise<{ payload: string }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('timed out waiting for PASS verdict')),
        15_000,
      )
      const unsub = dispatcher.subscribe(
        { event_types: ['quality_gate_verdict'] },
        (evt) => {
          try {
            const p = JSON.parse(evt.payload) as { team_id?: string }
            if (p.team_id === teamId) {
              clearTimeout(timeout)
              unsub()
              resolve({ payload: evt.payload })
            }
          } catch {
            /* skip */
          }
        },
      )
    })

    eventLog.teamCompleted(null, {
      teamId,
      memberSessionIds: [`agent-a-${sugg.id}`, `agent-b-${sugg.id}`],
      stagedDiff,
      artifacts: [],
      logs: [],
      aggregateOutcome: 'success',
      completedAt: new Date().toISOString(),
    })

    const verdictEvent = await verdictPromise
    const verdict = JSON.parse(verdictEvent.payload) as {
      passed: boolean
      reason: string
      score: number
      branch: string | null
      sourceSuggestionId: string | null
      qualityCheckId: string | null
    }

    expect(verdict.passed).toBe(true)
    expect(verdict.branch).toMatch(/^scns\/auto\//)
    expect(verdict.sourceSuggestionId).toBe(sugg.id)
    expect(verdict.qualityCheckId).toBeTruthy()

    // 1) Branch created on real git repo
    const branchesAfter = listBranches(projectRoot).filter((b) => b.startsWith('scns/auto/'))
    expect(branchesAfter.length).toBe(branchesBefore.length + 1)
    expect(branchesAfter).toContain(verdict.branch!)

    // 2) Commit on that branch has our trailer
    const log = execSync(
      `git log --format=%B -n 1 ${verdict.branch}`,
      { cwd: projectRoot, encoding: 'utf8' },
    )
    expect(log).toContain('Co-authored-by: Copilot')
    expect(log).toContain(sugg.id)

    // 3) quality_checks row persisted (team:<teamId>, passed=1)
    const row = db
      .prepare('SELECT * FROM quality_checks WHERE id = ?')
      .get(verdict.qualityCheckId!) as Record<string, unknown>
    expect(row).toBeDefined()
    expect(row.passed).toBe(1)
    expect(row.task_type).toBe(`team:${teamId}`)

    // 4) Suggestion moved to `implemented` (via QG arbiter approveSuggestion)
    const after = suggestionStore.get(sugg.id)
    expect(after).not.toBeNull()
    expect(after!.status).toBe('implemented')
    expect(after!.reviewReason).toBe('qg-pass')

    // 5) quality_gate_verdict event logged
    const res = await fetch(`${baseUrl}/api/events/since/0`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: Array<{ event_type: string; payload: string }> }
    const verdicts = body.events.filter((e) => e.event_type === 'quality_gate_verdict')
    const passVerdict = verdicts.find((e) => {
      try {
        const p = JSON.parse(e.payload) as { team_id?: string; passed?: boolean }
        return p.team_id === teamId && p.passed === true
      } catch {
        return false
      }
    })
    expect(passVerdict).toBeDefined()
  })

  // ── FAIL loop (drives via real event dispatcher to exercise wiring) ─

  it('FAIL: team_completed event with empty diff → suggestion rejected + negative memory written', async () => {
    const sugg = makeSuggestion({
      title: 'fail-loop-proof',
      description: 'Synthetic FAIL artifact — QG should reject due to empty staged diff.',
    })
    suggestionStore.save(sugg)

    const teamId = `team-task-sugg-${sugg.id}`

    // Subscribe for the arbiter's verdict so we can await the async handler.
    const verdictPromise = new Promise<{ payload: string; id: number }>((resolve) => {
      const unsub = dispatcher.subscribe(
        { event_types: ['quality_gate_verdict'] },
        (evt) => {
          try {
            const p = JSON.parse(evt.payload) as { team_id?: string }
            if (p.team_id === teamId) {
              unsub()
              resolve({ payload: evt.payload, id: evt.id })
            }
          } catch {
            /* skip malformed */
          }
        },
      )
    })

    // Drive via the real event log → dispatcher → arbiter subscription path.
    eventLog.teamCompleted(null, {
      teamId,
      memberSessionIds: [`agent-fail-${sugg.id}`],
      stagedDiff: '',
      artifacts: [],
      logs: [],
      aggregateOutcome: 'failed',
      completedAt: new Date().toISOString(),
    })

    const verdictEvent = await Promise.race([
      verdictPromise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for verdict')), 15_000),
      ),
    ])
    const verdictPayload = JSON.parse(verdictEvent.payload) as {
      team_id: string
      passed: boolean
      reason: string
      sourceSuggestionId: string | null
      qualityCheckId: string | null
    }
    expect(verdictPayload.passed).toBe(false)
    expect(verdictPayload.reason).toBe('no-diff')
    expect(verdictPayload.sourceSuggestionId).toBe(sugg.id)

    // quality_checks row exists (passed=0)
    const row = db
      .prepare('SELECT * FROM quality_checks WHERE id = ?')
      .get(verdictPayload.qualityCheckId!) as Record<string, unknown>
    expect(row).toBeDefined()
    expect(row.passed).toBe(0)

    // Suggestion moved to rejected
    const after = suggestionStore.get(sugg.id)
    expect(after).not.toBeNull()
    expect(after!.status).toBe('rejected')
    expect(after!.reviewReason).toContain('qg-fail')

    // Negative memory recorded
    const negDir = join(vaultDir, 'negative')
    expect(existsSync(negDir)).toBe(true)
    const negFiles = readdirSync(negDir).filter((f) => f.endsWith('.md'))
    expect(negFiles.length).toBeGreaterThanOrEqual(1)
  })

  // ── Cross-cutting evidence ─────────────────────────────────────────

  it('exposes PASS+FAIL evidence via live HTTP broker (curl-equivalent)', async () => {
    // team_completed events ≥ 2
    const evRes = await fetch(`${baseUrl}/api/events/since/0`)
    const evBody = (await evRes.json()) as { events: Array<{ event_type: string }> }
    const completions = evBody.events.filter((e) => e.event_type === 'team_completed')
    const verdicts = evBody.events.filter((e) => e.event_type === 'quality_gate_verdict')
    expect(completions.length).toBeGreaterThanOrEqual(2)
    expect(verdicts.length).toBeGreaterThanOrEqual(2)

    // quality_checks table has ≥ 2 rows (PASS + FAIL)
    const qcCount = db
      .prepare('SELECT COUNT(*) AS n FROM quality_checks')
      .get() as { n: number }
    expect(qcCount.n).toBeGreaterThanOrEqual(2)

    // At least one implemented + one rejected suggestion in the store
    const implemented = suggestionStore.list('implemented')
    const rejected = suggestionStore.list('rejected')
    expect(implemented.length).toBeGreaterThanOrEqual(1)
    expect(rejected.length).toBeGreaterThanOrEqual(1)

    // scns/auto/* branch exists for the PASS
    const autoBranches = listBranches(projectRoot).filter((b) => b.startsWith('scns/auto/'))
    expect(autoBranches.length).toBeGreaterThanOrEqual(1)
  })
})
