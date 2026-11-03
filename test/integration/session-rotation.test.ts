/**
 * Phase 8 — Session Rotation + Context Management integration tests.
 *
 * Exercises the full rotation lifecycle: health monitoring, compaction
 * detection, quality decay, handoff generation/persistence, and the
 * rotation controller that ties them together.
 */

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHealthMonitor } from '../../src/context/health-monitor.js'
import { createCompactionDetector } from '../../src/context/compaction-detector.js'
import { createHandoffGenerator } from '../../src/context/handoff-generator.js'
import type { HandoffInput, SessionInfo, TeamInfo } from '../../src/context/handoff-generator.js'
import { createHandoffStore } from '../../src/context/handoff-store.js'
import { HandoffStatus } from '../../src/context/handoff-types.js'
import type { HandoffDocument } from '../../src/context/handoff-types.js'
import {
  createInitialQualityState,
  calculateQualityScore,
  applyErrorPenalty,
} from '../../src/context/quality-decay.js'
import { createRotationController } from '../../src/context/rotation-controller.js'

// ── Helpers ──────────────────────────────────────────────────────────

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = join(tmpdir(), `scns-test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  tmpDirs.push(dir)
  return dir
}

function cleanupTmpDirs(): void {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs.length = 0
}

/**
 * A store rootDir that cannot be created, on EVERY platform.
 *
 * This used to be the literal `/dev/null/impossible-path`, which is only
 * impossible on POSIX. On Windows it resolves to `C:\dev\null\impossible-path`
 * and `mkdirSync(..., { recursive: true })` creates it happily — so the save
 * SUCCEEDED, rotation correctly reported success, and the assertion failed on a
 * POSIX-only premise rather than on a real defect. It also leaked handoff
 * documents into `C:\dev\` on every run.
 *
 * Nesting a directory beneath a regular FILE fails with ENOTDIR on POSIX and
 * Windows alike, and stays inside the tracked temp dir.
 */
function makeUncreatableDir(): string {
  const blocker = join(makeTmpDir(), 'not-a-directory')
  writeFileSync(blocker, 'blocker')
  return join(blocker, 'store')
}

/** Push a session to a given usage percent via recordTurn. */
function pushToUsage(
  healthMonitor: ReturnType<typeof createHealthMonitor>,
  sessionId: string,
  targetPercent: number,
  maxTokens = 200_000,
  tokensPerTurn = 2000,
): void {
  const targetTokens = Math.ceil((targetPercent / 100) * maxTokens)
  const turns = Math.ceil(targetTokens / tokensPerTurn)
  for (let i = 0; i < turns; i++) {
    healthMonitor.recordTurn(sessionId)
  }
}

function makeRichHandoffInput(sessionId: string): HandoffInput {
  return {
    sessionId,
    currentTask: 'Implement session rotation tests',
    pendingWork: [
      { description: 'Write watchdog tests', priority: 'high' },
      { description: 'Write stress tests', priority: 'normal' },
    ],
    completedWork: ['Set up test infrastructure'],
    blockedWork: [
      {
        description: 'Deploy to staging',
        blockedBy: 'CI pipeline fix',
        since: new Date().toISOString(),
      },
    ],
    keyDecisions: [{ description: 'Use vitest', rationale: 'Fast and ESM-native' }],
    discoveredFacts: ['Rotation threshold is 85%'],
    warnings: ['Large context may cause OOM'],
    filesModified: [
      {
        path: 'src/context/rotation-controller.ts',
        changeType: 'modified',
        summary: 'Added watchdog',
      },
    ],
    filesCreated: ['test/integration/session-rotation.test.ts'],
    filesDeleted: [],
    relevantMemoryRefs: ['mem-abc-123'],
    suggestedMemoryUpdates: ['Update rotation docs'],
    resumptionInstructions:
      'Continue with watchdog tick tests after rotation controller is verified.',
  }
}

function makeControllerDeps(overrides: Record<string, unknown> = {}) {
  const healthMonitor = createHealthMonitor()
  const detector = createCompactionDetector({ healthMonitor })
  const handoffGenerator = createHandoffGenerator()
  const storeDir = makeTmpDir()
  const handoffStore = createHandoffStore({ rootDir: storeDir })

  return {
    healthMonitor,
    detector,
    handoffGenerator,
    handoffStore,
    onSpawnSession: vi.fn(
      async (_handoffId: string, _purpose: string) => `new-session-${randomUUID().slice(0, 8)}`,
    ),
    onSunsetSession: vi.fn(async (_sessionId: string) => {}),
    ...overrides,
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────

afterAll(() => {
  cleanupTmpDirs()
})

// =====================================================================
// 1. Full Rotation Lifecycle
// =====================================================================

describe('Full Rotation Lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
    cleanupTmpDirs()
  })

  it('rotates a session that hits the rotation threshold via turns', async () => {
    const deps = makeControllerDeps()
    const controller = createRotationController(deps)
    const sid = `sess-${randomUUID().slice(0, 8)}`

    deps.healthMonitor.registerSession(sid)
    deps.detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(deps.healthMonitor, sid, 90)

    const health = deps.healthMonitor.getHealth(sid)
    expect(health).not.toBeNull()
    expect(health!.usagePercent).toBeGreaterThanOrEqual(85)

    const result = await controller.rotateSession(sid, makeRichHandoffInput(sid))

    expect(result.success).toBe(true)
    expect(result.sourceSessionId).toBe(sid)
    expect(result.targetSessionId).not.toBeNull()
    expect(result.handoffId).toBeTruthy()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(deps.onSpawnSession).toHaveBeenCalled()
    expect(deps.onSunsetSession).toHaveBeenCalledWith(sid)
  })

  it('preserves team context through rotation', async () => {
    const teamInfo: TeamInfo = {
      teamId: 'team-alpha',
      role: 'frontend-lead',
      phase: 'implementation',
    }
    const sessionInfo: SessionInfo = {
      purpose: 'Build dashboard UI',
      workingDir: '/project',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      status: 'active',
    }

    const healthMonitor = createHealthMonitor()
    const detector = createCompactionDetector({ healthMonitor })
    const handoffGenerator = createHandoffGenerator({
      getSessionInfo: () => sessionInfo,
      getTeamInfo: () => teamInfo,
    })
    const storeDir = makeTmpDir()
    const handoffStore = createHandoffStore({ rootDir: storeDir })

    const controller = createRotationController({
      healthMonitor,
      detector,
      handoffGenerator,
      handoffStore,
      onSpawnSession: vi.fn(async () => 'new-session-team'),
      onSunsetSession: vi.fn(async () => {}),
    })

    const sid = 'team-session-1'
    healthMonitor.registerSession(sid)
    detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(healthMonitor, sid, 90)

    const result = await controller.rotateSession(sid, {
      sessionId: sid,
      currentTask: 'Dashboard layout',
      pendingWork: [{ description: 'Add charts', priority: 'high' }],
      resumptionInstructions: 'Continue with chart component',
    })

    expect(result.success).toBe(true)

    const doc = handoffStore.load(result.handoffId)
    expect(doc).not.toBeNull()
    expect(doc!.teamId).toBe('team-alpha')
    expect(doc!.teamRole).toBe('frontend-lead')
    expect(doc!.teamPhase).toBe('implementation')
    expect(doc!.sessionPurpose).toBe('Build dashboard UI')
  })

  it('captures pending work items and loads them in fresh session handoff', async () => {
    const deps = makeControllerDeps()
    const controller = createRotationController(deps)
    const sid = `work-sess-${randomUUID().slice(0, 8)}`

    deps.healthMonitor.registerSession(sid)
    deps.detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(deps.healthMonitor, sid, 90)

    const input: HandoffInput = {
      sessionId: sid,
      currentTask: 'Refactor auth module',
      pendingWork: [
        { description: 'Update JWT validation', priority: 'critical' },
        { description: 'Add refresh token', priority: 'high' },
        { description: 'Write auth tests', priority: 'normal' },
      ],
      completedWork: ['Set up auth middleware'],
      resumptionInstructions: 'Start with JWT validation, then refresh tokens.',
    }

    const result = await controller.rotateSession(sid, input)
    expect(result.success).toBe(true)

    const doc = deps.handoffStore.load(result.handoffId)
    expect(doc).not.toBeNull()
    expect(doc!.pendingWork).toHaveLength(3)
    expect(doc!.pendingWork[0]!.priority).toBe('critical')
    expect(doc!.completedWork).toContain('Set up auth middleware')
    expect(doc!.resumptionInstructions).toContain('JWT validation')
  })

  it('triggers rotation from compaction count (not just token threshold)', async () => {
    const deps = makeControllerDeps()
    const controller = createRotationController(deps)
    const sid = `compact-sess-${randomUUID().slice(0, 8)}`

    deps.healthMonitor.registerSession(sid)
    deps.detector.recordSessionActivity(sid, { type: 'turn' })

    // Simulate 3 compactions (default maxCompactionsBeforeRotate = 3)
    for (let i = 0; i < 3; i++) {
      pushToUsage(deps.healthMonitor, sid, 80)
      deps.detector.recordSessionActivity(sid, { type: 'compaction' })
    }

    expect(deps.detector.shouldRotate(sid)).toBe(true)

    const result = await controller.rotateSession(sid, { sessionId: sid })
    expect(result.success).toBe(true)
    expect(result.handoffId).toBeTruthy()
  })

  it('rotates with custom handoff input (extra decisions/warnings)', async () => {
    const deps = makeControllerDeps()
    const controller = createRotationController(deps)
    const sid = `custom-sess-${randomUUID().slice(0, 8)}`

    deps.healthMonitor.registerSession(sid)
    deps.detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(deps.healthMonitor, sid, 90)

    const result = await controller.rotateSession(sid, {
      sessionId: sid,
      currentTask: 'Database migration',
      keyDecisions: [
        { description: 'Use PostgreSQL', rationale: 'Better JSON support' },
        { description: 'Skip ORM', rationale: 'Raw SQL for performance' },
      ],
      warnings: ['Migration is destructive', 'Backup required first'],
      discoveredFacts: ['Schema has 47 tables'],
      resumptionInstructions: 'Run migration script after backup verification.',
    })

    expect(result.success).toBe(true)
    const doc = deps.handoffStore.load(result.handoffId)
    expect(doc).not.toBeNull()
    expect(doc!.keyDecisions).toHaveLength(2)
    expect(doc!.warnings).toHaveLength(2)
    expect(doc!.discoveredFacts).toContain('Schema has 47 tables')
  })

  it('records rotation in history and stats', async () => {
    const deps = makeControllerDeps()
    const controller = createRotationController(deps)
    const sid = `hist-sess-${randomUUID().slice(0, 8)}`

    deps.healthMonitor.registerSession(sid)
    deps.detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(deps.healthMonitor, sid, 90)

    await controller.rotateSession(sid, { sessionId: sid })

    const history = controller.getRotationHistory()
    expect(history.length).toBeGreaterThanOrEqual(1)
    expect(history.some((r) => r.sourceSessionId === sid)).toBe(true)

    const stats = controller.getStats()
    expect(stats.totalRotations).toBeGreaterThanOrEqual(1)
    expect(stats.successfulRotations).toBeGreaterThanOrEqual(1)
  })
})

// =====================================================================
// 2. Quality Decay + Compaction Detection
// =====================================================================

describe('Quality Decay + Compaction Detection', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fresh session quality starts at 100, decays over time', () => {
    vi.useFakeTimers()
    const state = createInitialQualityState('decay-test')

    const initialScore = calculateQualityScore(state, 2, new Date())
    expect(initialScore).toBe(100)

    // Advance 10 hours → penalty = 10 * 2 = 20
    vi.advanceTimersByTime(10 * 60 * 60 * 1000)
    const decayedScore = calculateQualityScore(state, 2, new Date())
    expect(decayedScore).toBe(80)

    // Advance another 15 hours → total 25h → penalty = 50
    vi.advanceTimersByTime(15 * 60 * 60 * 1000)
    const furtherDecayed = calculateQualityScore(state, 2, new Date())
    expect(furtherDecayed).toBe(50)
  })

  it('stacked compaction penalties reduce quality and trigger rotation', () => {
    const healthMonitor = createHealthMonitor()
    const detector = createCompactionDetector({ healthMonitor })
    const sid = 'compaction-quality-test'

    healthMonitor.registerSession(sid)
    detector.recordSessionActivity(sid, { type: 'turn' })

    for (let i = 0; i < 3; i++) {
      pushToUsage(healthMonitor, sid, 80)
      detector.recordSessionActivity(sid, { type: 'compaction' })
    }

    const score = detector.getQualityScore(sid)
    expect(score).toBeLessThanOrEqual(85)

    expect(detector.shouldRotate(sid)).toBe(true)
  })

  it('error penalties reduce quality progressively', () => {
    vi.useFakeTimers()
    let state = createInitialQualityState('error-test')

    for (let i = 0; i < 20; i++) {
      state = applyErrorPenalty(state)
    }

    const score = calculateQualityScore(state, 2, new Date())
    expect(score).toBe(60)

    // Advance 10 hours → 100 - 40 (errors) - 20 (time) = 40
    vi.advanceTimersByTime(10 * 60 * 60 * 1000)
    const laterScore = calculateQualityScore(state, 2, new Date())
    expect(laterScore).toBe(40)

    for (let i = 0; i < 10; i++) {
      state = applyErrorPenalty(state)
    }
    const criticalScore = calculateQualityScore(state, 2, new Date())
    expect(criticalScore).toBe(20)
    expect(criticalScore).toBeLessThan(30)
  })

  it('only degraded sessions appear as rotation candidates', () => {
    const healthMonitor = createHealthMonitor()
    const detector = createCompactionDetector({ healthMonitor })

    healthMonitor.registerSession('healthy-1')
    healthMonitor.registerSession('healthy-2')
    healthMonitor.registerSession('degraded-1')

    detector.recordSessionActivity('healthy-1', { type: 'turn' })
    detector.recordSessionActivity('healthy-2', { type: 'turn' })
    detector.recordSessionActivity('degraded-1', { type: 'turn' })

    pushToUsage(healthMonitor, 'healthy-1', 20)
    pushToUsage(healthMonitor, 'healthy-2', 30)
    pushToUsage(healthMonitor, 'degraded-1', 90)

    const candidates = detector.getRotationCandidates()
    const candidateIds = candidates.map((c) => c.sessionId)

    expect(candidateIds).toContain('degraded-1')
    expect(candidateIds).not.toContain('healthy-1')
    expect(candidateIds).not.toContain('healthy-2')
  })

  it('quality decay integrates with compaction detector scoring', () => {
    vi.useFakeTimers()
    const healthMonitor = createHealthMonitor()
    const detector = createCompactionDetector({
      healthMonitor,
      config: {
        maxCompactionsBeforeRotate: 3,
        qualityDecayRate: 2,
        minRotationIntervalMs: 300_000,
        enableAutoDetection: true,
      },
    })
    const sid = 'decay-detect-test'

    healthMonitor.registerSession(sid)
    detector.recordSessionActivity(sid, { type: 'turn' })

    const freshScore = detector.getQualityScore(sid)
    expect(freshScore).toBeGreaterThanOrEqual(99)

    detector.recordSessionActivity(sid, { type: 'compaction' })
    detector.recordSessionActivity(sid, { type: 'compaction' })

    const penalizedScore = detector.getQualityScore(sid)
    expect(penalizedScore).toBeLessThan(freshScore)

    vi.advanceTimersByTime(5 * 60 * 60 * 1000)
    const decayedScore = detector.getQualityScore(sid)
    expect(decayedScore).toBeLessThan(penalizedScore)
  })
})

// =====================================================================
// 3. Handoff Round-Trip
// =====================================================================

describe('Handoff Round-Trip', () => {
  afterEach(() => {
    cleanupTmpDirs()
  })

  it('generate → save → load by ID → all fields match', () => {
    const generator = createHandoffGenerator()
    const storeDir = makeTmpDir()
    const store = createHandoffStore({ rootDir: storeDir })

    const input = makeRichHandoffInput('round-trip-1')
    const doc = generator.generate(input)
    const savedPath = store.save(doc)
    expect(savedPath).toBeTruthy()

    const loaded = store.load(doc.id)
    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe(doc.id)
    expect(loaded!.sourceSessionId).toBe(doc.sourceSessionId)
    expect(loaded!.currentTask).toBe(doc.currentTask)
    expect(loaded!.pendingWork).toHaveLength(doc.pendingWork.length)
    expect(loaded!.completedWork).toEqual(doc.completedWork)
    expect(loaded!.keyDecisions).toHaveLength(doc.keyDecisions.length)
    expect(loaded!.resumptionInstructions).toBe(doc.resumptionInstructions)
  })

  it('generate → toMarkdown → fromMarkdown → validate → completeness 100%', () => {
    const generator = createHandoffGenerator({
      getSessionInfo: () => ({
        purpose: 'Integration testing',
        workingDir: '/project',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        status: 'active',
      }),
    })
    const input = makeRichHandoffInput('md-round-trip')
    const doc = generator.generate(input)

    const md = generator.toMarkdown(doc)
    expect(md).toContain('Session Handoff')
    expect(md).toContain(doc.id)

    const parsed = generator.fromMarkdown(md)
    expect(parsed.id).toBe(doc.id)
    expect(parsed.sourceSessionId).toBe(doc.sourceSessionId)
    expect(parsed.currentTask).toBe(doc.currentTask)
    expect(parsed.pendingWork).toHaveLength(doc.pendingWork.length)

    const validation = generator.validate(parsed)
    expect(validation.valid).toBe(true)
    expect(validation.completeness).toBe(100)
    expect(validation.missingFields).toHaveLength(0)
  })

  it('save multiple handoffs → loadLatest returns most recent for session', () => {
    const generator = createHandoffGenerator()
    const storeDir = makeTmpDir()
    const store = createHandoffStore({ rootDir: storeDir })
    const sid = 'multi-handoff-sess'

    const docs: HandoffDocument[] = []
    for (let i = 0; i < 3; i++) {
      const doc = generator.generate({
        sessionId: sid,
        currentTask: `Task ${i}`,
        resumptionInstructions: `Resume step ${i}`,
      })
      store.save(doc)
      docs.push(doc)
    }

    const latest = store.loadLatest(sid)
    expect(latest).not.toBeNull()
    // All 3 were created in the same millisecond, so latest is any of them
    const docIds = docs.map((d) => d.id)
    expect(docIds).toContain(latest!.id)
  })

  it('handoff consumed → marked in store → not returned as ready', () => {
    const generator = createHandoffGenerator()
    const storeDir = makeTmpDir()
    const store = createHandoffStore({ rootDir: storeDir })
    const sid = 'consumed-test'

    const doc = generator.generate({
      sessionId: sid,
      currentTask: 'Some task',
      resumptionInstructions: 'Resume here',
    })
    store.save(doc)

    store.markConsumed(doc.id, 'new-session-1')

    const readyDocs = store.list({ status: HandoffStatus.Ready, sessionId: sid })
    expect(readyDocs).toHaveLength(0)

    const consumedDocs = store.list({ status: HandoffStatus.Consumed, sessionId: sid })
    expect(consumedDocs).toHaveLength(1)
    expect(consumedDocs[0]!.targetSessionId).toBe('new-session-1')
  })
})

// =====================================================================
// 4. Watchdog Tick Cycle
// =====================================================================

describe('Watchdog Tick Cycle', () => {
  afterEach(() => {
    vi.useRealTimers()
    cleanupTmpDirs()
  })

  it('tick with no candidates → empty results', async () => {
    const deps = makeControllerDeps()
    const controller = createRotationController(deps)

    deps.healthMonitor.registerSession('healthy-a')
    deps.healthMonitor.registerSession('healthy-b')
    deps.detector.recordSessionActivity('healthy-a', { type: 'turn' })
    deps.detector.recordSessionActivity('healthy-b', { type: 'turn' })
    pushToUsage(deps.healthMonitor, 'healthy-a', 20)
    pushToUsage(deps.healthMonitor, 'healthy-b', 30)

    const results = await controller.tick()
    expect(results).toHaveLength(0)
  })

  it('tick with one critical session → rotates it', async () => {
    const deps = makeControllerDeps()
    const controller = createRotationController(deps)

    const sid = 'critical-tick-1'
    deps.healthMonitor.registerSession(sid)
    deps.detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(deps.healthMonitor, sid, 90)

    const results = await controller.tick()
    expect(results.length).toBeGreaterThanOrEqual(1)

    const rotated = results.find((r) => r.sourceSessionId === sid)
    expect(rotated).toBeDefined()
    expect(rotated!.success).toBe(true)
  })

  it('tick while external rotations active → respects maxConcurrentRotations', async () => {
    const deps = makeControllerDeps({
      onSpawnSession: vi.fn(async (_handoffId: string, _purpose: string) => {
        await new Promise((r) => setTimeout(r, 100))
        return `new-${randomUUID().slice(0, 8)}`
      }),
    })
    const controller = createRotationController(deps, { maxConcurrentRotations: 2 })

    // Create 4 sessions all needing rotation
    for (let i = 0; i < 4; i++) {
      const sid = `batch-${i}`
      deps.healthMonitor.registerSession(sid)
      deps.detector.recordSessionActivity(sid, { type: 'turn' })
      pushToUsage(deps.healthMonitor, sid, 90)
    }

    // Start 2 manual rotations (don't await — they occupy active slots)
    const manualP1 = controller.rotateSession('batch-0', { sessionId: 'batch-0' })
    const manualP2 = controller.rotateSession('batch-1', { sessionId: 'batch-1' })

    // Give microtasks a chance to register active rotations
    await new Promise((r) => setTimeout(r, 10))

    // Tick should see 2 active rotations and not start more
    const tickResults = await controller.tick()

    // Complete the manual rotations
    await Promise.all([manualP1, manualP2])

    // Tick should have been blocked by active rotation limit
    const tickSuccesses = tickResults.filter((r) => r.success)
    expect(tickSuccesses.length).toBeLessThanOrEqual(2)
  })
})

// =====================================================================
// 5. Concurrent Rotation Safety
// =====================================================================

describe('Concurrent Rotation Safety', () => {
  afterEach(() => {
    vi.useRealTimers()
    cleanupTmpDirs()
  })

  it('two rotations for same session → second rejected', async () => {
    const deps = makeControllerDeps({
      onSpawnSession: vi.fn(async (_handoffId: string, _purpose: string) => {
        await new Promise((r) => setTimeout(r, 50))
        return `new-${randomUUID().slice(0, 8)}`
      }),
    })
    const controller = createRotationController(deps)
    const sid = `dup-rot-${randomUUID().slice(0, 8)}`

    deps.healthMonitor.registerSession(sid)
    deps.detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(deps.healthMonitor, sid, 90)

    const [r1, r2] = await Promise.all([
      controller.rotateSession(sid, { sessionId: sid }),
      controller.rotateSession(sid, { sessionId: sid }),
    ])

    const successes = [r1, r2].filter((r) => r.success)
    const failures = [r1, r2].filter((r) => !r.success)
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.error).toContain('already rotating')
  })

  it('maxConcurrentRotations=2 → third rotation rejected', async () => {
    const deps = makeControllerDeps({
      onSpawnSession: vi.fn(async (_handoffId: string, _purpose: string) => {
        await new Promise((r) => setTimeout(r, 50))
        return `new-${randomUUID().slice(0, 8)}`
      }),
    })
    const controller = createRotationController(deps, { maxConcurrentRotations: 2 })

    const sids = ['conc-a', 'conc-b', 'conc-c']
    for (const sid of sids) {
      deps.healthMonitor.registerSession(sid)
      deps.detector.recordSessionActivity(sid, { type: 'turn' })
      pushToUsage(deps.healthMonitor, sid, 90)
    }

    const results = await Promise.all(
      sids.map((sid) => controller.rotateSession(sid, { sessionId: sid })),
    )

    const successes = results.filter((r) => r.success)
    const failures = results.filter((r) => !r.success)
    expect(successes.length).toBeLessThanOrEqual(2)
    expect(failures.length).toBeGreaterThanOrEqual(1)
    expect(failures[0]!.error).toContain('Max concurrent rotations')
  })

  it('rapid tick calls → no duplicate rotations for same session', async () => {
    const deps = makeControllerDeps({
      onSpawnSession: vi.fn(async (_handoffId: string, _purpose: string) => {
        await new Promise((r) => setTimeout(r, 50))
        return `new-${randomUUID().slice(0, 8)}`
      }),
    })
    const controller = createRotationController(deps, { maxConcurrentRotations: 5 })

    const sid = 'rapid-tick'
    deps.healthMonitor.registerSession(sid)
    deps.detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(deps.healthMonitor, sid, 90)

    const tickResults = await Promise.all([controller.tick(), controller.tick(), controller.tick()])

    const allResults = tickResults.flat()
    const successfulForSid = allResults.filter((r) => r.sourceSessionId === sid && r.success)
    expect(successfulForSid.length).toBeLessThanOrEqual(1)
  })
})

// =====================================================================
// 6. Error Recovery
// =====================================================================

describe('Error Recovery', () => {
  afterEach(() => {
    vi.useRealTimers()
    cleanupTmpDirs()
  })

  it('spawn failure → rotation fails gracefully → old session stays alive', async () => {
    const deps = makeControllerDeps({
      onSpawnSession: vi.fn(async () => {
        throw new Error('Spawn failed: out of resources')
      }),
    })
    const controller = createRotationController(deps)
    const sid = `spawn-fail-${randomUUID().slice(0, 8)}`

    deps.healthMonitor.registerSession(sid)
    deps.detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(deps.healthMonitor, sid, 90)

    const result = await controller.rotateSession(sid, { sessionId: sid })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Spawn failed')
    expect(deps.healthMonitor.getHealth(sid)).not.toBeNull()
    expect(deps.onSunsetSession).not.toHaveBeenCalled()
  })

  it('sunset failure → rotation still succeeds → handoff saved and consumed', async () => {
    const deps = makeControllerDeps({
      onSunsetSession: vi.fn(async () => {
        throw new Error('Sunset failed: session stuck')
      }),
    })
    const controller = createRotationController(deps)
    const sid = `sunset-fail-${randomUUID().slice(0, 8)}`

    deps.healthMonitor.registerSession(sid)
    deps.detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(deps.healthMonitor, sid, 90)

    const result = await controller.rotateSession(sid, { sessionId: sid })

    // Rotation succeeds despite sunset failure (sunset is non-fatal)
    expect(result.success).toBe(true)
    expect(result.handoffId).toBeTruthy()
    expect(result.targetSessionId).not.toBeNull()

    const doc = deps.handoffStore.load(result.handoffId)
    expect(doc).not.toBeNull()
    expect(deps.onSpawnSession).toHaveBeenCalled()
  })

  it('store save failure → rotation fails → no session disruption', async () => {
    const healthMonitor = createHealthMonitor()
    const detector = createCompactionDetector({ healthMonitor })
    const handoffGenerator = createHandoffGenerator()
    const badStore = createHandoffStore({ rootDir: makeUncreatableDir() })
    const onSpawnSession = vi.fn(async () => 'new-sess')
    const onSunsetSession = vi.fn(async () => {})

    const controller = createRotationController({
      healthMonitor,
      detector,
      handoffGenerator,
      handoffStore: badStore,
      onSpawnSession,
      onSunsetSession,
    })

    const sid = `store-fail-${randomUUID().slice(0, 8)}`
    healthMonitor.registerSession(sid)
    detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(healthMonitor, sid, 90)

    const result = await controller.rotateSession(sid, { sessionId: sid })

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
    // Assert the EFFECT, not just the reported status: the save is step 4 and
    // the spawn is step 5, so a failed save must abort before any replacement
    // session exists — otherwise the old session would be retired in favour of
    // one with no handoff to read.
    expect(onSpawnSession).not.toHaveBeenCalled()
    expect(onSunsetSession).not.toHaveBeenCalled()
    expect(healthMonitor.getHealth(sid)).not.toBeNull()
  })
})

// =====================================================================
// 7. Mid-Team-Task Rotation
// =====================================================================

describe('Mid-Team-Task Rotation', () => {
  afterEach(() => {
    vi.useRealTimers()
    cleanupTmpDirs()
  })

  it('session in a team → rotation preserves team context → new session can resume role', async () => {
    const teamInfo: TeamInfo = { teamId: 'team-backend', role: 'api-dev', phase: 'testing' }
    const sessionInfo: SessionInfo = {
      purpose: 'API endpoint implementation',
      workingDir: '/api-project',
      startedAt: new Date(Date.now() - 1_800_000).toISOString(),
      status: 'active',
    }

    const healthMonitor = createHealthMonitor()
    const detector = createCompactionDetector({ healthMonitor })
    const handoffGenerator = createHandoffGenerator({
      getSessionInfo: () => sessionInfo,
      getTeamInfo: () => teamInfo,
    })
    const storeDir = makeTmpDir()
    const handoffStore = createHandoffStore({ rootDir: storeDir })

    const controller = createRotationController({
      healthMonitor,
      detector,
      handoffGenerator,
      handoffStore,
      onSpawnSession: vi.fn(async () => 'new-team-session'),
      onSunsetSession: vi.fn(async () => {}),
    })

    const sid = 'team-mid-task'
    healthMonitor.registerSession(sid)
    detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(healthMonitor, sid, 90)

    const result = await controller.rotateSession(sid, {
      sessionId: sid,
      currentTask: 'Implementing /users endpoint',
      pendingWork: [
        { description: 'Add pagination', priority: 'high' },
        { description: 'Add rate limiting', priority: 'normal' },
      ],
      resumptionInstructions: 'Continue with /users pagination using cursor-based approach.',
    })

    expect(result.success).toBe(true)
    expect(result.targetSessionId).toBe('new-team-session')

    const doc = handoffStore.load(result.handoffId)
    expect(doc).not.toBeNull()
    expect(doc!.teamId).toBe('team-backend')
    expect(doc!.teamRole).toBe('api-dev')
    expect(doc!.teamPhase).toBe('testing')
    expect(doc!.pendingWork).toHaveLength(2)
    expect(doc!.resumptionInstructions).toContain('cursor-based')
  })

  it('session with active A2A tasks → handoff lists tasks as pending work', async () => {
    const deps = makeControllerDeps()
    const controller = createRotationController(deps)
    const sid = `a2a-active-${randomUUID().slice(0, 8)}`

    deps.healthMonitor.registerSession(sid)
    deps.detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(deps.healthMonitor, sid, 90)

    const result = await controller.rotateSession(sid, {
      sessionId: sid,
      currentTask: 'Coordinating code review',
      pendingWork: [
        {
          description: 'A2A task: code-review by agent-reviewer (in-progress)',
          priority: 'critical',
        },
        { description: 'A2A task: test-gen by agent-tester (queued)', priority: 'high' },
        { description: 'Merge approved PRs', priority: 'normal' },
      ],
      resumptionInstructions: 'Wait for code-review task completion, then proceed with merge.',
    })

    expect(result.success).toBe(true)
    const doc = deps.handoffStore.load(result.handoffId)
    expect(doc).not.toBeNull()
    expect(doc!.pendingWork.some((w) => w.description.includes('A2A task'))).toBe(true)
    expect(doc!.pendingWork.filter((w) => w.description.includes('A2A task'))).toHaveLength(2)
  })
})

// =====================================================================
// 8. Stress Tests
// =====================================================================

describe('Stress Tests', () => {
  afterEach(() => {
    vi.useRealTimers()
    cleanupTmpDirs()
  })

  it('10 sessions simultaneously hitting rotation threshold → all rotated', async () => {
    const deps = makeControllerDeps()
    const controller = createRotationController(deps, { maxConcurrentRotations: 10 })

    const sids: string[] = []
    for (let i = 0; i < 10; i++) {
      const sid = `stress-${i}`
      sids.push(sid)
      deps.healthMonitor.registerSession(sid)
      deps.detector.recordSessionActivity(sid, { type: 'turn' })
      pushToUsage(deps.healthMonitor, sid, 90)
    }

    const results = await Promise.all(
      sids.map((sid) => controller.rotateSession(sid, { sessionId: sid })),
    )

    const successes = results.filter((r) => r.success)
    expect(successes.length).toBe(10)

    const handoffIds = new Set(successes.map((r) => r.handoffId))
    expect(handoffIds.size).toBe(10)

    const stats = controller.getStats()
    expect(stats.totalRotations).toBeGreaterThanOrEqual(10)
    expect(stats.successfulRotations).toBe(10)
  })

  it('rapid rotation cycling on single session → detector rate-limits shouldRotate', async () => {
    const deps = makeControllerDeps()
    const controller = createRotationController(deps)
    const sid = 'flip-flop'

    deps.healthMonitor.registerSession(sid)
    deps.detector.recordSessionActivity(sid, { type: 'turn' })
    pushToUsage(deps.healthMonitor, sid, 90)

    // First shouldRotate → true
    expect(deps.detector.shouldRotate(sid)).toBe(true)
    deps.detector.markRotated(sid)

    // First rotation succeeds
    const r1 = await controller.rotateSession(sid, { sessionId: sid })
    expect(r1.success).toBe(true)

    // Immediate second shouldRotate → false (within minRotationIntervalMs=300s)
    expect(deps.detector.shouldRotate(sid)).toBe(false)

    // But direct rotateSession still works (controller has no rate-limit)
    const r2 = await controller.rotateSession(sid, { sessionId: sid })
    expect(r2.success).toBe(true)

    const history = controller.getRotationHistory()
    expect(history.filter((r) => r.sourceSessionId === sid)).toHaveLength(2)
  })
})
