/**
 * Phase-1 wedge 5 — mine the REAL held-out val split.
 *
 * T1-T3 are PURE: they drive `mineValTasksFromEvents` with INJECTED synthetic
 * broker events (the same payload shapes as mine.test.ts) — no database, no
 * network, no spawn. T4-T5 build a throwaway fixture broker DB on disk with the
 * broker's own schema (`openDatabase` + `appendEvent`) and prove `mineValTasks`
 * opens it READONLY and never mutates it (file bytes unchanged).
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { mineValTasks, mineValTasksFromEvents } from '../../../src/selfopt/mine-val-tasks.js'
import { mineTaskRecords } from '../../../src/selfopt/mine.js'
import { openDatabase } from '../../../src/broker/storage/db.js'
import { appendEvent } from '../../../src/broker/storage/repositories/event-repository.js'
import type { Event } from '../../../src/broker/types.js'

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

let nextId = 1
function ev(event_type: string, payload: Record<string, unknown>): Event {
  return {
    id: nextId++,
    event_type,
    session_id: null,
    payload: JSON.stringify(payload),
    created_at: '2026-06-13T00:00:00Z',
  }
}

function tc(team: string): Event {
  return ev('team_completed', {
    teamId: team,
    memberSessionIds: [`${team}-sess`],
    stagedDiff: `diff --git a/src/${team}.ts b/src/${team}.ts\n@@ -1 +1 @@\n-old\n+new\n`,
    aggregateOutcome: 'completed',
    completedAt: '2026-06-13T00:00:01Z',
  })
}

function qg(team: string, score: number, passed: boolean, qcid: string): Event {
  return ev('quality_gate_verdict', {
    team_id: team,
    passed,
    score,
    reason: 'r',
    branch: `scns/auto/${team}`,
    sourceSuggestionId: null,
    qualityCheckId: qcid,
  })
}

interface Spec {
  team: string
  score: number
  passed: boolean
  qcid: string
}

function syntheticEvents(specs: readonly Spec[]): Event[] {
  nextId = 1
  const events: Event[] = []
  for (const s of specs) {
    events.push(tc(s.team))
    events.push(qg(s.team, s.score, s.passed, s.qcid))
  }
  return events
}

const SIX: readonly Spec[] = [
  { team: 'team-a', score: 1.0, passed: true, qcid: 'qc-a' },
  { team: 'team-b', score: 0.45, passed: false, qcid: 'qc-b' },
  { team: 'team-c', score: 0.0, passed: false, qcid: 'qc-c' },
  { team: 'team-d', score: 0.55, passed: true, qcid: 'qc-d' },
  { team: 'team-e', score: 0.9, passed: false, qcid: 'qc-e' },
  { team: 'team-f', score: 1.0, passed: true, qcid: 'qc-f' },
]

describe('mineValTasksFromEvents — pure, injected events (no DB)', () => {
  it('T1: returns ONLY the recorded val split, and the split filter actually partitions', () => {
    const events = syntheticEvents(SIX)
    const all = mineTaskRecords(events, { project: 'scns' })
    const val = mineValTasksFromEvents(events)
    const train = mineValTasksFromEvents(events, { split: 'train' })

    // assignSplits guarantees a non-empty val when there are >= 2 real tasks.
    expect(val.length).toBeGreaterThanOrEqual(1)
    expect(val.every((t) => t.split === 'val')).toBe(true)
    expect(val.every((t) => t.referenceKind === 'recorded')).toBe(true)
    expect(train.every((t) => t.split === 'train')).toBe(true)

    // val and train are disjoint; together they cover the whole set (testFraction 0).
    const valIds = new Set(val.map((t) => t.id))
    expect(train.some((t) => valIds.has(t.id))).toBe(false)
    expect(val.length + train.length).toBe(all.length)
  })

  it('T2: deterministic — re-mining the same events yields an identical val split', () => {
    const a = mineValTasksFromEvents(syntheticEvents(SIX))
    const b = mineValTasksFromEvents(syntheticEvents(SIX))
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id))
    expect(a).toEqual(b)
  })

  it('T3: recordedScore is preserved and clamped to [0,1] for every val task', () => {
    const specs: Spec[] = [
      ...SIX,
      { team: 'team-hi', score: 1.5, passed: true, qcid: 'qc-hi' },
      { team: 'team-lo', score: -0.2, passed: false, qcid: 'qc-lo' },
    ]
    const scoreByTeam = new Map(specs.map((s) => [s.team, s.score]))
    const val = mineValTasksFromEvents(syntheticEvents(specs))

    expect(val.length).toBeGreaterThanOrEqual(1)
    for (const t of val) {
      expect(t.recordedScore).not.toBeNull()
      expect(t.recordedScore!).toBeGreaterThanOrEqual(0)
      expect(t.recordedScore!).toBeLessThanOrEqual(1)
      const teamTag = t.tags.find((tag) => tag.startsWith('team:'))
      expect(teamTag).toBeDefined()
      const team = teamTag!.slice('team:'.length)
      const raw = scoreByTeam.get(team)!
      expect(t.recordedScore!).toBe(Math.max(0, Math.min(1, raw)))
    }
  })
})

describe('mineValTasks — readonly fixture broker DB (no network, no spawn)', () => {
  function buildFixtureDb(dir: string): string {
    const dbPath = join(dir, 'fixture.db')
    const db = openDatabase(dbPath)
    for (const s of SIX) {
      appendEvent(db, {
        event_type: 'team_completed',
        session_id: null,
        payload: JSON.stringify({
          teamId: s.team,
          memberSessionIds: [`${s.team}-sess`],
          stagedDiff: `diff --git a/src/${s.team}.ts b/src/${s.team}.ts\n@@ -1 +1 @@\n-old\n+new\n`,
          aggregateOutcome: 'completed',
          completedAt: '2026-06-13T00:00:01Z',
        }),
      })
      appendEvent(db, {
        event_type: 'quality_gate_verdict',
        session_id: null,
        payload: JSON.stringify({
          team_id: s.team,
          passed: s.passed,
          score: s.score,
          reason: 'r',
          branch: `scns/auto/${s.team}`,
          sourceSuggestionId: null,
          qualityCheckId: s.qcid,
        }),
      })
    }
    db.close()
    return dbPath
  }

  it('T4: mines the val split end-to-end from a fixture broker DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scns-mvt-fixture-'))
    try {
      const dbPath = buildFixtureDb(dir)
      const val = mineValTasks(dbPath)
      expect(val.length).toBeGreaterThanOrEqual(1)
      expect(val.every((t) => t.split === 'val' && t.referenceKind === 'recorded')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('T5: opens the DB READONLY — the fixture file bytes are unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scns-mvt-ro-'))
    try {
      const dbPath = buildFixtureDb(dir)
      const before = sha256(readFileSync(dbPath, 'latin1'))
      const val = mineValTasks(dbPath)
      const after = sha256(readFileSync(dbPath, 'latin1'))
      expect(after).toBe(before)
      expect(val.length).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
