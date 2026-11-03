/**
 * The FOLLOW-UP SATISFACTION READER (provider) — "what did the human's next turn say about the answer
 * we just served?".
 *
 * ## Why this exists
 * The chain classifier in `query-chain.ts` settles on three surface shapes: a high-similarity
 * reformulation, a `^no|^actually|^wait|i meant` correction, or a `^yes|^ok|^now|go ahead|lgtm`
 * affirmation. Everything else abstains under rule 4 ("a bare topic change is not evidence of value").
 *
 * Measured read-only on the live store 2026-07-28 over every delivery-eligible pair the CLI transcript
 * oracle can see (24 pairs across 871 rows): the deterministic rules classify **5**, abstain on **19** —
 * 20.8% coverage. The 19 are NOT bare topic changes. They are substantive engagement with the SAME
 * need, and they skew hard toward DISSATISFACTION, e.g.
 *
 *   prior: "SCNS scheduling: two distinct layers ..."
 *   next : "confirm that those tasks never actually run -- pretty sure they do"
 *
 * and one is a true affirmation defeated by a TYPO — `"okayu -- so we need to handoff ..."` misses
 * `/^(ok|okay)\b/` because `okay` is not followed by a word boundary. So the regexes do not merely
 * under-cover; they under-cover ASYMMETRICALLY, dropping most of the waste signal the reward learner
 * most needs. That is a broken instrument in a way that a low settle rate alone would not reveal.
 *
 * ## The mechanism (prior art, in the order it is applied)
 * 1. **Kim et al., LLM4Eval @ SIGIR 2024, arXiv:2407.13166** — "Using LLMs to Investigate Correlations
 *    of Conversational Follow-up Queries with User Satisfaction". An LLM classifies the follow-up TYPE
 *    against a verified taxonomy built from real sessions; *clarifying*, *excluding-condition* and
 *    *substituting-condition* follow-ups correlate with DISsatisfaction, acknowledgment patterns with
 *    satisfaction. {@link FOLLOWUP_PATTERNS} is that taxonomy, collapsed onto SCNS's existing
 *    {@link ImplicitCue}. Antecedent: Huang & Efthimiadis, CIKM 2009 (reformulation-type taxonomy);
 *    Hassan & White, CIKM 2013 (refinement ⇒ dissatisfaction vs. topic shift ⇒ task completion).
 * 2. **Chow, IEEE Trans. Inf. Theory 16(1) 1970** — the optimum error/reject tradeoff: abstain when
 *    `P(best class | x) < θ`. {@link CUE_CONFIDENCE_FLOOR} is that θ, and it is **class-conditional**
 *    because Chow's rule is derived from a COST MATRIX and ours is asymmetric (see below).
 *    Framework: El-Yaniv & Wiener, JMLR 11 (2010) — risk/coverage is a CURVE, so a low settle rate is
 *    a success exactly when precision on the settled subset is high; Geifman & El-Yaniv, NeurIPS 2017
 *    (arXiv:1705.08500) for using the model's own confidence as the selection function.
 * 3. **Ziegler et al. arXiv:2205.06537 · RealHumanEval arXiv:2404.02806 · SPACE (ACM Queue 19(1) 2021)**
 *    — acceptance is a BIASED proxy for value and must never be optimized naked. Already cited by
 *    `kto-learner.ts` for the LEARNING step; this module applies it to the LABELLING step.
 *
 * ## Why there is NO ACCEPT LABEL — the anti-manufacture property
 * Loosening abstention is exactly how this metric gets manufactured: widen the accept rule, settled
 * rows appear, "the learning loop is unblocked", and it is fake. An independent grader supplied the
 * decisive argument for closing that path STRUCTURALLY rather than thresholding it: this reader is
 * shown the user's two messages and NEVER the assistant answer between them, so "the user accepted
 * it" is an inference about text the reader cannot see, whereas "the user re-asked, corrected or
 * disputed" is evidence visible in the follow-up itself. The ungroundable inference and the strongest
 * incentive to inflate landed on the same label, so `used` was REMOVED: there is no positive cue to
 * emit and no floor left to tune. Chow's rule still governs the cues that remain.
 *
 * A consequence that must be stated plainly wherever these labels are consumed: this reader reports
 * DISSATISFACTION AND FRICTION ONLY. It is NOT a measure of how often SCNS succeeds and must never be
 * read as one. The bias is uniform across retrieval arms, so a between-arm comparison of waste stays
 * valid, while the headline "did the loop settle anything" cannot be inflated by relaxing a rule.
 *
 * ## The residual risk, stated rather than hidden
 * Continuity is judged by the classifier itself (`same_need`), so a classifier that answers `yes`
 * about a genuine topic change can still record FRICTION or WASTE that did not happen. That risk is
 * accepted deliberately: the only deterministic alternative measured -- shared-word overlap -- threw
 * away 13 of 19 real pairs because real follow-ups paraphrase and are heavily typo'd, which is a
 * worse instrument, not a safer one. The exposure is bounded by direction: a wrong label here can
 * only make SCNS look WORSE than it was, never better. Consumers must treat these labels as
 * model-derived (the `followup:` provenance and the stored confidence exist for exactly that) and
 * must not pool them with oracle-grade labels.
 *
 * ## Hard floors the model CANNOT override
 * {@link readFollowupSatisfaction} abstains — whatever the model returns, at any confidence — when the
 * next turn is machine-authored, too short, or classified as a bare topic change. Rule 4 of the
 * deterministic classifier is preserved verbatim as {@link FOLLOWUP_PATTERNS}'s `new-topic` ⇒ abstain.
 *
 * This module is PURE: taxonomy, prompt builder, response parser, the decision rule, the provider seam
 * and a CI-safe NULL provider. The real transport (a deny-all `copilot --acp` spawn) is
 * `followup-satisfaction-acp.ts`, mirroring `gate-question.ts` / `gate-question-acp.ts` exactly.
 */

import { classifyPromptAuthorship } from './prompt-authorship.js'
import type { ImplicitCue } from './human-outcome.js'

/**
 * The follow-up taxonomy (Kim et al. arXiv:2407.13166, collapsed onto SCNS's 3 cues + abstain).
 * Every pattern maps to exactly one cue, or to `null` meaning "this is not evidence about the answer".
 */
export const FOLLOWUP_PATTERNS = {
  /** Asks SCNS to re-explain or expand the SAME answer — the answer did not land. */
  clarify: 're-asked',
  /** "not that / without X" — rules out what was served and restates the need. */
  'exclude-condition': 're-asked',
  /** Swaps a constraint and re-poses the same underlying need. */
  'substitute-condition': 're-asked',
  /** Restates the same information need in different words. */
  'repeat-need': 're-asked',
  /** Disputes or disbelieves the answer's correctness ("pretty sure they do"). */
  dispute: 're-asked',
  /** Supplies a correction or a new constraint and directs the work onward. */
  'correct-and-continue': 'edited',
  /** Accepts the direction but reorders, narrows or re-scopes the work. */
  'redirect-scope': 'edited',
  /** Acknowledges the answer and moves to a genuinely DIFFERENT need. NEVER A LABEL — see below. */
  'acknowledge-advance': null,
  /** Restates the answer's conclusion as an accepted premise, then builds on it. NEVER A LABEL. */
  'accept-and-build': null,
  /** A bare topic change. RULE 4 — not evidence of value. Never a label. */
  'new-topic': null,
  /** The model could not tell. Never a label. */
  ambiguous: null,
} as const satisfies Record<string, ReadableCue | null>

export type FollowupPattern = keyof typeof FOLLOWUP_PATTERNS

/** Every taxonomy key, for prompt rendering and parser validation. */
export const FOLLOWUP_PATTERN_NAMES = Object.keys(FOLLOWUP_PATTERNS) as readonly FollowupPattern[]

/**
 * The cues this reader is permitted to emit. `used` (1.0) is DELIBERATELY ABSENT.
 *
 * An independent grader made the decisive argument: this reader is shown only the user's two
 * messages and NEVER the assistant answer between them, so "the user accepted the answer" is an
 * inference about text the reader cannot see, whereas "the user re-asked / corrected / disputed" is
 * evidence visible in the follow-up itself. Since `used` is also the label that would MANUFACTURE
 * this metric, an ungroundable inference and the strongest incentive to inflate coincided on the
 * same label — so the label is removed rather than thresholded. Empirically this costs nothing: over
 * all 19 real abstain-residue pairs, zero accepts cleared the old 0.85 floor anyway.
 *
 * Consequence, stated plainly: this reader can report DISSATISFACTION AND FRICTION ONLY. It is not a
 * measure of how often SCNS succeeds and must never be read as one. The bias is uniform across arms,
 * so a between-arm comparison of waste remains valid.
 */
export type ReadableCue = Exclude<ImplicitCue, 'used'>

/**
 * Chow's per-class reject thresholds over the cues that remain.
 */
export const CUE_CONFIDENCE_FLOOR: Record<ReadableCue, number> = {
  /** 0.8 — accepted with friction; the correction is visible in the follow-up text. */
  edited: 0.7,
  /** 0.2 — says SCNS served badly; the conservative direction. */
  're-asked': 0.6,
}

/** Below this many characters a follow-up carries too little signal to classify. */
export const DEFAULT_MIN_CHARS = 12

export interface FollowupClassificationRequest {
  /** The query the briefing answered. */
  readonly priorQuery: string
  /** The human's next turn, verbatim from the CLI transcript oracle. */
  readonly nextTurn: string
}

export interface FollowupVerdict {
  readonly pattern: FollowupPattern
  /** The model's confidence in `pattern`, in [0,1]. */
  readonly confidence: number
  /**
   * Does the second message pursue the SAME information need as the first? Asked as its own
   * question so the continuity judgement is made independently of the pattern choice — a classifier
   * that picks `dispute` for what is really a topic change must still answer `no` here. Anything but
   * an explicit `yes` abstains. This is the same-need check the independent grader asked for, done
   * with a model rather than lexical overlap because the real follow-ups paraphrase and are heavily
   * typo'd, which a shared-word rule cannot survive.
   */
  readonly sameNeed: 'yes' | 'no' | 'unclear'
}

/** The provider seam — one async call yielding a verdict, or null when it could not classify. */
export interface FollowupSatisfactionProvider {
  classify(req: FollowupClassificationRequest): Promise<FollowupVerdict | null>
}

export interface FollowupReading {
  readonly cue: ReadableCue
  readonly pattern: FollowupPattern
  readonly confidence: number
}

/**
 * Neutral system framing. Deliberately NOT phrased as "did this help?" — an LLM judge asked a leading
 * question agrees with the framing (sycophancy; Zheng et al. arXiv:2406.07791 and the LLM-as-a-judge
 * survey arXiv:2411.15594). The model is asked to name a conversational PATTERN, not to rate us.
 */
export const FOLLOWUP_SYSTEM_PROMPT =
  'You are a conversation analyst. You label the RELATIONSHIP between a question a user asked and the ' +
  'single message they sent next. You are not evaluating any assistant and you are not being asked ' +
  'whether anyone did a good job — you only name the discourse pattern that the second message stands ' +
  'in to the first. Report low confidence when the pattern is genuinely unclear.'

function describeTaxonomy(): string {
  // The two satisfaction patterns are still OFFERED to the classifier even though neither can ever
  // produce a label. Removing them from the menu would force genuinely-satisfied follow-ups into the
  // nearest remaining bucket — which are all dissatisfaction buckets — and would inflate the waste
  // signal. Keeping them gives those cases a correct place to land and abstain.
  return [
    'clarify              - asks for the SAME thing to be re-explained or expanded',
    'exclude-condition    - rules out what was given ("not that", "without X") and restates the need',
    'substitute-condition - swaps a constraint and re-poses the same underlying need',
    'repeat-need          - restates the same information need in different words',
    'dispute              - disputes or disbelieves what was said ("pretty sure they do")',
    'correct-and-continue - supplies a correction or new constraint and directs the work onward',
    'redirect-scope       - accepts the direction but reorders, narrows or re-scopes the work',
    'acknowledge-advance  - acknowledges, then moves to a genuinely DIFFERENT need',
    'accept-and-build     - treats the previous conclusion as settled and builds on it',
    'new-topic            - simply changes the subject, with no reference back',
    'ambiguous            - you cannot tell',
  ].join('\n')
}

/**
 * Build the classification prompt. The two messages are labelled FIRST/SECOND rather than
 * question/answer, and no assistant output is shown, so the model cannot infer a desired verdict.
 */
export function buildFollowupPrompt(req: FollowupClassificationRequest): string {
  return [
    'FIRST message (what the user asked):',
    `"""${req.priorQuery.trim()}"""`,
    '',
    'SECOND message (what the same user sent next):',
    `"""${req.nextTurn.trim()}"""`,
    '',
    'Choose exactly one pattern describing how SECOND relates to FIRST:',
    describeTaxonomy(),
    '',
    'Answer with exactly three lines and nothing else:',
    'same_need: <yes if SECOND pursues the same information need as FIRST, no if it moves to a '
      + 'different need, unclear if you cannot tell>',
    'pattern: <one name from the list above>',
    'confidence: <a number between 0 and 1>',
  ].join('\n')
}

/**
 * Parse the two-line response.
 *
 * HARDENED after an independent grader broke the first cut: the original took the FIRST `pattern:`
 * match anywhere in the text, so a model that reasoned *"this is NOT a case of pattern:
 * acknowledge-advance ... pattern: new-topic"* was read as a maximal-confidence ACCEPT. A negated
 * mention in the model's own prose became the verdict. The parser now requires the response to name
 * exactly ONE distinct pattern; any disagreement with itself is an abstain, because an ambiguous
 * answer is NOT evidence.
 */
export function parseFollowupVerdict(raw: string): FollowupVerdict | null {
  if (!raw) return null
  const text = raw.toLowerCase()
  const named = new Set<FollowupPattern>()
  for (const m of text.matchAll(/^[\s>*`-]*pattern\s*[:=][\s"'`*]*([a-z-]+)/gm)) {
    const name = m[1] as FollowupPattern
    if (FOLLOWUP_PATTERN_NAMES.includes(name)) named.add(name)
  }
  if (named.size !== 1) return null
  const name = [...named][0] as FollowupPattern
  const confMatches = [...text.matchAll(/^[\s>*`-]*confidence\s*[:=][\s"'`*]*([0-9]*\.?[0-9]+)/gm)]
  if (confMatches.length === 0) return null
  // The LAST stated confidence is the model's final answer; an earlier one may sit inside reasoning.
  const confidence = Number(confMatches[confMatches.length - 1]?.[1])
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
  // Anchored to line starts: the contract is three lines and nothing else, so a `same_need: yes`
  // buried mid-sentence in the model's prose is NOT the model's answer (grader's third-round break).
  const needMatches = [...text.matchAll(/^[\s>*`-]*same[_ -]?need\s*[:=][\s"'`*]*(yes|no|unclear)/gm)]
  const stated = needMatches[needMatches.length - 1]?.[1]
  // An omitted or self-contradicting continuity answer is NOT a yes.
  const sameNeed: FollowupVerdict['sameNeed'] =
    stated === 'yes' && new Set(needMatches.map((m) => m[1])).size === 1 ? 'yes' : 'unclear'
  return { pattern: name, confidence, sameNeed }
}

/**
 * Chow's reject rule over a taxonomy verdict: emit the cue only when the pattern carries one AND the
 * confidence clears that cue's class-conditional floor. Returns null (ABSTAIN) otherwise.
 */
export function decideCue(verdict: FollowupVerdict | null): FollowupReading | null {
  if (!verdict) return null
  // CONTINUITY FIRST: no label of any kind for a follow-up that left the original need.
  if (verdict.sameNeed !== 'yes') return null
  const cue = FOLLOWUP_PATTERNS[verdict.pattern]
  if (cue === null) return null
  if (!(verdict.confidence >= CUE_CONFIDENCE_FLOOR[cue])) return null
  return { cue, pattern: verdict.pattern, confidence: verdict.confidence }
}

export interface ReadFollowupOptions {
  readonly minChars?: number
}

/**
 * Read the accept/waste signal from one (prior query, next human turn) pair.
 *
 * The deterministic floors are applied BEFORE the model is ever consulted, and the model cannot
 * overturn them:
 *   - a machine-authored next turn is never the human's reaction (a sub-agent brief or an
 *     "agent has finished processing" notice landing in the prompt slot — the exact contamination
 *     `prompt-authorship.ts` exists to stop, which already produced two fabricated live ACCEPTs);
 *   - a next turn below `minChars` carries too little signal;
 *   - `new-topic`, `ambiguous` and BOTH satisfaction patterns map to no cue at ANY confidence, so
 *     rule 4 is guaranteed STRUCTURALLY: there is no positive label for a topic change to become.
 *
 * Fail-safe: a provider that throws yields ABSTAIN, never a label.
 */
export async function readFollowupSatisfaction(
  provider: FollowupSatisfactionProvider,
  req: FollowupClassificationRequest,
  opts: ReadFollowupOptions = {},
): Promise<FollowupReading | null> {
  const prior = req.priorQuery?.trim() ?? ''
  const next = req.nextTurn?.trim() ?? ''
  if (prior === '') return null
  if (next.length < (opts.minChars ?? DEFAULT_MIN_CHARS)) return null
  if (classifyPromptAuthorship(next).author === 'machine') return null
  try {
    return decideCue(await provider.classify({ priorQuery: prior, nextTurn: next }))
  } catch {
    return null
  }
}

/** CI-safe default: never spawns, never labels. The reader stays inert unless a real provider is wired. */
export const NULL_FOLLOWUP_PROVIDER: FollowupSatisfactionProvider = {
  async classify(): Promise<FollowupVerdict | null> {
    return null
  },
}
