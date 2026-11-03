import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HandoffInput } from '../../../src/context/handoff-generator.js'
import type { HandoffDocument } from '../../../src/context/handoff-types.js'
import { HandoffStatus } from '../../../src/context/handoff-types.js'
import type {
  RotationControllerDeps,
  RotationControllerConfig,
  RotationController,
} from '../../../src/context/rotation-controller.js'
import { createRotationController } from '../../../src/context/rotation-controller.js'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeFakeHandoffDoc(overrides: Partial<HandoffDocument> = {}): HandoffDocument {
  return {
    id: 'handoff-001',
    sourceSessionId: 'sess-old',
    targetSessionId: null,
    createdAt: new Date().toISOString(),
    status: HandoffStatus.Ready,
    sessionPurpose: 'test',
    workingDir: '/tmp/test',
    elapsedMinutes: 10,
    tokenUsage: { estimated: 150_000, max: 200_000, percent: 75 },
    currentTask: 'testing',
    pendingWork: [],
    completedWork: [],
    blockedWork: [],
    keyDecisions: [],
    discoveredFacts: [],
    warnings: [],
    filesModified: [],
    filesCreated: [],
    filesDeleted: [],
    teamId: null,
    teamRole: null,
    teamPhase: null,
    relevantMemoryRefs: [],
    suggestedMemoryUpdates: [],
    resumptionInstructions: '',
    ...overrides,
  }
}

function makeDeps(overrides: Partial<RotationControllerDeps> = {}): RotationControllerDeps {
  const handoffDoc = makeFakeHandoffDoc()

  return {
    detector: {
      start: vi.fn(),
      stop: vi.fn(),
      recordSessionActivity: vi.fn(),
      checkSession: vi.fn().mockReturnValue(null),
      checkAll: vi.fn().mockReturnValue([]),
      getQualityScore: vi.fn().mockReturnValue(80),
      getRotationCandidates: vi.fn().mockReturnValue([]),
      shouldRotate: vi.fn().mockReturnValue(false),
      markRotated: vi.fn(),
      getSignalHistory: vi.fn().mockReturnValue([]),
      getStats: vi.fn().mockReturnValue({
        trackedSessions: 0,
        totalSignals: 0,
        rotationCandidates: 0,
        averageQualityScore: 100,
      }),
    } as unknown as RotationControllerDeps['detector'],
    handoffGenerator: {
      generate: vi.fn().mockReturnValue(handoffDoc),
      toMarkdown: vi.fn().mockReturnValue('# handoff'),
      fromMarkdown: vi.fn().mockReturnValue(handoffDoc),
      validate: vi
        .fn()
        .mockReturnValue({ valid: true, completeness: 100, missingFields: [], warnings: [] }),
      markConsumed: vi.fn().mockReturnValue({
        ...handoffDoc,
        status: HandoffStatus.Consumed,
        targetSessionId: 'sess-new',
      }),
    } as unknown as RotationControllerDeps['handoffGenerator'],
    handoffStore: {
      save: vi.fn().mockReturnValue('/handoffs/handoff-001.md'),
      load: vi.fn().mockReturnValue(null),
      loadLatest: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      markConsumed: vi.fn(),
      markExpired: vi.fn(),
      cleanup: vi.fn().mockReturnValue(0),
    } as unknown as RotationControllerDeps['handoffStore'],
    healthMonitor: {
      registerSession: vi.fn(),
      unregisterSession: vi.fn(),
      recordTurn: vi.fn(),
      recordToolCall: vi.fn(),
      recordCompaction: vi.fn(),
      getHealth: vi.fn().mockReturnValue({
        sessionId: 'sess-old',
        estimatedTokens: 150_000,
        maxTokens: 200_000,
        usagePercent: 75,
        status: 'critical',
        lastUpdated: new Date().toISOString(),
        turnCount: 50,
        toolCallCount: 20,
        compactionCount: 1,
      }),
      getAllHealth: vi.fn().mockReturnValue([]),
      getRotationRecommendation: vi.fn().mockReturnValue(null),
      getUrgentSessions: vi.fn().mockReturnValue([]),
      getStats: vi.fn().mockReturnValue({}),
      prepareHandoff: vi.fn(),
    } as unknown as RotationControllerDeps['healthMonitor'],
    onSpawnSession: vi.fn().mockResolvedValue('sess-new'),
    onSunsetSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeConfig(overrides: Partial<RotationControllerConfig> = {}): RotationControllerConfig {
  return {
    watchdogIntervalMs: 60_000,
    maxConcurrentRotations: 3,
    rotationTimeoutMs: 30_000,
    autoRotateEnabled: false,
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('createRotationController', () => {
  let deps: RotationControllerDeps
  let controller: RotationController

  beforeEach(() => {
    vi.useFakeTimers()
    deps = makeDeps()
    controller = createRotationController(deps)
  })

  afterEach(() => {
    controller.stopWatchdog()
    vi.useRealTimers()
  })

  // ── Creation ──────────────────────────────────────────────────────

  it('creates a controller with default config', () => {
    expect(controller).toBeDefined()
    expect(controller.getActiveRotations()).toEqual([])
    expect(controller.getRotationHistory()).toEqual([])
  })

  // ── rotateSession: happy path ─────────────────────────────────────

  it('rotateSession: full happy path (handoff → spawn → sunset)', async () => {
    const result = await controller.rotateSession('sess-old')

    expect(result.success).toBe(true)
    expect(result.sourceSessionId).toBe('sess-old')
    expect(result.targetSessionId).toBe('sess-new')
    expect(result.handoffId).toBe('handoff-001')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.error).toBeUndefined()
  })

  it('rotateSession: generates handoff with provided input', async () => {
    const input: Partial<HandoffInput> = {
      currentTask: 'building feature X',
      pendingWork: [{ description: 'finish tests', priority: 'high' }],
    }
    await controller.rotateSession('sess-old', input)

    expect(deps.handoffGenerator.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-old',
        currentTask: 'building feature X',
        pendingWork: [{ description: 'finish tests', priority: 'high' }],
      }),
    )
  })

  it('rotateSession: saves handoff to store', async () => {
    await controller.rotateSession('sess-old')

    expect(deps.handoffStore.save).toHaveBeenCalledTimes(1)
    expect(deps.handoffStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'handoff-001' }),
    )
  })

  it('rotateSession: calls onSpawnSession with correct args', async () => {
    await controller.rotateSession('sess-old')

    expect(deps.onSpawnSession).toHaveBeenCalledWith('handoff-001', expect.any(String))
  })

  it('rotateSession: marks handoff consumed with new sessionId', async () => {
    await controller.rotateSession('sess-old')

    expect(deps.handoffStore.markConsumed).toHaveBeenCalledWith('handoff-001', 'sess-new')
  })

  it('rotateSession: calls onSunsetSession on old session', async () => {
    await controller.rotateSession('sess-old')

    expect(deps.onSunsetSession).toHaveBeenCalledWith('sess-old')
  })

  it('rotateSession: records success in history', async () => {
    await controller.rotateSession('sess-old')

    const history = controller.getRotationHistory()
    expect(history).toHaveLength(1)
    expect(history[0]!.success).toBe(true)
    expect(history[0]!.sourceSessionId).toBe('sess-old')
  })

  // ── rotateSession: error cases ────────────────────────────────────

  it('rotateSession: rejects duplicate rotation (already rotating)', async () => {
    // Make spawn hang so rotation stays active
    const neverResolve = new Promise<string>(() => {})
    ;(deps.onSpawnSession as ReturnType<typeof vi.fn>).mockReturnValue(neverResolve)

    // Start first rotation (will not resolve)
    const _p1 = controller.rotateSession('sess-old')

    // Second should fail immediately
    const result = await controller.rotateSession('sess-old')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already rotating/i)

    // Clean up the hanging promise
    ;(deps.onSpawnSession as ReturnType<typeof vi.fn>).mockResolvedValue('sess-new')
  })

  it('rotateSession: respects maxConcurrentRotations limit', async () => {
    const ctrl = createRotationController(deps, makeConfig({ maxConcurrentRotations: 1 }))
    const neverResolve = new Promise<string>(() => {})
    ;(deps.onSpawnSession as ReturnType<typeof vi.fn>).mockReturnValue(neverResolve)

    // Start one rotation (hangs)
    ctrl.rotateSession('sess-1')

    // Second should be blocked by concurrent limit
    const result = await ctrl.rotateSession('sess-2')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/concurrent/i)
  })

  it('rotateSession: handles spawn failure gracefully', async () => {
    ;(deps.onSpawnSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('spawn failed'))

    const result = await controller.rotateSession('sess-old')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/spawn failed/i)
    expect(result.targetSessionId).toBeNull()
    // Session should not be left in rotating state
    expect(controller.getActiveRotations()).not.toContain('sess-old')
  })

  it('rotateSession: handles sunset failure (still records result)', async () => {
    ;(deps.onSunsetSession as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('sunset failed'),
    )

    const result = await controller.rotateSession('sess-old')

    // Sunset failure should still count as success (new session is alive)
    expect(result.success).toBe(true)
    expect(result.targetSessionId).toBe('sess-new')
    const history = controller.getRotationHistory()
    expect(history).toHaveLength(1)
  })

  it('rotateSession: measures duration accurately', async () => {
    // With real timers, the duration should be measurable
    vi.useRealTimers()

    const result = await controller.rotateSession('sess-old')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(typeof result.durationMs).toBe('number')

    vi.useFakeTimers()
  })

  it('rotateSession: works without onSpawnSession callback', async () => {
    const depsNoSpawn = makeDeps()
    delete (depsNoSpawn as Record<string, unknown>).onSpawnSession
    const ctrl = createRotationController(depsNoSpawn)

    const result = await ctrl.rotateSession('sess-old')
    expect(result.success).toBe(true)
    expect(result.targetSessionId).toBeNull()
  })

  it('rotateSession: works without onSunsetSession callback', async () => {
    const depsNoSunset = makeDeps()
    delete (depsNoSunset as Record<string, unknown>).onSunsetSession
    const ctrl = createRotationController(depsNoSunset)

    const result = await ctrl.rotateSession('sess-old')
    expect(result.success).toBe(true)
  })

  // ── tick ──────────────────────────────────────────────────────────

  it('tick: gets candidates from detector', async () => {
    await controller.tick()

    expect(deps.detector.getRotationCandidates).toHaveBeenCalled()
  })

  it('tick: only rotates high/immediate urgency', async () => {
    ;(deps.detector.getRotationCandidates as ReturnType<typeof vi.fn>).mockReturnValue([
      { sessionId: 'sess-low', reason: 'low', urgency: 'low', qualityScore: 80, health: {} },
      { sessionId: 'sess-med', reason: 'medium', urgency: 'medium', qualityScore: 60, health: {} },
      { sessionId: 'sess-high', reason: 'high', urgency: 'high', qualityScore: 40, health: {} },
      {
        sessionId: 'sess-imm',
        reason: 'immediate',
        urgency: 'immediate',
        qualityScore: 10,
        health: {},
      },
    ])

    const results = await controller.tick()

    // Should have rotated high and immediate (2 sessions)
    const rotatedIds = results.map((r) => r.sourceSessionId)
    expect(rotatedIds).toContain('sess-high')
    expect(rotatedIds).toContain('sess-imm')
    expect(rotatedIds).not.toContain('sess-low')
    expect(rotatedIds).not.toContain('sess-med')
  })

  it('tick: respects concurrent limit', async () => {
    const ctrl = createRotationController(deps, makeConfig({ maxConcurrentRotations: 1 }))

    ;(deps.detector.getRotationCandidates as ReturnType<typeof vi.fn>).mockReturnValue([
      { sessionId: 'sess-1', reason: 'urgent', urgency: 'immediate', qualityScore: 10, health: {} },
      { sessionId: 'sess-2', reason: 'urgent', urgency: 'immediate', qualityScore: 10, health: {} },
    ])

    const results = await ctrl.tick()

    // maxConcurrentRotations=1, no active rotations → only 1 candidate processed
    expect(results).toHaveLength(1)
    expect(results[0]!.sourceSessionId).toBe('sess-1')
  })

  it('tick: returns results for each rotation', async () => {
    ;(deps.detector.getRotationCandidates as ReturnType<typeof vi.fn>).mockReturnValue([
      { sessionId: 'sess-a', reason: 'urgent', urgency: 'high', qualityScore: 30, health: {} },
    ])

    const results = await controller.tick()

    expect(results).toHaveLength(1)
    expect(results[0]!.sourceSessionId).toBe('sess-a')
    expect(results[0]!.success).toBe(true)
  })

  it('tick: skips when no candidates', async () => {
    ;(deps.detector.getRotationCandidates as ReturnType<typeof vi.fn>).mockReturnValue([])

    const results = await controller.tick()

    expect(results).toHaveLength(0)
  })

  // ── watchdog ──────────────────────────────────────────────────────

  it('watchdog: start sets interval running', () => {
    expect(controller.isWatchdogRunning()).toBe(false)
    controller.startWatchdog()
    expect(controller.isWatchdogRunning()).toBe(true)
  })

  it('watchdog: stop clears interval', () => {
    controller.startWatchdog()
    expect(controller.isWatchdogRunning()).toBe(true)
    controller.stopWatchdog()
    expect(controller.isWatchdogRunning()).toBe(false)
  })

  it('watchdog: isRunning reflects state', () => {
    expect(controller.isWatchdogRunning()).toBe(false)
    controller.startWatchdog()
    expect(controller.isWatchdogRunning()).toBe(true)
    controller.stopWatchdog()
    expect(controller.isWatchdogRunning()).toBe(false)
  })

  it('watchdog: start is idempotent', () => {
    controller.startWatchdog()
    controller.startWatchdog()
    expect(controller.isWatchdogRunning()).toBe(true)
    controller.stopWatchdog()
    expect(controller.isWatchdogRunning()).toBe(false)
  })

  // ── getStats ──────────────────────────────────────────────────────

  it('getStats: accurate counts and averages', async () => {
    await controller.rotateSession('sess-old')

    const stats = controller.getStats()
    expect(stats.totalRotations).toBe(1)
    expect(stats.successfulRotations).toBe(1)
    expect(stats.failedRotations).toBe(0)
    expect(stats.activeRotations).toBe(0)
    expect(stats.averageDurationMs).toBeGreaterThanOrEqual(0)
    expect(stats.watchdogRunning).toBe(false)
    expect(stats.lastWatchdogTick).toBeNull()
  })

  it('getStats: reflects failed rotations', async () => {
    ;(deps.onSpawnSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('oops'))

    await controller.rotateSession('sess-old')

    const stats = controller.getStats()
    expect(stats.totalRotations).toBe(1)
    expect(stats.failedRotations).toBe(1)
    expect(stats.successfulRotations).toBe(0)
  })

  it('getStats: shows watchdog running', () => {
    controller.startWatchdog()
    expect(controller.getStats().watchdogRunning).toBe(true)
  })

  it('getStats: records lastWatchdogTick after tick', async () => {
    await controller.tick()
    expect(controller.getStats().lastWatchdogTick).not.toBeNull()
  })

  // ── History cap ───────────────────────────────────────────────────

  it('rotation history capped at 200', async () => {
    // Generate a fresh handoff id for each call to avoid "already rotating" collision
    let callCount = 0
    ;(deps.handoffGenerator.generate as ReturnType<typeof vi.fn>).mockImplementation(
      (input: HandoffInput) =>
        makeFakeHandoffDoc({ id: `handoff-${callCount++}`, sourceSessionId: input.sessionId }),
    )

    for (let i = 0; i < 210; i++) {
      await controller.rotateSession(`sess-${i}`)
    }

    const history = controller.getRotationHistory()
    expect(history.length).toBe(200)
  })

  // ── Config override ───────────────────────────────────────────────

  it('accepts custom config', () => {
    const ctrl = createRotationController(deps, makeConfig({ watchdogIntervalMs: 5000 }))
    expect(ctrl).toBeDefined()
  })
})
