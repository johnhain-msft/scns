import type { ChronicleEntry } from './chronicle-reader.js'

export interface DedupState {
  readonly knownSessionIds: ReadonlySet<string>
  readonly knownTraceIds: ReadonlySet<string>
}

/** Build an entry dedup key from its identity fields */
function entryKey(entry: ChronicleEntry): string {
  return `${entry.sessionId}:${entry.type}:${entry.timestamp}`
}

/** Create a deduplication tracker for Chronicle entries */
export function createChronicleDedup() {
  const knownSessionIds = new Set<string>()
  const knownTraceIds = new Set<string>()
  const knownEntryKeys = new Set<string>()

  return {
    /** Check if an entry is a duplicate (already known or in OTel data) */
    isDuplicate(entry: ChronicleEntry, otelSessionIds: ReadonlySet<string>): boolean {
      if (otelSessionIds.has(entry.sessionId)) return true
      return knownEntryKeys.has(entryKey(entry))
    },

    /** Mark an entry as known */
    addKnown(entry: ChronicleEntry): void {
      knownSessionIds.add(entry.sessionId)
      knownEntryKeys.add(entryKey(entry))
      const traceId = entry.metadata?.['traceId']
      if (typeof traceId === 'string') {
        knownTraceIds.add(traceId)
      }
    },

    /** Return a snapshot of current dedup state */
    getState(): DedupState {
      return {
        knownSessionIds: new Set(knownSessionIds),
        knownTraceIds: new Set(knownTraceIds),
      }
    },
  }
}
