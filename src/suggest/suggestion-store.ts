/**
 * Suggestion store — filesystem-based storage for suggestions.
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'
import { serializeSuggestion, parseSuggestion } from './suggestion-file.js'
import { SuggestionStatus } from './types.js'
import { isHumanReason, type ReviewVerdict } from './review-reason.js'
import { isGateExhausted } from './escalation.js'
import { logger } from '../shared/logger.js'
import { normalizeTitle, wordOverlap } from './title-similarity.js'
import type { EscalationKind, Suggestion, SuggestionType } from './types.js'

export interface SuggestionStoreOptions {
  readonly rootDir: string
}

const STATUS_DIRS: readonly string[] = Object.values(SuggestionStatus)

/**
 * FR-050 (E10) — reason-preserving semantics for `updateStatus`.
 *
 * `reviewReason` was written as `reviewReason: reason` with no guard, so the field belonged to
 * whoever wrote last. Two consequences, both measured on the live corpus:
 *
 *   1. **Every reason-less caller erased.** `review.ts:96` marks an approved item `implemented`
 *      with no reason at all, and that runs within minutes of John typing his approval — so his
 *      words were gone long before Monday's sweep could carry them to the learner. His REJECTIONS
 *      survived (a rejection is terminal and nothing transitions it again), which is exactly the
 *      asymmetry he objected to: *"it is important to understand why i approve *and* reject
 *      something because otherwise i'm allowing the machine to make assumptions about *why* i
 *      accepted something -- which could incorrectly skew the intent algorithm."*
 *   2. **Machine verdicts displaced human ones.** `qg-pass`, `self-critique: …` and triage strings
 *      overwrote his text in the same slot.
 *
 * The rules, in order:
 *   - **no reason given ⇒ change nothing.** Absence is not an instruction to forget. (`repromote()`
 *     remains the one deliberate clear, and is untouched.)
 *   - **a human reason ⇒ becomes the review reason.** John's latest words are what he'd expect to
 *     see on the file. Earlier ones are not lost: `decision_rationale` is append-only and keeps
 *     every decision verbatim.
 *   - **a machine reason ⇒ recorded as the machine's,** and it only reaches `reviewReason` when
 *     there is no human reason to protect — which preserves today's behaviour exactly for the
 *     machine-only items that make up most of the corpus, so no existing reader changes meaning.
 */
/**
 * Who is writing this status change.
 *
 * FR-050c. `verdictContradictsStatus` below is a fail-safe for a HUMAN re-deciding through a seam
 * that has no verdict field, and it was correct for that. What it could not do is tell a human
 * from a machine — so when the quality gate wrote `rejected` on a proposal John had approved, the
 * store read that as John changing his mind and cleared his `approve` verdict. The machine's
 * inability to build something is not the human withdrawing his judgement of it.
 *
 * Defaults to `'human'` at every call site that does not say otherwise, deliberately: that
 * preserves the reviewed T130/FR-051b behaviour byte-for-byte, and makes the new protection
 * something a machine caller must OPT IN to rather than something a human caller can lose by
 * omission. Every machine seam in `src/` declares itself explicitly; the default is a fail-safe,
 * not a shortcut.
 */
export type StatusAuthor = 'human' | 'machine'

/**
 * A recorded verdict that the new status flatly denies.
 *
 * Only outright opposites count. This is the fail-safe for seams where a human re-decides through a
 * path that has no verdict field (the dashboard buttons), so absence there cannot be read as "he
 * still means what he said last week".
 */
function verdictContradictsStatus(
  verdict: ReviewVerdict | undefined,
  status: SuggestionStatus,
): boolean {
  if (verdict === 'approve') return status === 'rejected'
  if (verdict === 'reject') return status === 'approved' || status === 'implemented'
  return false
}

function resolveReasons(
  current: Suggestion,
  reason: string | undefined,
): { reviewReason: string | undefined; machineReason: string | undefined } {
  if (reason === undefined) {
    return { reviewReason: current.reviewReason, machineReason: current.machineReason }
  }
  if (isHumanReason(reason)) {
    return { reviewReason: reason, machineReason: current.machineReason }
  }
  const protectedHuman = isHumanReason(current.reviewReason) ? current.reviewReason : undefined
  return { reviewReason: protectedHuman ?? reason, machineReason: reason }
}

/** Phase 13.12.9: attempts before a suggestion transitions to terminal `failed`. */
export const MAX_ATTEMPTS_BEFORE_FAILED = 5
/** Phase 13.12.9: backoff cap so a chronically failing item doesn't sleep forever. */
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000 // 1 day

/**
 * Phase 13.12.9: exponential backoff — `2^attempt` minutes, capped at 1 day.
 * Exported for test determinism.
 */
export function computeNextRetryAt(attemptCount: number, nowMs: number): string {
  const minutes = Math.pow(2, Math.max(0, attemptCount))
  const ms = Math.min(minutes * 60 * 1000, MAX_BACKOFF_MS)
  return new Date(nowMs + ms).toISOString()
}

/** Create a filesystem-based suggestion store */
export function createSuggestionStore(options: SuggestionStoreOptions) {
  const { rootDir } = options

  // Memoized: this used to run on every mutating call (9 call sites), issuing a
  // recursive mkdir per status dir each time. Seeding a few dozen suggestions
  // therefore spent thousands of syscalls re-creating directories that already
  // existed — cheap on Linux, expensive enough on Windows to push a test past
  // its timeout. Same pattern as handoff-store.ts's `dirCreated`.
  let dirsEnsured = false

  function ensureDirs(): void {
    if (dirsEnsured) return
    for (const dir of STATUS_DIRS) {
      mkdirSync(join(rootDir, dir), { recursive: true })
    }
    dirsEnsured = true
  }

  function filenameForId(id: string): string {
    return `${id}.md`
  }

  /** Find which status directory contains a suggestion file */
  function findFile(id: string): { dir: string; path: string; status: string } | null {
    const filename = filenameForId(id)
    for (const status of STATUS_DIRS) {
      const filePath = join(rootDir, status, filename)
      if (existsSync(filePath)) {
        return { dir: status, path: filePath, status }
      }
    }
    return null
  }

  /**
   * Phase 13.12.25: move a malformed suggestion file out of the status
   * directory so subsequent wakes don't re-log the parse failure. Emits a
   * single warn on the rescue (not on each tick).
   */
  function archiveMalformed(filePath: string, file: string, err: unknown): void {
    const archiveDir = join(rootDir, 'archive')
    try {
      mkdirSync(archiveDir, { recursive: true })
      const target = join(archiveDir, file)
      // If a same-named archive file already exists, suffix with timestamp.
      const finalTarget = existsSync(target) ? `${target}.${Date.now()}` : target
      renameSync(filePath, finalTarget)
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          file,
          archivedTo: finalTarget,
        },
        'suggestion-store: archived malformed suggestion (parse failed)',
      )
    } catch (moveErr) {
      // If we can't move it, fall back to debug log so we don't spam warn
      // every wake.
      logger.debug(
        {
          err: err instanceof Error ? err.message : String(err),
          moveErr: moveErr instanceof Error ? moveErr.message : String(moveErr),
          file,
        },
        'suggestion-store: parse failed (archive move also failed)',
      )
    }
  }

  /** Read all suggestions from a single status directory */
  function readDir(status: string): Suggestion[] {
    const dirPath = join(rootDir, status)
    if (!existsSync(dirPath)) return []

    // Phase 13.12.25: skip critique records — they are sidecar files written
    // by self-critique and have a different schema; they must not be parsed
    // as suggestions.
    const files = readdirSync(dirPath).filter(
      (f) => f.endsWith('.md') && !f.endsWith('.critique.md'),
    )
    const suggestions: Suggestion[] = []

    for (const file of files) {
      const filePath = join(dirPath, file)
      let content = ''
      try {
        content = readFileSync(filePath, 'utf-8')
        suggestions.push(parseSuggestion(content))
      } catch (err) {
        // Phase 13.12.25: archive malformed files (one-time move) instead of
        // logging the parse failure on every wake.
        archiveMalformed(filePath, file, err)
      }
    }

    return suggestions
  }

  /**
   * The ONE retry implementation. Both `recordFailure` (the executor path, Phase 13.12.9) and
   * `recordQualityGateFailure` (the gate path, FR-057) are thin parameterisations of it, so the
   * attempt counter, the backoff curve and `MAX_ATTEMPTS_BEFORE_FAILED` cannot diverge between
   * them — the "second retry system" this phase exists to avoid.
   */
  function recordAttemptFailure(
    id: string,
    error: string,
    nowMs: number,
    opts: {
      /** Where the proposal waits between attempts. Default: wherever it already is. */
      readonly betweenAttemptsStatus?: SuggestionStatus
      /** Where it lands once the budget is exhausted. Default: `failed`. */
      readonly terminalStatus?: SuggestionStatus
      /** Drop `inflightTeamId` so the next attempt cannot resume a stuck context. */
      readonly clearInflightTeam?: boolean
      /** Also file `error` as the MACHINE's reason, protecting any human reason (FR-048). */
      readonly recordAsMachineReason?: boolean
    },
  ): Suggestion | null {
    ensureDirs()
    const found = findFile(id)
    if (!found) return null

    const content = readFileSync(found.path, 'utf-8')
    const current = parseSuggestion(content)

    const attemptCount = current.attemptCount + 1
    const lastAttemptAt = new Date(nowMs).toISOString()
    const reachedTerminal = attemptCount >= MAX_ATTEMPTS_BEFORE_FAILED

    // A machine retry must never REOPEN a decision the human already owns.
    //
    // `betweenAttemptsStatus` moves the item to a new status rather than leaving it where it is,
    // and nothing above consults where it currently is. The reachable sequence: John rejects a
    // proposal (or the dashboard's reject button fires) while its team is still running, then the
    // gate fails and resolves the team back to that suggestion by string-parsing its id
    // (`resolveSourceSuggestionId`) — independent of status. Without this guard the item moves
    // `rejected` → `approved`, the brain re-spawns a team for work he explicitly declined up to
    // five times, and the file ends up carrying `status: approved` beside
    // `reviewVerdict: reject` — the precise contradiction `verdictContradictsStatus` exists to
    // prevent, written by the one path that legitimately bypasses it.
    //
    // It would also invert his intent a second time on read: `weekly-session.ts` maps
    // `status === 'rejected' ? 'reject' : 'approve'`, so his rejection would come back as an
    // approval. That is this phase's own defect running in the opposite direction, so the guard
    // belongs here rather than at the caller.
    //
    // `recordFailure` (the executor path) never had this exposure because it defaults
    // `betweenAttemptsStatus` to `current.status`; `'approved'` is what introduces it.
    //
    // RE-GRADE 2026-08-04 — the first version of this guard held `current.status`, nulled
    // `nextRetryAt` and skipped the terminal transition. For `status: approved` +
    // `reviewVerdict: reject` all three fire together and the item is left PROMOTABLE with no
    // backoff and no ceiling: measured at `attemptCount: 8` against a ceiling of 5, still promoted.
    // The guard against "the brain rebuilds work he declined up to five times" had made it
    // unbounded — strictly worse than the bug it was added to fix.
    //
    // So "he owns this" cannot mean "leave the status alone"; it has to mean THE MACHINE STOPS.
    // A refusal parks at `rejected`, which is not a promotable status. That is the machine
    // CONFORMING to his verdict, not overriding it — the verdict is his and authoritative, and
    // `status: approved` beside `reviewVerdict: reject` is the stale field, not the true one.
    //
    // THIRD PASS — `implemented` is tested FIRST, and that ordering is load-bearing. Shipped work
    // is the one thing no verdict can undo, and a backfill reject on an implemented proposal
    // ("I wouldn't have approved that") legitimately produces `status: implemented` +
    // `reviewVerdict: reject`. With `humanRefused` evaluated first, the next machine failure moved
    // that file out of `implemented/` and into `rejected/` — a BUILD FAILURE deciding that the
    // human declined something, which is this phase's own subject, and a direct contradiction of
    // the invariant the weekly-review fix is built on.
    const landed = current.status === 'implemented'
    const humanRefused =
      !landed && (current.reviewVerdict === 'reject' || current.status === 'rejected')
    const humanOwnsOutcome = landed || humanRefused

    const newStatus: SuggestionStatus = landed
      ? current.status
      : humanRefused
        ? 'rejected'
        : reachedTerminal
          ? opts.terminalStatus ?? 'failed'
          : opts.betweenAttemptsStatus ?? current.status
    const nextRetryAt =
      reachedTerminal || humanOwnsOutcome ? null : computeNextRetryAt(attemptCount, nowMs)
    const reasons = opts.recordAsMachineReason
      ? resolveReasons(current, error)
      : { reviewReason: current.reviewReason, machineReason: current.machineReason }

    const updated: Suggestion = {
      ...current,
      status: newStatus,
      // Tag the escalation explicitly when this failure is what made it terminal, so no downstream
      // reader has to infer the kind from `machineReason` + `attemptCount` (John, 2026-08-04).
      ...(reachedTerminal && newStatus === 'needs-human'
        ? { escalation: 'gate-exhausted' as const }
        : {}),
      attemptCount,
      lastError: error,
      lastAttemptAt,
      nextRetryAt,
      updatedAt: lastAttemptAt,
      reviewReason: reasons.reviewReason,
      machineReason: reasons.machineReason,
      // `reviewVerdict` is carried through by the spread, unconditionally. A failed BUILD is not
      // the human re-deciding, so there is no case in which this write may clear his verdict
      // (FR-050c). Contrast `updateStatus`, which must still fail safe for a human writer.
      ...(opts.clearInflightTeam ? { inflightTeamId: null } : {}),
    }

    const targetPath = join(rootDir, newStatus, filenameForId(id))
    writeFileSync(targetPath, serializeSuggestion(updated), 'utf-8')
    if (targetPath !== found.path) {
      unlinkSync(found.path)
    }
    return updated
  }

  /** Normalize a title for similarity comparison */


  return {
    /** Save a new suggestion (goes to pending/) */
    save(suggestion: Suggestion): void {
      ensureDirs()
      const content = serializeSuggestion(suggestion)
      const filePath = join(rootDir, 'pending', filenameForId(suggestion.id))
      writeFileSync(filePath, content, 'utf-8')
    },

    /** Get a suggestion by ID (searches all dirs) */
    get(id: string): Suggestion | null {
      const found = findFile(id)
      if (!found) return null
      const content = readFileSync(found.path, 'utf-8')
      return parseSuggestion(content)
    },

    /** List suggestions by status (or all if no status given) */
    list(status?: SuggestionStatus): readonly Suggestion[] {
      ensureDirs()
      const dirs = status ? [status] : [...STATUS_DIRS]
      const all: Suggestion[] = []

      for (const dir of dirs) {
        all.push(...readDir(dir))
      }

      return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },

    /** Move suggestion between status dirs */
    updateStatus(
      id: string,
      newStatus: SuggestionStatus,
      reason?: string,
      blockedMetadata?: { readonly requiredLevel: number; readonly blockedAt: string },
      opts?: {
        readonly reviewVerdict?: ReviewVerdict
        readonly author?: StatusAuthor
        readonly escalation?: EscalationKind
      },
    ): Suggestion | null {
      ensureDirs()
      const found = findFile(id)
      if (!found) return null

      const content = readFileSync(found.path, 'utf-8')
      const suggestion = parseSuggestion(content)
      const reasons = resolveReasons(suggestion, reason)
      const author: StatusAuthor = opts?.author ?? 'human'

      const updated: Suggestion = {
        ...suggestion,
        status: newStatus,
        updatedAt: new Date().toISOString(),
        // FR-070b: a MACHINE write is not a review, so it does not stamp the review clock.
        //
        // This field feeds two readers that both took real damage from the old unconditional
        // stamp. `weekly-session.ts` renders it as the moment John reviewed the item, and folds
        // that into `assessEngagement` — which gates an autonomy raise — so a quality-gate build
        // attempt was being counted as evidence he is paying attention. And the weekly backfill
        // pool scores staleness from the last surviving human decision (`weekly-review.ts`); a
        // machine resetting that clock is how `65a914f4` reached rank 107 of 107, a ~54-week wait,
        // measured 2026-08-06.
        //
        // The machine's write is still fully recorded — in `updatedAt`, `machineReason`,
        // `attemptCount` and `lastAttemptAt`. It is simply not recorded as a REVIEW, because it
        // was not one. Per A1, a machine judgement standing in for a human one is this feature's
        // defining failure class, and a timestamp is a judgement about who attended to the item.
        reviewedAt: author === 'human' ? new Date().toISOString() : suggestion.reviewedAt,
        reviewReason: reasons.reviewReason,
        machineReason: reasons.machineReason,
        // FR-051a: absence means "no verdict in this transition", never "he withdrew his verdict" —
        // the auto-execute path marks an approved item `implemented` with no reason and no verdict,
        // and it must not erase what he said, for the same reason `resolveReasons` exists.
        // ...but a sticky verdict must not outrank a LATER decision that simply had no way to
        // express one. The dashboard buttons are exactly that: a human re-deciding through a seam
        // with no verdict field. Preserving a contradicted verdict there would let Monday's answer
        // overrule Tuesday's click. Fail safe (fall back to the status) rather than fail wrong.
        //
        // FR-050c: that fail-safe is only sound when the writer could be a human. A MACHINE write
        // is never a re-decision, so a contradicting status from one is evidence about the build,
        // not about John — it leaves his verdict standing. This is the whole fix for the 65a914f4
        // inversion, where `updateStatus(id,'rejected','qg-fail:…')` silently deleted his `approve`.
        reviewVerdict:
          opts?.reviewVerdict ??
          (author === 'human' && verdictContradictsStatus(suggestion.reviewVerdict, newStatus)
            ? undefined
            : suggestion.reviewVerdict),
        // Phase 13.12.2: attach blocked metadata on transition INTO
        // blocked-autonomy; clear it on transition OUT of blocked-autonomy
        // so a re-approved item doesn't keep stale metadata.
        blockedMetadata:
          newStatus === 'blocked-autonomy'
            ? blockedMetadata ?? suggestion.blockedMetadata
            : undefined,
        // Same lifecycle rule as `blockedMetadata`: the escalation kind is meaningful only WHILE
        // the item is `needs-human`. Clearing it on the way out stops a stale tag outliving the
        // state it describes and re-classifying the item the next time it escalates.
        escalation:
          newStatus === 'needs-human'
            ? opts?.escalation ?? suggestion.escalation
            : undefined,        // Phase 13.12.20: clear inflightTeamId on any transition OUT of
        // in-progress. Terminal states never retain a dangling team id.
        inflightTeamId:
          newStatus === 'in-progress' ? suggestion.inflightTeamId : null,
      }

      // Write to new location
      const newPath = join(rootDir, newStatus, filenameForId(id))
      writeFileSync(newPath, serializeSuggestion(updated), 'utf-8')

      // Remove from old location — but ONLY when it actually moved. A same-status update (e.g.
      // attaching a reason to an already-rejected suggestion) resolves newPath === found.path, so an
      // unconditional unlink here DELETES the file that was just written and loses the suggestion.
      if (newPath !== found.path) {
        unlinkSync(found.path)
      }

      return updated
    },

    /** Check if a suggestion similar to this already exists (dedup) */
    findSimilar(title: string, type: SuggestionType): Suggestion | null {
      ensureDirs()
      const titleWords = normalizeTitle(title)

      for (const dir of STATUS_DIRS) {
        for (const suggestion of readDir(dir)) {
          if (suggestion.type !== type) continue
          const existingWords = normalizeTitle(suggestion.title)
          if (wordOverlap(titleWords, existingWords) > 0.8) {
            return suggestion
          }
        }
      }

      return null
    },

    /** Get all rejected suggestion titles (for blocklist) */
    getRejectedTitles(): readonly string[] {
      return readDir('rejected').map((s) => s.title)
    },

    /** Delete a suggestion */
    remove(id: string): boolean {
      const found = findFile(id)
      if (!found) return false
      unlinkSync(found.path)
      return true
    },

    /**
     * Phase 13.12.9: record an executor failure. Increments `attemptCount`,
     * stores `lastError` + `lastAttemptAt`, sets `nextRetryAt` via exponential
     * backoff, and transitions to the terminal `failed` status once
     * `attemptCount` reaches {@link MAX_ATTEMPTS_BEFORE_FAILED}.
     *
     * @param id      suggestion id
     * @param error   executor-returned error message (truncated on write)
     * @param nowMs   override for the current time in ms (defaults to `Date.now()`)
     */
    recordFailure(
      id: string,
      error: string,
      nowMs: number = Date.now(),
    ): Suggestion | null {
      return recordAttemptFailure(id, error, nowMs, {})
    },

    /**
     * FR-057 / FR-058 — the QUALITY GATE's failure seam.
     *
     * The same retry machinery as {@link recordFailure}, differing only in where the proposal
     * waits between attempts and where it lands when the budget runs out. It is deliberately a
     * parameterisation of that one implementation and not a second retry system: the counter,
     * the backoff curve and the ceiling are literally the same code, so the gate cannot drift
     * to a different limit than the executor path (T146).
     *
     * What it changes versus `updateStatus(id, 'rejected', reason)`, which is what the arbiter
     * called before:
     *
     *   - **Between attempts the proposal returns to `approved`,** not `in-progress`. The brain's
     *     retry loop lists `approved` only, so parking it anywhere else is a silent terminal
     *     state — worse than the mislabel this replaces.
     *   - **`inflightTeamId` is cleared,** so the next attempt gets a NEW agent context (FR-057c).
     *     Both dev sessions on 65a914f4 exited with `message_count=0`; resuming that team would
     *     reproduce the failure deterministically.
     *   - **At the ceiling it escalates to `needs-human`,** never `rejected` and never `failed`.
     *     `needs-human` is in neither `LANDED_VERDICTS` nor `FAILED_VERDICTS`, so an exhausted
     *     implementation contributes 0 to both (FR-056a) instead of being counted as John's
     *     refusal.
     *   - **The human verdict and words are untouched.** This writes the file directly rather
     *     than going through `updateStatus`, so `verdictContradictsStatus` never sees a machine
     *     write at all — the `author: 'machine'` guarantee of FR-050c, structurally.
     *
     * @param id      suggestion id
     * @param reason  the gate's machine reason, e.g. `qg-fail:tests-failed`
     * @param nowMs   override for the current time in ms (defaults to `Date.now()`)
     */
    recordQualityGateFailure(
      id: string,
      reason: string,
      nowMs: number = Date.now(),
    ): Suggestion | null {
      return recordAttemptFailure(id, reason, nowMs, {
        betweenAttemptsStatus: 'approved',
        terminalStatus: 'needs-human',
        clearInflightTeam: true,
        recordAsMachineReason: true,
      })
    },

    /**
     * Phase 13.12.20: transition a suggestion into `in-progress` and persist
     * the team id so the team_completed event listener can find it later.
     * Same status-dir move semantics as updateStatus, plus writes
     * `inflightTeamId` into the frontmatter.
     */
    markInProgress(id: string, teamId: string): Suggestion | null {
      ensureDirs()
      const found = findFile(id)
      if (!found) return null
      const content = readFileSync(found.path, 'utf-8')
      const current = parseSuggestion(content)
      const updated: Suggestion = {
        ...current,
        status: 'in-progress',
        inflightTeamId: teamId,
        updatedAt: new Date().toISOString(),
      }
      const targetPath = join(rootDir, 'in-progress', filenameForId(id))
      writeFileSync(targetPath, serializeSuggestion(updated), 'utf-8')
      if (targetPath !== found.path) unlinkSync(found.path)
      return updated
    },

    /**
     * Phase 13.12.20: find the in-progress suggestion that owns the given
     * team id. Used by the team_completed event listener to route the
     * stagedDiff back to the source suggestion.
     */
    findByInflightTeamId(teamId: string): Suggestion | null {
      ensureDirs()
      for (const s of readDir('in-progress')) {
        if (s.inflightTeamId === teamId) return s
      }
      return null
    },

    /**
     * Phase 13.12.9: clear all backoff/failure tracking on a suggestion.
     * Used by the manual `POST /api/suggestions/:id/retry` endpoint and by
     * the autonomy-raise auto-reset for RunCommand-skipped failures.
     *
     * If the suggestion is currently in `failed`, moves it back to
     * `approved` so the brain will pick it up on the next wake.
     */
    clearBackoff(id: string): Suggestion | null {
      ensureDirs()
      const found = findFile(id)
      if (!found) return null

      const content = readFileSync(found.path, 'utf-8')
      const current = parseSuggestion(content)

      const wasFailed = current.status === 'failed'
      // FR-058 — a gate-exhausted `needs-human` is retryable too, and reads the same way as
      // `failed`: the machine ran out of attempts, John looked at it and wants another go. Without
      // this it is a dead end — `runRetry` refuses it, and `repromote` (the only other exit) sends
      // it back to `pending` for re-triage rather than resuming the implementation he already
      // approved.
      //
      // Only the EXHAUSTED meaning moves. The 13.12.16 meaning ("a safety gate refused this;
      // rebuild it") must keep requiring `repromote`, because there the proposal genuinely needs
      // re-judging rather than another attempt. The two kinds are now an explicit tag rather than
      // an inline sniff — see `escalation.ts` for why.
      const wasGateExhausted = isGateExhausted(current)
      const newStatus: SuggestionStatus = wasFailed || wasGateExhausted ? 'approved' : current.status
      const now = new Date().toISOString()

      const updated: Suggestion = {
        ...current,
        status: newStatus,
        // The tag describes a `needs-human` state; once resumed it is stale (see `updateStatus`).
        ...(newStatus === 'needs-human' ? {} : { escalation: undefined }),
        attemptCount: 0,
        lastError: null,
        lastAttemptAt: null,
        nextRetryAt: null,
        updatedAt: now,
      }

      const targetPath = join(rootDir, newStatus, filenameForId(id))
      writeFileSync(targetPath, serializeSuggestion(updated), 'utf-8')
      if (targetPath !== found.path) {
        unlinkSync(found.path)
      }
      return updated
    },

    /**
     * Phase 13.12.16: re-promote a `needs-human` suggestion back to `pending`
     * after the root cause has been addressed. Clears `reviewReason` and
     * `reviewedAt` so the item looks fresh to the pipeline. No-op (returns
     * null) if the suggestion is not found or not in `needs-human`.
     */
    repromote(id: string): Suggestion | null {
      ensureDirs()
      const found = findFile(id)
      if (!found) return null
      if (found.status !== 'needs-human') return null

      const content = readFileSync(found.path, 'utf-8')
      const current = parseSuggestion(content)
      const now = new Date().toISOString()

      // `needs-human` carries two meanings and they need opposite handling here (FR-056b).
      //
      //   (1) 13.12.16 — a safety gate refused the proposal and it was REBUILT. The text John
      //       judged no longer exists, so carrying his verdict forward would bank the
      //       replacement's outcome under a verdict about the discarded one. Clearing is correct.
      //
      //   (2) Phase 10f — the implementation was EXHAUSTED after `MAX_ATTEMPTS_BEFORE_FAILED`
      //       gate failures. Nothing was rebuilt; the proposal text is byte-identical to the one
      //       he approved, and his approval is still valid. Clearing here would delete the very
      //       verdict this phase added `recordQualityGateFailure` to protect — the machine would
      //       simply erase it one hop later instead of at the gate, and harm #2 of the original
      //       defect (the evidence destroyed) would survive the fix that was meant to remove it.
      //
      // The two kinds are now an explicit tag rather than an inline sniff (`escalation.ts`), and
      // this is the one seam where the distinction changes an outcome.
      const isExhaustedImplementation = isGateExhausted(current)

      const updated: Suggestion = isExhaustedImplementation
        ? {
            ...current,
            status: 'pending',
            reviewedAt: undefined,
            // Verdict and reason survive: same text, same standing decision.
            // `attemptCount` resets so the retry budget is restored. Without this a repromoted
            // item is already at/over the ceiling and goes terminal on its NEXT single failure —
            // restoring "terminal on attempt one" through the back door.
            attemptCount: 0,
            nextRetryAt: null,
            // Both arms leave `needs-human`, so the escalation tag is stale either way.
            escalation: undefined,
            updatedAt: now,
          }
        : {
            ...current,
            status: 'pending',
            reviewedAt: undefined,
            reviewReason: undefined,
            escalation: undefined,
            // The verdict belongs to the version he judged. Carrying it onto the rebuild would bank the
            // replacement's outcome under a verdict about the discarded one — and `reviewReason` is
            // already cleared here, so nothing would be left to explain the label.
            reviewVerdict: undefined,
            updatedAt: now,
          }

      const targetPath = join(rootDir, 'pending', filenameForId(id))
      writeFileSync(targetPath, serializeSuggestion(updated), 'utf-8')
      if (targetPath !== found.path) {
        unlinkSync(found.path)
      }
      return updated
    },
  }
}
