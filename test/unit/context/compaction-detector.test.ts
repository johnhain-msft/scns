import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCompactionDetector } from '../../../src/context/compaction-detector.js'
import { createHealthMonitor } from '../../../src/context/health-monitor.js'
import { createEventDispatcher } from '../../../src/broker/event-dispatcher.js'
import type { EventDispatcher, TypedEvent } from '../../../src/broker/event-dispatcher.js'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEvent(
  eventType: TypedEvent['event_type'],
  sessionId: string,
  payload: Record<string, unknown> = {},
): TypedEvent {
  return {
    id: Math.floor(Math.random() * 100_000),
    event_type: eventType,
    session_id: sessionId,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
  }
}

function pushTokensTo(
  monitor: ReturnType<typeof createHealthMonitor>,
  sessionId: string,
  targetPercent: number,
  maxTokens = 200_000,
) {
  const targetTokens = Math.ceil((targetPercent / 100) * maxTokens)
  const tokensPerTurn = 2000
  const turns = Math.ceil(targetTokens / tokensPerTurn)
  for (let i = 0; i < turns; i++) {
    monitor.recordTurn(sessionId)
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('createCompactionDetector', () => {
  let monitor: ReturnType<typeof createHealthMonitor>
  let dispatcher: EventDispatcher

  beforeEach(() => {
    monitor = createHealthMonitor()
    dispatcher = createEventDispatcher()
  })

  // ── Basic creation ─────────────────────────────────────────────────

  it('creates a detector with health monitor', () => {
    const detector = createCompactionDetector({ healthMonitor: monitor })
    expect(detector).toBeDefined()
    expect(detector.getStats().trackedSessions).toBe(0)
  })

  // ── Event-driven registration ──────────────────────────────────────

  it('tracks session on session_registered event', () => {
    const detector = createCompactionDetector({ healthMonitor: monitor, dispatcher })
    detector.start()
    dispatcher.dispatch(makeEvent('session_registered', 'sess-1'))
    expect(detector.getQualityScore('sess-1')).toBe(100)
    expect(detector.getStats().trackedSessions).toBe(1)
    detector.stop()
  })

  it('removes session on session_deregistered event', () => {
    const detector = createCompactionDetector({ healthMonitor: monitor, dispatcher })
    detector.start()
    dispatcher.dispatch(makeEvent('session_registered', 'sess-1'))
    dispatcher.dispatch(makeEvent('session_deregistered', 'sess-1'))
    expect(detector.getQualityScore('sess-1')).toBe(0)
    expect(detector.getStats().trackedSessions).toBe(0)
    detector.stop()
  })

  // ── Activity recording ─────────────────────────────────────────────

  it('records turn activity and increases token estimate', () => {
    monitor.registerSession('sess-1')
    const detector = createCompactionDetector({ healthMonitor: monitor })
    detector.recordSessionActivity('sess-1', { type: 'turn' })
    const health = monitor.getHealth('sess-1')
    expect(health!.estimatedTokens).toBeGreaterThan(0)
  })

  it('records tool-call activity and increases token estimate', () => {
    monitor.registerSession('sess-1')
    const detector = createCompactionDetector({ healthMonitor: monitor })
    detector.recordSessionActivity('sess-1', { type: 'tool-call' })
    const health = monitor.getHealth('sess-1')
    expect(health!.toolCallCount).toBe(1)
  })

  it('records compaction and reduces tokens while incrementing count', () => {
    monitor.registerSession('sess-1')
    const detector = createCompactionDetector({ healthMonitor: monitor })
    // Push tokens up first
    for (let i = 0; i < 50; i++) monitor.recordTurn('sess-1')
    const before = monitor.getHealth('sess-1')!.estimatedTokens
    detector.recordSessionActivity('sess-1', { type: 'compaction' })
    const after = monitor.getHealth('sess-1')!
    expect(after.estimatedTokens).toBeLessThan(before)
    expect(after.compactionCount).toBe(1)
  })

  // ── Quality decay ─────────────────────────────────────────────────

  it('decays quality over time', () => {
    monitor.registerSession('sess-1')
    const detector = createCompactionDetector({ healthMonitor: monitor })
    detector.recordSessionActivity('sess-1', { type: 'turn' })

    // Mock time: 2 hours later
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000))

    const score = detector.getQualityScore('sess-1')
    expect(score).toBeLessThan(100)
    expect(score).toBeGreaterThan(0)

    vi.useRealTimers()
  })

  it('quality decays faster with compactions', () => {
    monitor.registerSession('sess-1')
    monitor.registerSession('sess-2')
    const detector = createCompactionDetector({ healthMonitor: monitor })
    detector.recordSessionActivity('sess-1', { type: 'turn' })
    detector.recordSessionActivity('sess-2', { type: 'turn' })
    detector.recordSessionActivity('sess-1', { type: 'compaction' })
    detector.recordSessionActivity('sess-1', { type: 'compaction' })

    const score1 = detector.getQualityScore('sess-1')
    const score2 = detector.getQualityScore('sess-2')
    expect(score1).toBeLessThan(score2)
  })

  it('quality decays faster with errors', () => {
    monitor.registerSession('sess-1')
    monitor.registerSession('sess-2')
    const detector = createCompactionDetector({ healthMonitor: monitor })
    detector.recordSessionActivity('sess-1', { type: 'turn' })
    detector.recordSessionActivity('sess-2', { type: 'turn' })
    detector.recordSessionActivity('sess-1', { type: 'error' })
    detector.recordSessionActivity('sess-1', { type: 'error' })

    const score1 = detector.getQualityScore('sess-1')
    const score2 = detector.getQualityScore('sess-2')
    expect(score1).toBeLessThan(score2)
  })

  // ── Compaction signals ─────────────────────────────────────────────

  it('produces warning signal at 50%+ token usage', () => {
    monitor.registerSession('sess-1', 200_000)
    const detector = createCompactionDetector({ healthMonitor: monitor })
    pushTokensTo(monitor, 'sess-1', 52)
    const signal = detector.checkSession('sess-1')
    expect(signal).not.toBeNull()
    expect(signal!.severity).toBe('warning')
    expect(signal!.type).toBe('token-threshold')
  })

  it('produces critical signal at 75%+ token usage', () => {
    monitor.registerSession('sess-1', 200_000)
    const detector = createCompactionDetector({ healthMonitor: monitor })
    pushTokensTo(monitor, 'sess-1', 76)
    const signal = detector.checkSession('sess-1')
    expect(signal).not.toBeNull()
    expect(signal!.severity).toBe('critical')
    expect(signal!.type).toBe('token-threshold')
  })

  it('produces rotate-now signal at 85%+ token usage', () => {
    monitor.registerSession('sess-1', 200_000)
    const detector = createCompactionDetector({ healthMonitor: monitor })
    pushTokensTo(monitor, 'sess-1', 86)
    const signal = detector.checkSession('sess-1')
    expect(signal).not.toBeNull()
    expect(signal!.severity).toBe('rotate-now')
    expect(signal!.type).toBe('token-threshold')
  })

  it('produces rotate-now signal when compaction count >= 3', () => {
    monitor.registerSession('sess-1')
    const detector = createCompactionDetector({ healthMonitor: monitor })
    // Push tokens, compact, repeat 3 times
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 10; j++) monitor.recordTurn('sess-1')
      monitor.recordCompaction('sess-1')
    }
    const signal = detector.checkSession('sess-1')
    expect(signal).not.toBeNull()
    expect(signal!.severity).toBe('rotate-now')
    expect(signal!.type).toBe('compaction-count')
  })

  it('produces critical signal when quality drops below 30', () => {
    monitor.registerSession('sess-1')
    const detector = createCompactionDetector({
      healthMonitor: monitor,
      config: {
        maxCompactionsBeforeRotate: 100,
        qualityDecayRate: 2,
        minRotationIntervalMs: 300_000,
        enableAutoDetection: true,
      },
    })
    detector.recordSessionActivity('sess-1', { type: 'turn' })

    // Lots of errors to tank quality (avoid hitting compaction-count threshold)
    for (let i = 0; i < 30; i++) {
      detector.recordSessionActivity('sess-1', { type: 'error' })
    }
    // 2 compactions (below the 100 cap) add penalty
    detector.recordSessionActivity('sess-1', { type: 'compaction' })
    detector.recordSessionActivity('sess-1', { type: 'compaction' })

    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() + 5 * 60 * 60 * 1000))

    const score = detector.getQualityScore('sess-1')
    expect(score).toBeLessThan(30)
    const signal = detector.checkSession('sess-1')
    expect(signal).not.toBeNull()
    expect(signal!.severity).toBe('critical')
    expect(signal!.type).toBe('quality-decay')

    vi.useRealTimers()
  })

  // ── Rotation candidates ────────────────────────────────────────────

  it('returns rotation candidates sorted by urgency', () => {
    monitor.registerSession('sess-low', 200_000)
    monitor.registerSession('sess-high', 200_000)
    const detector = createCompactionDetector({ healthMonitor: monitor })
    pushTokensTo(monitor, 'sess-low', 52) // warning
    pushTokensTo(monitor, 'sess-high', 86) // rotate-now

    const candidates = detector.getRotationCandidates()
    expect(candidates.length).toBe(2)
    // Highest urgency first
    expect(candidates[0]!.sessionId).toBe('sess-high')
    expect(candidates[0]!.urgency).toBe('immediate')
  })

  // ── shouldRotate ───────────────────────────────────────────────────

  it('returns true when rotation is needed', () => {
    monitor.registerSession('sess-1', 200_000)
    const detector = createCompactionDetector({ healthMonitor: monitor })
    pushTokensTo(monitor, 'sess-1', 86)
    expect(detector.shouldRotate('sess-1')).toBe(true)
  })

  it('respects minimum rotation interval', () => {
    monitor.registerSession('sess-1', 200_000)
    const detector = createCompactionDetector({
      healthMonitor: monitor,
      config: {
        maxCompactionsBeforeRotate: 3,
        qualityDecayRate: 2,
        minRotationIntervalMs: 300_000,
        enableAutoDetection: true,
      },
    })
    pushTokensTo(monitor, 'sess-1', 86)

    // First check triggers rotation
    expect(detector.shouldRotate('sess-1')).toBe(true)
    detector.markRotated('sess-1')
    // Second check within interval → false
    expect(detector.shouldRotate('sess-1')).toBe(false)
  })

  // ── Signal history ─────────────────────────────────────────────────

  it('caps signal history at 100 entries', () => {
    monitor.registerSession('sess-1', 200_000)
    const detector = createCompactionDetector({ healthMonitor: monitor })
    pushTokensTo(monitor, 'sess-1', 52) // warning level
    // Generate >100 signals
    for (let i = 0; i < 110; i++) {
      detector.checkSession('sess-1')
    }
    const history = detector.getSignalHistory('sess-1')
    expect(history.length).toBeLessThanOrEqual(100)
  })

  // ── Stats ──────────────────────────────────────────────────────────

  it('reports accurate stats', () => {
    monitor.registerSession('sess-1', 200_000)
    monitor.registerSession('sess-2', 200_000)
    const detector = createCompactionDetector({ healthMonitor: monitor })
    detector.recordSessionActivity('sess-1', { type: 'turn' })
    detector.recordSessionActivity('sess-2', { type: 'turn' })
    pushTokensTo(monitor, 'sess-1', 52)
    detector.checkSession('sess-1')

    const stats = detector.getStats()
    expect(stats.trackedSessions).toBe(2)
    expect(stats.totalSignals).toBeGreaterThanOrEqual(1)
  })

  // ── Start/stop ─────────────────────────────────────────────────────

  it('subscribes to dispatcher on start and unsubscribes on stop', () => {
    const detector = createCompactionDetector({ healthMonitor: monitor, dispatcher })
    expect(dispatcher.subscriberCount()).toBe(0)
    detector.start()
    expect(dispatcher.subscriberCount()).toBeGreaterThan(0)
    detector.stop()
    expect(dispatcher.subscriberCount()).toBe(0)
  })

  it('does not process events after stop', () => {
    const detector = createCompactionDetector({ healthMonitor: monitor, dispatcher })
    detector.start()
    detector.stop()
    dispatcher.dispatch(makeEvent('session_registered', 'sess-1'))
    expect(detector.getStats().trackedSessions).toBe(0)
  })

  // ── Multiple sessions ──────────────────────────────────────────────

  it('tracks multiple sessions independently', () => {
    monitor.registerSession('sess-1', 200_000)
    monitor.registerSession('sess-2', 200_000)
    const detector = createCompactionDetector({ healthMonitor: monitor })

    // Both get at least one activity so they're tracked
    detector.recordSessionActivity('sess-1', { type: 'turn' })
    detector.recordSessionActivity('sess-2', { type: 'turn' })
    // Only sess-1 gets error penalty
    detector.recordSessionActivity('sess-1', { type: 'error' })

    const score1 = detector.getQualityScore('sess-1')
    const score2 = detector.getQualityScore('sess-2')
    expect(score1).toBeLessThan(score2)
  })

  // ── checkAll ───────────────────────────────────────────────────────

  it('checkAll returns signals for all sessions needing attention', () => {
    monitor.registerSession('sess-1', 200_000)
    monitor.registerSession('sess-2', 200_000)
    monitor.registerSession('sess-healthy', 200_000)
    const detector = createCompactionDetector({ healthMonitor: monitor })

    pushTokensTo(monitor, 'sess-1', 52)
    pushTokensTo(monitor, 'sess-2', 76)

    const signals = detector.checkAll()
    expect(signals.length).toBeGreaterThanOrEqual(2)
    const sessionIds = signals.map((s) => s.sessionId)
    expect(sessionIds).toContain('sess-1')
    expect(sessionIds).toContain('sess-2')
  })

  // ── Event-driven activity ──────────────────────────────────────────

  it('records activity from heartbeat_received event', () => {
    monitor.registerSession('sess-1')
    const detector = createCompactionDetector({ healthMonitor: monitor, dispatcher })
    detector.start()
    dispatcher.dispatch(makeEvent('heartbeat_received', 'sess-1'))
    const health = monitor.getHealth('sess-1')
    expect(health!.turnCount).toBe(1)
    detector.stop()
  })

  it('records activity from activity_reported event with tool-call type', () => {
    monitor.registerSession('sess-1')
    const detector = createCompactionDetector({ healthMonitor: monitor, dispatcher })
    detector.start()
    dispatcher.dispatch(makeEvent('activity_reported', 'sess-1', { type: 'tool-call' }))
    const health = monitor.getHealth('sess-1')
    expect(health!.toolCallCount).toBe(1)
    detector.stop()
  })

  // ── No signal for healthy session ──────────────────────────────────

  it('returns null signal for healthy session', () => {
    monitor.registerSession('sess-1')
    const detector = createCompactionDetector({ healthMonitor: monitor })
    const signal = detector.checkSession('sess-1')
    expect(signal).toBeNull()
  })

  // ── Unknown session ────────────────────────────────────────────────

  it('returns null for unknown session check', () => {
    const detector = createCompactionDetector({ healthMonitor: monitor })
    const signal = detector.checkSession('unknown')
    expect(signal).toBeNull()
  })

  it('returns 0 quality score for unknown session', () => {
    const detector = createCompactionDetector({ healthMonitor: monitor })
    expect(detector.getQualityScore('unknown')).toBe(0)
  })
})
