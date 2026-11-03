import { describe, it, expect } from 'vitest'
import {
  REJECT_REASON_CODES,
  APPROVE_REASON_CODES,
  EXPLAIN_REASON_CODES,
  reasonCodesFor,
  parseReviewReply,
  formatReviewReason,
  tagHumanReason,
  parseReviewReason,
  verdictFromInput,
  isHumanReason,
  hasHumanRationale,
} from '../../../src/suggest/review-reason.js'

describe('review reason taxonomy', () => {
  it('offers a non-empty, mechanism-bearing code set per verdict', () => {
    expect(Object.keys(REJECT_REASON_CODES).length).toBeGreaterThanOrEqual(6)
    expect(Object.keys(APPROVE_REASON_CODES).length).toBeGreaterThanOrEqual(3)
    // Every code carries a human-readable prompt so the CLI can render a menu.
    for (const desc of Object.values(REJECT_REASON_CODES)) expect(desc.length).toBeGreaterThan(0)
    expect(REJECT_REASON_CODES).toHaveProperty('already-exists')
  })

  it('resolves the code set by verdict', () => {
    expect(reasonCodesFor('reject')).toBe(REJECT_REASON_CODES)
    expect(reasonCodesFor('approve')).toBe(APPROVE_REASON_CODES)
    expect(reasonCodesFor('explain')).toBe(EXPLAIN_REASON_CODES)
    expect(reasonCodesFor('defer')).toEqual({})
  })
})

describe('parseReviewReply — structured form', () => {
  it('parses an explicit three-line reply', () => {
    const r = parseReviewReply('verdict: reject\ncode: already-exists\nwhy: the team-reaper already does this')
    expect(r).toEqual({
      verdict: 'reject',
      code: 'already-exists',
      text: 'the team-reaper already does this',
    })
  })

  it('accepts an unknown code by dropping the code but KEEPING the free text', () => {
    const r = parseReviewReply('verdict: reject\ncode: banana\nwhy: not worth it right now')
    expect(r?.verdict).toBe('reject')
    expect(r?.code).toBeNull()
    expect(r?.text).toBe('not worth it right now')
  })

  it('rejects a code that belongs to the OTHER verdict', () => {
    const r = parseReviewReply('verdict: approve\ncode: already-exists\nwhy: sure')
    expect(r?.verdict).toBe('approve')
    expect(r?.code).toBeNull()
  })
})

describe('parseReviewReply — natural language', () => {
  it('reads a leading yes as approve and keeps the whole reply as the reason', () => {
    const r = parseReviewReply('yes - this unblocks the scheduler work i care about')
    expect(r?.verdict).toBe('approve')
    expect(r?.code).toBeNull()
    expect(r?.text).toBe('this unblocks the scheduler work i care about')
  })

  it('reads a leading no as reject and preserves typos verbatim', () => {
    const r = parseReviewReply("no -- we alreaady have thsi in src/brain, its redundannt")
    expect(r?.verdict).toBe('reject')
    expect(r?.text).toBe('we alreaady have thsi in src/brain, its redundannt')
  })

  it('reads a defer/skip cue', () => {
    expect(parseReviewReply('skip this one for now')?.verdict).toBe('defer')
  })

  it('NEVER infers a taxonomy code from prose (no fabricated structure)', () => {
    const r = parseReviewReply('no, we already have that capability elsewhere')
    expect(r?.verdict).toBe('reject')
    expect(r?.code).toBeNull()
  })
})

describe('parseReviewReply — NEGATIVE CONTROLS (must abstain, never fabricate)', () => {
  it('abstains on empty / whitespace input', () => {
    expect(parseReviewReply('')).toBeNull()
    expect(parseReviewReply('   \n  ')).toBeNull()
  })

  it('abstains on a genuinely ambiguous reply', () => {
    expect(parseReviewReply('hmm, maybe')).toBeNull()
    expect(parseReviewReply('what does this even do?')).toBeNull()
  })

  it('does NOT coerce a verdict word buried mid-sentence', () => {
    expect(parseReviewReply('i would rather not reject this outright, tell me more')).toBeNull()
    expect(parseReviewReply('the proposal says it will approve things automatically')).toBeNull()
  })

  it('abstains when a verdict cue is present but NO reason is given (the whole point)', () => {
    expect(parseReviewReply('no')).toBeNull()
    expect(parseReviewReply('yes')).toBeNull()
    expect(parseReviewReply('verdict: reject\ncode: already-exists\nwhy:   ')).toBeNull()
  })

  it('abstains on a reason too short to carry signal', () => {
    expect(parseReviewReply('no - bad')).toBeNull()
  })
})

describe('formatReviewReason / parseReviewReason round-trip', () => {
  it('encodes code + text into the existing reviewReason string field', () => {
    const s = formatReviewReason({ verdict: 'reject', code: 'already-exists', text: 'the reaper does this' })
    expect(s).toContain('already-exists')
    expect(s).toContain('the reaper does this')
    expect(parseReviewReason(s)).toEqual({ code: 'already-exists', text: 'the reaper does this' })
  })

  it('round-trips when there is no code', () => {
    const s = formatReviewReason({ verdict: 'reject', code: null, text: 'just not now' })
    expect(parseReviewReason(s)).toEqual({ code: null, text: 'just not now' })
  })

  it('round-trips the EXPLAIN taxonomy code the weekly review writes', () => {
    const s = formatReviewReason({
      verdict: 'explain',
      code: 'needs-explanation',
      text: 'say what this actually does',
    })
    expect(parseReviewReason(s)).toEqual({
      code: 'needs-explanation',
      text: 'say what this actually does',
    })
  })

  it('drops a code borrowed from a different verdict before storage', () => {
    const s = formatReviewReason({
      verdict: 'approve',
      code: 'not-valuable',
      text: 'the prose must survive',
    })
    expect(parseReviewReason(s)).toEqual({ code: null, text: 'the prose must survive' })
  })

  it('is distinguishable from a MACHINE-written reason', () => {
    // Every reason on disk today is machine-written (qg-fail:*). A human reason must never
    // be confused with one, or the learner will train on the quality gate's opinions.
    const s = formatReviewReason({ verdict: 'reject', code: 'already-exists', text: 'the reaper does this' })
    expect(s.startsWith('human:')).toBe(true)
    expect(parseReviewReason('qg-fail:tests-failed')).toBeNull()
    expect(parseReviewReason('RunCommand skipped at autonomy level 2')).toBeNull()
  })
})

describe('tagHumanReason — verdict-aware CLI encoding', () => {
  it('recognizes a valid leading code followed by terminal punctuation', () => {
    expect(tagHumanReason('reject', 'not-valuable. this will never pay off')).toBe(
      'human:not-valuable: this will never pay off',
    )
  })

  it('keeps an invalid cross-verdict code as prose rather than structure', () => {
    expect(tagHumanReason('approve', 'not-valuable. the prose must survive')).toBe(
      'human:none: not-valuable. the prose must survive',
    )
  })

  it('keeps valid already-tagged input idempotent', () => {
    expect(tagHumanReason('approve', 'human:cheap-win: low effort, high payoff')).toBe(
      'human:cheap-win: low effort, high payoff',
    )
  })
})

describe('verdictFromInput — the interactive answer parser', () => {
  it('maps the plain words', () => {
    expect(verdictFromInput('approve')).toBe('approve')
    expect(verdictFromInput('a')).toBe('approve')
    expect(verdictFromInput('reject')).toBe('reject')
    expect(verdictFromInput('n')).toBe('reject')
    expect(verdictFromInput('defer')).toBe('defer')
  })

  // The exact bug: "explain" begins with 'e', and the old parser banked it as a rejection.
  it('never reads a request for explanation as a rejection', () => {
    for (const w of ['explain', 'e', '?', 'what is this', 'unclear', "i don't understand", 'idk']) {
      expect(verdictFromInput(w)).toBe('explain')
    }
  })

  // NEGATIVE CONTROL: an unrecognised answer must record NOTHING, never default to reject.
  it('returns null rather than guessing', () => {
    for (const w of ['', '   ', 'maybe', 'hmm', 'purple']) {
      expect(verdictFromInput(w)).toBeNull()
    }
  })
})

/**
 * Live artefact `65a914f4` carries `reviewReason: "human:cheap-win:"` — an approve CODE with no
 * prose after it. `parseReviewReason`'s `([\s\S]*)` group matches empty, so one predicate was
 * answering two different questions about that string:
 *
 *   "did a HUMAN author this?"          — yes. The mislabel census needs that to stay true.
 *   "does it contain his REASONING?"    — no. The learner corpus and the backfill pool need that.
 *
 * Conflating them is why `65a914f4` never came back for re-decision: it counted as explained, so
 * the backfill pool — whose whole job is to find unexplained decisions — could not see it.
 */
describe('a wordless verdict is provenance, not a rationale (65a914f4)', () => {
  const WORDLESS = 'human:cheap-win:'

  it('isHumanReason stays TRUE — provenance survives, so the mislabel census still counts it', () => {
    expect(isHumanReason(WORDLESS)).toBe(true)
  })

  it('hasHumanRationale is FALSE — there are no words to learn from', () => {
    expect(hasHumanRationale(WORDLESS)).toBe(false)
  })

  it('hasHumanRationale is TRUE when he actually wrote something', () => {
    expect(hasHumanRationale('human:none: mis-scoped, it targets an arbitrary number')).toBe(true)
  })

  it('whitespace-only prose is not words', () => {
    expect(hasHumanRationale('human:cheap-win:    ')).toBe(false)
  })

  it('a machine reason is neither (NEGATIVE CONTROL)', () => {
    expect(isHumanReason('qg-fail:tests-failed')).toBe(false)
    expect(hasHumanRationale('qg-fail:tests-failed')).toBe(false)
  })
})
