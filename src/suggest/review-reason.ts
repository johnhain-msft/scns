/**
 * THE HUMAN'S REASON — a learnable encoding of *why* John accepted or rejected a proposal.
 *
 * ## Why this exists
 *
 * The verdict channel was already complete before this file: `reviewReason` has lived in
 * {@link ../suggest/types.ts} since Phase 13, `suggestion-store.updateStatus(id, status, reason)`
 * writes it, `suggestion-file` persists it, and `outcome-writer.ts` already forwards it into
 * `proposal_outcomes` as `rationale` and settles the entity's `human_outcome`. The pipe was laid.
 *
 * What was missing is that **nothing ever asked the human**. Measured 2026-07-28 across all 138
 * on-disk suggestions in every status, exactly twelve reasons existed and every single one was
 * machine-written by the quality gate:
 *
 *     7  qg-fail:tests-failed      3  qg-fail:no-diff
 *     1  qg-pass                   1  RunCommand skipped at autonomy level 2
 *
 * Zero human reasons, ever — while 30 rejections sat on disk with no recorded *why*. That absent
 * "why" is the actual training signal, and this module is the schema for capturing it.
 *
 * ## Design, and the papers it comes from
 *
 * - **Hybrid feedback (Monarch, *Human-in-the-Loop Machine Learning*, 2021).** A fixed taxonomy
 *   code AND a free-text field, not one or the other. The code is a tabular feature that a model
 *   can learn from while N is tiny (SCNS has ~74 terminal proposals); the free text is the richer
 *   supervision that becomes usable at larger N. Capturing only free text would leave nothing
 *   learnable today; capturing only a code would throw away the reasoning John actually gives.
 * - **ILF — learning from language feedback (Scheurer et al. 2023, arXiv:2303.16755).** The unit of
 *   supervision is the triple `(original rationale, human feedback, revised rationale)`. This module
 *   captures the middle term; {@link formatReviewReason} keeps it recoverable so a later refinement
 *   step can form the triple.
 * - **KTO (Ethayarajh et al. 2024, arXiv:2402.01306) FM-3.** Do not train on reason-free, imbalanced
 *   history. Hence the deliberate refusal below to record a verdict that carries no reason: a bare
 *   "no" adds an unexplained rejection to a corpus that already has twenty of them.
 *
 * ## The abstain discipline
 *
 * This parser mirrors `followup-satisfaction.parseFollowupVerdict`: cues are ANCHORED, an ambiguous
 * reply returns `null` rather than a guessed verdict, and a taxonomy code is NEVER inferred from
 * prose. Fabricating structure the human did not supply would poison the very corpus this exists to
 * build, so every uncertain path abstains.
 */

/**
 * A verdict the human can render on a proposal.
 *
 * `defer` and `explain` are NON-DECISIONS and must never be banked as one. `explain` exists
 * because the first live review produced five of them: John answered every proposal with a
 * question ("what *is* a file-management extension?"), which is neither approval nor rejection.
 * Forcing that into `reject` would have taught the learner the IDEA was bad when in fact the
 * PROPOSAL TEXT was bad — the opposite lesson.
 */
export type ReviewVerdict = 'approve' | 'reject' | 'defer' | 'explain'

/** Non-decisions: they change no status and never reach the learner as an outcome. */
export const NON_DECISION_VERDICTS: readonly ReviewVerdict[] = ['defer', 'explain']

export function isDecision(verdict: ReviewVerdict): boolean {
  return !NON_DECISION_VERDICTS.includes(verdict)
}

/**
 * Did the human ANSWER without deciding? (FR-071b, issue #31)
 *
 * The complement of {@link isDecision} over the three states a `reviewVerdict` field can hold, and
 * it exists because those three states are NOT two:
 *
 *   `undefined`            — he has never answered. Absence.
 *   `defer` / `explain`    — he answered, and decided nothing. A QUESTION.
 *   `approve` / `reject`   — he decided. The only state that resolves anything.
 *
 * Readers that collapse the middle case into either neighbour get it wrong in opposite directions:
 * treating a question as a decision silently closes the item (the disappearance issue #31 records),
 * while treating it as absence would discard the fact that he engaged with it at all.
 *
 * Exported rather than re-derived at each call site on purpose. `matchesCensusSignature` and the
 * backfill filter both needed this reading and each had spelled it inline and differently — the
 * "duplicated, so readers drift and disagree about the same file" failure `escalation.ts` was
 * written to eliminate, occurring about the same field this constant already defines.
 */
export function isNonDecision(verdict: ReviewVerdict | undefined): boolean {
  return verdict !== undefined && !isDecision(verdict)
}

/**
 * Why a proposal was REJECTED. Each code names a distinct, actionable failure so a refinement step
 * can do something different in response — a taxonomy of interchangeable synonyms would be useless.
 */
export const REJECT_REASON_CODES = {
  /** Right idea, wrong time — revisit later rather than discard. */
  premature: 'Right idea, wrong time',
  /** The capability already exists somewhere else (the redundant-lane failure). */
  'already-exists': 'We already have this capability elsewhere',
  /** Misidentified what actually needs work. */
  'wrong-target': "Aimed at the wrong thing — that's not the problem",
  /** Not worth doing at any point. */
  'not-valuable': "Not worth doing — this won't ever pay off",
  /** The case is not made; the evidence is too thin to act on. */
  'insufficient-evidence': "The case isn't made — not enough evidence",
  /** Right direction, wrong size or shape. */
  'mis-scoped': 'Right direction, wrong scope or shape',
  /** Unacceptable blast radius / safety risk. */
  risky: 'Too risky — unacceptable blast radius',
  /** The proposal itself could not be understood. */
  unclear: "I couldn't tell what this actually proposes",
} as const

/**
 * Why a proposal was APPROVED. Approvals carry a reason too, deliberately: Mosier & Skitka (1996,
 * 1999) show that requiring a brief justification is what suppresses automation bias, and an
 * approval corpus with no stated reason cannot distinguish genuine agreement from rubber-stamping —
 * which is precisely what the readiness check must be able to detect.
 */
export const APPROVE_REASON_CODES = {
  /** Clears something the human is actually blocked on. */
  unblocks: 'Unblocks work I actually care about',
  /** Cheap relative to its payoff. */
  'cheap-win': 'Cheap enough for the payoff',
  /** The stated reasoning is sound on its merits. */
  'sound-reasoning': "The reasoning holds up — I agree with the case made",
  /** Addresses a known, previously-named problem. */
  'known-problem': 'Fixes a problem I already knew about',
} as const

export type RejectReasonCode = keyof typeof REJECT_REASON_CODES
export type ApproveReasonCode = keyof typeof APPROVE_REASON_CODES

/**
 * Why a proposal could not be judged at all. This is signal about the PROPOSAL, not the idea:
 * it says the case was never made well enough to rule on.
 */
export const EXPLAIN_REASON_CODES = {
  'needs-explanation': "I can't evaluate this — say what it actually is and what it would do",
} as const

export type ExplainReasonCode = keyof typeof EXPLAIN_REASON_CODES
export type ReasonCode = RejectReasonCode | ApproveReasonCode | ExplainReasonCode

/** The code menu that applies to a verdict. `defer` teaches nothing, so it has no codes. */
export function reasonCodesFor(verdict: ReviewVerdict): Readonly<Record<string, string>> {
  if (verdict === 'reject') return REJECT_REASON_CODES
  if (verdict === 'approve') return APPROVE_REASON_CODES
  if (verdict === 'explain') return EXPLAIN_REASON_CODES
  return {}
}

/** A code is only valid for the verdict whose menu contains it. */
export function codeIsValidFor(verdict: ReviewVerdict, code: string): code is ReasonCode {
  return Object.prototype.hasOwnProperty.call(reasonCodesFor(verdict), code)
}

const VERDICTS_WITH_REASON_CODES: readonly ReviewVerdict[] = ['approve', 'reject', 'explain']

function isReasonCode(code: string): code is ReasonCode {
  return VERDICTS_WITH_REASON_CODES.some((verdict) => codeIsValidFor(verdict, code))
}

export interface ReviewReply {
  readonly verdict: ReviewVerdict
  /** The taxonomy code, or null when the human did not pick one. NEVER inferred from prose. */
  readonly code: ReasonCode | null
  /** The human's own words, verbatim — the primary signal. Typos and all. */
  readonly text: string
}

/**
 * Below this many characters a free-prose reply carries no reason worth recording. Matched to
 * `followup-satisfaction.DEFAULT_MIN_CHARS` so the two human-signal readers agree on what "too
 * little to be signal" means.
 */
export const MIN_REASON_CHARS = 12

/** Verdict cues, matched ONLY at the very start of the reply (see {@link parseReviewReply}). */
const VERDICT_CUES: ReadonlyArray<readonly [RegExp, ReviewVerdict]> = [
  [/^(?:yes|yep|yeah|yup|sure|ok|okay|approve[d]?|agreed?|do it|ship it|lgtm)\b/i, 'approve'],
  [/^(?:no|nope|nah|reject(?:ed)?|disagree|drop it|kill it)\b/i, 'reject'],
  [/^(?:skip|defer|later|not now|hold|pass|park it)\b/i, 'defer'],
  [
    /^(?:explain|what is (?:this|it)|what'?s this|unclear|i don'?t (?:understand|know what)|no context|clarify)\b/i,
    'explain',
  ],
]

/** Strip a leading cue and any connective punctuation, leaving the human's actual reason. */
function stripCue(raw: string, cue: RegExp): string {
  return raw.replace(cue, '').replace(/^[\s,:;.\u2014-]+/, '').trim()
}

/**
 * Parse a review reply into a verdict + optional code + the human's own words.
 *
 * Two accepted shapes:
 *
 * 1. **Structured** — the form our own menu-driven CLI emits:
 *    ```
 *    verdict: reject
 *    code: already-exists
 *    why: the team-reaper already does this
 *    ```
 * 2. **Natural prose** — `"no -- we already have thsi in src/brain, its redundannt"`.
 *
 * Returns `null` (ABSTAIN) rather than guessing whenever the reply is ambiguous, and — importantly —
 * **also when a verdict is given with no reason at all**. Recording a bare "no" would add yet another
 * unexplained rejection to a corpus whose defining problem is twenty unexplained rejections, so the
 * caller is expected to treat `null` as "ask again", not as an error.
 *
 * The two shapes apply different substance floors, deliberately. The structured form's `why:` field
 * was explicitly presented and typed into, so any non-empty answer is a deliberate act and is kept.
 * Free prose has no such guarantee, so it must clear {@link MIN_REASON_CHARS} before it counts as a
 * reason — this is what stops a conversational "no" from being banked as explained judgment.
 */
export function parseReviewReply(raw: string): ReviewReply | null {
  const input = raw?.trim() ?? ''
  if (input === '') return null

  // ── Shape 1: structured. Line-anchored, exactly like `parseFollowupVerdict`, so a stray
  // "verdict:" inside quoted prose can never be read as the human's answer.
  const verdictLine = /^[\s>*`-]*verdict\s*[:=][\s"'`*]*(approve|reject|defer|explain)\b/im.exec(input)
  if (verdictLine) {
    const verdict = verdictLine[1]!.toLowerCase() as ReviewVerdict
    const codeLine = /^[\s>*`-]*code\s*[:=][\s"'`*]*([a-z-]+)/im.exec(input)
    const rawCode = codeLine?.[1]?.toLowerCase() ?? ''
    // An unknown code, or one borrowed from the other verdict's menu, is DROPPED — but the free
    // text is always kept. A mistyped code must never cost us the reasoning.
    const code = codeIsValidFor(verdict, rawCode) ? rawCode : null
    const whyLine = /^[\s>*`-]*(?:why|reason|because)\s*[:=]([\s\S]*)$/im.exec(input)
    const text = whyLine?.[1]?.trim() ?? ''
    if (!isDecision(verdict)) return { verdict, code, text }
    if (text === '') return null
    return { verdict, code, text }
  }

  // ── Shape 2: natural prose. The cue MUST open the reply. This anchoring is what keeps
  // "i would rather not reject this outright" and "it will approve things automatically" from
  // being read as verdicts — the decisive negative controls for this parser.
  for (const [cue, verdict] of VERDICT_CUES) {
    if (!cue.test(input)) continue
    const text = stripCue(input, cue)
    if (!isDecision(verdict)) return { verdict, code: null, text }
    // A verdict with no substantive reason is exactly what we refuse to bank.
    if (text.length < MIN_REASON_CHARS) return null
    // NEVER infer a code from prose — the human picks it or it stays null.
    return { verdict, code: null, text }
  }

  return null
}

/**
 * Does this reply carry a reason worth recording?
 *
 * The single definition of "substantive", shared by {@link parseReviewReply} and the weekly review,
 * so the two surfaces can never disagree about what counts as an explanation. An explicitly-picked
 * taxonomy code is a deliberate act and stands on its own; free prose must clear
 * {@link MIN_REASON_CHARS}.
 */
export function hasSubstance(reply: Pick<ReviewReply, 'code' | 'text'>): boolean {
  if (reply.code !== null && reply.code !== undefined && String(reply.code).trim() !== '') return true
  return (reply.text?.trim().length ?? 0) >= MIN_REASON_CHARS
}

/**
 * Encode a reply into the EXISTING `reviewReason` string field.
 *
 * The `human:` prefix is load-bearing, not decoration. Every reason currently on disk was written by
 * the quality gate (`qg-fail:tests-failed`, `qg-pass`, …), and `outcome-writer.ts` forwards this same
 * field into `proposal_outcomes.rationale` for the learner to consume. Without a discriminator the
 * learner would train on the quality gate's opinions as if they were John's judgment, so a machine
 * reason and a human reason must stay mechanically separable — the same requirement that keeps
 * `followup:` labels distinguishable from `transcript-oracle:` ones in `query-chain.ts`.
 */
export function formatReviewReason(reply: Pick<ReviewReply, 'verdict' | 'code' | 'text'>): string {
  const code = reply.code !== null && codeIsValidFor(reply.verdict, reply.code) ? reply.code : null
  return `human:${code ?? 'none'}: ${reply.text}`.trim()
}

/**
 * Tag a reason typed at the CLI (`scns review approve|reject --reason "..."`) as the human's own.
 *
 * `--reason` arrives as bare prose, so before this it was byte-identical to a quality-gate string
 * and `isHumanReason` said false about it. Two consequences, both bad: the words were filed as a
 * machine reason and overwritten by the auto-execute transition, and the learner could not tell
 * John's judgement from the gate's. Only a human runs this command, so the origin is known here and
 * nowhere later — tag it at the boundary.
 *
 * Idempotent: an already-tagged reason is returned unchanged, so a caller that has already gone
 * through {@link formatReviewReason} (the weekly session) is not double-prefixed.
 */
export function tagHumanReason(
  verdict: Extract<ReviewVerdict, 'approve' | 'reject'>,
  raw: string | undefined,
): string | undefined {
  if (raw == null) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined

  if (isHumanReason(trimmed)) {
    const parsed = parseReviewReason(trimmed)!
    return formatReviewReason({
      verdict,
      code: parsed.code,
      text: parsed.text,
    })
  }

  // A leading known code is honoured ("wrong-target: it targets the wrong file"); otherwise the
  // prose stands alone under `none`. A code is NEVER inferred from prose — that would put words in
  // his mouth and then train on them.
  const leading = /^([a-z]+(?:-[a-z]+)*)(?=$|[\s:;,.\u2014-])/i.exec(trimmed)
  const candidate = leading?.[1]?.toLowerCase() ?? ''
  const code = codeIsValidFor(verdict, candidate) ? candidate : null
  const text =
    code === null
      ? trimmed
      : trimmed
          .slice(code.length)
          .replace(/^[\s:;,.\u2014-]+/, '')
          .trim()
  return formatReviewReason({ verdict, code, text })
}

/** Recover a human reason. Returns null for machine-written reasons, which is the point. */
export function parseReviewReason(stored: string): { code: ReasonCode | null; text: string } | null {
  const m = /^human:([a-z-]+):([\s\S]*)$/i.exec(stored?.trim() ?? '')
  if (!m) return null
  const rawCode = m[1]!.toLowerCase()
  const text = m[2]!.trim()
  return { code: isReasonCode(rawCode) ? rawCode : null, text }
}

/** Did a HUMAN author this stored `reviewReason` (vs. the quality gate)? Provenance only. */
export function isHumanReason(stored: string | undefined | null): boolean {
  return stored != null && parseReviewReason(stored) !== null
}

/**
 * Does this stored reason carry the human's actual REASONING — words, not just a verdict code?
 *
 * Deliberately distinct from {@link isHumanReason}, which answers provenance. The regex group that
 * holds the prose is `([\s\S]*)`, which matches empty, so `human:cheap-win:` — an approve code with
 * nothing after it — parses successfully with `text: ''`. Live artefact `65a914f4` is exactly that.
 *
 * Both answers about that string are needed, and they differ:
 *
 *   provenance — YES, John authored it. `qg-mislabel-census` must keep counting it as evidence he
 *                approved, and `suggestion-store` must keep protecting it from machine overwrite.
 *   rationale  — NO, there is nothing to learn from. The learner corpus and the backfill pool must
 *                treat it as unexplained, or it is never asked about again.
 *
 * Conflating them is why `65a914f4` counted as explained and dropped out of the one pool whose job
 * is to find unexplained decisions.
 */
export function hasHumanRationale(stored: string | undefined | null): boolean {
  if (stored == null) return false
  const parsed = parseReviewReason(stored)
  return parsed !== null && parsed.text !== ''
}

/**
 * Map a bare interactive answer to a verdict, or null when it is not recognisable.
 *
 * Returning null matters: the interactive loop previously treated ANY non-approve word as a
 * rejection, so "explain" — the honest "I cannot judge this" — was banked as a reject and taught
 * the learner the idea was bad. An unrecognised answer must record nothing at all.
 */
export function verdictFromInput(raw: string): ReviewVerdict | null {
  const t = raw.trim().toLowerCase()
  if (t === '') return null
  if (/^(?:a|y|approve|yes|ok|accept)\b/.test(t)) return 'approve'
  if (/^(?:r|n|reject|no|decline)\b/.test(t)) return 'reject'
  if (t.startsWith('?')) return 'explain'
  if (/^(?:e|explain|what|unclear|huh|clarify|idk|i don'?t)\b/.test(t)) return 'explain'
  if (/^(?:d|defer|later|skip)\b/.test(t)) return 'defer'
  return null
}
