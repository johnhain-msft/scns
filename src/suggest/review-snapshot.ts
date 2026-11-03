/**
 * A verbatim copy of the suggestion corpus, taken the moment John finishes a review.
 *
 * WHY THIS EXISTS ALONGSIDE THE REAL FIX
 * --------------------------------------
 * The erasure defect (his approval reasoning overwritten minutes later by the reason-less
 * `updateStatus(id, 'implemented')` on the auto-execute path) is fixed in `suggestion-store.ts`,
 * and his words are additionally captured to the vault as markdown at decision time. This snapshot
 * is neither of those. It is the belt-and-braces third copy, and it is here because the failure it
 * guards against is *silent and unrecoverable*: if some path I have not found still clobbers a
 * `reviewReason`, nothing alerts anyone, and the words are simply gone. A cheap `cp -R` of a
 * directory that is a few hundred kilobytes buys back the ability to notice and recover.
 *
 * It is deliberately dumb. No parsing, no filtering, no schema — a byte copy of whatever is on
 * disk. Anything cleverer could share a bug with the thing it is supposed to be insuring against.
 *
 * Snapshot timing is load-bearing: AFTER the review loop, so his verdicts and reasons are already
 * written, and before the brain's next promotion pass can transition anything.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface SnapshotInput {
  /** The live suggestions directory, e.g. `~/.scns/suggestions`. */
  readonly sourceDir: string
  /** Where snapshots accumulate, e.g. `~/.scns/suggestions-snapshots`. */
  readonly snapshotRootDir: string
  readonly now?: Date
}

export interface SnapshotOutcome {
  readonly taken: boolean
  /** Absolute path of the snapshot directory, when one was made. */
  readonly path?: string
  /** Why not, when `taken` is false. Never silently empty. */
  readonly reason?: string
}

/** `2026-08-03T14-30-00-123Z` — sortable, and legal on every filesystem we run on. */
export function snapshotStamp(at: Date): string {
  return at.toISOString().replace(/[:.]/g, '-')
}

/**
 * Copy the suggestion corpus to a timestamped sibling directory.
 *
 * Never throws: a snapshot failure must not take down the review that just succeeded. The reason is
 * returned so the caller can tell John, rather than swallowing it — an insurance policy that fails
 * quietly is worse than none, because it is believed.
 */
export function snapshotSuggestions(input: SnapshotInput): SnapshotOutcome {
  const at = input.now ?? new Date()
  if (!existsSync(input.sourceDir)) {
    return { taken: false, reason: `no suggestions directory at ${input.sourceDir}` }
  }
  const dest = join(input.snapshotRootDir, snapshotStamp(at))
  try {
    mkdirSync(input.snapshotRootDir, { recursive: true })
    cpSync(input.sourceDir, dest, { recursive: true })
    return { taken: true, path: dest }
  } catch (err) {
    return { taken: false, reason: (err as Error).message }
  }
}
