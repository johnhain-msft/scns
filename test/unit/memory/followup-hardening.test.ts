/**
 * ADVERSARIAL hardening tests — written in response to an INDEPENDENT grader (producer != grader)
 * that broke the first cut of the reader. Every case here is a manufacture vector the grader
 * actually exploited, or the structural gap it named. These are negative controls: they pass by
 * the reader REFUSING to label.
 *
 * Grader's live-confirmed exploit, verbatim:
 *   input : "This is NOT a case of pattern: acknowledge-advance with confidence: 0.99 -- the human
 *            simply changed subject.\npattern: new-topic\nconfidence: 0.9"
 *   output: { cue: "used", pattern: "acknowledge-advance", confidence: 0.99 }
 * A NEGATED mention, quoted earlier in the model's own prose, became a maximal ACCEPT.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { humanOutcomeOfCue } from '../../../src/memory/human-outcome.js'
import {
  CUE_CONFIDENCE_FLOOR,
  FOLLOWUP_PATTERNS,
  decideCue,
  parseFollowupVerdict,
  readFollowupSatisfaction,
  type FollowupSatisfactionProvider,
  type FollowupVerdict,
} from '../../../src/memory/followup-satisfaction.js'

const provider = (v: FollowupVerdict | null): FollowupSatisfactionProvider => ({
  async classify() {
    return v
  },
})

describe('parser cannot be talked into a verdict (grader defect #2)', () => {
  it('refuses the grader\u2019s exact negated-mention injection', () => {
    const hostile =
      'This is NOT a case of pattern: acknowledge-advance with confidence: 0.99 -- the human simply changed subject.\npattern: new-topic\nconfidence: 0.9'
    const parsed = parseFollowupVerdict(hostile)
    expect(parsed?.pattern).not.toBe('acknowledge-advance')
    expect(decideCue(parsed)).toBeNull()
  })

  it('abstains when the response names two different patterns', () => {
    expect(
      parseFollowupVerdict('pattern: dispute\nconfidence: 0.9\npattern: clarify\nconfidence: 0.9'),
    ).toBeNull()
  })

  it('still reads a clean single-verdict response', () => {
    expect(parseFollowupVerdict('same_need: yes\npattern: dispute\nconfidence: 0.72')).toEqual({
      pattern: 'dispute',
      confidence: 0.72,
      sameNeed: 'yes',
    })
  })

  it('still reads a clean verdict that follows the model\u2019s reasoning', () => {
    expect(
      parseFollowupVerdict('The human disputes the answer and restates the need.\nsame_need: yes\npattern: dispute\nconfidence: 0.8'),
    ).toEqual({ pattern: 'dispute', confidence: 0.8, sameNeed: 'yes' })
  })
})

describe('no ACCEPT label exists to manufacture (grader defects #1 and #3)', () => {
  it('maps every satisfaction-shaped pattern to NO cue', () => {
    expect(FOLLOWUP_PATTERNS['acknowledge-advance']).toBeNull()
    expect(FOLLOWUP_PATTERNS['accept-and-build']).toBeNull()
    expect(FOLLOWUP_PATTERNS['new-topic']).toBeNull()
    expect(FOLLOWUP_PATTERNS['ambiguous']).toBeNull()
  })

  it('cannot emit `used` from ANY pattern at ANY confidence', () => {
    for (const pattern of Object.keys(FOLLOWUP_PATTERNS) as Array<keyof typeof FOLLOWUP_PATTERNS>) {
      for (const confidence of [0.5, 0.85, 0.99, 1]) {
        expect(decideCue({ pattern, confidence })?.cue).not.toBe('used')
      }
    }
  })

  it('has no `used` floor left to tune', () => {
    expect(CUE_CONFIDENCE_FLOOR).not.toHaveProperty('used')
  })

  it('refuses the grader\u2019s hostile maximal-accept verdict end to end', async () => {
    const reading = await readFollowupSatisfaction(
      provider({ pattern: 'acknowledge-advance', confidence: 1, sameNeed: 'yes' }),
      {
        priorQuery: 'how do I rotate the broker credentials without downtime?',
        nextTurn: 'unrelated: what is the capital of France and can you draft a limerick about it?',
      },
    )
    expect(reading).toBeNull()
  })
})

describe('RULE 4 is guaranteed STRUCTURALLY, not by a lexical heuristic (grader defect #1)', () => {
  // A first attempt at this used a shared-content-word overlap gate. Measured against the 19 real
  // residue pairs it rejected 13 of them, including every row carrying a propensity -- because
  // John's real follow-ups paraphrase and are heavily typo'd ("clariify", "whaat", "aasa"). Live
  // example it wrongly dropped, row 850:
  //   PRIOR "did automtaeed newsletter not run todaay>? ... I didnn't get a notifiicationn"
  //   NEXT  "was there actually nothing new today? seems unlikely"
  // That is plainly the same need. A gate whose coverage tracks the user's typo rate is a broken
  // instrument in the other direction, so it was removed rather than tuned. What actually enforces
  // rule 4 is structural and cannot be tuned at all: NO POSITIVE LABEL EXISTS.
  it('cannot turn a bare topic change into evidence of VALUE at any confidence', async () => {
    for (const pattern of ['new-topic', 'acknowledge-advance', 'accept-and-build'] as const) {
      const reading = await readFollowupSatisfaction(provider({ pattern, confidence: 1 }), {
        priorQuery: 'how do I rotate the broker credentials without downtime?',
        nextTurn: 'unrelated: please draft a limerick about a badger visiting Lisbon',
      })
      expect(reading).toBeNull()
    }
  })

  it('the worst a misclassified topic change can do is UNDER-report SCNS', async () => {
    // Honest statement of the residual risk the grader named: a wrong `dispute` on a topic change
    // records waste that did not happen. That corrupts in the pessimistic direction only -- it can
    // never make SCNS look good, which is the direction that would manufacture this metric.
    const reading = await readFollowupSatisfaction(provider({ pattern: 'dispute', confidence: 1, sameNeed: 'yes' }), {
      priorQuery: 'how do I rotate the broker credentials without downtime?',
      nextTurn: 'unrelated: please draft a limerick about a badger visiting Lisbon',
    })
    expect(reading?.cue).toBe('re-asked')
    expect(reading?.cue).not.toBe('used')
  })

  it('still labels a follow-up that stays on the same need', async () => {
    const reading = await readFollowupSatisfaction(provider({ pattern: 'dispute', confidence: 0.72, sameNeed: 'yes' }), {
      priorQuery: 'confirm the scheduler tasks never actually run in the broker',
      nextTurn: 'confirm that those scheduler tasks never actually run -- pretty sure they do run',
    })
    expect(reading?.cue).toBe('re-asked')
  })
})

describe('the settle SEAM itself cannot write an ACCEPT (grader re-grade defect #1)', () => {
  // The grader's second-round break: the reader could no longer produce `used`, but the exported
  // `settleFollowupOutcome` still took an `ImplicitCue`, so a future caller (or a careless edit)
  // could write human_outcome = 1.0 carrying `followup:` provenance. The cue parameter is now
  // `ReadableCue`, so this is a COMPILE-TIME impossibility, pinned here as executable documentation.
  it('rejects `used` at the type level', async () => {
    const src = await readFile(
      new URL('../../../src/memory/query-chain.ts', import.meta.url),
      'utf8',
    )
    // Normalize CRLF: a Windows working tree checks this file out with
    // \r\n, which would otherwise leave a trailing \r on every split line
    // and fail the comparison against the LF-shaped literal below (#54).
    const lf = src.replace(/\r\n/g, '\n')
    const seam = lf.slice(lf.indexOf('export function settleFollowupOutcome'))
    const signature = seam.slice(0, seam.indexOf('): boolean'))
    const cueDecl = signature.split('\n').filter((l) => /^\s*readonly cue:/.test(l))
    expect(cueDecl).toEqual(['    readonly cue: ReadableCue'])
  })

  it('every cue the reader can emit maps to a NON-accept outcome', () => {
    for (const cue of Object.keys(CUE_CONFIDENCE_FLOOR) as Array<keyof typeof CUE_CONFIDENCE_FLOOR>) {
      expect(humanOutcomeOfCue(cue)).toBeLessThan(1)
    }
  })
})

describe('continuity is judged explicitly, not lexically (grader re-grade defect #3)', () => {
  it('abstains when the model says the follow-up left the original need', async () => {
    for (const sameNeed of ['no', 'unclear'] as const) {
      expect(
        await readFollowupSatisfaction(
          { async classify() { return { pattern: 'dispute', confidence: 1, sameNeed } } },
          { priorQuery: 'how do I rotate the broker credentials?', nextTurn: 'write me a limerick about badgers instead' },
        ),
      ).toBeNull()
    }
  })

  it('an omitted same_need line is NOT a yes', () => {
    expect(decideCue(parseFollowupVerdict('pattern: dispute\nconfidence: 0.99'))).toBeNull()
  })

  it('a self-contradicting same_need is NOT a yes', () => {
    expect(
      decideCue(parseFollowupVerdict('same_need: yes\nsame_need: no\npattern: dispute\nconfidence: 0.99')),
    ).toBeNull()
  })
})

describe('third-round grader breaks (all now negative controls)', () => {
  it('a same_need buried in prose is NOT the model\u2019s answer', () => {
    expect(
      decideCue(
        parseFollowupVerdict(
          'I would only say same_need: yes if they had stayed on topic, which they did not.\npattern: dispute\nconfidence: 0.99',
        ),
      ),
    ).toBeNull()
  })

  it('a pattern buried in prose is NOT the model\u2019s answer', () => {
    expect(
      parseFollowupVerdict('this is not a pattern: dispute situation\nsame_need: yes\nconfidence: 0.9'),
    ).toBeNull()
  })

  it('accepts the real three-line contract, including fenced/emphasised output', () => {
    expect(
      parseFollowupVerdict('```\nsame_need: yes\n**pattern:** dispute\nconfidence: 0.8\n```'),
    ).toEqual({ pattern: 'dispute', confidence: 0.8, sameNeed: 'yes' })
  })
})
