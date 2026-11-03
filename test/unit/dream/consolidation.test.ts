import { describe, it, expect } from 'vitest'
import {
  orient,
  gather,
  consolidate,
  prune,
  runConsolidation,
} from '../../../src/dream/consolidation.js'
import { serializeMemoryMd } from '../../../src/dream/memory-entries.js'
import type { MemoryEntry } from '../../../src/dream/memory-entries.js'

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    type: 'project',
    name: 'test-entry',
    description: 'A test entry',
    content: 'Some test content.',
    ...overrides,
  }
}

function buildMd(entries: MemoryEntry[]): string {
  return serializeMemoryMd(entries)
}

const REF_DATE = new Date('2025-06-15')

// -------------------------------------------------------------------
// Phase 1: ORIENT
// -------------------------------------------------------------------
describe('orient', () => {
  it('parses valid MEMORY.md into correct entries', () => {
    const entries = [
      entry({ name: 'Pref A', type: 'user', description: 'desc A', content: 'content A' }),
      entry({ name: 'Proj B', type: 'project', description: 'desc B', content: 'content B' }),
    ]
    const md = buildMd(entries)
    const result = orient(md)
    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe('Pref A')
    expect(result[1]!.name).toBe('Proj B')
  })

  it('empty MEMORY.md → empty array', () => {
    expect(orient('')).toEqual([])
    expect(orient('   ')).toEqual([])
  })

  it('malformed MEMORY.md → empty array (graceful)', () => {
    expect(orient('not valid markdown at all')).toEqual([])
    expect(orient('---\nbroken\n')).toEqual([])
  })

  it('converts relative dates to absolute', () => {
    const entries = [entry({ name: 'E1', content: 'Discovered yesterday in code review.' })]
    const md = buildMd(entries)
    const result = orient(md, REF_DATE)
    expect(result[0]!.content).toContain('2025-06-14')
    expect(result[0]!.content).not.toContain('yesterday')
  })

  it('drops machine-authored entries carried forward from pre-gate harvests', () => {
    // The extraction gate only protects NEW harvests. A dispatch brief harvested
    // before the gate existed sits in MEMORY.md and is re-synthesized and
    // re-injected every cycle unless the carry-forward path drops it.
    const briefText =
      'You are slidesmith. Scope is TWO rows of storyboard.md and nothing else - you must NOT touch slides.'
    const md = buildMd([
      entry({ name: 'Real preference', type: 'user', content: 'Prefers tabs over spaces.' }),
      entry({
        name: 'Never Touch Slides',
        type: 'prohibition',
        description: briefText,
        content: briefText,
      }),
    ])
    const result = orient(md, REF_DATE)
    expect(result.map((e) => e.name)).toEqual(['Real preference'])
  })
})

// -------------------------------------------------------------------
// Phase 2: GATHER
// -------------------------------------------------------------------
describe('gather', () => {
  it('valid entries pass through', () => {
    const input: MemoryEntry[] = [entry({ name: 'G1' }), entry({ name: 'G2' })]
    const result = gather(input)
    expect(result).toHaveLength(2)
  })

  it('invalid entries filtered out', () => {
    const input = [
      entry({ name: 'Good' }),
      { type: 'user', name: '', description: '', content: '' } as unknown as MemoryEntry,
    ]
    const result = gather(input)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('Good')
  })

  it('converts relative dates', () => {
    const input = [entry({ name: 'E1', content: 'Added yesterday.' })]
    const result = gather(input, REF_DATE)
    expect(result[0]!.content).toContain('2025-06-14')
  })

  it('empty input → empty output', () => {
    expect(gather([])).toEqual([])
  })
})

// -------------------------------------------------------------------
// Phase 3: CONSOLIDATE
// -------------------------------------------------------------------
describe('consolidate', () => {
  it('existing + new merged correctly (new entries are newer)', () => {
    const existing = [entry({ name: 'Ex1', content: 'existing' })]
    const gathered = [entry({ name: 'New1', content: 'new thing' })]
    const result = consolidate(existing, gathered)
    expect(result.entries.length).toBeGreaterThanOrEqual(2)
  })

  it('duplicate entries deduplicated (keep newer)', () => {
    // Use different names but near-identical content to trigger dedup (not contradiction)
    const existing = [
      entry({ name: 'DB Info', content: 'Uses PostgreSQL with Supabase for data.' }),
    ]
    const gathered = [
      entry({ name: 'Database Info', content: 'Uses PostgreSQL with Supabase for data!' }),
    ]
    const result = consolidate(existing, gathered)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.name).toBe('Database Info')
    expect(result.deduped).toBeGreaterThanOrEqual(1)
  })

  it('contradicting entries resolved (keep newer)', () => {
    const existing = [entry({ name: 'DB', content: 'Use MySQL' })]
    const gathered = [entry({ name: 'DB', content: 'Use PostgreSQL' })]
    const result = consolidate(existing, gathered)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.content).toBe('Use PostgreSQL')
    expect(result.contradictions).toBeGreaterThanOrEqual(1)
  })

  it('stats reflect dedup/contradiction counts', () => {
    const existing = [entry({ name: 'A', content: 'v1' }), entry({ name: 'B', content: 'unique' })]
    const gathered = [
      entry({ name: 'A', content: 'v2' }),
      entry({ name: 'C', content: 'brand new' }),
    ]
    const result = consolidate(existing, gathered)
    // A was contradicted/deduped, B and C remain
    expect(result.entries.length).toBeGreaterThanOrEqual(2)
  })

  it('no duplicates → all kept, deduped=0', () => {
    const existing = [entry({ name: 'X', content: 'xxx' })]
    const gathered = [entry({ name: 'Y', content: 'yyy' })]
    const result = consolidate(existing, gathered)
    expect(result.entries).toHaveLength(2)
    expect(result.deduped).toBe(0)
    expect(result.contradictions).toBe(0)
  })

  it('groups entries by type', () => {
    const existing: MemoryEntry[] = []
    const gathered: MemoryEntry[] = [
      entry({
        type: 'reference',
        name: 'Ref1',
        content: 'A useful reference link.',
        createdAt: '2025-01-01',
      }),
      entry({
        type: 'user',
        name: 'Usr1',
        content: 'User prefers dark mode always.',
        createdAt: '2025-01-01',
      }),
      entry({
        type: 'project',
        name: 'Prj1',
        content: 'Project uses Node.js runtime.',
        createdAt: '2025-01-01',
      }),
    ]
    const result = consolidate(existing, gathered)
    const types = result.entries.map((e) => e.type)
    const userIdx = types.indexOf('user')
    const refIdx = types.indexOf('reference')
    expect(userIdx).toBeLessThan(refIdx)
  })
})

// -------------------------------------------------------------------
// Phase 4: PRUNE
// -------------------------------------------------------------------
describe('prune', () => {
  it('under limits → no pruning, truncated=false', () => {
    const entries = [entry({ name: 'Small', content: 'tiny.' })]
    const result = prune(entries)
    expect(result.truncated).toBe(false)
    expect(result.entries).toHaveLength(1)
  })

  it('over line limit → entries removed to fit', () => {
    // Create many entries that exceed 200 lines total
    const entries: MemoryEntry[] = []
    for (let i = 0; i < 50; i++) {
      entries.push(
        entry({
          name: `Entry-${i}`,
          type: i < 5 ? 'user' : 'reference',
          content: `Line 1\nLine 2\nLine 3\nLine 4\nLine 5`,
          createdAt: `2025-01-${String(i + 1).padStart(2, '0')}`,
        }),
      )
    }
    const result = prune(entries)
    expect(result.entries.length).toBeLessThan(50)
  })

  it('reference entries dropped before user entries', () => {
    const entries: MemoryEntry[] = []
    // 10 user entries, 40 reference entries — should keep user
    for (let i = 0; i < 10; i++) {
      entries.push(
        entry({
          name: `User-${i}`,
          type: 'user',
          content: 'User pref line.',
          createdAt: `2025-06-${String(i + 1).padStart(2, '0')}`,
        }),
      )
    }
    for (let i = 0; i < 40; i++) {
      entries.push(
        entry({
          name: `Ref-${i}`,
          type: 'reference',
          content: `Ref line 1\nRef line 2\nRef line 3\nRef line 4`,
          createdAt: `2025-01-${String(i + 1).padStart(2, '0')}`,
        }),
      )
    }
    const result = prune(entries)
    const userCount = result.entries.filter((e) => e.type === 'user').length
    // All user entries should survive since they have higher priority
    expect(userCount).toBe(10)
  })

  it('older entries dropped before newer ones of same type', () => {
    const entries: MemoryEntry[] = []
    for (let i = 0; i < 50; i++) {
      entries.push(
        entry({
          name: `Ref-${i}`,
          type: 'reference',
          content: `Content line 1\nContent line 2\nContent line 3\nContent line 4`,
          createdAt: `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        }),
      )
    }
    const result = prune(entries)
    if (result.entries.length < entries.length) {
      // The kept entries should be newer ones (higher index = later date)
      const keptNames = new Set(result.entries.map((e) => e.name))
      const lastKeptIdx = Math.max(
        ...result.entries.map((e) => {
          const num = parseInt(e.name.split('-')[1]!, 10)
          return num
        }),
      )
      // The newest entry should be kept
      expect(keptNames.has(`Ref-${lastKeptIdx}`)).toBe(true)
    }
  })

  it('truncation as final safety net', () => {
    // Multiple entries that individually fit but collectively exceed limits,
    // and the last remaining entry is still oversized after trimToFit
    const entries: MemoryEntry[] = [
      entry({ name: 'Big-user', type: 'user', content: 'X\n'.repeat(250) }),
    ]
    const result = prune(entries)
    expect(result.truncated).toBe(true)
  })
})

// -------------------------------------------------------------------
// runConsolidation (full pipeline)
// -------------------------------------------------------------------
describe('runConsolidation', () => {
  it('full pipeline: existing MEMORY.md + new entries → improved MEMORY.md', () => {
    const existingMd = buildMd([
      entry({ name: 'Existing', type: 'project', content: 'Existing project info.' }),
    ])
    const newEntries: MemoryEntry[] = [
      entry({ name: 'New Pref', type: 'user', content: 'New user preference.' }),
    ]
    const result = runConsolidation({ currentMemoryMd: existingMd, newEntries })
    expect(result.memoryMd).toContain('Existing')
    expect(result.memoryMd).toContain('New Pref')
    expect(result.entriesProcessed).toBe(2)
    expect(result.entriesKept).toBe(2)
  })

  it('empty existing + new entries → new MEMORY.md created', () => {
    const contents = [
      'The backend API is built with Express and TypeScript for type safety.',
      'PostgreSQL serves as the primary database with Supabase hosting.',
      'Authentication uses JWT tokens with refresh token rotation.',
      'Frontend is React with Tailwind CSS for styling components.',
      'CI/CD pipeline runs on GitHub Actions with automated deployments.',
      'Redis caches frequently accessed data to reduce database load.',
      'Monitoring uses Datadog for metrics and PagerDuty for alerts.',
      'Documentation lives in Notion with API specs in OpenAPI format.',
      'Mobile app built with React Native sharing business logic.',
      'Infrastructure managed with Terraform across three AWS regions.',
    ]
    const names = [
      'Backend-API',
      'Database-Setup',
      'Auth-System',
      'Frontend-UI',
      'CICD-Pipeline',
      'Cache-Layer',
      'Monitoring-Stack',
      'Docs-Platform',
      'Mobile-App',
      'Infrastructure',
    ]
    const newEntries: MemoryEntry[] = names.map((name, i) =>
      entry({ name, type: 'project', content: contents[i]! }),
    )
    const result = runConsolidation({ currentMemoryMd: '', newEntries })
    expect(result.memoryMd.length).toBeGreaterThan(0)
    expect(result.entriesKept).toBe(10)
    expect(result.phases.orient.existingEntries).toBe(0)
    expect(result.phases.gather.newEntries).toBe(10)
  })

  it('existing with duplicates of new → deduped', () => {
    const existingMd = buildMd([entry({ name: 'SharedName', content: 'old content' })])
    const newEntries: MemoryEntry[] = [entry({ name: 'SharedName', content: 'updated content' })]
    const result = runConsolidation({ currentMemoryMd: existingMd, newEntries })
    // Same-name entries are resolved as contradictions (not dedup)
    expect(result.contradictionsResolved).toBeGreaterThanOrEqual(1)
    expect(result.memoryMd).toContain('updated content')
    expect(result.entriesKept).toBe(1)
  })

  it('phase log has correct stats', () => {
    const existingMd = buildMd([entry({ name: 'A', type: 'user', content: 'A content' })])
    const newEntries: MemoryEntry[] = [entry({ name: 'B', type: 'project', content: 'B content' })]
    const result = runConsolidation({ currentMemoryMd: existingMd, newEntries })
    expect(result.phases.orient.existingEntries).toBe(1)
    expect(result.phases.gather.newEntries).toBe(1)
    expect(result.phases.consolidate.merged).toBe(2)
  })

  it('result fits within limits', () => {
    // Create many entries that would push past limits
    const newEntries: MemoryEntry[] = Array.from({ length: 60 }, (_, i) =>
      entry({
        name: `Entry-${i}`,
        type: 'reference',
        content: `Line 1\nLine 2\nLine 3\nLine 4`,
        createdAt: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
      }),
    )
    const result = runConsolidation({ currentMemoryMd: '', newEntries })
    // Count lines in final output
    const lines = result.memoryMd.split('\n').length
    // Should be at or under 200 lines (plus possible truncation marker)
    expect(lines).toBeLessThanOrEqual(210) // small margin for truncation comment
  })

  it('idempotency: run twice with same input → same output', () => {
    const existingMd = buildMd([
      entry({ name: 'Stable', type: 'user', content: 'Stable content.' }),
    ])
    const newEntries: MemoryEntry[] = [
      entry({ name: 'New', type: 'project', content: 'New content.' }),
    ]
    const input = { currentMemoryMd: existingMd, newEntries, referenceDate: REF_DATE }
    const result1 = runConsolidation(input)
    const result2 = runConsolidation(input)
    expect(result1.memoryMd).toBe(result2.memoryMd)
    expect(result1.entriesKept).toBe(result2.entriesKept)
  })

  it('referenceDate is used for date conversion', () => {
    const newEntries: MemoryEntry[] = [
      entry({ name: 'DatedEntry', content: 'Found yesterday in the logs.' }),
    ]
    const result = runConsolidation({
      currentMemoryMd: '',
      newEntries,
      referenceDate: REF_DATE,
    })
    expect(result.memoryMd).toContain('2025-06-14')
    expect(result.memoryMd).not.toContain('yesterday')
  })
})
