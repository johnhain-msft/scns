import { describe, it, expect } from 'vitest'
import {
  parseMemoryMd,
  serializeMemoryMd,
  detectDuplicates,
  deduplicateEntries,
  resolveContradictions,
  validateMemoryEntry,
  type MemoryEntry,
} from '../../../src/dream/memory-entries.js'

const sampleEntry: MemoryEntry = {
  type: 'user',
  name: 'TypeScript preference',
  description: 'User prefers TypeScript over JavaScript',
  content: 'User always wants TypeScript in all projects.',
}

const sampleMd = `---
name: TypeScript preference
description: User prefers TypeScript over JavaScript
type: user
---
User always wants TypeScript in all projects.`

const multiEntryMd = `---
name: TypeScript preference
description: User prefers TypeScript over JavaScript
type: user
---
User always wants TypeScript in all projects.

---
name: PostgreSQL choice
description: Primary database is PostgreSQL
type: project
---
The real estate project uses PostgreSQL with Supabase.`

describe('parseMemoryMd', () => {
  it('single entry with frontmatter', () => {
    const entries = parseMemoryMd(sampleMd)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.name).toBe('TypeScript preference')
    expect(entries[0]!.type).toBe('user')
    expect(entries[0]!.content).toBe('User always wants TypeScript in all projects.')
  })

  it('multiple entries separated by ---', () => {
    const entries = parseMemoryMd(multiEntryMd)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.name).toBe('TypeScript preference')
    expect(entries[1]!.name).toBe('PostgreSQL choice')
    expect(entries[1]!.type).toBe('project')
  })

  it('empty content → empty array', () => {
    expect(parseMemoryMd('')).toEqual([])
    expect(parseMemoryMd('   ')).toEqual([])
  })

  it('malformed frontmatter → skip entry', () => {
    const malformed = `---
not valid yaml stuff: [
---
Some content here.

---
name: Valid entry
description: This is valid
type: project
---
Valid content.`
    const entries = parseMemoryMd(malformed)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.name).toBe('Valid entry')
  })
})

describe('serializeMemoryMd', () => {
  it('round-trip (parse → serialize → parse = same)', () => {
    const entries = parseMemoryMd(multiEntryMd)
    const serialized = serializeMemoryMd(entries)
    const reparsed = parseMemoryMd(serialized)
    expect(reparsed).toEqual(entries)
  })

  it('preserves all fields', () => {
    const entry: MemoryEntry = {
      type: 'feedback',
      name: 'Test entry',
      description: 'A test',
      content: 'Content here.',
      source: 'daily-log:2026-04-05',
      createdAt: '2026-04-05T12:00:00Z',
    }
    const serialized = serializeMemoryMd([entry])
    expect(serialized).toContain('source: daily-log:2026-04-05')
    expect(serialized).toContain('createdAt: 2026-04-05T12:00:00Z')
    const reparsed = parseMemoryMd(serialized)
    expect(reparsed[0]).toEqual(entry)
  })
})

describe('detectDuplicates', () => {
  it('exact name match found', () => {
    const entries: MemoryEntry[] = [
      { ...sampleEntry, name: 'TS Pref' },
      { ...sampleEntry, name: 'Other', content: 'different content entirely' },
      { ...sampleEntry, name: 'ts pref' },
    ]
    const dupes = detectDuplicates(entries)
    expect(dupes.length).toBeGreaterThanOrEqual(1)
    expect(dupes).toContainEqual([0, 2])
  })

  it('no duplicates → empty', () => {
    const entries: MemoryEntry[] = [
      { ...sampleEntry, name: 'One', content: 'aaa' },
      { ...sampleEntry, name: 'Two', content: 'bbb' },
    ]
    expect(detectDuplicates(entries)).toEqual([])
  })

  it('content similarity detected', () => {
    const entries: MemoryEntry[] = [
      {
        ...sampleEntry,
        name: 'Entry A',
        content: 'User prefers TypeScript for all new projects.',
      },
      {
        ...sampleEntry,
        name: 'Entry B',
        content: 'User prefers TypeScript for all new projects!',
      },
    ]
    const dupes = detectDuplicates(entries)
    expect(dupes.length).toBeGreaterThanOrEqual(1)
  })
})

describe('deduplicateEntries', () => {
  it('keeps later entry', () => {
    const entries: MemoryEntry[] = [
      { ...sampleEntry, name: 'Pref', content: 'old' },
      { ...sampleEntry, name: 'pref', content: 'new' },
    ]
    const result = deduplicateEntries(entries)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe('new')
  })

  it('no duplicates → same entries', () => {
    const entries: MemoryEntry[] = [
      { ...sampleEntry, name: 'A', content: 'aaa' },
      { ...sampleEntry, name: 'B', content: 'bbb' },
    ]
    const result = deduplicateEntries(entries)
    expect(result).toHaveLength(2)
  })
})

describe('resolveContradictions', () => {
  it('same name different content → keep later', () => {
    const entries: MemoryEntry[] = [
      { ...sampleEntry, name: 'DB Choice', content: 'Use MySQL' },
      { ...sampleEntry, name: 'DB Choice', content: 'Use PostgreSQL' },
    ]
    const result = resolveContradictions(entries)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe('Use PostgreSQL')
  })

  it('different names → both kept', () => {
    const entries: MemoryEntry[] = [
      { ...sampleEntry, name: 'DB Choice', content: 'Use PostgreSQL' },
      { ...sampleEntry, name: 'Language Choice', content: 'Use TypeScript' },
    ]
    const result = resolveContradictions(entries)
    expect(result).toHaveLength(2)
  })
})

describe('validateMemoryEntry', () => {
  it('valid entry → true', () => {
    expect(validateMemoryEntry(sampleEntry)).toBe(true)
  })

  it('missing required fields → false', () => {
    expect(validateMemoryEntry({ type: 'user' })).toBe(false)
    expect(validateMemoryEntry({})).toBe(false)
    expect(validateMemoryEntry(null)).toBe(false)
  })

  it('invalid type → false', () => {
    expect(validateMemoryEntry({ ...sampleEntry, type: 'invalid' })).toBe(false)
  })
})
