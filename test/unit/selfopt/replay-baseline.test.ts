/**
 * Phase 0 — replay harness + reproducible held-out baseline.
 *
 * The MockBackend is deterministic and offline (no agent spawn): for recorded
 * tasks it replays the historical label verbatim, so the held-out baseline is
 * exactly reproducible across runs — the property the Phase-0 verification bar
 * requires and that the strict-improve gate later compares candidates to.
 */
import { describe, it, expect } from 'vitest'
import {
  aggregateScores,
  MockBackend,
  replayBatch,
  replayOne,
} from '../../../src/selfopt/replay.js'
import { computeBaseline } from '../../../src/selfopt/baseline.js'
import { mineTaskRecords } from '../../../src/selfopt/mine.js'
import type { Event } from '../../../src/broker/types.js'
import type { TaskRecord } from '../../../src/selfopt/types.js'

let nextId = 1
function ev(event_type: string, payload: Record<string, unknown>): Event {
  return { id: nextId++, event_type, session_id: null, payload: JSON.stringify(payload), created_at: '2026-06-13T00:00:00Z' }
}
function pair(team: string, passed: boolean, score: number, qcid: string): Event[] {
  return [
    ev('team_completed', {
      teamId: team,
      memberSessionIds: [],
      stagedDiff: `diff --git a/src/${team}.ts b/src/${team}.ts\n`,
      aggregateOutcome: passed ? 'completed' : 'failed',
      completedAt: '2026-06-13T00:00:01Z',
    }),
    ev('quality_gate_verdict', {
      team_id: team,
      passed,
      score,
      reason: 'r',
      branch: `scns/auto/${team}`,
      sourceSuggestionId: null,
      qualityCheckId: qcid,
    }),
  ]
}
function history(): Event[] {
  nextId = 1
  return [
    ...pair('t1', true, 1.0, 'q1'),
    ...pair('t2', false, 0.45, 'q2'),
    ...pair('t3', false, 0.0, 'q3'),
    ...pair('t4', true, 0.9, 'q4'),
    ...pair('t5', true, 1.0, 'q5'),
    ...pair('t6', false, 0.25, 'q6'),
  ]
}

describe('replayOne (MockBackend, recorded judge)', () => {
  it('scores a recorded task from its historical label', async () => {
    const [task] = mineTaskRecords(history(), { project: 'scns' }) as TaskRecord[]
    const r = await replayOne(new MockBackend(), task!)
    expect(r.hard).toBe(task!.recordedScore)
    expect(r.id).toBe(task!.id)
    expect(r.tokens).toBeGreaterThan(0)
  })
})

describe('computeBaseline reproducibility', () => {
  it('produces an IDENTICAL held-out score across two runs (deterministic)', async () => {
    const tasksA = mineTaskRecords(history(), { project: 'scns' })
    const tasksB = mineTaskRecords(history(), { project: 'scns' })

    const b1 = await computeBaseline(tasksA, { split: 'val' })
    const b2 = await computeBaseline(tasksB, { split: 'val' })

    expect(b1.nTasks).toBe(b2.nTasks)
    expect(b1.score).toBe(b2.score)
    expect(b1.hard).toBe(b2.hard)
    // per-task report is identical and id-ordered
    expect(b1.perTask).toEqual(b2.perTask)
    const ids = b1.perTask.map((p) => p.id)
    expect([...ids].sort()).toEqual(ids)
  })

  it('baseline score equals the mean recorded score of the val split', async () => {
    const tasks = mineTaskRecords(history(), { project: 'scns' })
    const valTasks = tasks.filter((t) => t.split === 'val')
    expect(valTasks.length).toBeGreaterThan(0)
    const expectedMean =
      valTasks.reduce((s, t) => s + (t.recordedScore ?? 0), 0) / valTasks.length

    const baseline = await computeBaseline(tasks, { split: 'val' })
    expect(baseline.score).toBeCloseTo(expectedMean, 10)
  })

  it('aggregateScores averages hard/soft over a batch', async () => {
    const tasks = mineTaskRecords(history(), { project: 'scns' })
    const pairs = await replayBatch(new MockBackend(), tasks)
    const { hard } = aggregateScores(pairs)
    const mean = tasks.reduce((s, t) => s + (t.recordedScore ?? 0), 0) / tasks.length
    expect(hard).toBeCloseTo(mean, 10)
    expect(aggregateScores([])).toEqual({ hard: 0, soft: 0 })
  })
})
