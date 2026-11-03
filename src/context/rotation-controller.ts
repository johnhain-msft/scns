/**
 * Rotation controller — orchestrates the complete session rotation lifecycle.
 * Generates handoffs, spawns replacements, sunsets old sessions.
 */

import type { CompactionDetector } from './compaction-detector.js'
import type { HandoffGenerator, HandoffInput } from './handoff-generator.js'
import type { HandoffStore } from './handoff-store.js'
import type { EventDispatcher } from '../broker/event-dispatcher.js'

// Re-import the health monitor type from the factory
import type { createHealthMonitor } from './health-monitor.js'

// ── Public interfaces ───────────────────────────────────────────────────────

export interface RotationControllerDeps {
  readonly detector: CompactionDetector
  readonly handoffGenerator: HandoffGenerator
  readonly handoffStore: HandoffStore
  readonly healthMonitor: ReturnType<typeof createHealthMonitor>
  readonly dispatcher?: EventDispatcher
  readonly onSpawnSession?: (handoffId: string, purpose: string) => Promise<string>
  readonly onSunsetSession?: (sessionId: string) => Promise<void>
  readonly config?: Partial<RotationControllerConfig>
}

export interface RotationControllerConfig {
  readonly watchdogIntervalMs: number
  readonly maxConcurrentRotations: number
  readonly rotationTimeoutMs: number
  readonly autoRotateEnabled: boolean
}

export interface RotationResult {
  readonly sourceSessionId: string
  readonly targetSessionId: string | null
  readonly handoffId: string
  readonly success: boolean
  readonly durationMs: number
  readonly error?: string
}

export interface RotationControllerStats {
  readonly totalRotations: number
  readonly successfulRotations: number
  readonly failedRotations: number
  readonly activeRotations: number
  readonly averageDurationMs: number
  readonly watchdogRunning: boolean
  readonly lastWatchdogTick: string | null
}

export interface RotationController {
  rotateSession(sessionId: string, input?: Partial<HandoffInput>): Promise<RotationResult>
  startWatchdog(): void
  stopWatchdog(): void
  isWatchdogRunning(): boolean
  tick(): Promise<readonly RotationResult[]>
  getActiveRotations(): readonly string[]
  getRotationHistory(): readonly RotationResult[]
  getStats(): RotationControllerStats
}

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RotationControllerConfig = {
  watchdogIntervalMs: 60_000,
  maxConcurrentRotations: 3,
  rotationTimeoutMs: 30_000,
  autoRotateEnabled: true,
}

const HISTORY_CAP = 200

// ── Factory ─────────────────────────────────────────────────────────────────

export function createRotationController(
  deps: RotationControllerDeps,
  config?: Partial<RotationControllerConfig>,
): RotationController {
  const cfg: RotationControllerConfig = { ...DEFAULT_CONFIG, ...deps.config, ...config }
  const { detector, handoffGenerator, handoffStore } = deps

  const activeRotations = new Set<string>()
  const history: RotationResult[] = []
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  let lastWatchdogTick: string | null = null

  // ── Internal helpers ────────────────────────────────────────────────

  function recordResult(result: RotationResult): void {
    history.push(result)
    if (history.length > HISTORY_CAP) {
      history.splice(0, history.length - HISTORY_CAP)
    }
  }

  // ── Core rotation ─────────────────────────────────────────────────

  async function rotateSession(
    sessionId: string,
    input?: Partial<HandoffInput>,
  ): Promise<RotationResult> {
    const startTime = Date.now()

    // 1. Check if already rotating
    if (activeRotations.has(sessionId)) {
      const result: RotationResult = {
        sourceSessionId: sessionId,
        targetSessionId: null,
        handoffId: '',
        success: false,
        durationMs: Date.now() - startTime,
        error: 'Session is already rotating',
      }
      recordResult(result)
      return result
    }

    // 2. Check concurrent limit
    if (activeRotations.size >= cfg.maxConcurrentRotations) {
      const result: RotationResult = {
        sourceSessionId: sessionId,
        targetSessionId: null,
        handoffId: '',
        success: false,
        durationMs: Date.now() - startTime,
        error: `Max concurrent rotations reached (${cfg.maxConcurrentRotations})`,
      }
      recordResult(result)
      return result
    }

    activeRotations.add(sessionId)

    try {
      // 3. Generate handoff document
      const handoffInput: HandoffInput = {
        sessionId,
        ...input,
      }
      const handoffDoc = handoffGenerator.generate(handoffInput)

      // 4. Save handoff to store
      handoffStore.save(handoffDoc)

      // 5. Spawn fresh session
      let targetSessionId: string | null = null
      if (deps.onSpawnSession) {
        targetSessionId = await deps.onSpawnSession(
          handoffDoc.id,
          `Rotation replacement for ${sessionId}`,
        )
      }

      // 6. Mark handoff as consumed
      if (targetSessionId) {
        handoffStore.markConsumed(handoffDoc.id, targetSessionId)
      }

      // 7. Sunset old session (failure here is non-fatal)
      if (deps.onSunsetSession) {
        try {
          await deps.onSunsetSession(sessionId)
        } catch {
          // Sunset failure is tolerated — new session is already alive
        }
      }

      // 8. Record success
      const result: RotationResult = {
        sourceSessionId: sessionId,
        targetSessionId,
        handoffId: handoffDoc.id,
        success: true,
        durationMs: Date.now() - startTime,
      }
      recordResult(result)
      return result
    } catch (err) {
      // 9. Record failure, clean up active state
      const result: RotationResult = {
        sourceSessionId: sessionId,
        targetSessionId: null,
        handoffId: '',
        success: false,
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      }
      recordResult(result)
      return result
    } finally {
      activeRotations.delete(sessionId)
    }
  }

  // ── Watchdog tick ─────────────────────────────────────────────────

  async function tick(): Promise<readonly RotationResult[]> {
    lastWatchdogTick = new Date().toISOString()

    const candidates = detector.getRotationCandidates()
    const eligible = candidates.filter((c) => c.urgency === 'high' || c.urgency === 'immediate')

    // Pre-calculate available slots to cap the number of rotations this tick
    const available = cfg.maxConcurrentRotations - activeRotations.size
    const toRotate = eligible.slice(0, Math.max(0, available))

    const results: RotationResult[] = []
    for (const candidate of toRotate) {
      const result = await rotateSession(candidate.sessionId)
      results.push(result)
    }

    return results
  }

  // ── Watchdog lifecycle ────────────────────────────────────────────

  function startWatchdog(): void {
    if (watchdogTimer !== null) return
    watchdogTimer = setInterval(() => {
      void tick()
    }, cfg.watchdogIntervalMs)
  }

  function stopWatchdog(): void {
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer)
      watchdogTimer = null
    }
  }

  // ── Public API ────────────────────────────────────────────────────

  return {
    rotateSession,
    startWatchdog,
    stopWatchdog,

    isWatchdogRunning(): boolean {
      return watchdogTimer !== null
    },

    tick,

    getActiveRotations(): readonly string[] {
      return [...activeRotations]
    },

    getRotationHistory(): readonly RotationResult[] {
      return [...history]
    },

    getStats(): RotationControllerStats {
      const successful = history.filter((r) => r.success).length
      const failed = history.filter((r) => !r.success).length
      const totalDuration = history.reduce((sum, r) => sum + r.durationMs, 0)

      return {
        totalRotations: history.length,
        successfulRotations: successful,
        failedRotations: failed,
        activeRotations: activeRotations.size,
        averageDurationMs: history.length > 0 ? Math.round(totalDuration / history.length) : 0,
        watchdogRunning: watchdogTimer !== null,
        lastWatchdogTick,
      }
    },
  }
}
