/**
 * Compaction detector — event-driven context health tracking.
 * Subscribes to broker events, detects compaction signals, manages quality decay.
 */

import { createHealthMonitor } from './health-monitor.js'
import type { ContextHealth } from './types.js'
import type { EventDispatcher } from '../broker/event-dispatcher.js'
import {
  calculateQualityScore,
  applyCompactionPenalty,
  applyErrorPenalty,
  createInitialQualityState,
  type QualityState,
} from './quality-decay.js'

// ── Config ──────────────────────────────────────────────────────────────────

export interface CompactionDetectorConfig {
  readonly maxCompactionsBeforeRotate: number
  readonly qualityDecayRate: number
  readonly minRotationIntervalMs: number
  readonly enableAutoDetection: boolean
}

const DEFAULT_CONFIG: CompactionDetectorConfig = {
  maxCompactionsBeforeRotate: 3,
  qualityDecayRate: 2,
  minRotationIntervalMs: 300_000,
  enableAutoDetection: true,
}

// ── Public interfaces ───────────────────────────────────────────────────────

export interface CompactionDetectorOptions {
  readonly healthMonitor: ReturnType<typeof createHealthMonitor>
  readonly dispatcher?: EventDispatcher
  readonly config?: CompactionDetectorConfig
}

export interface CompactionSignal {
  readonly sessionId: string
  readonly type: 'token-threshold' | 'compaction-count' | 'quality-decay' | 'manual'
  readonly severity: 'warning' | 'critical' | 'rotate-now'
  readonly details: string
  readonly timestamp: string
}

export interface SessionActivity {
  readonly type: 'turn' | 'tool-call' | 'compaction' | 'error' | 'idle'
  readonly estimatedTokens?: number
  readonly metadata?: Record<string, unknown>
}

export interface RotationCandidate {
  readonly sessionId: string
  readonly reason: string
  readonly urgency: 'low' | 'medium' | 'high' | 'immediate'
  readonly qualityScore: number
  readonly health: ContextHealth
}

export interface CompactionDetectorStats {
  readonly trackedSessions: number
  readonly totalSignals: number
  readonly rotationCandidates: number
  readonly averageQualityScore: number
}

export interface CompactionDetector {
  start(): void
  stop(): void
  recordSessionActivity(sessionId: string, activity: SessionActivity): void
  checkSession(sessionId: string): CompactionSignal | null
  checkAll(): readonly CompactionSignal[]
  getQualityScore(sessionId: string): number
  getRotationCandidates(): readonly RotationCandidate[]
  shouldRotate(sessionId: string): boolean
  markRotated(sessionId: string): void
  getSignalHistory(sessionId: string): readonly CompactionSignal[]
  getStats(): CompactionDetectorStats
}

// ── Urgency ordering ────────────────────────────────────────────────────────

const URGENCY_ORDER: Record<string, number> = {
  immediate: 0,
  high: 1,
  medium: 2,
  low: 3,
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createCompactionDetector(options: CompactionDetectorOptions): CompactionDetector {
  const { healthMonitor, dispatcher } = options
  const config: CompactionDetectorConfig = { ...DEFAULT_CONFIG, ...options.config }

  const qualityStates = new Map<string, QualityState>()
  const signalHistory = new Map<string, CompactionSignal[]>()
  const lastRotationTime = new Map<string, number>()
  const unsubscribers: Array<() => void> = []

  const SIGNAL_HISTORY_CAP = 100
  const QUALITY_CRITICAL_THRESHOLD = 30

  // Health config thresholds (matching ContextHealthConfigSchema defaults)
  const WARNING_THRESHOLD = 50
  const CRITICAL_THRESHOLD = 75
  const ROTATION_THRESHOLD = 85

  // ── Internal helpers ────────────────────────────────────────────────

  function ensureTracked(sessionId: string): void {
    if (!qualityStates.has(sessionId)) {
      qualityStates.set(sessionId, createInitialQualityState(sessionId))
    }
    if (!signalHistory.has(sessionId)) {
      signalHistory.set(sessionId, [])
    }
  }

  function removeTracked(sessionId: string): void {
    qualityStates.delete(sessionId)
    signalHistory.delete(sessionId)
    lastRotationTime.delete(sessionId)
  }

  function addSignal(signal: CompactionSignal): void {
    const history = signalHistory.get(signal.sessionId)
    if (!history) return
    history.push(signal)
    if (history.length > SIGNAL_HISTORY_CAP) {
      history.splice(0, history.length - SIGNAL_HISTORY_CAP)
    }
  }

  function severityToUrgency(severity: CompactionSignal['severity']): RotationCandidate['urgency'] {
    switch (severity) {
      case 'rotate-now':
        return 'immediate'
      case 'critical':
        return 'high'
      case 'warning':
        return 'medium'
    }
  }

  function detectSignal(sessionId: string): CompactionSignal | null {
    const health = healthMonitor.getHealth(sessionId)
    if (!health) return null

    const qualityState = qualityStates.get(sessionId)

    // Priority 1: Compaction count
    if (health.compactionCount >= config.maxCompactionsBeforeRotate) {
      return {
        sessionId,
        type: 'compaction-count',
        severity: 'rotate-now',
        details: `Session compacted ${health.compactionCount} times (max: ${config.maxCompactionsBeforeRotate})`,
        timestamp: new Date().toISOString(),
      }
    }

    // Priority 2: Token threshold (highest severity first)
    if (health.usagePercent >= ROTATION_THRESHOLD) {
      return {
        sessionId,
        type: 'token-threshold',
        severity: 'rotate-now',
        details: `Token usage at ${Math.round(health.usagePercent)}% (rotation threshold: ${ROTATION_THRESHOLD}%)`,
        timestamp: new Date().toISOString(),
      }
    }

    // Priority 3: Quality decay
    if (qualityState) {
      const score = calculateQualityScore(qualityState, config.qualityDecayRate)
      if (score < QUALITY_CRITICAL_THRESHOLD) {
        return {
          sessionId,
          type: 'quality-decay',
          severity: 'critical',
          details: `Quality score dropped to ${score} (threshold: ${QUALITY_CRITICAL_THRESHOLD})`,
          timestamp: new Date().toISOString(),
        }
      }
    }

    if (health.usagePercent >= CRITICAL_THRESHOLD) {
      return {
        sessionId,
        type: 'token-threshold',
        severity: 'critical',
        details: `Token usage at ${Math.round(health.usagePercent)}% (critical threshold: ${CRITICAL_THRESHOLD}%)`,
        timestamp: new Date().toISOString(),
      }
    }

    if (health.usagePercent >= WARNING_THRESHOLD) {
      return {
        sessionId,
        type: 'token-threshold',
        severity: 'warning',
        details: `Token usage at ${Math.round(health.usagePercent)}% (warning threshold: ${WARNING_THRESHOLD}%)`,
        timestamp: new Date().toISOString(),
      }
    }

    return null
  }

  // ── Event handlers ──────────────────────────────────────────────────

  function handleSessionRegistered(sessionId: string): void {
    healthMonitor.registerSession(sessionId)
    ensureTracked(sessionId)
  }

  function handleSessionDeregistered(sessionId: string): void {
    healthMonitor.unregisterSession(sessionId)
    removeTracked(sessionId)
  }

  function handleHeartbeat(sessionId: string): void {
    healthMonitor.recordTurn(sessionId)
  }

  function handleActivityReported(sessionId: string, payload: string): void {
    try {
      const data = JSON.parse(payload) as Record<string, unknown>
      const actType = typeof data.type === 'string' ? data.type : 'turn'
      const activity: SessionActivity = {
        type: actType as SessionActivity['type'],
        estimatedTokens:
          typeof data.estimatedTokens === 'number' ? data.estimatedTokens : undefined,
      }
      recordActivity(sessionId, activity)
    } catch {
      // Unparseable payload — treat as a turn
      healthMonitor.recordTurn(sessionId)
    }
  }

  function recordActivity(sessionId: string, activity: SessionActivity): void {
    ensureTracked(sessionId)

    switch (activity.type) {
      case 'turn':
        healthMonitor.recordTurn(sessionId, activity.estimatedTokens)
        break
      case 'tool-call':
        healthMonitor.recordToolCall(sessionId, activity.estimatedTokens)
        break
      case 'compaction': {
        healthMonitor.recordCompaction(sessionId)
        const state = qualityStates.get(sessionId)
        if (state) {
          qualityStates.set(sessionId, applyCompactionPenalty(state))
        }
        break
      }
      case 'error': {
        const state = qualityStates.get(sessionId)
        if (state) {
          qualityStates.set(sessionId, applyErrorPenalty(state))
        }
        break
      }
      case 'idle':
        // No-op
        break
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  return {
    start(): void {
      if (!dispatcher) return
      unsubscribers.push(
        dispatcher.subscribe({ event_types: ['session_registered'] }, (event) => {
          if (event.session_id) handleSessionRegistered(event.session_id)
        }),
        dispatcher.subscribe({ event_types: ['session_deregistered'] }, (event) => {
          if (event.session_id) handleSessionDeregistered(event.session_id)
        }),
        dispatcher.subscribe({ event_types: ['heartbeat_received'] }, (event) => {
          if (event.session_id) handleHeartbeat(event.session_id)
        }),
        dispatcher.subscribe({ event_types: ['activity_reported'] }, (event) => {
          if (event.session_id) handleActivityReported(event.session_id, event.payload)
        }),
      )
    },

    stop(): void {
      for (const unsub of unsubscribers) unsub()
      unsubscribers.length = 0
    },

    recordSessionActivity(sessionId: string, activity: SessionActivity): void {
      recordActivity(sessionId, activity)
    },

    checkSession(sessionId: string): CompactionSignal | null {
      const signal = detectSignal(sessionId)
      if (signal) addSignal(signal)
      return signal
    },

    checkAll(): readonly CompactionSignal[] {
      const signals: CompactionSignal[] = []
      const allHealth = healthMonitor.getAllHealth()
      for (const h of allHealth) {
        const signal = detectSignal(h.sessionId)
        if (signal) {
          addSignal(signal)
          signals.push(signal)
        }
      }
      return signals
    },

    getQualityScore(sessionId: string): number {
      const state = qualityStates.get(sessionId)
      if (!state) return 0
      return calculateQualityScore(state, config.qualityDecayRate)
    },

    getRotationCandidates(): readonly RotationCandidate[] {
      const candidates: RotationCandidate[] = []
      const allHealth = healthMonitor.getAllHealth()

      for (const health of allHealth) {
        const signal = detectSignal(health.sessionId)
        if (signal) {
          const qualityScore = this.getQualityScore(health.sessionId)
          candidates.push({
            sessionId: health.sessionId,
            reason: signal.details,
            urgency: severityToUrgency(signal.severity),
            qualityScore,
            health,
          })
        }
      }

      candidates.sort((a, b) => (URGENCY_ORDER[a.urgency] ?? 99) - (URGENCY_ORDER[b.urgency] ?? 99))
      return candidates
    },

    shouldRotate(sessionId: string): boolean {
      const signal = detectSignal(sessionId)
      if (!signal || signal.severity !== 'rotate-now') return false

      const lastRotation = lastRotationTime.get(sessionId)
      const now = Date.now()
      if (lastRotation !== undefined && now - lastRotation < config.minRotationIntervalMs) {
        return false
      }

      return true
    },

    markRotated(sessionId: string): void {
      lastRotationTime.set(sessionId, Date.now())
    },

    getSignalHistory(sessionId: string): readonly CompactionSignal[] {
      return signalHistory.get(sessionId) ?? []
    },

    getStats(): CompactionDetectorStats {
      const trackedSessions = qualityStates.size
      let totalSignals = 0
      for (const history of signalHistory.values()) {
        totalSignals += history.length
      }
      const rotationCandidates = this.getRotationCandidates().length

      let sumQuality = 0
      for (const state of qualityStates.values()) {
        sumQuality += calculateQualityScore(state, config.qualityDecayRate)
      }
      const averageQualityScore = trackedSessions > 0 ? Math.round(sumQuality / trackedSessions) : 0

      return { trackedSessions, totalSignals, rotationCandidates, averageQualityScore }
    },
  }
}
