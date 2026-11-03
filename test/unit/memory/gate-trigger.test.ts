import { describe, it, expect } from 'vitest'
import {
  isUnderspecified,
  isClearlySpecific,
  cosineSimilarity,
  shouldElicit,
} from '../../../src/memory/gate-trigger.js'

// ── GATE Part A — the ambiguity / OOS trigger (WHEN to ask) ───────────────────────────────────────
// GATE (arXiv:2310.11589) always elicits when the task spec is under-determined; SCNS must NOT nag, so
// the trigger is conservative + high-precision. Two independent "can't confidently serve" signals:
//   (1) the prompt is intrinsically ambiguous  → isUnderspecified  (Aliannejadi SIGIR'19 ambiguity)
//   (2) the prompt is novel / out-of-scope      → OOS cosine < threshold (Larson 1909.02027)
// A CLEARLY-specific prompt never asks (John's neg control: "clear ⇒ asking wastes"), even if novel.
// Budget-bounded (Settles'09 / GATE's automation-bias caveat). Pure + deterministic (no DB, no LLM).

describe('cosineSimilarity — pure cosine over Float32 embeddings', () => {
  it('is 1 for identical vectors and ~0 for orthogonal', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([1, 0, 0])
    const c = new Float32Array([0, 1, 0])
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6)
    expect(cosineSimilarity(a, c)).toBeCloseTo(0, 6)
  })
  it('returns 0 on a zero vector (no divide-by-zero)', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0)
  })
})

describe('isUnderspecified — POSITIVE: intrinsically ambiguous prompts', () => {
  for (const p of [
    'fix this',
    'make it better',
    'improve this',
    'can you help me',
    'help me with this',
    "it doesn't work",
    'this is broken',
    'what should I do',
    'optimize it',
    // vague action verb + a curated GENERIC coding area (the what/how left open)
    'clean up the output',
    'improve the code',
    'improve the performance',
    'make the tests better',
  ]) {
    it(`fires on "${p}"`, () => expect(isUnderspecified(p)).toBe(true))
  }
})

describe('isUnderspecified — NEGATIVE: specific prompts never fire (precision guard)', () => {
  for (const p of [
    'How do I restart the SCNS broker on port 3456 without disturbing team mode?',
    'Explain the semantic edge tier in src/memory/semantic-edges.ts',
    'Add a returnBudget option to adaptiveTraversalSearch so Stage-4 sees all visited nodes',
    'What is the default embedding dimension used by BGE-small?',
    // vague verb but a concrete value/anchor pins it down ⇒ NOT under-determined
    'change the port to 4000',
    'update package.json to version 2',
    'fix the bug in src/memory/db.ts',
    // NAMED/proper subjects — a vague verb but the target is specific (independent-grader controls)
    'update the README',
    'fix OAuth callback handling',
    'optimize SQL query plan',
    'refactor the UserService class',
  ]) {
    it(`does NOT fire on "${p.slice(0, 40)}…"`, () => expect(isUnderspecified(p)).toBe(false))
  }
})

describe('isClearlySpecific — protects the neg control (clear ⇒ never ask)', () => {
  it('POSITIVE: a file path / code anchor is clearly specific', () => {
    expect(isClearlySpecific('Refactor src/memory/arm-router.ts to export cosine')).toBe(true)
    expect(isClearlySpecific('Why does chunk_embeddings accumulate orphans in db.ts?')).toBe(true)
  })
  it('POSITIVE: a numeric anchor makes a long technical sentence clearly specific', () => {
    // Renamed 2026-07-30: this used to be titled "a long detailed technical sentence", but the length
    // branch is gone — it now passes solely on the `0.25`/`4.0` numeric anchors, so the name must say so.
    expect(
      isClearlySpecific(
        'Wire the edge reinforcement writer so applyExperienceReinforcement runs on every settled experience row and bounds the weight update between 0.25 and 4.0',
      ),
    ).toBe(true)
  })
  it('NEGATIVE: a vague deictic ask is not clearly specific', () => {
    expect(isClearlySpecific('fix this')).toBe(false)
    expect(isClearlySpecific('make it better')).toBe(false)
  })

  // REGRESSION (2026-07-30) — length is NOT specificity. Measured read-only over the live store: of the
  // 275 human prompts the gate called `clearly-specific`, 264 carry a real anchor and 11 got there ONLY
  // via the >=14-word branch. Because `clearly-specific` short-circuits BEFORE the OOS/novelty check in
  // `shouldElicit`, those 11 could never elicit however novel they were. The two prompts below are
  // VERBATIM `query_text` of live rows 1085 and 1019 — both anchor-less, both genuinely ambiguous.
  // NOTE ON MAGNITUDE: on its own this change unblocks exactly ONE extra ask across the corpus (row
  // 1495); the recalibrated OOS threshold is what drives the rate. Kept because length is not evidence.
  it('NEGATIVE (regression): a long prompt with NO concrete anchor is not clearly specific', () => {
    expect(
      isClearlySpecific("i'm confused -- are you saying there is or isn't a bug to address right now?"),
    ).toBe(false)
    expect(
      isClearlySpecific(
        'iis there a reason tot hit the live backlog at this point -- or do we nened to wait. do they all have implementation plans and details?',
      ),
    ).toBe(false)
  })

  it('POSITIVE (anchor survives): a long prompt WITH an anchor is still clearly specific', () => {
    // The negative control must not regress: a concrete anchor still pins the request down. This is the
    // VERBATIM text of live row 845 — it keeps its `clearly-specific` verdict via the `over-critical/
    // self-rejecting` slash token, which is the correct outcome and shows the fix is not indiscriminate.
    expect(
      isClearlySpecific(
        'to clariify -- the funnel that will allow it to self-improve is unblocked? I thought we fixed the grader that was over-critical/self-rejecting a while ago. is that a regression or is that something we just never flipped on',
      ),
    ).toBe(true)
  })
})

describe('shouldElicit — the combined decision (conservative, budget-bounded, fail-safe)', () => {
  it('POSITIVE (ambiguity): an underspecified prompt asks', () => {
    const d = shouldElicit({ prompt: 'fix this', maxPriorSimilarity: null })
    expect(d.ask).toBe(true)
    expect(d.confidence).toBeGreaterThan(0)
    expect(d.reason).toMatch(/underspecified|ambiguous/i)
  })

  it('POSITIVE (novelty/OOS): a moderate prompt with NO precedent (low similarity) asks', () => {
    const d = shouldElicit({
      prompt: 'set up the nightly reconciliation job for the ledger',
      maxPriorSimilarity: 0.12,
    })
    expect(d.ask).toBe(true)
    expect(d.reason).toMatch(/oos|novel/i)
  })

  it('NEGATIVE (neg control): a clearly-specific prompt never asks — even when OOS/novel', () => {
    const d = shouldElicit({
      prompt: 'Explain the semantic edge tier in src/memory/semantic-edges.ts',
      maxPriorSimilarity: 0.05, // very novel, but the prompt is clear
    })
    expect(d.ask).toBe(false)
    expect(d.confidence).toBe(0)
  })

  it('NEGATIVE (warm + clear): high prior similarity (precedent) does not ask', () => {    const d = shouldElicit({
      prompt: 'set up the nightly reconciliation job for the ledger',
      maxPriorSimilarity: 0.92,
    })
    expect(d.ask).toBe(false)
  })

  it('NEGATIVE (cold-start caveat): unknown similarity + a well-formed prompt does not ask on novelty alone', () => {
    // maxPriorSimilarity null (no priors) must NOT be treated as "maximally novel" (Settles cold-start caveat)
    const d = shouldElicit({
      prompt: 'set up the nightly reconciliation job for the ledger',
      maxPriorSimilarity: null,
    })
    expect(d.ask).toBe(false)
  })

  it('NEGATIVE (greeting): a whole-turn ack never asks', () => {
    expect(shouldElicit({ prompt: 'thanks' }).ask).toBe(false)
    expect(shouldElicit({ prompt: 'ok great' }).ask).toBe(false)
  })

  it('NEGATIVE (too short): a trivial one-word command never asks', () => {
    expect(shouldElicit({ prompt: 'go' }).ask).toBe(false)
    expect(shouldElicit({ prompt: 'plan' }).ask).toBe(false)
  })

  it('NEGATIVE (budget): once the per-session ask budget is spent, it stops asking (anti-nag)', () => {
    const spent = shouldElicit(
      { prompt: 'fix this', sessionAskCount: 2 },
      { maxAsksPerSession: 2 },
    )
    expect(spent.ask).toBe(false)
    expect(spent.reason).toMatch(/budget/i)
    // one below budget still asks
    expect(shouldElicit({ prompt: 'fix this', sessionAskCount: 1 }, { maxAsksPerSession: 2 }).ask).toBe(
      true,
    )
  })

  it('confidence is 0 whenever ask is false, and in [0,1]', () => {    for (const d of [
      shouldElicit({ prompt: 'thanks' }),
      shouldElicit({ prompt: 'fix this' }),
      shouldElicit({ prompt: 'set up the nightly ledger job', maxPriorSimilarity: 0.1 }),
    ]) {
      expect(d.confidence).toBeGreaterThanOrEqual(0)
      expect(d.confidence).toBeLessThanOrEqual(1)
      if (!d.ask) expect(d.confidence).toBe(0)
    }
  })
})

// ── Calibration (2026-07-30) — the OOS threshold must be REACHABLE on real traffic ────────────────
// Measured read-only over `~/.scns/memory/experience.db` across the 259 human-authored rows that
// carry a recorded `gate_max_sim`: min=0.612, p5=0.700, p50=0.990. The shipped default was 0.5 —
// BELOW the entire observed distribution, so the novelty branch could never fire (0 rows under 0.5).
// `intent-prior-art.md:511` warns exactly this: the threshold "needs its own positive/negative control".
// 0.70 is the 5th percentile ⇒ ~4.2% of human prompts (11/259), further bounded by the 2/session budget.
describe('OOS threshold calibration — reachable on the live similarity distribution', () => {
  it('POSITIVE: a long anchor-less prompt below the calibrated threshold now asks (was unreachable)', () => {
    const d = shouldElicit({
      prompt:
        'to clarify -- the funnel that will allow it to self-improve is unblocked? I thought we fixed the grader that was blocking it',
      maxPriorSimilarity: 0.65, // inside the real observed range (min 0.612) — the OLD 0.5 could not fire
    })
    expect(d.ask).toBe(true)
    expect(d.reason).toMatch(/oos|novel/i)
  })

  it('NEGATIVE: a well-precedented prompt (p50 of live traffic) still does not ask', () => {
    const d = shouldElicit({
      prompt:
        'to clarify -- the funnel that will allow it to self-improve is unblocked? I thought we fixed the grader that was blocking it',
      maxPriorSimilarity: 0.99, // the live median — must stay a confident serve
    })
    expect(d.ask).toBe(false)
    expect(d.reason).toMatch(/confident-serve/)
  })

  it('NEGATIVE (neg control holds): an ANCHORED prompt never asks even below the threshold', () => {
    const d = shouldElicit({
      prompt: 'Explain the semantic edge tier in src/memory/semantic-edges.ts and why it regressed',
      maxPriorSimilarity: 0.05,
    })
    expect(d.ask).toBe(false)
    expect(d.confidence).toBe(0)
  })

  it('the default threshold sits at the measured p5 (0.70), not the unreachable 0.5', () => {
    const prompt =
      'so we are good -- bugs fixed and on the right track for intent resolution and measuring'
    // 0.69 is below p5 ⇒ ask; 0.71 is above ⇒ serve. Pins the calibrated boundary.
    expect(shouldElicit({ prompt, maxPriorSimilarity: 0.69 }).ask).toBe(true)
    expect(shouldElicit({ prompt, maxPriorSimilarity: 0.71 }).ask).toBe(false)
  })
})

// ── Authorship guard — never elicit from a prompt no human authored (2026-07-31) ──────────────────
// Independent review of the `isClearlySpecific` length-branch removal (14fa563): that branch used to
// be an INCIDENTAL shield for long machine briefs. With it gone, a long anchor-less agent brief below
// the OOS threshold reaches the novelty branch and asks — spawning an ACP question worker and burning
// the per-session budget on a row no human will ever answer. Measured live exposure was 0 only because
// every observed machine brief happened to carry a digit/path/quote; the negative control rested on
// happenstance, not on a guard. The trigger is the right home: `recordGateDecision` telemetry still
// runs (so the machine funnel stays OBSERVED, which is what proves the negative control), and no
// caller can forget the guard. Reuses the existing `classifyPromptAuthorship` negative filter.
describe('shouldElicit — authorship guard (no human present ⇒ never ask)', () => {
  const NOVEL = 0.65 // inside the real observed range, below the 0.70 threshold ⇒ would otherwise ask

  it('POSITIVE (guard fires): a long anchor-less agent role preamble never asks', () => {
    const d = shouldElicit({
      prompt:
        'You are the editor of a DAILY developer-news briefing, and you must not repeat yourself',
      maxPriorSimilarity: NOVEL,
    })
    expect(d.ask).toBe(false)
    expect(d.confidence).toBe(0)
    expect(d.reason).toBe('machine-authored')
  })

  it('POSITIVE (guard fires): a runtime-injected system block never asks', () => {
    const d = shouldElicit({
      prompt: '<system_reminder> the assistant should consider whether more memory is warranted',
      maxPriorSimilarity: NOVEL,
    })
    expect(d.ask).toBe(false)
    expect(d.reason).toBe('machine-authored')
  })

  it('POSITIVE (guard is not anchor-dependent): the same brief WITH an anchor still never asks', () => {
    const d = shouldElicit({
      prompt: 'You are the editor of 1 DAILY briefing and you must not repeat yourself',
      maxPriorSimilarity: NOVEL,
    })
    expect(d.ask).toBe(false)
    expect(d.reason).toBe('machine-authored')
  })

  it('NEGATIVE CONTROL: a human prompt of the same shape below threshold STILL asks', () => {
    const d = shouldElicit({
      prompt:
        'could we make the editor of the daily developer news briefing stop repeating itself please',
      maxPriorSimilarity: NOVEL,
    })
    expect(d.ask).toBe(true)
    expect(d.reason).toMatch(/oos|novel/i)
  })

  it('NEGATIVE CONTROL: the guard does not swallow a human underspecified ask', () => {
    const d = shouldElicit({ prompt: 'fix this', maxPriorSimilarity: 0.99 })
    expect(d.ask).toBe(true)
    expect(d.reason).toBe('underspecified')
  })
})
