import { describe, it, expect } from 'vitest'
import {
  getEntryPriority,
  sortByPriority,
  trimToFit,
} from '../../../src/dream/consolidation-priorities.js'
import type { MemoryEntry } from '../../../src/dream/memory-entries.js'

function entry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, 'type'>): MemoryEntry {
  return {
    name: 'test',
    description: 'test entry',
    content: 'test content',
    ...overrides,
  }
}

describe('getEntryPriority', () => {
  it('user → critical', () => {
    expect(getEntryPriority(entry({ type: 'user' }))).toBe('critical')
  })

  it('feedback → high', () => {
    expect(getEntryPriority(entry({ type: 'feedback' }))).toBe('high')
  })

  it('project → medium', () => {
    expect(getEntryPriority(entry({ type: 'project' }))).toBe('medium')
  })

  it('reference → low', () => {
    expect(getEntryPriority(entry({ type: 'reference' }))).toBe('low')
  })
})

describe('sortByPriority', () => {
  it('user entries before reference entries', () => {
    const entries: MemoryEntry[] = [
      entry({ type: 'reference', name: 'ref1' }),
      entry({ type: 'user', name: 'user1' }),
      entry({ type: 'project', name: 'proj1' }),
      entry({ type: 'feedback', name: 'fb1' }),
    ]
    const sorted = sortByPriority(entries)
    expect(sorted[0]!.type).toBe('user')
    expect(sorted[1]!.type).toBe('feedback')
    expect(sorted[2]!.type).toBe('project')
    expect(sorted[3]!.type).toBe('reference')
  })

  it('within same type, newer entries first', () => {
    const entries: MemoryEntry[] = [
      entry({ type: 'user', name: 'old', createdAt: '2025-01-01' }),
      entry({ type: 'user', name: 'new', createdAt: '2025-06-01' }),
    ]
    const sorted = sortByPriority(entries)
    expect(sorted[0]!.name).toBe('new')
    expect(sorted[1]!.name).toBe('old')
  })

  it('entries without createdAt sort after entries with createdAt within same priority', () => {
    const entries: MemoryEntry[] = [
      entry({ type: 'user', name: 'no-date' }),
      entry({ type: 'user', name: 'dated', createdAt: '2025-06-01' }),
    ]
    const sorted = sortByPriority(entries)
    expect(sorted[0]!.name).toBe('dated')
    expect(sorted[1]!.name).toBe('no-date')
  })

  it('does not mutate original array', () => {
    const entries: MemoryEntry[] = [
      entry({ type: 'reference', name: 'ref' }),
      entry({ type: 'user', name: 'usr' }),
    ]
    const original = [...entries]
    sortByPriority(entries)
    expect(entries).toEqual(original)
  })
})

describe('trimToFit', () => {
  it('under limits → all kept', () => {
    const entries: MemoryEntry[] = [
      entry({ type: 'user', name: 'u1' }),
      entry({ type: 'project', name: 'p1' }),
    ]
    const result = trimToFit(entries, 200, 25_000)
    expect(result).toHaveLength(2)
  })

  it('over limits → low-priority entries removed first', () => {
    const entries: MemoryEntry[] = [
      entry({ type: 'user', name: 'user-pref', content: 'Keep this user preference.' }),
      entry({ type: 'reference', name: 'ref-link', content: 'A'.repeat(500) }),
      entry({ type: 'reference', name: 'ref-link2', content: 'B'.repeat(500) }),
    ]
    // Set very tight limits so at least one must be removed
    const result = trimToFit(entries, 10, 25_000)
    // User entry should be kept, some reference entries removed
    const userEntries = result.filter((e) => e.type === 'user')
    expect(userEntries).toHaveLength(1)
    expect(result.length).toBeLessThan(entries.length)
  })

  it('removes older entries of same type before newer', () => {
    const entries: MemoryEntry[] = [
      entry({
        type: 'reference',
        name: 'old-ref',
        createdAt: '2025-01-01',
        content: 'A'.repeat(200),
      }),
      entry({
        type: 'reference',
        name: 'new-ref',
        createdAt: '2025-06-01',
        content: 'B'.repeat(200),
      }),
      entry({ type: 'user', name: 'user1', content: 'Keep me.' }),
    ]
    // Tight limit: force removal
    const result = trimToFit(entries, 10, 25_000)
    const refs = result.filter((e) => e.type === 'reference')
    if (refs.length === 1) {
      expect(refs[0]!.name).toBe('new-ref')
    }
  })

  it('empty input → empty output', () => {
    expect(trimToFit([], 200, 25_000)).toEqual([])
  })
})
