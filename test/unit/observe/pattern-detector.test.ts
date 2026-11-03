import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Observation } from '../../../src/observe/types.js'
import { createPatternDetector } from '../../../src/observe/pattern-detector.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeObs(overrides: Partial<Observation> & { timestamp: string }): Observation {
  return {
    id: randomUUID(),
    type: 'active-app',
    source: 'VSCode',
    content: 'Switched to VSCode',
    tags: [],
    ...overrides,
  }
}

function makeObsAt(
  hour: number,
  day: number = 3,
  type = 'active-app' as const,
  source = 'VSCode',
): Observation {
  const d = new Date(Date.UTC(2025, 0, 12 + day, hour, 0, 0))
  return makeObs({ timestamp: d.toISOString(), type, source })
}

function makeGitObs(repo: string, timestamp: string): Observation {
  return makeObs({
    type: 'git-activity',
    source: repo,
    content: `commit in ${repo}`,
    timestamp,
    tags: ['git:commit'],
  })
}

function makeFileObs(ext: string, timestamp: string): Observation {
  return makeObs({
    type: 'file-change',
    source: 'fs-watcher',
    content: `changed file.${ext}`,
    timestamp,
    tags: [`ext:${ext}`],
  })
}

// ── Work Schedule ────────────────────────────────────────────────────

describe('detectWorkSchedule', () => {
  const detector = createPatternDetector()

  it('detects active hours from observation timestamps', () => {
    const obs = [
      makeObsAt(9),
      makeObsAt(9),
      makeObsAt(10),
      makeObsAt(10),
      makeObsAt(14),
      makeObsAt(14),
      makeObsAt(14),
      makeObsAt(17),
      makeObsAt(17),
      makeObsAt(17),
    ]
    const result = detector.detectWorkSchedule(obs)
    expect(result).not.toBeNull()
    expect(result!.activeHours).toContain(9)
    expect(result!.activeHours).toContain(10)
    expect(result!.activeHours).toContain(14)
    expect(result!.activeHours).toContain(17)
  })

  it('identifies peak hour correctly', () => {
    const obs = [
      makeObsAt(9),
      makeObsAt(9),
      makeObsAt(9),
      makeObsAt(10),
      makeObsAt(10),
      makeObsAt(10),
      makeObsAt(10),
      makeObsAt(14),
      makeObsAt(14),
      makeObsAt(14),
    ]
    const result = detector.detectWorkSchedule(obs)
    expect(result!.peakHour).toBe(10)
  })

  it('calculates average session length', () => {
    // Session 1: 09:00, 09:10, 09:20 (20 min)
    // Break gap > 30 min
    // Session 2: 11:00, 11:15 (15 min)
    const obs = [
      makeObs({ timestamp: '2025-01-15T09:00:00Z' }),
      makeObs({ timestamp: '2025-01-15T09:10:00Z' }),
      makeObs({ timestamp: '2025-01-15T09:20:00Z' }),
      makeObs({ timestamp: '2025-01-15T11:00:00Z' }),
      makeObs({ timestamp: '2025-01-15T11:15:00Z' }),
      // extra to hit minObservations
      makeObs({ timestamp: '2025-01-15T11:16:00Z' }),
      makeObs({ timestamp: '2025-01-15T11:17:00Z' }),
      makeObs({ timestamp: '2025-01-15T11:18:00Z' }),
      makeObs({ timestamp: '2025-01-15T11:19:00Z' }),
      makeObs({ timestamp: '2025-01-15T11:20:00Z' }),
    ]
    const result = detector.detectWorkSchedule(obs)
    expect(result).not.toBeNull()
    // Session 1 = 20 min, Session 2 = 20 min → avg = 20
    expect(result!.averageSessionMinutes).toBeCloseTo(20, 0)
  })

  it('detects break gaps (>30 min gaps)', () => {
    const obs = [
      makeObs({ timestamp: '2025-01-15T09:00:00Z' }),
      makeObs({ timestamp: '2025-01-15T09:10:00Z' }),
      makeObs({ timestamp: '2025-01-15T10:00:00Z' }), // 50 min gap → break
      makeObs({ timestamp: '2025-01-15T10:10:00Z' }),
      makeObs({ timestamp: '2025-01-15T12:00:00Z' }), // 110 min gap → break
      makeObs({ timestamp: '2025-01-15T12:05:00Z' }),
      makeObs({ timestamp: '2025-01-15T12:10:00Z' }),
      makeObs({ timestamp: '2025-01-15T12:15:00Z' }),
      makeObs({ timestamp: '2025-01-15T12:20:00Z' }),
      makeObs({ timestamp: '2025-01-15T12:25:00Z' }),
    ]
    const result = detector.detectWorkSchedule(obs)
    expect(result!.breakGaps).toContain(50)
    expect(result!.breakGaps).toContain(110)
    expect(result!.breakGaps).toHaveLength(2)
  })

  it('identifies active days of week', () => {
    // Wed=3, Thu=4
    const obs = [
      ...Array.from({ length: 5 }, () => makeObsAt(10, 3)),
      ...Array.from({ length: 5 }, () => makeObsAt(14, 4)),
    ]
    const result = detector.detectWorkSchedule(obs)
    expect(result!.activeDays).toContain(3) // Wed
    expect(result!.activeDays).toContain(4) // Thu
  })

  it('returns null when fewer than minObservations', () => {
    const obs = [makeObsAt(10), makeObsAt(11)]
    const result = detector.detectWorkSchedule(obs)
    expect(result).toBeNull()
  })

  it('handles single observation (edge case)', () => {
    const custom = createPatternDetector({ minObservations: 1 })
    const obs = [makeObsAt(14)]
    const result = custom.detectWorkSchedule(obs)
    expect(result).not.toBeNull()
    expect(result!.activeHours).toEqual([14])
    expect(result!.peakHour).toBe(14)
    expect(result!.averageSessionMinutes).toBe(0)
    expect(result!.breakGaps).toEqual([])
  })

  it('handles observations all in same hour', () => {
    const obs = Array.from({ length: 10 }, () => makeObsAt(10))
    const result = detector.detectWorkSchedule(obs)
    expect(result!.activeHours).toEqual([10])
    expect(result!.peakHour).toBe(10)
  })

  it('handles observations spread across midnight', () => {
    const obs = [
      ...Array.from({ length: 5 }, () => makeObsAt(23)),
      ...Array.from({ length: 5 }, () => makeObsAt(0)),
    ]
    const result = detector.detectWorkSchedule(obs)
    expect(result!.activeHours).toContain(23)
    expect(result!.activeHours).toContain(0)
  })
})

// ── Tool Frequency ───────────────────────────────────────────────────

describe('detectToolFrequency', () => {
  const detector = createPatternDetector()

  it('counts app usage correctly', () => {
    const obs = [
      makeObsAt(10, 3, 'active-app', 'VSCode'),
      makeObsAt(10, 3, 'active-app', 'VSCode'),
      makeObsAt(11, 3, 'active-app', 'Chrome'),
    ]
    const result = detector.detectToolFrequency(obs)
    expect(result).not.toBeNull()
    expect(result!.appCounts.get('VSCode')).toBe(2)
    expect(result!.appCounts.get('Chrome')).toBe(1)
  })

  it('returns top 5 apps in order', () => {
    const apps = ['A', 'B', 'C', 'D', 'E', 'F']
    const counts = [10, 8, 6, 4, 2, 1]
    const obs = apps.flatMap((app, i) =>
      Array.from({ length: counts[i] }, () => makeObsAt(10, 3, 'active-app', app)),
    )
    const result = detector.detectToolFrequency(obs)
    expect(result!.topApps).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('categorizes IDEs as "coding"', () => {
    const ides = ['VSCode', 'Cursor', 'Xcode', 'IntelliJ']
    const obs = ides.map((ide) => makeObsAt(10, 3, 'active-app', ide))
    const result = detector.detectToolFrequency(obs)
    expect(result!.categoryBreakdown.get('coding')).toBe(4)
  })

  it('categorizes browsers as "browsing"', () => {
    const browsers = ['Chrome', 'Safari', 'Arc', 'Firefox']
    const obs = browsers.map((b) => makeObsAt(10, 3, 'active-app', b))
    const result = detector.detectToolFrequency(obs)
    expect(result!.categoryBreakdown.get('browsing')).toBe(4)
  })

  it('categorizes messaging as "communication"', () => {
    const apps = ['Slack', 'Discord', 'Teams']
    const obs = apps.map((a) => makeObsAt(10, 3, 'active-app', a))
    const result = detector.detectToolFrequency(obs)
    expect(result!.categoryBreakdown.get('communication')).toBe(3)
  })

  it('handles unknown apps as "other"', () => {
    const obs = [makeObsAt(10, 3, 'active-app', 'SomeRandomApp')]
    const result = detector.detectToolFrequency(obs)
    expect(result!.categoryBreakdown.get('other')).toBe(1)
  })

  it('returns null when no active-app observations', () => {
    const obs = [makeGitObs('repo', '2025-01-15T10:00:00Z')]
    const result = detector.detectToolFrequency(obs)
    expect(result).toBeNull()
  })

  it('handles single app (all usage is one app)', () => {
    const obs = Array.from({ length: 5 }, () => makeObsAt(10, 3, 'active-app', 'Cursor'))
    const result = detector.detectToolFrequency(obs)
    expect(result!.topApps).toEqual(['Cursor'])
    expect(result!.appCounts.get('Cursor')).toBe(5)
  })
})

// ── Project Focus ────────────────────────────────────────────────────

describe('detectProjectFocus', () => {
  const detector = createPatternDetector()

  it('counts commits per repo', () => {
    const obs = [
      makeGitObs('scns', '2025-01-15T10:00:00Z'),
      makeGitObs('scns', '2025-01-15T11:00:00Z'),
      makeGitObs('other-repo', '2025-01-15T12:00:00Z'),
    ]
    const result = detector.detectProjectFocus(obs)
    expect(result).not.toBeNull()
    expect(result!.repoCounts.get('scns')).toBe(2)
    expect(result!.repoCounts.get('other-repo')).toBe(1)
  })

  it('returns top repos in order', () => {
    const obs = [
      ...Array.from({ length: 5 }, () => makeGitObs('alpha', '2025-01-15T10:00:00Z')),
      ...Array.from({ length: 3 }, () => makeGitObs('beta', '2025-01-15T10:00:00Z')),
      ...Array.from({ length: 1 }, () => makeGitObs('gamma', '2025-01-15T10:00:00Z')),
    ]
    const result = detector.detectProjectFocus(obs)
    expect(result!.topRepos).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('counts file changes by extension', () => {
    const obs = [
      makeFileObs('ts', '2025-01-15T10:00:00Z'),
      makeFileObs('ts', '2025-01-15T10:01:00Z'),
      makeFileObs('json', '2025-01-15T10:02:00Z'),
    ]
    const result = detector.detectProjectFocus(obs)
    expect(result!.fileTypeCounts.get('ts')).toBe(2)
    expect(result!.fileTypeCounts.get('json')).toBe(1)
  })

  it('combines git commits and file-change events into repoActivityCounts (basename-keyed)', () => {
    const fileEdit = (ts: string) =>
      makeObs({
        type: 'file-change',
        source: '/Users/me/Coding_Projects/scns',
        content: 'changed file.ts',
        timestamp: ts,
        tags: ['ext:ts'],
      })
    const obs = [
      makeGitObs('scns', '2025-01-15T10:00:00Z'),
      makeGitObs('scns', '2025-01-15T11:00:00Z'),
      fileEdit('2025-01-15T12:00:00Z'),
      fileEdit('2025-01-15T12:01:00Z'),
      fileEdit('2025-01-15T12:02:00Z'),
    ]
    const result = detector.detectProjectFocus(obs)
    // 2 commits + 3 file edits, all keyed by repo basename 'scns'
    expect(result!.repoActivityCounts.get('scns')).toBe(5)
    // git-only repoCounts is unchanged (regression-safe)
    expect(result!.repoCounts.get('scns')).toBe(2)
  })

  it('repoActivityCounts surfaces a repo under active editing with zero commits', () => {
    const fileEdit = (ts: string) =>
      makeObs({
        type: 'file-change',
        source: '/Users/me/code/scns',
        content: 'edit',
        timestamp: ts,
        tags: ['ext:ts'],
      })
    const obs = [fileEdit('2025-01-15T12:00:00Z'), fileEdit('2025-01-15T12:01:00Z')]
    const result = detector.detectProjectFocus(obs)
    expect(result!.repoCounts.get('scns')).toBeUndefined() // no commits during a freeze
    expect(result!.repoActivityCounts.get('scns')).toBe(2) // but active editing is visible
  })

  it('identifies recent focus (last 24h window)', () => {
    const obs = [
      // Older activity — lots of commits in alpha
      ...Array.from({ length: 10 }, () => makeGitObs('alpha', '2025-01-13T10:00:00Z')),
      // Recent activity — beta dominates last 24h
      ...Array.from({ length: 3 }, () => makeGitObs('beta', '2025-01-15T22:00:00Z')),
      makeGitObs('alpha', '2025-01-15T23:00:00Z'),
    ]
    const result = detector.detectProjectFocus(obs)
    expect(result!.recentFocus).toBe('beta')
  })

  it('returns null when no git/file observations', () => {
    const obs = [makeObsAt(10, 3, 'active-app', 'VSCode')]
    const result = detector.detectProjectFocus(obs)
    expect(result).toBeNull()
  })

  it('recentFocus is null when no recent activity', () => {
    // Git activity is old, but a file-change observation is recent
    // so the window end is driven by the file-change, and git is >24h before it
    const obs = [
      makeGitObs('old-repo', '2025-01-01T10:00:00Z'),
      makeGitObs('old-repo', '2025-01-01T11:00:00Z'),
      makeFileObs('ts', '2025-01-10T12:00:00Z'),
    ]
    const result = detector.detectProjectFocus(obs)
    expect(result).not.toBeNull()
    expect(result!.recentFocus).toBeNull()
  })

  it('handles repos with same count (stable sort)', () => {
    const obs = [
      makeGitObs('aaa', '2025-01-15T10:00:00Z'),
      makeGitObs('bbb', '2025-01-15T10:01:00Z'),
    ]
    const result = detector.detectProjectFocus(obs)
    expect(result!.topRepos).toHaveLength(2)
    // Both present, order is stable (first seen first)
    expect(result!.topRepos).toContain('aaa')
    expect(result!.topRepos).toContain('bbb')
  })
})

// ── Integration: detect() ────────────────────────────────────────────

function recentISO(offsetMinutes: number): string {
  return new Date(Date.now() - offsetMinutes * 60_000).toISOString()
}

describe('detect (integration)', () => {
  it('returns all three patterns when sufficient data', () => {
    const _now = recentISO(0)
    const obs = [
      ...Array.from({ length: 10 }, (_, i) =>
        makeObs({
          timestamp: recentISO(i * 5),
          type: 'active-app',
          source: i % 2 === 0 ? 'VSCode' : 'Chrome',
        }),
      ),
      ...Array.from({ length: 3 }, () => makeGitObs('scns', recentISO(60))),
      ...Array.from({ length: 2 }, () => makeFileObs('ts', recentISO(90))),
    ]
    const detector = createPatternDetector({ minObservations: 5 })
    const result = detector.detect(obs)
    expect(result.workSchedule).not.toBeNull()
    expect(result.toolFrequency).not.toBeNull()
    expect(result.projectFocus).not.toBeNull()
    expect(result.observationCount).toBe(15)
  })

  it('handles mixed observation types', () => {
    const obs = [
      makeObs({ timestamp: recentISO(10), type: 'active-app', source: 'VSCode' }),
      makeGitObs('scns', recentISO(8)),
      makeFileObs('ts', recentISO(6)),
      makeObs({
        type: 'terminal-history',
        timestamp: recentISO(4),
        source: 'zsh',
        content: 'ls -la',
      }),
      makeObs({
        type: 'browser-tab',
        timestamp: recentISO(2),
        source: 'Chrome',
        content: 'github.com',
      }),
    ]
    const detector = createPatternDetector({ minObservations: 1 })
    const result = detector.detect(obs)
    expect(result.observationCount).toBe(5)
    expect(result.workSchedule).not.toBeNull()
  })

  it('with empty array returns nulls + count 0', () => {
    const detector = createPatternDetector()
    const result = detector.detect([])
    expect(result.workSchedule).toBeNull()
    expect(result.toolFrequency).toBeNull()
    expect(result.projectFocus).toBeNull()
    expect(result.observationCount).toBe(0)
    expect(result.windowStart).toBe('')
    expect(result.windowEnd).toBe('')
  })

  it('custom windowHours respected', () => {
    // All observations are 200 hours ago — outside 24h window
    const oldDate = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString()
    const obs = Array.from({ length: 10 }, () =>
      makeObs({ timestamp: oldDate, type: 'active-app', source: 'VSCode' }),
    )
    const detector = createPatternDetector({ windowHours: 24 })
    const result = detector.detect(obs)
    // Observations outside window are filtered out
    expect(result.observationCount).toBe(0)
    expect(result.workSchedule).toBeNull()
  })

  it('custom minObservations threshold works', () => {
    const obs = Array.from({ length: 5 }, () =>
      makeObs({ timestamp: recentISO(5), type: 'active-app', source: 'VSCode' }),
    )
    const strict = createPatternDetector({ minObservations: 20 })
    const result = strict.detect(obs)
    expect(result.workSchedule).toBeNull()
  })

  it('window start/end calculated correctly from observations', () => {
    const t1 = recentISO(120) // earliest
    const t2 = recentISO(60)
    const t3 = recentISO(10) // latest
    const obs = [
      makeObs({ timestamp: t1 }),
      makeObs({ timestamp: t2 }),
      makeObs({ timestamp: t3 }),
      ...Array.from({ length: 7 }, () => makeObs({ timestamp: t2 })),
    ]
    const detector = createPatternDetector()
    const result = detector.detect(obs)
    expect(result.windowStart).toBe(new Date(t1).toISOString())
    expect(result.windowEnd).toBe(new Date(t3).toISOString())
  })
})
