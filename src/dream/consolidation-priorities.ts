/**
 * Entry prioritization for MEMORY.md consolidation.
 * Determines which entries to keep when pruning is needed.
 */
import type { MemoryEntry } from './memory-entries.js'
import { serializeMemoryMd } from './memory-entries.js'
import { countLines, countBytes } from './memory-limits.js'

export type EntryPriority = 'critical' | 'high' | 'medium' | 'low'

const PRIORITY_MAP: Record<MemoryEntry['type'], EntryPriority> = {
  user: 'critical',
  feedback: 'high',
  prohibition: 'critical',
  project: 'medium',
  reference: 'low',
}

const PRIORITY_RANK: Record<EntryPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/** Get the priority level for a memory entry based on its type. */
export function getEntryPriority(entry: MemoryEntry): EntryPriority {
  return PRIORITY_MAP[entry.type]
}

/**
 * Sort entries by priority (critical first), then by createdAt (newest first).
 * Does not mutate the original array.
 */
export function sortByPriority(entries: ReadonlyArray<MemoryEntry>): ReadonlyArray<MemoryEntry> {
  return [...entries].sort((a, b) => {
    const rankDiff = PRIORITY_RANK[getEntryPriority(a)] - PRIORITY_RANK[getEntryPriority(b)]
    if (rankDiff !== 0) return rankDiff

    // Within same priority: newer first (descending date)
    const dateA = a.createdAt ?? ''
    const dateB = b.createdAt ?? ''
    if (dateA && dateB) return dateB.localeCompare(dateA)
    if (dateA) return -1
    if (dateB) return 1
    return 0
  })
}

/**
 * Remove lowest-priority entries until serialized form fits within limits.
 * Entries should already be sorted by priority (use sortByPriority first).
 */
export function trimToFit(
  entries: ReadonlyArray<MemoryEntry>,
  maxLines: number,
  maxBytes: number,
): ReadonlyArray<MemoryEntry> {
  if (entries.length === 0) return []

  const sorted = sortByPriority(entries)
  let current = [...sorted]

  while (current.length > 0) {
    const serialized = serializeMemoryMd(current)
    if (countLines(serialized) <= maxLines && countBytes(serialized) <= maxBytes) {
      return current
    }
    // Remove last entry (lowest priority, oldest within that priority)
    current = current.slice(0, -1)
  }

  return []
}
