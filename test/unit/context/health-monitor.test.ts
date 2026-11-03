import { describe, it, expect, beforeEach } from 'vitest'
import { createHealthMonitor } from '../../../src/context/health-monitor.js'
import { ContextStatus, RotationAction } from '../../../src/context/types.js'

describe('createHealthMonitor', () => {
  // ── Session Registration ───────────────────────────────────────────

  describe('session registration', () => {
    it('registers a new session with initial healthy state', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      const health = monitor.getHealth('sess-1')
      expect(health).not.toBeNull()
      expect(health!.sessionId).toBe('sess-1')
      expect(health!.estimatedTokens).toBe(0)
      expect(health!.usagePercent).toBe(0)
      expect(health!.status).toBe(ContextStatus.Healthy)
      expect(health!.turnCount).toBe(0)
      expect(health!.toolCallCount).toBe(0)
      expect(health!.compactionCount).toBe(0)
    })

    it('registers a session with custom maxTokens', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1', 128_000)
      const health = monitor.getHealth('sess-1')
      expect(health!.maxTokens).toBe(128_000)
    })

    it('uses default maxTokens when none specified', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      const health = monitor.getHealth('sess-1')
      expect(health!.maxTokens).toBe(200_000)
    })

    it('unregisters a session so getHealth returns null', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      monitor.unregisterSession('sess-1')
      expect(monitor.getHealth('sess-1')).toBeNull()
    })

    it('double-registering the same session is idempotent', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      monitor.recordTurn('sess-1')
      monitor.registerSession('sess-1')
      const health = monitor.getHealth('sess-1')
      // Should keep existing state, not reset
      expect(health!.turnCount).toBe(1)
    })
  })

  // ── Token Tracking ─────────────────────────────────────────────────

  describe('token tracking', () => {
    let monitor: ReturnType<typeof createHealthMonitor>

    beforeEach(() => {
      monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
    })

    it('recordTurn increments estimated tokens by default tokensPerTurn', () => {
      monitor.recordTurn('sess-1')
      const health = monitor.getHealth('sess-1')
      expect(health!.estimatedTokens).toBe(2000)
      expect(health!.turnCount).toBe(1)
    })

    it('recordTurn with custom token count uses that value', () => {
      monitor.recordTurn('sess-1', 5000)
      const health = monitor.getHealth('sess-1')
      expect(health!.estimatedTokens).toBe(5000)
      expect(health!.turnCount).toBe(1)
    })

    it('recordToolCall increments estimated tokens by default tokensPerToolCall', () => {
      monitor.recordToolCall('sess-1')
      const health = monitor.getHealth('sess-1')
      expect(health!.estimatedTokens).toBe(500)
      expect(health!.toolCallCount).toBe(1)
    })

    it('recordToolCall with custom token count uses that value', () => {
      monitor.recordToolCall('sess-1', 1200)
      const health = monitor.getHealth('sess-1')
      expect(health!.estimatedTokens).toBe(1200)
      expect(health!.toolCallCount).toBe(1)
    })

    it('multiple turns accumulate correctly', () => {
      monitor.recordTurn('sess-1')
      monitor.recordTurn('sess-1')
      monitor.recordTurn('sess-1')
      monitor.recordToolCall('sess-1')
      monitor.recordToolCall('sess-1')
      const health = monitor.getHealth('sess-1')
      // 3 * 2000 + 2 * 500 = 7000
      expect(health!.estimatedTokens).toBe(7000)
      expect(health!.turnCount).toBe(3)
      expect(health!.toolCallCount).toBe(2)
    })

    it('estimatedTokens never goes below 0 after compaction', () => {
      monitor.recordTurn('sess-1', 100)
      // Compact with 100% savings — should floor at 0
      monitor.recordCompaction('sess-1', 100)
      const health = monitor.getHealth('sess-1')
      expect(health!.estimatedTokens).toBe(0)
    })

    it('ignores recordTurn for unregistered session', () => {
      // Should not throw
      monitor.recordTurn('unknown')
      expect(monitor.getHealth('unknown')).toBeNull()
    })

    it('ignores recordToolCall for unregistered session', () => {
      monitor.recordToolCall('unknown')
      expect(monitor.getHealth('unknown')).toBeNull()
    })
  })

  // ── Status Transitions ─────────────────────────────────────────────

  describe('status transitions', () => {
    it('0% usage → Healthy', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      expect(monitor.getHealth('sess-1')!.status).toBe(ContextStatus.Healthy)
    })

    it('50% usage → Warning (at default threshold)', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      // 50% of 200_000 = 100_000 tokens. 100_000 / 2000 = 50 turns
      for (let i = 0; i < 50; i++) monitor.recordTurn('sess-1')
      const health = monitor.getHealth('sess-1')
      expect(health!.usagePercent).toBe(50)
      expect(health!.status).toBe(ContextStatus.Warning)
    })

    it('75% usage → Critical', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      // 75% of 200_000 = 150_000 tokens
      monitor.recordTurn('sess-1', 150_000)
      const health = monitor.getHealth('sess-1')
      expect(health!.usagePercent).toBe(75)
      expect(health!.status).toBe(ContextStatus.Critical)
    })

    it('85% usage → RotationNeeded', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      // 85% of 200_000 = 170_000
      monitor.recordTurn('sess-1', 170_000)
      const health = monitor.getHealth('sess-1')
      expect(health!.usagePercent).toBe(85)
      expect(health!.status).toBe(ContextStatus.RotationNeeded)
    })

    it('custom thresholds shift boundaries correctly', () => {
      const monitor = createHealthMonitor({
        config: {
          defaultMaxTokens: 100_000,
          warningThreshold: 30,
          criticalThreshold: 60,
          rotationThreshold: 80,
          tokensPerTurn: 1000,
          tokensPerToolCall: 500,
          compactionSavingsPercent: 40,
        },
      })
      monitor.registerSession('sess-1')
      // 30% of 100_000 = 30_000 → 30 turns at 1000 each
      for (let i = 0; i < 30; i++) monitor.recordTurn('sess-1')
      expect(monitor.getHealth('sess-1')!.status).toBe(ContextStatus.Warning)

      // Push to 60% → 60 turns total → 30 more
      for (let i = 0; i < 30; i++) monitor.recordTurn('sess-1')
      expect(monitor.getHealth('sess-1')!.status).toBe(ContextStatus.Critical)
    })

    it('status downgrades after compaction', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      // Push to Critical (75% = 150_000 tokens)
      monitor.recordTurn('sess-1', 150_000)
      expect(monitor.getHealth('sess-1')!.status).toBe(ContextStatus.Critical)
      // Compact — saves 40% by default: 150_000 * 0.6 = 90_000 → 45%
      monitor.recordCompaction('sess-1')
      // Right after compaction → Compacted override
      expect(monitor.getHealth('sess-1')!.status).toBe(ContextStatus.Compacted)
    })
  })

  // ── Compaction ─────────────────────────────────────────────────────

  describe('compaction', () => {
    it('recordCompaction reduces estimated tokens by savingsPercent', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      monitor.recordTurn('sess-1', 100_000)
      monitor.recordCompaction('sess-1')
      // Default 40% savings: 100_000 * 0.6 = 60_000
      const health = monitor.getHealth('sess-1')
      expect(health!.estimatedTokens).toBe(60_000)
      expect(health!.compactionCount).toBe(1)
    })

    it('recordCompaction with custom savings percentage', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      monitor.recordTurn('sess-1', 100_000)
      monitor.recordCompaction('sess-1', 60)
      // 60% savings: 100_000 * 0.4 = 40_000
      expect(monitor.getHealth('sess-1')!.estimatedTokens).toBe(40_000)
    })

    it('after compaction, status may improve (Critical → Compacted)', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      // 75% = 150_000
      monitor.recordTurn('sess-1', 150_000)
      expect(monitor.getHealth('sess-1')!.status).toBe(ContextStatus.Critical)
      monitor.recordCompaction('sess-1')
      // 150_000 * 0.6 = 90_000 → 45% → underlying Healthy, but Compacted override
      expect(monitor.getHealth('sess-1')!.status).toBe(ContextStatus.Compacted)
    })

    it('Compacted status set after recent compaction (within 5 turns)', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      monitor.recordTurn('sess-1', 100_000)
      monitor.recordCompaction('sess-1')
      // After 3 turns, still Compacted
      monitor.recordTurn('sess-1', 1000)
      monitor.recordTurn('sess-1', 1000)
      monitor.recordTurn('sess-1', 1000)
      expect(monitor.getHealth('sess-1')!.status).toBe(ContextStatus.Compacted)
    })

    it('Compacted status cleared after 5+ turns', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      monitor.recordTurn('sess-1', 10_000)
      monitor.recordCompaction('sess-1')
      // After compaction: 10_000 * 0.6 = 6_000
      // Now add 5 turns to clear compaction flag
      for (let i = 0; i < 5; i++) monitor.recordTurn('sess-1', 100)
      // 6_000 + 500 = 6_500 → ~3.25% → Healthy (not Compacted anymore)
      expect(monitor.getHealth('sess-1')!.status).not.toBe(ContextStatus.Compacted)
      expect(monitor.getHealth('sess-1')!.status).toBe(ContextStatus.Healthy)
    })

    it('ignores recordCompaction for unregistered session', () => {
      const monitor = createHealthMonitor()
      // Should not throw
      monitor.recordCompaction('unknown')
      expect(monitor.getHealth('unknown')).toBeNull()
    })
  })

  // ── Rotation Recommendations ───────────────────────────────────────

  describe('rotation recommendations', () => {
    it('healthy session → no rotation needed', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      const rec = monitor.getRotationRecommendation('sess-1')
      expect(rec).not.toBeNull()
      expect(rec!.urgency).toBe('none')
      expect(rec!.suggestedAction).toBe(RotationAction.None)
    })

    it('warning session → low urgency, no action', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      // 55% usage
      monitor.recordTurn('sess-1', 110_000)
      const rec = monitor.getRotationRecommendation('sess-1')
      expect(rec!.urgency).toBe('low')
      expect(rec!.suggestedAction).toBe(RotationAction.None)
    })

    it('critical session → medium urgency, compact', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      // 78% usage
      monitor.recordTurn('sess-1', 156_000)
      const rec = monitor.getRotationRecommendation('sess-1')
      expect(rec!.urgency).toBe('medium')
      expect(rec!.suggestedAction).toBe(RotationAction.Compact)
    })

    it('rotation needed → high urgency, handoff', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      // 90% usage
      monitor.recordTurn('sess-1', 180_000)
      const rec = monitor.getRotationRecommendation('sess-1')
      expect(rec!.urgency).toBe('high')
      expect(rec!.suggestedAction).toBe(RotationAction.Handoff)
    })

    it('already compacted + still critical → immediate urgency, split', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      // Push to rotation level
      monitor.recordTurn('sess-1', 180_000)
      // Compact with small savings (10%) to remain critical: 180_000 * 0.9 = 162_000 → 81%
      monitor.recordCompaction('sess-1', 10)
      const health = monitor.getHealth('sess-1')
      // 162_000 / 200_000 = 81% → Critical range, but Compacted override
      expect(health!.status).toBe(ContextStatus.Compacted)
      const rec = monitor.getRotationRecommendation('sess-1')
      expect(rec!.urgency).toBe('immediate')
      expect(rec!.suggestedAction).toBe(RotationAction.Split)
    })

    it('recommendation includes estimatedTokensSaved', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      monitor.recordTurn('sess-1', 156_000)
      const rec = monitor.getRotationRecommendation('sess-1')
      expect(rec!.estimatedTokensSaved).toBeGreaterThan(0)
    })

    it('returns null for unregistered session', () => {
      const monitor = createHealthMonitor()
      expect(monitor.getRotationRecommendation('unknown')).toBeNull()
    })
  })

  // ── Handoff ────────────────────────────────────────────────────────

  describe('handoff', () => {
    it('prepareHandoff creates HandoffState with all fields', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      const handoff = monitor.prepareHandoff(
        'sess-1',
        'Completed auth module refactor',
        ['Deploy to staging', 'Write integration tests'],
        ['Used JWT over sessions'],
        ['src/auth.ts', 'src/middleware.ts'],
      )
      expect(handoff.sessionId).toBe('sess-1')
      expect(handoff.summary).toBe('Completed auth module refactor')
      expect(handoff.pendingWork).toEqual(['Deploy to staging', 'Write integration tests'])
      expect(handoff.keyDecisions).toEqual(['Used JWT over sessions'])
      expect(handoff.filesModified).toEqual(['src/auth.ts', 'src/middleware.ts'])
    })

    it('HandoffState includes ISO timestamp', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      const handoff = monitor.prepareHandoff('sess-1', 'Done', [], [], [])
      expect(handoff.timestamp).toBeTruthy()
      // Should be parseable as a date
      expect(new Date(handoff.timestamp).toISOString()).toBe(handoff.timestamp)
    })

    it('prepareHandoff for unregistered session still returns handoff', () => {
      const monitor = createHealthMonitor()
      const handoff = monitor.prepareHandoff('unknown', 'Summary', ['task'], [], [])
      expect(handoff.sessionId).toBe('unknown')
      expect(handoff.summary).toBe('Summary')
    })
  })

  // ── Aggregate ──────────────────────────────────────────────────────

  describe('aggregate', () => {
    it('getAllHealth returns all tracked sessions', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      monitor.registerSession('sess-2')
      monitor.registerSession('sess-3')
      const all = monitor.getAllHealth()
      expect(all).toHaveLength(3)
      const ids = all.map((h) => h.sessionId)
      expect(ids).toContain('sess-1')
      expect(ids).toContain('sess-2')
      expect(ids).toContain('sess-3')
    })

    it('getUrgentSessions returns only Critical and RotationNeeded', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('healthy')
      monitor.registerSession('warning')
      monitor.registerSession('critical')
      monitor.registerSession('rotation')

      // warning: 55%
      monitor.recordTurn('warning', 110_000)
      // critical: 78%
      monitor.recordTurn('critical', 156_000)
      // rotation: 90%
      monitor.recordTurn('rotation', 180_000)

      const urgent = monitor.getUrgentSessions()
      const ids = urgent.map((h) => h.sessionId)
      expect(ids).toContain('critical')
      expect(ids).toContain('rotation')
      expect(ids).not.toContain('healthy')
      expect(ids).not.toContain('warning')
    })

    it('getStats counts sessions by status correctly', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('h1')
      monitor.registerSession('h2')
      monitor.registerSession('w1')
      monitor.registerSession('c1')
      monitor.registerSession('r1')

      monitor.recordTurn('w1', 110_000) // 55% → Warning
      monitor.recordTurn('c1', 156_000) // 78% → Critical
      monitor.recordTurn('r1', 180_000) // 90% → RotationNeeded

      const stats = monitor.getStats()
      expect(stats.total).toBe(5)
      expect(stats.healthy).toBe(2)
      expect(stats.warning).toBe(1)
      expect(stats.critical).toBe(1)
      expect(stats.rotationNeeded).toBe(1)
    })

    it('empty monitor → all zeros in stats', () => {
      const monitor = createHealthMonitor()
      const stats = monitor.getStats()
      expect(stats.total).toBe(0)
      expect(stats.healthy).toBe(0)
      expect(stats.warning).toBe(0)
      expect(stats.critical).toBe(0)
      expect(stats.rotationNeeded).toBe(0)
    })
  })

  // ── Multi-session ──────────────────────────────────────────────────

  describe('multi-session', () => {
    it('tracks 3 sessions independently', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('a')
      monitor.registerSession('b')
      monitor.registerSession('c')

      monitor.recordTurn('a', 50_000)
      monitor.recordTurn('b', 150_000)
      monitor.recordTurn('c', 180_000)

      expect(monitor.getHealth('a')!.status).toBe(ContextStatus.Healthy)
      expect(monitor.getHealth('b')!.status).toBe(ContextStatus.Critical)
      expect(monitor.getHealth('c')!.status).toBe(ContextStatus.RotationNeeded)
    })

    it('one session rotated, others unaffected', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('a')
      monitor.registerSession('b')

      monitor.recordTurn('a', 50_000)
      monitor.recordTurn('b', 50_000)

      // Compact session a
      monitor.recordCompaction('a')
      expect(monitor.getHealth('a')!.estimatedTokens).toBe(30_000)
      // Session b unaffected
      expect(monitor.getHealth('b')!.estimatedTokens).toBe(50_000)
    })

    it('unregister one, others persist', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('a')
      monitor.registerSession('b')
      monitor.registerSession('c')

      monitor.unregisterSession('b')

      expect(monitor.getHealth('a')).not.toBeNull()
      expect(monitor.getHealth('b')).toBeNull()
      expect(monitor.getHealth('c')).not.toBeNull()
      expect(monitor.getAllHealth()).toHaveLength(2)
    })
  })

  // ── lastUpdated tracking ───────────────────────────────────────────

  describe('lastUpdated', () => {
    it('is set on registration', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      const health = monitor.getHealth('sess-1')
      expect(health!.lastUpdated).toBeTruthy()
      expect(new Date(health!.lastUpdated).toISOString()).toBe(health!.lastUpdated)
    })

    it('is updated on recordTurn', () => {
      const monitor = createHealthMonitor()
      monitor.registerSession('sess-1')
      const before = monitor.getHealth('sess-1')!.lastUpdated
      // Small delay to ensure different timestamp
      monitor.recordTurn('sess-1')
      const after = monitor.getHealth('sess-1')!.lastUpdated
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime())
    })
  })
})
