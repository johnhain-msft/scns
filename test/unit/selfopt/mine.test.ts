/**
 * Phase 0 — mining + deterministic split.
 *
 * Synthetic broker events mirror the REAL payload shapes verified live against
 * ~/.session-broker/data.db:
 *   - team_completed:       {teamId, memberSessionIds, stagedDiff, aggregateOutcome, completedAt}
 *   - quality_gate_verdict: {team_id, passed, score, reason, branch, sourceSuggestionId, qualityCheckId}
 *
 * Asserts: correlation (verdict <- nearest preceding team_completed of same
 * team), recorded-score labelling, and that the train/val/test split is a
 * deterministic function of the task id (re-mining => identical split).
 */
import { describe, it, expect } from 'vitest'
import {
  assignSplits,
  changedFilesFromDiff,
  mineTaskRecords,
  parseTeamOutcomes,
} from '../../../src/selfopt/mine.js'
import type { Event } from '../../../src/broker/types.js'
import type { TaskRecord } from '../../../src/selfopt/types.js'

let nextId = 1
function ev(event_type: string, payload: Record<string, unknown>, session_id: string | null = null): Event {
  return { id: nextId++, event_type, session_id, payload: JSON.stringify(payload), created_at: '2026-06-13T00:00:00Z' }
}

function tc(team: string, opts: { diff?: string; outcome?: string } = {}): Event {
  return ev('team_completed', {
    teamId: team,
    memberSessionIds: [`${team}-sess`],
    stagedDiff: opts.diff ?? `diff --git a/src/${team}.ts b/src/${team}.ts\n@@ -1 +1 @@\n-old\n+new\n`,
    aggregateOutcome: opts.outcome ?? 'completed',
    completedAt: '2026-06-13T00:00:01Z',
  })
}

function qg(
  team: string,
  opts: { passed: boolean; score: number; qcid: string; branch?: string; suggestionId?: string | null },
): Event {
  return ev('quality_gate_verdict', {
    team_id: team,
    passed: opts.passed,
    score: opts.score,
    reason: opts.passed ? 'baseline-clean' : 'lint-regression',
    branch: opts.branch ?? `scns/auto/${team}-x`,
    sourceSuggestionId: opts.suggestionId ?? null,
    qualityCheckId: opts.qcid,
  })
}

/** A realistic interleaving: TC then QG, per team, in id order. */
function syntheticHistory(): Event[] {
  nextId = 1
  const events: Event[] = []
  // 6 real outcomes with a spread of labels
  const specs: Array<{ team: string; passed: boolean; score: number; qcid: string; suggestionId?: string }> = [
    { team: 'team-a', passed: true, score: 1.0, qcid: 'qc-a' },
    { team: 'team-b', passed: false, score: 0.45, qcid: 'qc-b' },
    { team: 'team-c', passed: false, score: 0.0, qcid: 'qc-c' },
    { team: 'team-d', passed: true, score: 0.55, qcid: 'qc-d', suggestionId: 'sugg-1' },
    { team: 'team-e', passed: false, score: 0.9, qcid: 'qc-e' },
    { team: 'team-f', passed: true, score: 1.0, qcid: 'qc-f' },
  ]
  for (const s of specs) {
    events.push(tc(s.team))
    events.push(qg(s.team, s))
  }
  return events
}

describe('changedFilesFromDiff', () => {
  it('extracts all changed file paths from a unified diff', () => {
    const diff =
      'diff --git a/src/x.ts b/src/x.ts\n@@\n' + 'diff --git a/docs/y.md b/docs/y.md\n@@\n'
    expect(changedFilesFromDiff(diff)).toEqual(['src/x.ts', 'docs/y.md'])
    expect(changedFilesFromDiff('')).toEqual([])
  })
})

describe('parseTeamOutcomes', () => {
  it('pairs each verdict with the nearest preceding team_completed of the same team', () => {
    const outcomes = parseTeamOutcomes(syntheticHistory())
    expect(outcomes).toHaveLength(6)
    const a = outcomes.find((o) => o.teamId === 'team-a')!
    expect(a.passed).toBe(true)
    expect(a.score).toBe(1.0)
    expect(a.qualityCheckId).toBe('qc-a')
    expect(a.changedFiles).toEqual(['src/team-a.ts']) // recovered from the paired TC diff
    expect(a.aggregateOutcome).toBe('completed')
  })

  it('drops verdicts without a qualityCheckId (no stable identity)', () => {
    nextId = 1
    const events = [tc('team-x'), ev('quality_gate_verdict', { team_id: 'team-x', passed: true, score: 1 })]
    expect(parseTeamOutcomes(events)).toHaveLength(0)
  })

  it('keeps a verdict even when its team_completed is missing (label stands alone)', () => {
    nextId = 1
    const events = [qg('lonely', { passed: false, score: 0.25, qcid: 'qc-lonely' })]
    const outcomes = parseTeamOutcomes(events)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.changedFiles).toEqual([])
    expect(outcomes[0]!.score).toBe(0.25)
  })
})

describe('mineTaskRecords', () => {
  it('produces recorded-score TaskRecords with the right outcome labels', () => {
    const tasks = mineTaskRecords(syntheticHistory(), { project: 'scns' })
    expect(tasks).toHaveLength(6)
    for (const t of tasks) {
      expect(t.referenceKind).toBe('recorded')
      expect(t.recordedScore).not.toBeNull()
      expect(t.project).toBe('scns')
      expect(t.origin).toBe('real')
    }
    // outcome mapping: passed->success, !passed&score>0->mixed, !passed&score0->fail
    const byScore = Object.fromEntries(tasks.map((t) => [t.recordedScore, t.outcome]))
    expect(byScore[1]).toBe('success')
    expect(byScore[0.45]).toBe('mixed')
    expect(byScore[0]).toBe('fail')
  })

  it('uses the intent resolver for suggestion-backed tasks', () => {
    const tasks = mineTaskRecords(syntheticHistory(), {
      project: 'scns',
      intentResolver: (id) => (id === 'sugg-1' ? 'Add a clamp() numeric utility' : null),
    })
    const resolved = tasks.find((t) => t.tags.includes('suggestion:sugg-1'))!
    expect(resolved.intent).toBe('Add a clamp() numeric utility')
  })

  it('produces an IDENTICAL split on a re-mine (deterministic)', () => {
    const a = mineTaskRecords(syntheticHistory(), { project: 'scns' })
    const b = mineTaskRecords(syntheticHistory(), { project: 'scns' })
    const sig = (ts: TaskRecord[]) =>
      ts
        .map((t) => `${t.id}:${t.split}`)
        .sort()
        .join('|')
    expect(sig(a)).toBe(sig(b))
    // and a non-empty val (the gate set) exists
    expect(a.some((t) => t.split === 'val')).toBe(true)
  })
})

describe('assignSplits anti-overfitting contract', () => {
  const realTask = (id: string): TaskRecord => ({
    id,
    project: 'scns',
    intent: 'x',
    contextExcerpt: '',
    attemptedSolution: '',
    outcome: 'success',
    referenceKind: 'recorded',
    reference: '',
    recordedScore: 1,
    judge: null,
    tags: [],
    sourceSessions: [],
    split: 'train',
    origin: 'real',
    derivedFrom: '',
  })

  it('never places dream tasks in val/test; they always go to train', () => {
    const tasks: TaskRecord[] = [
      { ...realTask('r1'), origin: 'real' },
      { ...realTask('d1'), origin: 'dream', derivedFrom: 'r1' },
      { ...realTask('d2'), origin: 'dream', derivedFrom: 'r1' },
    ]
    const out = assignSplits(tasks, { valFraction: 1.0 }) // force every REAL task to val
    for (const t of out) {
      if (t.origin === 'dream') expect(t.split).toBe('train')
    }
  })

  it('is a pure function of (seed, id) — same inputs, same split', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e'].map(realTask)
    const s1 = assignSplits(tasks, { seed: 7 }).map((t) => t.split)
    const s2 = assignSplits(tasks, { seed: 7 }).map((t) => t.split)
    expect(s1).toEqual(s2)
    // a different seed generally yields a different assignment
    const s3 = assignSplits(tasks, { seed: 999 }).map((t) => t.split)
    expect(s3).not.toEqual([]) // sanity; determinism of seed-999 itself:
    expect(assignSplits(tasks, { seed: 999 }).map((t) => t.split)).toEqual(s3)
  })

  it('does not mutate the input task objects', () => {
    const tasks = [realTask('a'), realTask('b')]
    const before = tasks.map((t) => t.split)
    assignSplits(tasks, { seed: 1 })
    expect(tasks.map((t) => t.split)).toEqual(before)
  })
})
