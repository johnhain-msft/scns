import { describe, it, expect } from 'vitest'
import {
  ContextStatus,
  RotationAction,
  ContextHealthConfigSchema,
  type ContextHealth,
  type RotationRecommendation,
  type HandoffState,
} from '../../../src/context/types.js'

describe('ContextStatus', () => {
  it('has correct string values', () => {
    expect(ContextStatus.Healthy).toBe('healthy')
    expect(ContextStatus.Warning).toBe('warning')
    expect(ContextStatus.Critical).toBe('critical')
    expect(ContextStatus.RotationNeeded).toBe('rotation-needed')
    expect(ContextStatus.Compacted).toBe('compacted')
  })

  it('contains exactly 5 statuses', () => {
    const values = Object.values(ContextStatus)
    expect(values).toHaveLength(5)
  })
})

describe('RotationAction', () => {
  it('has correct string values', () => {
    expect(RotationAction.None).toBe('none')
    expect(RotationAction.Compact).toBe('compact')
    expect(RotationAction.Handoff).toBe('handoff')
    expect(RotationAction.Summarize).toBe('summarize')
    expect(RotationAction.Split).toBe('split')
  })

  it('contains exactly 5 actions', () => {
    const values = Object.values(RotationAction)
    expect(values).toHaveLength(5)
  })
})

describe('ContextHealthConfigSchema', () => {
  it('applies all defaults when given empty object', () => {
    const config = ContextHealthConfigSchema.parse({})
    expect(config.defaultMaxTokens).toBe(200_000)
    expect(config.warningThreshold).toBe(50)
    expect(config.criticalThreshold).toBe(75)
    expect(config.rotationThreshold).toBe(85)
    expect(config.tokensPerTurn).toBe(2000)
    expect(config.tokensPerToolCall).toBe(500)
    expect(config.compactionSavingsPercent).toBe(40)
  })

  it('allows custom overrides', () => {
    const config = ContextHealthConfigSchema.parse({
      defaultMaxTokens: 128_000,
      warningThreshold: 40,
      criticalThreshold: 60,
      rotationThreshold: 80,
      tokensPerTurn: 3000,
      tokensPerToolCall: 800,
      compactionSavingsPercent: 50,
    })
    expect(config.defaultMaxTokens).toBe(128_000)
    expect(config.warningThreshold).toBe(40)
    expect(config.criticalThreshold).toBe(60)
    expect(config.rotationThreshold).toBe(80)
    expect(config.tokensPerTurn).toBe(3000)
    expect(config.tokensPerToolCall).toBe(800)
    expect(config.compactionSavingsPercent).toBe(50)
  })

  it('rejects warningThreshold below 0', () => {
    expect(() => ContextHealthConfigSchema.parse({ warningThreshold: -1 })).toThrow()
  })

  it('rejects warningThreshold above 100', () => {
    expect(() => ContextHealthConfigSchema.parse({ warningThreshold: 101 })).toThrow()
  })

  it('rejects criticalThreshold above 100', () => {
    expect(() => ContextHealthConfigSchema.parse({ criticalThreshold: 101 })).toThrow()
  })

  it('rejects rotationThreshold below 0', () => {
    expect(() => ContextHealthConfigSchema.parse({ rotationThreshold: -1 })).toThrow()
  })
})

describe('ContextHealth interface', () => {
  it('accepts a valid context health object', () => {
    const health: ContextHealth = {
      sessionId: 'sess-1',
      estimatedTokens: 50_000,
      maxTokens: 200_000,
      usagePercent: 25,
      status: ContextStatus.Healthy,
      lastUpdated: '2025-01-01T00:00:00Z',
      turnCount: 10,
      toolCallCount: 5,
      compactionCount: 0,
    }
    expect(health.sessionId).toBe('sess-1')
    expect(health.status).toBe('healthy')
  })
})

describe('RotationRecommendation interface', () => {
  it('accepts a valid rotation recommendation', () => {
    const rec: RotationRecommendation = {
      sessionId: 'sess-1',
      urgency: 'high',
      reason: 'Context nearly full',
      suggestedAction: RotationAction.Handoff,
      estimatedTokensSaved: 80_000,
    }
    expect(rec.urgency).toBe('high')
    expect(rec.suggestedAction).toBe('handoff')
  })
})

describe('HandoffState interface', () => {
  it('accepts a valid handoff state', () => {
    const handoff: HandoffState = {
      sessionId: 'sess-1',
      summary: 'Completed auth module',
      pendingWork: ['Add tests', 'Deploy'],
      keyDecisions: ['Used JWT'],
      filesModified: ['src/auth.ts'],
      timestamp: '2025-01-01T00:00:00Z',
    }
    expect(handoff.pendingWork).toHaveLength(2)
    expect(handoff.filesModified).toContain('src/auth.ts')
  })
})
