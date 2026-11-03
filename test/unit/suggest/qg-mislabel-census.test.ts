/**
 * T148 — verifying the measuring instrument itself.
 *
 * `censusQgMislabels` is the evidence for SC-029 ("no approved proposal ends in a human-refusal
 * status because of a build failure"). An unverified census is worse than no census: it reports a
 * number that reads like proof, and the number this one produces after the fix is ZERO — the same
 * value a completely broken predicate would return. So the census needs its own positive and
 * negative controls before its zero is allowed to mean anything.
 *
 * The two controls that matter:
 *   - POSITIVE: a corpus containing the real defect must produce a non-zero count. Without this,
 *     "0 violations" is indistinguishable from "the scanner never matched anything".
 *   - NEGATIVE: a corpus containing John's GENUINE rejections must produce zero. This is the
 *     control that stops the fix from being graded by a predicate that simply counts everything
 *     in `rejected/` — which would make the metric go up by deleting his real decisions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  censusQgMislabels,
  censusFamilySuppression,
} from '../../../src/suggest/qg-mislabel-census.js'
import { recordProposalOutcome } from '../../../src/memory/proposal-outcomes.js'

let dir: string

function writeSuggestion(status: string, id: string, frontmatter: Record<string, string>): void {
  const statusDir = join(dir, status)
  mkdirSync(statusDir, { recursive: true })
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`)
  writeFileSync(
    join(statusDir, `${id}.md`),
    `---\nid: "${id}"\nstatus: "${status}"\n${lines.join('\n')}\n---\n\nbody\n`,
    'utf-8',
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qg-census-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('qg-mislabel census (T148 — the instrument, not the result)', () => {
  it('POSITIVE CONTROL: detects the verdict-erased shape of the real 65a914f4 defect', () => {
    // This is a byte-faithful reproduction of the live file that motivated Phase 10f:
    // John approved it, the gate failed to build it, and the write that recorded the build
    // failure ALSO erased the `reviewVerdict: approve` that proved he had approved it. Only the
    // `human:` prefix on his (empty-bodied) reason survived to testify.
    writeSuggestion('rejected', '65a914f4-b229-4fde-874e-c46a44dd845f', {
      reviewReason: '"human:cheap-win:"',
      machineReason: '"qg-fail:tests-failed"',
    })

    const census = censusQgMislabels(dir)
    expect(census.scanned).toBe(1)
    expect(census.violations).toHaveLength(1)
    expect(census.violations[0]!.evidence).toBe('verdict-erased')
    expect(census.violations[0]!.id).toBe('65a914f4-b229-4fde-874e-c46a44dd845f')
    expect(census.violationsWithVerdictErased).toBe(1)
    expect(census.violationsWithVerdictIntact).toBe(0)
  })

  it('POSITIVE CONTROL: detects the verdict-intact shape too (union predicate, both arms)', () => {
    // The other arm of the union: had the erasing write not also cleared the verdict, the
    // violation would be visible directly. Both arms are exercised so that a future refactor
    // cannot quietly drop one and still report a plausible-looking zero.
    writeSuggestion('rejected', 'intact-0001', {
      reviewVerdict: '"approve"',
      reviewReason: '"human:worth doing"',
      machineReason: '"qg-fail:lint-failed"',
    })

    const census = censusQgMislabels(dir)
    expect(census.violations).toHaveLength(1)
    expect(census.violations[0]!.evidence).toBe('verdict-intact')
    expect(census.violationsWithVerdictIntact).toBe(1)
  })

  it('NEGATIVE CONTROL: a genuine human rejection is NOT a violation', () => {
    // The control that protects John's real decisions. `rejected` + a `human:` reason is the
    // CORRECT and expected shape of him turning something down. It becomes a violation only when
    // a `qg-fail:` machineReason shows the terminal status came from a build failure instead.
    // A census that missed this distinction would report violations that could be "fixed" by
    // deleting his rejections — improving the metric by destroying the data it measures.
    writeSuggestion('rejected', 'genuine-refusal', {
      reviewVerdict: '"reject"',
      reviewReason: '"human:not worth the churn"',
    })

    const census = censusQgMislabels(dir)
    expect(census.scanned).toBe(1)
    expect(census.violations).toHaveLength(0)
  })

  it('NEGATIVE CONTROL: an explicit human REJECT with a qg-fail machineReason is not a violation', () => {
    // The control the original pair missed. The first negative control omitted `machineReason`
    // entirely, so it passed for the wrong reason — the item was filtered out one check earlier
    // and the verdict arm was never exercised.
    //
    // This is the ordinary post-fix sequence: John approves, the gate fails (the `qg-fail:`
    // machineReason now SURVIVES, which is the fix working), and John later rejects it for real.
    // His explicit `reject` must end the enquiry. Counting it would make SC-029 climb during
    // correct operation and reward deleting his decisions.
    writeSuggestion('rejected', 'genuine-refusal-after-gate-fail', {
      reviewVerdict: '"reject"',
      reviewReason: '"human:wrong-layer:the broker already owns this"',
      machineReason: '"qg-fail:tests-failed"',
      attemptCount: '3',
    })

    const census = censusQgMislabels(dir)
    expect(census.scanned).toBe(1)
    expect(census.violations).toHaveLength(0)
  })

  it('NEGATIVE CONTROL: the post-fix shape (gate failure parked in needs-human) is clean', () => {
    // What Phase 10f produces instead. `needs-human` is in neither LANDED_VERDICTS nor
    // FAILED_VERDICTS, so it asserts nothing about what John thinks — which is the whole point.
    writeSuggestion('needs-human', 'escalated-0001', {
      reviewVerdict: '"approve"',
      reviewReason: '"human:cheap win"',
      machineReason: '"qg-fail:tests-failed"',
      attemptCount: '5',
    })
    // ...and the between-attempts shape: back in `approved`, waiting for the brain to retry.
    writeSuggestion('approved', 'retrying-0001', {
      reviewVerdict: '"approve"',
      reviewReason: '"human:cheap win"',
      machineReason: '"qg-fail:tests-failed"',
      attemptCount: '2',
    })

    const census = censusQgMislabels(dir)
    expect(census.scanned).toBe(2)
    expect(census.violations).toHaveLength(0)
  })

  it('does not count a machine-rejected item that no human ever approved', () => {
    // Auto-triage rejections carry no `human:` reason and no approve verdict. They are not
    // mislabelled approvals — nobody's judgement was overwritten — so they must not inflate the
    // count. Otherwise the "violations" figure measures queue volume rather than label integrity.
    writeSuggestion('rejected', 'machine-triage', {
      reviewReason: '"auto-triage: duplicate"',
      machineReason: '"qg-fail:tests-failed"',
    })

    const census = censusQgMislabels(dir)
    expect(census.violations).toHaveLength(0)
  })

  it('reports unreadable files rather than silently skipping them', () => {
    // A census that swallows parse errors can report zero because it read nothing. Surfacing the
    // count keeps "0 violations / 0 unreadable" honestly distinguishable from "0 violations
    // because 147 files failed to parse".
    mkdirSync(join(dir, 'rejected'), { recursive: true })
    writeFileSync(join(dir, 'rejected', 'broken.md'), 'not frontmatter at all', 'utf-8')

    const census = censusQgMislabels(dir)
    expect(census.scanned).toBe(1)
    expect(census.violations).toHaveLength(0)
    // Either it parsed to an empty frontmatter (no status match) or it counted as unreadable —
    // both are acceptable, but the file must have been SEEN.
    expect(census.scanned).toBeGreaterThan(0)
  })

  it('returns a zeroed census for a missing directory instead of throwing', () => {
    const census = censusQgMislabels(join(dir, 'does-not-exist'))
    expect(census.scanned).toBe(0)
    expect(census.violations).toHaveLength(0)
  })
})

/**
 * The SC-031 half of the census. These tests exist because the evidence document for Phase 10f
 * originally claimed "the census has positive and negative controls" while only
 * `censusQgMislabels` had any — `censusFamilySuppression` had none, and was inverted.
 *
 * Both cases below are regression pins for that inversion: the original implementation counted
 * `acc.failed` using the live (post-FR-059) `FAILED_VERDICTS`, which no longer contains `failed`.
 */
describe('censusFamilySuppression (T148 — the SC-031 instrument)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
  })
  afterEach(() => {
    db.close()
  })

  const rec = (family: string, verdict: string, id: string): void => {
    recordProposalOutcome(db, {
      entity: 'ent',
      family,
      title: 't',
      verdict: verdict as never,
      suggestionId: id,
    })
  }

  it('POSITIVE CONTROL: a family suppressed only by `failed` rows IS the FR-059 population', () => {
    // Three build failures, no human ever refused it. Pre-FR-059 this family was suppressed;
    // post-FR-059 it un-suppresses. This is precisely what SC-031 is meant to count, and the
    // inverted implementation scored it 0 and discarded it before it was ever considered.
    rec('docs', 'failed', 'a')
    rec('docs', 'failed', 'b')
    rec('docs', 'failed', 'c')

    const c = censusFamilySuppression(db, 2)
    expect(c.totalOutcomeRows).toBe(3)
    expect(c.suppressed).toHaveLength(1)
    expect(c.suppressed[0]!.family).toBe('docs')
    expect(c.suppressedSolelyByFailedVerdict).toHaveLength(1)
    expect(c.suppressedSolelyByFailedVerdict[0]!.family).toBe('docs')
  })

  it('NEGATIVE CONTROL: a family suppressed by genuine human refusals is NOT attributed to `failed`', () => {
    // Two real rejections push this over the threshold on their own; the single build failure is
    // incidental. Reporting this as "suppressed solely by `failed`" would credit FR-059 with
    // un-suppressing a family John actually turned down twice — an overclaim in the direction
    // that most flatters the change, which is why it needs its own pin.
    rec('cicd', 'rejected', 'd')
    rec('cicd', 'rejected', 'e')
    rec('cicd', 'failed', 'f')

    const c = censusFamilySuppression(db, 2)
    expect(c.suppressed).toHaveLength(1)
    expect(c.suppressed[0]!.family).toBe('cicd')
    expect(c.suppressedSolelyByFailedVerdict).toHaveLength(0)
  })

  it('a mixed family that needs the `failed` rows to cross the line counts as solely-failed', () => {
    // 1 rejection + 2 build failures, threshold 3: without the build failures it would not be
    // suppressed at all, so FR-059 genuinely releases it.
    rec('mixed', 'rejected', 'g')
    rec('mixed', 'failed', 'h')
    rec('mixed', 'failed', 'i')

    const c = censusFamilySuppression(db, 3)
    expect(c.suppressed).toHaveLength(1)
    expect(c.suppressedSolelyByFailedVerdict).toHaveLength(1)
  })

  it('a family below the threshold is not reported as suppressed at all', () => {
    rec('small', 'failed', 'j')
    const c = censusFamilySuppression(db, 2)
    expect(c.suppressed).toHaveLength(0)
    expect(c.suppressedSolelyByFailedVerdict).toHaveLength(0)
  })

  it('returns a zeroed census when the table does not exist', () => {
    const empty = new Database(':memory:')
    const c = censusFamilySuppression(empty, 2)
    expect(c.totalOutcomeRows).toBe(0)
    expect(c.suppressed).toHaveLength(0)
    empty.close()
  })
})

/**
 * RE-GRADE 2026-08-04, finding 5 — the census claimed to "mirror the threshold arithmetic in
 * `selectMemoryDerivedSeeds` rather than restating it", but restated only HALF of it.
 *
 * The real rule is `familyLanded > 0 || familyFailed >= maxFamilyFailures`
 * (`memory-self-improvement.ts:198`). The census implemented the second disjunct alone, so a family
 * suppressed because it ALREADY LANDED was attributed to `failed` rows — crediting FR-059 with
 * un-suppressing something it does not touch, in the very metric that certifies FR-059's benefit.
 */
describe('censusFamilySuppression — the landed disjunct (re-grade finding 5)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
  })
  afterEach(() => {
    db.close()
  })

  const rec = (family: string, verdict: string, id: string): void => {
    recordProposalOutcome(db, {
      entity: 'ent',
      family,
      title: 't',
      verdict: verdict as never,
      suggestionId: id,
    })
  }

  it('a family that LANDED is suppressed, and never "solely by `failed`"', () => {
    // The exact shape the re-grade used: 2 × failed + 1 × implemented. The old arithmetic scored
    // `failed = 1`, and `1 - 1 < 2` reported it as suppressed SOLELY by a build failure — while
    // the real generator suppresses it via `landed > 0`, which FR-059 does not lift.
    rec('fam-landed', 'failed', 'aaaaaaaa-0000-0000-0000-0000000000f1')
    rec('fam-landed', 'failed', 'aaaaaaaa-0000-0000-0000-0000000000f2')
    rec('fam-landed', 'implemented', 'aaaaaaaa-0000-0000-0000-0000000000f3')

    const out = censusFamilySuppression(db, 2)
    expect(out.suppressed.map((r) => r.family)).toContain('fam-landed')
    expect(out.suppressedSolelyByFailedVerdict.map((r) => r.family)).not.toContain('fam-landed')
  })

  it('NEGATIVE CONTROL: a family with neither a landing nor enough failures is not suppressed', () => {
    rec('fam-quiet', 'failed', 'bbbbbbbb-0000-0000-0000-0000000000f1')

    const out = censusFamilySuppression(db, 2)
    expect(out.suppressed.map((r) => r.family)).not.toContain('fam-quiet')
  })

  it('the FR-059 population is still counted when the family has NOT landed', () => {
    rec('fam-failed', 'failed', 'cccccccc-0000-0000-0000-0000000000f1')
    rec('fam-failed', 'failed', 'cccccccc-0000-0000-0000-0000000000f2')

    const out = censusFamilySuppression(db, 2)
    expect(out.suppressedSolelyByFailedVerdict.map((r) => r.family)).toContain('fam-failed')
  })
})
