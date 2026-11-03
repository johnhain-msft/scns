/**
 * F1 (CRITICAL) — the Monday cron must EMIT the weekly report, not merely log a pointer to a command
 * the human then has to type. One renderer, two callers; these tests cover the extracted seam.
 *
 * Step 2 (2026-08-15, purpose frame): the section is now ROUTING ACCURACY — per-tool accept/waste,
 * sliced by the shadow hop-shape classifier, plus classifier-vs-outcome agreement — with the same
 * honesty discipline the promote/retire section had (three-state evidence, no zero rendered as fact,
 * measured FR-038 caveats). The promotion verdict, `minN`, and `readSampleCaveats` are gone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { WeeklySession } from '../../../src/suggest/weekly-session.js'
import type { WeeklyPacket } from '../../../src/suggest/weekly-review.js'
import {
  SuggestionType,
  SuggestionStatus,
  SuggestionSchema,
  type Suggestion,
} from '../../../src/suggest/types.js'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openExperienceStore } from '../../../src/memory/experience-store.js'
import {
  renderRoutingAccuracySection,
  renderWeeklyReviewDocument,
  writeWeeklyReviewFile,
  weeklyReviewFilePath,
} from '../../../src/suggest/weekly-report.js'

let home: string
let scnsDir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'scns-weekly-report-'))
  scnsDir = join(home, '.scns')
  mkdirSync(join(scnsDir, 'memory'), { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const SINGLE = 'continue' // hop-shape: single-hop → magma
const MULTI = 'why is the brains consolidate branch the reason for the starvation?' // multi-hop → multihop-iter

/** Seed a store with `settled` settled rows (outcome 1.0) on `arm` with `text`, plus `served` unsettled ones. */
function seed(arm: string, settled: number, served: number, text = SINGLE, outcome = 1.0): void {
  const store = openExperienceStore(join(scnsDir, 'memory', 'experience.db'))
  const ins = store.db.prepare(
    `INSERT INTO retrieval_experience (query_text, retriever, explore_arm, human_outcome)
     VALUES (?, 'magma', ?, ?)`,
  )
  for (let i = 0; i < settled; i++) ins.run(text, arm, outcome)
  for (let i = 0; i < served; i++) ins.run(text, arm, null)
  store.close()
}

describe('C7 [US1] FR-038 wiring — the measured caveats REACH the rendered report', () => {
  // detectSampleCaveats being correct is worthless if nobody calls it. This is the wiring test:
  // deleting the `sampleCaveats = detectSampleCaveats(s, …)` line in weekly-report.ts must turn it red.
  it('names the provenance-free records of the sample in the rendered text', () => {
    seed('magma', 6, 0)
    seed('multihop-iter', 6, 0, MULTI)

    const out = renderRoutingAccuracySection({ scnsDir })

    expect(out.text).toContain('answer_source')
    expect(out.text).toMatch(/12 record\(s\)/)
  })
})

/**
 * PR #24, minor finding 4 — a FAILED caveat read must not masquerade as a caveat: `undefined` renders
 * "NOT MEASURED", never a one-element array filed under "known open defects".
 */
describe('PR#24-4 [US1] — a failed caveat read is NOT MEASURED, not a known open defect', () => {
  it('renders NOT MEASURED when the annotation read throws but the counts read cleanly', () => {
    seed('magma', 6, 0)
    seed('multihop-iter', 6, 0, MULTI)
    // Drop a column ONLY the caveat queries touch. The strict count reads and the routing-row load
    // (explore_arm / retriever / prompt_origin / human_outcome / query_text / propensity) still
    // succeed, so this is precisely the "annotations failed, counts fine" state the catch exists for.
    const s = openExperienceStore(join(scnsDir, 'memory', 'experience.db'))
    s.db.exec('ALTER TABLE retrieval_experience DROP COLUMN answer_source')
    s.close()

    const out = renderRoutingAccuracySection({ scnsDir })

    expect(out.text).toContain('NOT MEASURED')
    expect(out.text).not.toContain('Known open defects touching this sample')
    expect(out.text).not.toContain('No known open defect touches these records')
    // ...and it must NOT escalate an evidence base that demonstrably read fine.
    expect(out.evidenceError).toBeNull()
    expect(out.text).toContain('Labels per tool')
  })

  it('POSITIVE CONTROL: a readable corpus with a real defect still says "Known open defects"', () => {
    seed('magma', 6, 0)
    seed('multihop-iter', 6, 0, MULTI)
    const out = renderRoutingAccuracySection({ scnsDir })
    expect(out.text).toContain('Known open defects touching this sample')
    expect(out.text).not.toContain('NOT MEASURED')
  })
})

describe('renderRoutingAccuracySection — the extracted evidence-read + render (F1, purpose frame)', () => {
  it('POSITIVE CONTROL: with real settled rows it renders the per-tool funnel AND the routing numbers', () => {
    seed('magma', 6, 4) // single-hop, accepted
    seed('multihop-iter', 2, 0, SINGLE, 0.2) // single-hop, wasted on the other tool
    seed('multihop-iter', 2, 5, MULTI) // multi-hop, accepted
    seed('magma', 2, 0, MULTI, 0.2) // multi-hop, wasted on the other tool

    const out = renderRoutingAccuracySection({ scnsDir })

    expect(out.evidenceError).toBeNull()
    expect(out.settledByArm.get('magma')).toBe(8)
    expect(out.settledByArm.get('multihop-iter')).toBe(4)
    expect(out.servedByArm.get('magma')).toBe(12)
    expect(out.text).toContain('Routing accuracy')
    expect(out.text).toContain('magma: 8 settled of 12 served')
    expect(out.text).toContain('multihop-iter: 4 settled of 9 served')
    // the routing layer: shapes and agreement, computed at read time from query_text
    expect(out.text).toMatch(/single-hop \(calls for magma\): 8 settled of 12 served — magma 1\.00 \(n=6\) vs multihop-iter 0\.00 \(n=2\)/)
    expect(out.text).toMatch(/multi-hop \(calls for multihop-iter\): 4 settled of 9 served — multihop-iter 1\.00 \(n=2\) vs magma 0\.00 \(n=2\)/)
    expect(out.text).toMatch(/Classifier-vs-outcome agreement: 1\.00 \(over 12 comparable settled rows/)
    expect(out.report?.agreement.n).toBe(12)
    // no promote/retire vocabulary anywhere in the live section
    expect(out.text).not.toMatch(/promot|verdict|incumbent|challenger/i)
  })

  it('NEGATIVE CONTROL: an ABSENT store names itself absent and never renders a zero as fact', () => {
    // no experience.db written at all
    const out = renderRoutingAccuracySection({ scnsDir })

    expect(out.evidenceError).not.toBeNull()
    expect(out.evidenceError).toContain('no experience store at')
    // FR-026: `absent` is its OWN state, NOT "unknown" — a missing store has a KNOWN cause that
    // resolves itself on first retrieval, a failed read does not, and the two license opposite actions.
    expect(out.text).toContain('no experience store at')
    expect(out.text).toContain('omitted rather than shown as zero')
    expect(out.text).not.toContain('UNKNOWN')
    // the funnel must NOT be rendered from an empty map
    expect(out.text).not.toContain('Labels per tool')
    expect(out.report).toBeNull()
  })

  it('NEGATIVE CONTROL: a CORRUPT store reports the read failure, not an empty corpus', () => {
    writeFileSync(join(scnsDir, 'memory', 'experience.db'), 'this is not a sqlite database')

    const out = renderRoutingAccuracySection({ scnsDir })

    expect(out.evidenceError).not.toBeNull()
    expect(out.text).toContain('could not read the experience store')
    expect(out.text).not.toContain('Labels per tool')
    expect(out.report).toBeNull()
  })

  it('is READ-ONLY: rendering does not change the store file (byte-identical before/after)', () => {
    seed('magma', 3, 3)
    const p = join(scnsDir, 'memory', 'experience.db')
    const before = readFileSync(p)
    renderRoutingAccuracySection({ scnsDir })
    renderRoutingAccuracySection({ scnsDir })
    expect(readFileSync(p).equals(before)).toBe(true)
  })
})

describe('writeWeeklyReviewFile — where the Monday cron lands its report (F1, John: file + log)', () => {
  it('writes ~/.scns/reviews/weekly-<date>.md and returns that path', () => {
    const now = new Date('2026-08-03T09:00:00Z')
    const text = '# Weekly review\n\nRouting accuracy — was each query sent to the tool its shape required?\n  · magma: 18'

    const path = writeWeeklyReviewFile({ scnsDir, now, text })

    expect(path).toBe(join(scnsDir, 'reviews', 'weekly-2026-08-03.md'))
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toContain('· magma: 18')
  })

  it('creates the reviews directory when it does not exist yet', () => {
    expect(existsSync(join(scnsDir, 'reviews'))).toBe(false)
    const path = writeWeeklyReviewFile({ scnsDir, now: new Date('2026-08-03T09:00:00Z'), text: 'x' })
    expect(existsSync(path)).toBe(true)
  })

  it('weeklyReviewFilePath is pure and agrees with what the writer produced', () => {
    const now = new Date('2026-08-10T09:00:00Z')
    expect(weeklyReviewFilePath(scnsDir, now)).toBe(
      join(scnsDir, 'reviews', 'weekly-2026-08-10.md'),
    )
  })

  it('a re-run on the same day overwrites rather than accumulating duplicates', () => {
    const now = new Date('2026-08-03T09:00:00Z')
    writeWeeklyReviewFile({ scnsDir, now, text: 'first' })
    const path = writeWeeklyReviewFile({ scnsDir, now, text: 'second' })
    expect(readFileSync(path, 'utf-8')).toBe('second')
  })
})

describe('live tools — a tool with zero rows must still be REPORTED, from the live roster', () => {
  it('names the alternate tool even when the corpus has no row for it at all', () => {
    // A GROUP BY over the corpus cannot produce a row for a tool that was never served, so it would
    // silently vanish from the report. `resolveBriefingTools()` supplies the roster instead.
    seed('magma', 6, 10)

    const out = renderRoutingAccuracySection({ scnsDir })

    expect(out.evidenceError).toBeNull()
    expect(out.settledByArm.get('multihop-iter')).toBeUndefined() // genuinely absent from the corpus …
    expect(out.text).toMatch(/multihop-iter: 0 settled — never served/) // … yet still reported
  })

  it('names the DEFAULT tool from the live env, not a hard-coded one', () => {
    const prev = process.env.SCNS_LIVE_MEMORY_BRIEFING
    process.env.SCNS_LIVE_MEMORY_BRIEFING = 'hybrid'
    try {
      seed('multihop-iter', 1, 1, MULTI)
      const out = renderRoutingAccuracySection({ scnsDir })
      expect(out.evidenceError).toBeNull()
      expect(out.text).toMatch(/hybrid: 0 settled — never served/)
    } finally {
      if (prev === undefined) delete process.env.SCNS_LIVE_MEMORY_BRIEFING
      else process.env.SCNS_LIVE_MEMORY_BRIEFING = prev
    }
  })

  it('an explicit `tools` roster overrides the env-derived one', () => {
    seed('magma', 2, 0)
    const out = renderRoutingAccuracySection({ scnsDir, tools: ['magma'] })
    expect(out.text).not.toMatch(/multihop-iter: 0 settled — never served/)
  })
})

describe('the integrity probe must touch the columns the counters read', () => {
  it('reports FAILED — not "empty" — when a required column is missing', () => {
    const p = join(scnsDir, 'memory', 'experience.db')
    const store = openExperienceStore(p)
    store.db.exec('DROP TABLE retrieval_experience')
    store.db.exec(`CREATE TABLE retrieval_experience (
      id INTEGER PRIMARY KEY, query_text TEXT, retriever TEXT, human_outcome REAL
    )`) // no explore_arm — schema drift, which openExperienceStoreReadOnly does not migrate
    store.db
      .prepare(`INSERT INTO retrieval_experience (query_text, retriever, human_outcome)
                VALUES ('q', 'magma', 1.0)`)
      .run()
    store.close()

    const out = renderRoutingAccuracySection({ scnsDir })

    expect(out.evidenceError).not.toBeNull()
    expect(out.evidenceError).toContain('explore_arm')
    expect(out.text).toContain('could not read the experience store')
    expect(out.text).not.toContain('Labels per tool')
  })

  it('reports FAILED when the counts read but the routing rows cannot (query_text missing)', () => {
    // The routing rows ARE the evidence this section is about — a failure to load them is a failed
    // read of the evidence base and must not render as an empty corpus.
    const p = join(scnsDir, 'memory', 'experience.db')
    const store = openExperienceStore(p)
    store.db.exec('DROP TABLE retrieval_experience')
    store.db.exec(`CREATE TABLE retrieval_experience (
      id INTEGER PRIMARY KEY, retriever TEXT, explore_arm TEXT, prompt_origin TEXT, human_outcome REAL
    )`)
    store.db
      .prepare(`INSERT INTO retrieval_experience (retriever, explore_arm, human_outcome)
                VALUES ('magma', 'magma', 1.0)`)
      .run()
    store.close()

    const out = renderRoutingAccuracySection({ scnsDir })

    expect(out.evidenceError).not.toBeNull()
    expect(out.evidenceError).toMatch(/query_text|propensity/)
    expect(out.text).toContain('could not read the experience store')
    expect(out.report).toBeNull()
  })

  it('NEGATIVE CONTROL: a valid but EMPTY store still reads as empty, not corrupt', () => {
    const store = openExperienceStore(join(scnsDir, 'memory', 'experience.db'))
    store.close()

    const out = renderRoutingAccuracySection({ scnsDir })

    expect(out.evidenceError).toBeNull() // empty is not an error
    expect(out.text).toContain('Labels per tool')
    expect(out.text).toMatch(/magma: 0 settled — never served/)
    expect(out.text).toContain('no comparable settled rows yet')
  })
})

describe('renderWeeklyReviewDocument — the file must name the items, not just count them', () => {
  // Judge finding F10: these fixtures were `as never`, which silences EVERY field-shape error — and
  // `tsconfig.json` excludes `test/`, so nothing else would catch the drift either. Typed against the
  // real interfaces instead, so a shape change in production breaks this file loudly.
  const session = (
    hasWork: boolean,
    items: Array<{ id: string; why: string }>,
  ): WeeklySession => ({
    hasWork,
    armPromotion: null,
    packet: {
      items: items as unknown as WeeklyPacket['items'],
      selectedPending: items.length,
      selectedBackfill: 0,
      totalPending: items.length,
      nonActionablePending: 0,
      totalUnexplained: 0,
      budget: 5,
    },
    engagement: {
      n: 0,
      sufficientData: false,
      approvalRate: 0,
      reasonEntropy: 0,
      meanReasonLength: 0,
      disagreedRecently: false,
      rubberStamping: false,
      readyToEscalate: false,
      flags: [],
    },
  })

  // `'process'` was not a member of SuggestionType at all — the `as never` hid it. Parsing through the
  // production Zod schema makes drift impossible: it rejects unknown enum members and fills the 9
  // defaulted fields the hand-written literal silently omitted.
  const suggestion = (id: string, title: string): Suggestion =>
    SuggestionSchema.parse({
      id,
      title,
      type: SuggestionType.Automation,
      confidence: 0.9,
      description: 'd',
      status: SuggestionStatus.Pending,
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      evidence: [],
    })

  it('POSITIVE CONTROL: renders the detail of every pending item', () => {
    // Real UUIDs: SuggestionSchema enforces `z.string().uuid()`, so the old 'aaa'/'bbb' placeholders
    // are themselves proof the fixture never went through validation before.
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    const items = [
      { id: idA, why: 'highest confidence' },
      { id: idB, why: 'oldest unexplained' },
    ]
    const byId: Record<string, Suggestion> = {
      [idA]: suggestion(idA, 'Cap the auto-merger retry budget'),
      [idB]: suggestion(idB, 'Split the nightly soak job'),
    }

    const doc = renderWeeklyReviewDocument({
      session: session(true, items),
      learningText: 'LEARNING-SECTION',
      getSuggestion: (id) => byId[id] ?? null,
    })

    // The whole point of John's ruling: he must be able to READ what needs a decision.
    expect(doc).toContain('Cap the auto-merger retry budget')
    expect(doc).toContain('Split the nightly soak job')
    expect(doc).toContain('highest confidence')
    expect(doc).toContain('oldest unexplained')
    expect(doc).toContain('LEARNING-SECTION')
    expect(doc).toContain('To record your decisions: `scns review weekly`')
  })

  it('NEGATIVE CONTROL: with no work it renders no item detail and no record-prompt', () => {
    const doc = renderWeeklyReviewDocument({
      session: session(false, []),
      learningText: 'LEARNING-SECTION',
      getSuggestion: () => null,
    })

    expect(doc).toContain('LEARNING-SECTION')
    expect(doc).not.toContain('To record your decisions')
    expect(doc).not.toContain('── 1 of')
  })

  it('skips an item whose suggestion has vanished rather than throwing', () => {
    const doc = renderWeeklyReviewDocument({
      session: session(true, [{ id: 'gone', why: 'was selected' }]),
      learningText: 'L',
      getSuggestion: () => null,
    })
    expect(doc).toContain('L')
    expect(doc).not.toContain('── 1 of')
  })
})
