import { describe, it, expect } from 'vitest'
import {
  FOLLOWUP_PATTERNS,
  FOLLOWUP_PATTERN_NAMES,
  CUE_CONFIDENCE_FLOOR,
  buildFollowupPrompt,
  parseFollowupVerdict,
  decideCue,
  readFollowupSatisfaction,
  NULL_FOLLOWUP_PROVIDER,
  type FollowupSatisfactionProvider,
  type FollowupVerdict,
} from '../../../src/memory/followup-satisfaction.js'

// ── The follow-up satisfaction reader ─────────────────────────────────────────────────────────────
//
// Kim et al. (LLM4Eval @ SIGIR 2024, arXiv:2407.13166) taxonomy -> SCNS's ImplicitCue, with Chow's
// (1970) reject rule at a CLASS-CONDITIONAL threshold. The asymmetry is the anti-manufacture property:
// `used` (1.0) is the label the acceptance-bias literature (Ziegler arXiv:2205.06537, RealHumanEval
// arXiv:2404.02806) warns is inflatable, so it carries the strongest evidence requirement.
//
// The tests below are deliberately weighted toward NEGATIVE controls. A reader that settles everything
// is a broken instrument, not a win — so the properties that matter most are the ones that prove the
// model CANNOT talk this module into a label.

const stub = (verdict: FollowupVerdict | null): FollowupSatisfactionProvider => ({
  async classify() {
    return verdict
  },
})

const PRIOR = 'so have we implemented and is the harness operating? measuring intent and improving?'

describe('taxonomy — every pattern maps to a cue or explicitly to no-cue', () => {
  it('covers all patterns and keeps rule 4 (bare topic change) as a NON-label', () => {
    expect(FOLLOWUP_PATTERNS['new-topic']).toBeNull()
    expect(FOLLOWUP_PATTERNS.ambiguous).toBeNull()
    for (const name of FOLLOWUP_PATTERN_NAMES) {
      const cue = FOLLOWUP_PATTERNS[name]
      expect(cue === null || cue === 'used' || cue === 'edited' || cue === 're-asked').toBe(true)
    }
  })

  it('offers NO accept cue at all, and grades friction above waste', () => {
    // The `used` label was REMOVED after an independent grader showed it was both ungroundable
    // (the reader never sees the assistant answer) and the one label that would manufacture the
    // metric. What remains is friction > waste, still Chow-asymmetric.
    expect(CUE_CONFIDENCE_FLOOR).not.toHaveProperty('used')
    expect(CUE_CONFIDENCE_FLOOR.edited).toBeGreaterThan(CUE_CONFIDENCE_FLOOR['re-asked'])
  })
})

describe('buildFollowupPrompt — neutral framing (anti-sycophancy)', () => {
  it('labels the messages FIRST/SECOND and never asks whether the assistant did well', () => {
    const p = buildFollowupPrompt({ priorQuery: PRIOR, nextTurn: 'and what about the retries?' })
    expect(p).toContain('FIRST message')
    expect(p).toContain('SECOND message')
    expect(p.toLowerCase()).not.toContain('satisf')
    expect(p.toLowerCase()).not.toContain('helpful')
    expect(p.toLowerCase()).not.toContain('good job')
    for (const name of FOLLOWUP_PATTERN_NAMES) expect(p).toContain(name)
  })
})

describe('parseFollowupVerdict', () => {
  it('POSITIVE: parses the three-line contract, tolerating chatter/fences/emphasis', () => {
    expect(parseFollowupVerdict('same_need: yes\npattern: clarify\nconfidence: 0.82')).toEqual({
      pattern: 'clarify',
      confidence: 0.82,
      sameNeed: 'yes',
    })
    // An OMITTED continuity answer is not a yes — it parses, then abstains at decideCue.
    expect(
      parseFollowupVerdict('```\nPattern: **acknowledge-advance**\nConfidence: 0.9\n```'),
    ).toEqual({ pattern: 'acknowledge-advance', confidence: 0.9, sameNeed: 'unclear' })
  })

  it('NEGATIVE: an unparseable or out-of-range answer is NOT evidence', () => {
    expect(parseFollowupVerdict('')).toBeNull()
    expect(parseFollowupVerdict('I think the user was happy!')).toBeNull()
    expect(parseFollowupVerdict('same_need: yes\npattern: delighted\nconfidence: 0.9')).toBeNull() // not in taxonomy
    expect(parseFollowupVerdict('pattern: clarify')).toBeNull() // no confidence
    expect(parseFollowupVerdict('same_need: yes\npattern: clarify\nconfidence: 1.4')).toBeNull()
    expect(parseFollowupVerdict('pattern: clarify\nconfidence: high')).toBeNull()
  })
})

describe('decideCue — Chow reject rule', () => {
  it('POSITIVE: emits the cue when confidence clears that class floor', () => {
    expect(decideCue({ pattern: 'clarify', confidence: 0.61, sameNeed: 'yes' })).toEqual({
      cue: 're-asked',
      pattern: 'clarify',
      confidence: 0.61,
    })
    expect(decideCue({ pattern: 'acknowledge-advance', confidence: 0.86, sameNeed: 'yes' })).toBeNull()
    expect(decideCue({ pattern: 'correct-and-continue', confidence: 0.71, sameNeed: 'yes' })?.cue).toBe('edited')
  })

  it('NEGATIVE: abstains just below each class floor', () => {
    expect(decideCue({ pattern: 'clarify', confidence: 0.59, sameNeed: 'yes' })).toBeNull()
    expect(decideCue({ pattern: 'correct-and-continue', confidence: 0.69, sameNeed: 'yes' })).toBeNull()
    expect(decideCue({ pattern: 'acknowledge-advance', confidence: 0.84, sameNeed: 'yes' })).toBeNull()
  })

  it('NEGATIVE CONTROL: an accept that would pass the waste bar is still rejected', () => {
    // 0.7 clears `re-asked` (0.6) and `edited` (0.7) but NOT `used` (0.85). The asymmetry is the point:
    // the same evidence strength buys a waste label but not an accept label.
    expect(decideCue({ pattern: 'dispute', confidence: 0.7, sameNeed: 'yes' })?.cue).toBe('re-asked')
    expect(decideCue({ pattern: 'acknowledge-advance', confidence: 0.7, sameNeed: 'yes' })).toBeNull()
  })

  it('NEGATIVE CONTROL: rule 4 holds at ANY confidence — a bare topic change is never a label', () => {
    expect(decideCue({ pattern: 'new-topic', confidence: 1, sameNeed: 'yes' })).toBeNull()
    expect(decideCue({ pattern: 'ambiguous', confidence: 1, sameNeed: 'yes' })).toBeNull()
  })

  it('NEGATIVE: a null verdict abstains', () => {
    expect(decideCue(null)).toBeNull()
  })
})

describe('readFollowupSatisfaction — the hard floors the model cannot override', () => {
  it('NEGATIVE CONTROL: a MACHINE-authored next turn never labels, even at confidence 1.0', async () => {
    const eager = stub({ pattern: 'acknowledge-advance', confidence: 1, sameNeed: 'yes' })
    expect(
      await readFollowupSatisfaction(eager, {
        priorQuery: PRIOR,
        nextTurn:
          'You are an INDEPENDENT fresh-context grader (producer != grader). You did NOT write this code.',
      }),
    ).toBeNull()
    expect(
      await readFollowupSatisfaction(eager, {
        priorQuery: PRIOR,
        nextTurn:
          'Agent "judge" (general-purpose) has finished processing and is now idle. Use read_agent with agent_id "judge".',
      }),
    ).toBeNull()
  })

  it('NEGATIVE CONTROL: a too-short or empty turn never labels, even at confidence 1.0', async () => {
    const eager = stub({ pattern: 'acknowledge-advance', confidence: 1, sameNeed: 'yes' })
    expect(await readFollowupSatisfaction(eager, { priorQuery: PRIOR, nextTurn: 'ok' })).toBeNull()
    expect(await readFollowupSatisfaction(eager, { priorQuery: PRIOR, nextTurn: '   ' })).toBeNull()
    expect(await readFollowupSatisfaction(eager, { priorQuery: '', nextTurn: 'a real follow-up here' })).toBeNull()
  })

  it('NEGATIVE CONTROL: a provider that throws abstains — a failure is never a label', async () => {
    const broken: FollowupSatisfactionProvider = {
      async classify() {
        throw new Error('acp spawn failed')
      },
    }
    expect(
      await readFollowupSatisfaction(broken, { priorQuery: PRIOR, nextTurn: 'so did we move the needle?' }),
    ).toBeNull()
  })

  it('NEGATIVE CONTROL: the NULL provider (CI default) never labels anything', async () => {
    expect(
      await readFollowupSatisfaction(NULL_FOLLOWUP_PROVIDER, {
        priorQuery: PRIOR,
        nextTurn: 'so -- did we actually move the needle forward here?',
      }),
    ).toBeNull()
  })

  it('POSITIVE: a confident dissatisfaction pattern on a real human turn labels waste', async () => {
    expect(
      await readFollowupSatisfaction(stub({ pattern: 'repeat-need', confidence: 0.8, sameNeed: 'yes' }), {
        priorQuery: PRIOR,
        nextTurn: 'so is the harness actually measuring intent yet, or did we only implement it?',
      }),
    ).toEqual({ cue: 're-asked', pattern: 'repeat-need', confidence: 0.8 })
  })

  it('NEGATIVE CONTROL: the TYPO case the old design "rescued" is now an honest abstain', async () => {
    // Live row 851. The first cut labelled this ACCEPT (`used`) and treated it as the win. It is
    // exactly the inference the reader cannot ground: it never sees the answer being accepted.
    // Removing the accept cue means this pair now abstains -- LOWER coverage, honestly earned.
    expect(
      await readFollowupSatisfaction(stub({ pattern: 'acknowledge-advance', confidence: 0.9, sameNeed: 'yes' }), {
        priorQuery: 'whaat do you men my next message settles 843 nad 845?',
        nextTurn: 'okayu -- so we need to handoff to a new session that can audit aand suggest some fixes?',
      }),
    ).toBeNull()
  })
})
