/**
 * P8 — Suggestion dedup policy (time-windowed).
 *
 * Extracted from generator.ts's inline shouldSkip closure so it can be
 * unit-tested in isolation and tuned via env config.
 *
 * Policy:
 *   - REJECTED suggestions ALWAYS block re-surface (respect user "no" forever).
 *   - ACTIVE suggestions (pending/approved/in-progress/needs-human/blocked-autonomy)
 *     always block (don't spam the dashboard with a duplicate someone is already
 *     looking at).
 *
 * ⚠️ A gate-exhausted `needs-human` EXCEPTION was written here and then REMOVED. Recorded so it is
 * not re-added without the missing piece. The idea was sound ("a failure to BUILD an idea must not
 * veto the idea for life") but the implementation was both inert and unsafe:
 *   - INERT: `shouldSkip` (`generator.ts`) consults `store.findSimilar` FIRST, which scans every
 *     status dir, lifetime, at >0.8 title overlap, so a regenerated title never reaches this
 *     function.
 *   - UNSAFE if made reachable: `SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD=0.80` is live, so a re-proposed
 *     idea at >=0.80 is auto-approved with NO human in the loop and burns up to
 *     `MAX_ATTEMPTS_BEFORE_FAILED` unattended builds.
 * The correct shape is to RESUME the existing suggestion so `attemptCount` accumulates, rather than
 * minting a fresh one whose counter resets to 0. That is a design change, not a dedup tweak.
 *   - TERMINAL suggestions (archive/implemented/failed) block only when
 *     `updatedAt` is within `dedupWindowDays` of `nowMs`. Outside the window,
 *     the pattern is allowed to re-surface if fresh evidence supports it.
 *   - When `dedupWindowDays` is undefined / 0, falls back to LEGACY behavior
 *     (any stored suggestion of same family + type blocks). Preserves
 *     backwards compatibility for callers that don't opt in.
 */
import type { Suggestion, SuggestionType } from './types.js'

const ACTIVE_STATUSES = new Set<Suggestion['status']>([
  'pending',
  'approved',
  'in-progress',
  'needs-human',
  'blocked-autonomy',
])

const PERMANENT_REJECT: Suggestion['status'] = 'rejected'

export interface DedupInput {
  readonly title: string
  readonly type: SuggestionType
  readonly stored: ReadonlyArray<Suggestion>
  readonly nowMs: number
  /** When undefined or ≤0, legacy behavior (lifetime dedup against any stored). */
  readonly dedupWindowDays?: number
}

/**
 * Reduce a title to its "template family" — case-insensitive, with
 * time tokens (HH:MM) and standalone integers normalized to placeholders.
 * Keeps "Schedule X at 22:00" and "...at 3:00" colliding as one family.
 * Kept identical to generator.ts:templateFamily for behavior preservation.
 */
export function templateFamily(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b\d{1,2}:\d{2}\b/g, '<time>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isFamilyDedupped(input: DedupInput): boolean {
  const family = templateFamily(input.title)
  const windowDays = input.dedupWindowDays ?? 0
  const windowMs = windowDays > 0 ? windowDays * 86_400_000 : 0

  for (const stored of input.stored) {
    if (stored.type !== input.type) continue
    if (templateFamily(stored.title) !== family) continue

    if (windowDays <= 0) {
      // Legacy: any match blocks.
      return true
    }

    if (stored.status === PERMANENT_REJECT) return true
    if (ACTIVE_STATUSES.has(stored.status)) return true

    // Terminal status — apply the time window.
    const updatedMs = Date.parse(stored.updatedAt)
    if (Number.isFinite(updatedMs) && input.nowMs - updatedMs < windowMs) {
      return true
    }
  }
  return false
}
