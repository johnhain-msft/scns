/**
 * Redundancy-flag scanner — the DETERMINISTIC pre-filter of the anti-redundant-
 * build hook (Track 1). Mirrors `claim-evidence-verifier.ts`: a cheap, pure,
 * NON-RECURSIVE pass that flags a suspect completion; the expensive judgement is
 * deferred to the single-shot model backend (`redundancy-verifier-backend.ts`),
 * exactly as the claim-evidence core defers to the claim-verifier spawn.
 *
 * Why this exists: the §4 anti-redundant-build guard was passive prose that
 * "didn't bind" — commit 647a985 shipped a parallel classifier that duplicated
 * `assignRole` and only human attention caught it. This scanner BINDS the guard:
 * it reads the agent's OWN output explanation for redundancy signal phrases
 * (the previous session's output literally articulated the concern, so the
 * signal is detectable) and, ONLY IF a flag trips AND no addressing explanation
 * is present, escalates for an explanation.
 *
 * NON-RECURSION (load-bearing): this is a single deterministic pass with a hard
 * flag cap and NO self-invocation. It scans the AGENT's output only — never the
 * verifier's output — so it can never feed itself and balloon.
 */

/** A matched redundancy signal + a short surrounding excerpt for the finding. */
export interface RedundancyFlag {
  readonly phrase: string
  readonly excerpt: string
}

export type RedundancyVerdictKind = 'pass' | 'needs-explanation'

export interface RedundancyScanResult {
  /** Redundancy signal phrases found in the output (capped). */
  readonly flags: readonly RedundancyFlag[]
  /** Whether the output already contains an addressing explanation. */
  readonly addressed: boolean
  /** `pass` = no flags, or flags with a clear addressing explanation. */
  readonly verdict: RedundancyVerdictKind
  /** Human-readable findings (empty on pass). */
  readonly findings: readonly string[]
}

/** Hard cap so a pathological output can never blow the finding list up. */
const MAX_FLAGS = 10
const EXCERPT_RADIUS = 60

/**
 * Signals that the agent may have BUILT something that already exists. Kept
 * specific to build-redundancy vocabulary (not a generic "exists") to hold down
 * false positives — an innocuous mention of a feature existing should not trip.
 */
const REDUNDANCY_PATTERNS: readonly RegExp[] = [
  /\bduplicat(?:e|es|ed|ing|ion)\b/i,
  /\bre-?implement(?:s|ed|ing|ation)?\b/i,
  /\breinvent(?:s|ed|ing)?\b/i,
  /\bredundan(?:t|cy)\b/i,
  /\bparallel (?:implementation|version|lane|path|classifier)\b/i,
  /\balready (?:exists?|implemented|present|handled|covered|have (?:a|an|one))\b/i,
  /\bsimilar to (?:the )?existing\b/i,
  /\boverlaps? with (?:the )?existing\b/i,
  /\bsame (?:as|thing as) (?:the )?existing\b/i,
  /\bcopy of (?:the )?existing\b/i,
]

/**
 * Signals that the agent ADDRESSED the redundancy — reused instead of rebuilding,
 * justified genuine distinctness, or deleted the thing it replaced. Presence of
 * any clears the deterministic verdict (the model may still be consulted).
 */
const ADDRESSING_PATTERNS: readonly RegExp[] = [
  /\breus(?:e|es|ed|ing)\b/i,
  /\binstead of (?:duplicat|re-?implement|reinvent|rebuild|building)\w*/i,
  /\brather than (?:duplicat|re-?implement|reinvent|rebuild|building)\w*/i,
  /\bnot (?:a )?(?:duplicate|redundant|reimplementation)\b/i,
  /\b(?:distinct|differs?|different) from (?:the )?existing\b/i,
  /\b(?:deleted|removed|dropped|replaced) the (?:duplicate|redundant|old|dead|existing|previous)\b/i,
  /\bconsolidat(?:e|es|ed|ing|ion)\b/i,
  /\bsingle source of truth\b/i,
  /\b(?:extends?|extending|builds? on|building on) (?:the )?existing\b/i,
]

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS)
  const end = Math.min(text.length, index + length + EXCERPT_RADIUS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

/** Find redundancy signal phrases in the output (deduped by phrase, capped). */
export function scanRedundancyFlags(output: string): readonly RedundancyFlag[] {
  if (!output || output.trim().length === 0) return []
  const flags: RedundancyFlag[] = []
  const seen = new Set<string>()
  for (const re of REDUNDANCY_PATTERNS) {
    const m = re.exec(output)
    if (!m) continue
    const phrase = m[0].toLowerCase()
    if (seen.has(phrase)) continue
    seen.add(phrase)
    flags.push({ phrase, excerpt: excerptAround(output, m.index, m[0].length) })
    if (flags.length >= MAX_FLAGS) break
  }
  return flags
}

/** True when the output contains a phrase that addresses potential redundancy. */
export function hasAddressingExplanation(output: string): boolean {
  if (!output) return false
  return ADDRESSING_PATTERNS.some((re) => re.test(output))
}

/**
 * Deterministic redundancy verdict over an agent output explanation.
 *   - no flags                    → `pass` (no-op; the model is NOT consulted).
 *   - flags + addressing present  → `pass` (the agent explained it).
 *   - flags + no addressing       → `needs-explanation` (escalate to the model,
 *                                    or block if no model is wired).
 * Single pass, no recursion, no spawn.
 */
export function evaluateRedundancy(output: string): RedundancyScanResult {
  const flags = scanRedundancyFlags(output)
  if (flags.length === 0) {
    return { flags: [], addressed: false, verdict: 'pass', findings: [] }
  }
  const addressed = hasAddressingExplanation(output)
  if (addressed) {
    return { flags, addressed: true, verdict: 'pass', findings: [] }
  }
  const phrases = flags.map((f) => `"${f.phrase}"`).join(', ')
  return {
    flags,
    addressed: false,
    verdict: 'needs-explanation',
    findings: [
      `Redundancy signal(s) in the agent's output (${phrases}) with no addressing ` +
        `explanation. State what existing code was reused, or why the new code is ` +
        `genuinely distinct, in the final output.`,
    ],
  }
}
