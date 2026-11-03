/**
 * Four-phase consolidation pipeline for MEMORY.md.
 * orient → gather → consolidate → prune
 *
 * Pure functions — no file I/O, no database access.
 */
import type { MemoryEntry } from './memory-entries.js'
import {
  parseMemoryMd,
  serializeMemoryMd,
  deduplicateEntries,
  resolveContradictions,
  validateMemoryEntry,
} from './memory-entries.js'
import {
  truncateEntrypoint,
  countLines,
  countBytes,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
} from './memory-limits.js'
import { convertRelativeDates } from './date-utils.js'
import { sortByPriority, trimToFit } from './consolidation-priorities.js'
import { classifyPromptAuthorship } from '../memory/prompt-authorship.js'

// ── Public interfaces ──────────────────────────────────────────────

export interface ConsolidationInput {
  readonly currentMemoryMd: string
  readonly newEntries: ReadonlyArray<MemoryEntry>
  readonly referenceDate?: Date
}

export interface ConsolidationResult {
  readonly memoryMd: string
  readonly entriesProcessed: number
  readonly entriesKept: number
  readonly duplicatesRemoved: number
  readonly contradictionsResolved: number
  readonly truncated: boolean
  readonly phases: ConsolidationPhaseLog
}

export interface ConsolidationPhaseLog {
  readonly orient: { existingEntries: number }
  readonly gather: { newEntries: number }
  readonly consolidate: { merged: number; deduped: number; contradictions: number }
  readonly prune: {
    beforeLines: number
    afterLines: number
    beforeBytes: number
    afterBytes: number
  }
}

// ── Phase 1: ORIENT ────────────────────────────────────────────────

/**
 * True when a carried-forward entry's text is machine-authored (a harvested dispatch brief, an
 * injected block). The extraction gate only protects NEW harvests; entries harvested before the
 * gate existed are re-parsed, re-synthesized and re-injected every cycle unless dropped here.
 * Fields are classified separately because the rules anchor on line starts. Same asymmetry as the
 * extraction gate: dropping a rare human entry that happens to match costs one memory; keeping a
 * machine entry costs a false global rule in every session's briefing.
 */
function isMachineAuthoredEntry(e: MemoryEntry): boolean {
  // Blank fields are not evidence either way (the classifier calls blank 'machine' only for its
  // gate-settle call sites, where settling an ACCEPT on nothing must fail closed).
  const machine = (s: string): boolean =>
    s.trim() !== '' && classifyPromptAuthorship(s).author === 'machine'
  return machine(e.content) || machine(e.description)
}

/**
 * Parse existing MEMORY.md into MemoryEntry objects.
 * Converts relative dates to absolute using referenceDate.
 * Drops machine-authored entries harvested before the extraction gate existed.
 */
export function orient(
  currentMemoryMd: string,
  referenceDate: Date = new Date(),
): ReadonlyArray<MemoryEntry> {
  const entries = parseMemoryMd(currentMemoryMd)
  return entries
    .filter((e) => !isMachineAuthoredEntry(e))
    .map((e) => ({
      ...e,
      content: convertRelativeDates(e.content, referenceDate),
      description: convertRelativeDates(e.description, referenceDate),
    }))
}

// ── Phase 2: GATHER ────────────────────────────────────────────────

/**
 * Validate and clean pre-extracted entries from log extraction.
 * Converts relative dates to absolute.
 */
export function gather(
  newEntries: ReadonlyArray<MemoryEntry>,
  referenceDate: Date = new Date(),
): ReadonlyArray<MemoryEntry> {
  return newEntries
    .filter((e) => validateMemoryEntry(e))
    .map((e) => ({
      ...e,
      content: convertRelativeDates(e.content, referenceDate),
      description: convertRelativeDates(e.description, referenceDate),
    }))
}

// ── Phase 3: CONSOLIDATE ───────────────────────────────────────────

export interface ConsolidateResult {
  readonly entries: ReadonlyArray<MemoryEntry>
  readonly deduped: number
  readonly contradictions: number
}

/**
 * Merge existing + gathered entries, resolve contradictions, deduplicate.
 * Gathered entries come after existing so they are treated as "newer".
 */
export function consolidate(
  existing: ReadonlyArray<MemoryEntry>,
  gathered: ReadonlyArray<MemoryEntry>,
): ConsolidateResult {
  // Merge: existing first, gathered after (later = newer)
  const merged = [...existing, ...gathered]
  const mergedCount = merged.length

  // Resolve contradictions (same name → keep later)
  const afterContradictions = resolveContradictions(merged)
  const contradictions = mergedCount - afterContradictions.length

  // Deduplicate (exact/near duplicates → keep later)
  const afterDedup = deduplicateEntries(afterContradictions)
  const deduped = afterContradictions.length - afterDedup.length

  // Group by type, sort within each group by priority (newest first)
  const sorted = sortByPriority(afterDedup)

  return { entries: sorted, deduped, contradictions }
}

// ── Phase 4: PRUNE ─────────────────────────────────────────────────

export interface PruneResult {
  readonly entries: ReadonlyArray<MemoryEntry>
  readonly truncated: boolean
  readonly linesRemoved: number
}

/**
 * Ensure entries fit within MEMORY.md size limits.
 * Removes lowest-priority entries first, then applies truncation as safety net.
 */
export function prune(entries: ReadonlyArray<MemoryEntry>): PruneResult {
  if (entries.length === 0) {
    return { entries: [], truncated: false, linesRemoved: 0 }
  }

  const beforeSerialized = serializeMemoryMd(entries)
  const beforeLines = countLines(beforeSerialized)

  // First pass: remove lowest-priority entries until within limits
  const trimmed = trimToFit(entries, MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES)

  // If trimToFit emptied the array but we had entries, fall back to truncation
  if (trimmed.length === 0 && entries.length > 0) {
    const truncResult = truncateEntrypoint(beforeSerialized)
    const reparsed = parseMemoryMd(truncResult.content)
    const afterLines = countLines(serializeMemoryMd(reparsed))
    return {
      entries: reparsed,
      truncated: true,
      linesRemoved: beforeLines - afterLines,
    }
  }

  // Second pass: truncate as final safety net
  const serialized = serializeMemoryMd(trimmed)
  const truncResult = truncateEntrypoint(serialized)

  if (truncResult.truncated) {
    const reparsed = parseMemoryMd(truncResult.content)
    const afterLines = countLines(serializeMemoryMd(reparsed))
    return {
      entries: reparsed,
      truncated: true,
      linesRemoved: beforeLines - afterLines,
    }
  }

  const afterLines = countLines(serialized)
  return {
    entries: trimmed,
    truncated: false,
    linesRemoved: beforeLines - afterLines,
  }
}

// ── Main pipeline ──────────────────────────────────────────────────

/** Run the full four-phase consolidation pipeline. */
export function runConsolidation(input: ConsolidationInput): ConsolidationResult {
  const refDate = input.referenceDate ?? new Date()

  // Phase 1: ORIENT
  const oriented = orient(input.currentMemoryMd, refDate)

  // Phase 2: GATHER
  const gathered = gather(input.newEntries, refDate)

  // Phase 3: CONSOLIDATE
  const consolidated = consolidate(oriented, gathered)

  // Phase 4: PRUNE
  const beforePrune = serializeMemoryMd(consolidated.entries)
  const beforePruneLines = countLines(beforePrune)
  const beforePruneBytes = countBytes(beforePrune)
  const pruned = prune(consolidated.entries)
  const finalMd = serializeMemoryMd(pruned.entries)

  // If pruned.truncated, append the truncation comment from truncateEntrypoint
  let resultMd = finalMd
  if (pruned.truncated) {
    const truncResult = truncateEntrypoint(finalMd)
    resultMd = truncResult.truncated ? truncResult.content : finalMd
  }

  const afterMd = resultMd
  const afterLines = countLines(afterMd)
  const afterBytes = countBytes(afterMd)

  return {
    memoryMd: afterMd,
    entriesProcessed: oriented.length + gathered.length,
    entriesKept: pruned.entries.length,
    duplicatesRemoved: consolidated.deduped,
    contradictionsResolved: consolidated.contradictions,
    truncated: pruned.truncated,
    phases: {
      orient: { existingEntries: oriented.length },
      gather: { newEntries: gathered.length },
      consolidate: {
        merged: oriented.length + gathered.length,
        deduped: consolidated.deduped,
        contradictions: consolidated.contradictions,
      },
      prune: {
        beforeLines: beforePruneLines,
        afterLines,
        beforeBytes: beforePruneBytes,
        afterBytes,
      },
    },
  }
}
