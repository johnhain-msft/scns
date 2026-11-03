/**
 * SC-029 / SC-031 census — how many human approvals were relabelled as human refusals
 * because the quality gate could not build them (FR-056), and how many families the
 * learner suppresses on `failed` rows alone (FR-059).
 *
 * Read-only by construction: nothing here opens a file for writing or a database for
 * anything but a `SELECT`. It exists so T143's baseline and T148's close-out run the
 * SAME code rather than two hand-written shell pipelines whose definitions can drift.
 *
 * ⚠️ Why the violation predicate is a UNION and not just `reviewVerdict === 'approve'`.
 * The live inversion destroys its own evidence: `updateStatus(id, 'rejected', …)` also
 * clears a standing `approve` verdict (`verdictContradictsStatus`), so by the time an
 * item is on disk in `rejected/` the verdict that proves John approved it is usually
 * already gone. `65a914f4` is exactly that shape — `reviewVerdict` absent,
 * `reviewReason: "human:cheap-win:"` intact. Counting only the surviving-verdict form
 * would report 0 violations for the very corpus that motivated the fix. Both forms are
 * reported separately below so neither hides inside the other.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { parseFrontmatter } from './suggestion-file.js'
import { isHumanReason } from './review-reason.js'
import { QG_FAIL_PREFIX } from './escalation.js'
import { LANDED_VERDICTS, type ProposalVerdict } from '../memory/proposal-outcomes.js'

/**
 * The status that means "the human declined this" (FR-056). An implementation failure
 * landing here IS the defect; every other terminal status is out of scope for SC-029.
 */
const HUMAN_REFUSAL_STATUS = 'rejected'

/** How the human approval is still visible on a mislabelled item. */
export type ApprovalEvidence =
  /** `reviewVerdict: approve` survived — the erasure did not (or has not yet) fired. */
  | 'verdict-intact'
  /** The verdict was cleared; only the `human:` reason remains as proof he approved. */
  | 'verdict-erased'

export interface QgMislabelViolation {
  readonly id: string
  readonly status: string
  readonly evidence: ApprovalEvidence
  readonly machineReason: string
  readonly reviewReason: string | null
  readonly attemptCount: number
}

/**
 * An OLDER damage shape, found on the live corpus during pass-5 grading: the quality gate wrote its
 * own failure string into `reviewReason` — the HUMAN's field — with no `machineReason` at all, and
 * set `status: rejected`.
 *
 * These are counted SEPARATELY from {@link QgMislabelCensus.violations} on purpose. SC-029's number
 * means "a human approval wearing the human-refusal label", and that is provable only when his
 * verdict or his `human:` reason survives. Here it does not: whatever he said was overwritten, so
 * his intent is unrecoverable and asserting he approved would be exactly the kind of unbacked
 * verdict this whole phase exists to stop.
 *
 * They are counted at all because the DAMAGE is identical and live: `rejected` is a member of
 * `FAILED_VERDICTS`, and `dedup-policy.ts` treats `rejected` as a permanent block with no time
 * window — so each of these vetoes its proposal family forever on the strength of a build failure.
 */
export interface MachineWrittenRefusal {
  readonly id: string
  readonly status: string
  /** The `qg-fail:*` string found in the human's `reviewReason` field. */
  readonly reviewReason: string
  readonly attemptCount: number
}

export interface QgMislabelCensus {
  /** Every suggestion file read, across every status directory. */
  readonly scanned: number
  /** Files that could not be parsed — reported, never silently skipped. */
  readonly unreadable: number
  /** SC-029's number: human approvals wearing the human-refusal label. */
  readonly violations: readonly QgMislabelViolation[]
  readonly violationsWithVerdictIntact: number
  readonly violationsWithVerdictErased: number
  /**
   * SC-030's companion: violations that were terminal on the FIRST attempt, i.e. no
   * retry was ever made. `attemptCount` absent from the file parses as 0.
   */
  readonly violationsWithZeroAttempts: number
  /**
   * The older shape (see {@link MachineWrittenRefusal}). Reported alongside `violations`, never
   * folded into it — the two have different standards of proof.
   */
  readonly machineWrittenRefusals: readonly MachineWrittenRefusal[]
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Census the on-disk suggestion corpus. `suggestionsDir` is the root that holds the
 * per-status directories (`rejected/`, `implemented/`, …).
 */
export function censusQgMislabels(suggestionsDir: string): QgMislabelCensus {
  const violations: QgMislabelViolation[] = []
  const machineWrittenRefusals: MachineWrittenRefusal[] = []
  let scanned = 0
  let unreadable = 0

  if (!existsSync(suggestionsDir)) {
    return {
      scanned: 0,
      unreadable: 0,
      violations: [],
      violationsWithVerdictIntact: 0,
      violationsWithVerdictErased: 0,
      violationsWithZeroAttempts: 0,
      machineWrittenRefusals: [],
    }
  }

  for (const entry of readdirSync(suggestionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(suggestionsDir, entry.name)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      scanned++
      let frontmatter: Record<string, unknown>
      try {
        frontmatter = parseFrontmatter(readFileSync(join(dir, file), 'utf-8')).frontmatter
      } catch {
        unreadable++
        continue
      }

      const status = readString(frontmatter['status']) ?? entry.name
      if (status !== HUMAN_REFUSAL_STATUS) continue

      const machineReason = readString(frontmatter['machineReason'])

      // The older shape first: the gate's failure string sitting in the HUMAN's reason field.
      // A `qg-fail:` prefix there can only have been machine-written — `isHumanReason` requires a
      // `human:` prefix — so this cannot capture one of John's real refusals.
      const rawReviewReason = readString(frontmatter['reviewReason'])
      if (!machineReason && rawReviewReason?.startsWith(QG_FAIL_PREFIX) === true) {
        machineWrittenRefusals.push({
          id: readString(frontmatter['id']) ?? file.replace(/\.md$/, ''),
          status,
          reviewReason: rawReviewReason,
          attemptCount: readNumber(frontmatter['attemptCount']),
        })
        continue
      }

      if (!machineReason?.startsWith(QG_FAIL_PREFIX)) continue

      const reviewVerdict = readString(frontmatter['reviewVerdict'])
      const reviewReason = readString(frontmatter['reviewReason'])
      // The `verdict-erased` arm requires the verdict to be genuinely ABSENT. Without that check
      // an explicit `reviewVerdict: "reject"` falls through to the `isHumanReason` test — which is
      // true of John's own rejection prose — and his real refusal is counted as a mislabelled
      // approval.
      //
      // This is reachable by the NORMAL post-fix sequence, which makes it worse than a corner
      // case: John approves → the gate fails → `machineReason: qg-fail:*` now SURVIVES (that is
      // the fix) → John later rejects it for real. The violation count would then drift upward
      // during correct operation, and the way to "improve" it would be to delete his rejections —
      // the exact perverse incentive this census's negative control exists to block.
      const evidence: ApprovalEvidence | null =
        reviewVerdict === 'approve'
          ? 'verdict-intact'
          : reviewVerdict === null && isHumanReason(reviewReason ?? undefined)
            ? 'verdict-erased'
            : null
      if (evidence === null) continue

      violations.push({
        id: readString(frontmatter['id']) ?? file.replace(/\.md$/, ''),
        status,
        evidence,
        machineReason,
        reviewReason,
        attemptCount: readNumber(frontmatter['attemptCount']),
      })
    }
  }

  return {
    scanned,
    unreadable,
    violations,
    violationsWithVerdictIntact: violations.filter((v) => v.evidence === 'verdict-intact').length,
    violationsWithVerdictErased: violations.filter((v) => v.evidence === 'verdict-erased').length,
    violationsWithZeroAttempts: violations.filter((v) => v.attemptCount === 0).length,
    machineWrittenRefusals,
  }
}

export interface FamilySuppressionRow {
  readonly entity: string
  readonly family: string
  /** Rows for this (entity, family) whose verdict is currently counted as a failure. */
  readonly failedCount: number
  /** Of those, how many carry the `failed` verdict specifically. */
  readonly failedVerdictCount: number
}

export interface FamilySuppressionCensus {
  readonly totalOutcomeRows: number
  /** (entity, family) pairs at or above the suppression threshold. */
  readonly suppressed: readonly FamilySuppressionRow[]
  /**
   * SC-031's number: suppressed families that would NOT be suppressed if `failed` were
   * not a failure verdict — i.e. suppressed **solely** by build failures.
   */
  readonly suppressedSolelyByFailedVerdict: readonly FamilySuppressionRow[]
}

/**
 * Census family suppression over `proposal_outcomes`. Mirrors the threshold arithmetic in
 * `selectMemoryDerivedSeeds` (`memory-self-improvement.ts:193-197`) rather than restating
 * it, so a change to one side shows up here instead of silently diverging.
 *
 * @param db                 an open memory database (opened read-only by the caller)
 * @param maxFamilyFailures  the suppression threshold the reader runs with
 */
export function censusFamilySuppression(
  db: Database.Database,
  maxFamilyFailures: number,
): FamilySuppressionCensus {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proposal_outcomes'")
    .get()
  if (!tableExists) {
    return { totalOutcomeRows: 0, suppressed: [], suppressedSolelyByFailedVerdict: [] }
  }

  const rows = db
    .prepare('SELECT entity, family, verdict FROM proposal_outcomes')
    .all() as Array<{ entity: string; family: string; verdict: ProposalVerdict }>

  // The set that suppressed families BEFORE FR-059 removed `failed`. This census exists to measure
  // what that removal changes, so it MUST count against the pre-change rule — `FAILED_VERDICTS` is
  // now the post-change rule and using it here inverts the whole instrument.
  //
  // The inverted version of this function (caught in review, 2026-08-04) computed `failed` from the
  // live `FAILED_VERDICTS`. Consequences, both verified by test:
  //   - a family with 3 × `failed` — the exact FR-059 target population — scored 0 and was dropped
  //     by the `< maxFamilyFailures` gate, so the census missed 100% of what it was built to find;
  //   - a family with 2 × `rejected` + 1 × `failed` scored 2, passed the gate, and then
  //     `2 - 1 < 2` reported it as "suppressed SOLELY by `failed`" — attributing suppression by two
  //     genuine human refusals to a build failure.
  // It printed `0` on the live vault only because that table holds a single row. A measuring
  // instrument that reads 0 for the wrong reason is worse than no instrument.
  const PRE_FR059_FAILED_VERDICTS: ReadonlySet<ProposalVerdict> = new Set<ProposalVerdict>([
    'rejected',
    'reverted',
    'failed',
  ])

  const byKey = new Map<
    string,
    { entity: string; family: string; landed: number; failed: number; failedVerdict: number }
  >()
  for (const r of rows) {
    const key = `${r.entity}\u0000${r.family}`
    const acc = byKey.get(key) ?? {
      entity: r.entity,
      family: r.family,
      landed: 0,
      failed: 0,
      failedVerdict: 0,
    }
    if (LANDED_VERDICTS.has(r.verdict)) acc.landed++
    if (PRE_FR059_FAILED_VERDICTS.has(r.verdict)) acc.failed++
    if (r.verdict === 'failed') acc.failedVerdict++
    byKey.set(key, acc)
  }

  const suppressed: FamilySuppressionRow[] = []
  const solely: FamilySuppressionRow[] = []
  for (const acc of byKey.values()) {
    // The real rule is `familyLanded > 0 || familyFailed >= maxFamilyFailures`
    // (`memory-self-improvement.ts:198`). The first version of this census implemented only the
    // second disjunct while claiming to mirror the whole rule, so a family suppressed because it
    // ALREADY LANDED was scored as suppressed by `failed` — attributing to a build failure a
    // suppression that FR-059 does not lift, and overstating the benefit this metric certifies.
    const suppressedByLanded = acc.landed > 0
    if (!suppressedByLanded && acc.failed < maxFamilyFailures) continue
    const row: FamilySuppressionRow = {
      entity: acc.entity,
      family: acc.family,
      failedCount: acc.failed,
      failedVerdictCount: acc.failedVerdict,
    }
    suppressed.push(row)
    // Would it still be suppressed with `failed` rows discounted? If not, `failed` alone
    // is what suppresses it — the FR-059 population. A family that landed is suppressed either
    // way, so it can never be "solely" attributable to `failed`.
    if (!suppressedByLanded && acc.failed - acc.failedVerdict < maxFamilyFailures) solely.push(row)
  }

  return { totalOutcomeRows: rows.length, suppressed, suppressedSolelyByFailedVerdict: solely }
}
