/**
 * Track 1 / item 1B — claim-evidence verifier (deterministic core).
 *
 * The structural counterpart to the §3a anti-overclaim rule. Given an analysis
 * / report / completion output, it extracts RUNTIME-BEHAVIOR claims (signal
 * words: "runs live", "handled by", "never fired", "unwired", "vestigial",
 * "dead code", "disabled", "runs via", "run_count") and checks that EACH one
 * carries a claim-evidence label:
 *   - `live-confirmed` — must be backed by a quoted row (backtick/quote content;
 *     an exit code or HTTP status does NOT count as evidence, per §3a).
 *   - `code-only` / inferred — traced from source, not observed at runtime.
 *
 * Verdict:
 *   - `pass`            — no runtime claims, OR every claim is labeled and every
 *                         live-confirmed claim has a quoted row.
 *   - `fail`            — a runtime claim is asserted as fact with NO label
 *                         (the 2026-07-09 guard-rca overclaim). Blocks / downgrades.
 *   - `needs-evidence`  — claims are labeled but a live-confirmed one lacks a
 *                         quoted row (unverifiable as written).
 *
 * This deterministic core verifies that the discipline was FOLLOWED (label +
 * quoted evidence present per item). Deep, independent RE-RUNNING of a cited
 * probe by a fresh producer≠verifier agent is a separate injection seam
 * (see docs/backlog/scns-verifier-gate.md); this module never spawns.
 */

export type ClaimEvidenceLabel = 'live-confirmed' | 'code-only'
export type VerifierVerdictKind = 'pass' | 'fail' | 'needs-evidence'

export interface RuntimeClaim {
  /** The trimmed line containing the claim. */
  readonly text: string
  /** The first runtime signal word that matched (representative). */
  readonly signal: string
  /** All runtime signal words that matched on the line. */
  readonly signals: readonly string[]
  /** The evidence label detected on the line, or null if the claim is unlabeled. */
  readonly label: ClaimEvidenceLabel | null
  /** For live-confirmed claims: whether a substantive quoted row is present. */
  readonly hasQuotedEvidence: boolean
}

export interface VerifierVerdict {
  readonly kind: VerifierVerdictKind
  readonly claims: readonly RuntimeClaim[]
  readonly findings: readonly string[]
}

interface Signal {
  readonly re: RegExp
  readonly name: string
}

/**
 * Runtime-behavior / wiring signal words. Broadened beyond §3a's literal list
 * after a blind AI-drives-AI test (2026-07-11) showed a real agent expressing
 * the same mechanism claims with paraphrases ("not wired", "not active", "runs
 * through", "no production caller", "does not execute") that the literal list
 * missed. Semantic detection is the deferred LLM verifier's job; this is the
 * fast deterministic pre-filter.
 */
const SIGNALS: readonly Signal[] = [
  { re: /\bruns?\s+(live|via|through|inside)\b/i, name: 'runs live/via/through' },
  { re: /\bruns?\s+on\s+.{0,20}\bset(Interval|Timeout)\b/i, name: 'runs on setInterval' },
  { re: /\brun\s+through\b/i, name: 'run through' },
  { re: /\bhandled\s+by\b/i, name: 'handled by' },
  { re: /\bexecuted\s+by\b/i, name: 'executed by' },
  { re: /\bdispatched\s+by\b/i, name: 'dispatched by' },
  { re: /\b(?:un|not[-\s]?)wired\b/i, name: 'unwired/not wired' },
  { re: /\bwired\s+(to|up|into)\b/i, name: 'wired to/up' },
  { re: /\bnot\s+(active|started|invoked|running|executed|dispatched)\b/i, name: 'not active/started' },
  { re: /\bno\s+(production\s+|source\s+)?caller\b/i, name: 'no caller' },
  { re: /\bnever\s+(runs?|ran|executes?|executed|fires?|fired|called|invoked|started)\b/i, name: 'never runs/fires/called' },
  { re: /\bdoes\s+not\s+(run|execute|fire|dispatch)\b/i, name: 'does not run/execute' },
  { re: /\bdoesn'?t\s+(run|execute|fire|dispatch)\b/i, name: "doesn't run/execute" },
  { re: /\bnever\s+fired\b/i, name: 'never fired' },
  { re: /\bvestigial\b/i, name: 'vestigial' },
  { re: /\bdead\s+code\b/i, name: 'dead code' },
  { re: /\bis\s+dead\b/i, name: 'is dead' },
  { re: /\binert\b/i, name: 'inert' },
  { re: /\bno-?op\b/i, name: 'no-op' },
  { re: /\bcosmetic\b/i, name: 'cosmetic' },
  { re: /\bdisabled\b/i, name: 'disabled' },
  { re: /\brun_count\b/i, name: 'run_count' },
  { re: /\bnever\s+ran\b/i, name: 'never ran' },
]

/**
 * A document-level code-only disclaimer means the author globally framed the
 * analysis as source-derived (not live-run). When present, unlabeled runtime
 * claims default to `code-only` (honest) rather than counting as unlabeled
 * overclaims — the anti-overclaim target is asserting LIVE without evidence, and
 * a blanket "I did not run it" is the safe direction. The per-line label tokens
 * (`live-confirmed` / `code-only`) are deliberately NOT disclaimer phrases.
 */
const DOC_CODE_ONLY_DISCLAIMERS: readonly RegExp[] = [
  /broker\s+(was\s+)?not\s+run/i,
  /not\s+run\s+(live|at\s+runtime)/i,
  /not\s+a\s+live\s+\w+\s+run/i,
  /did\s+not\s+run\s+(it|the|live|broker)/i,
  /source[-\s]code\s+(investigation|analysis|read|review)/i,
  /static\s+(source\s+)?(analysis|investigation|read|trace)/i,
  /read-only\s+\w*\s*investigation/i,
  /\bcode-traced\b/i,
  /code-only\s*[/-]\s*inferred/i,
  /\ball\s+(claims|conclusions|findings)\b[\s\S]{0,40}\bcode-only\b/i,
  /traced\s+from\s+source/i,
  /from\s+(the\s+)?source\s+(wiring|code)/i,
  /without\s+(running|actually\s+running|a\s+live\s+run)/i,
  /evidence\s+level:\s*(source|code)/i,
  /source\s+search\s+(shows|finds|found)/i,
]

function detectDocLevelCodeOnly(text: string): boolean {
  return DOC_CODE_ONLY_DISCLAIMERS.some((re) => re.test(text))
}

function detectLabel(line: string): ClaimEvidenceLabel | null {
  if (/live-confirmed/i.test(line) || /\[live\]/i.test(line)) return 'live-confirmed'
  if (/code-only/i.test(line) || /\[code-only\]/i.test(line) || /\binferred\b/i.test(line)) {
    return 'code-only'
  }
  return null
}

/** An exit code or HTTP status is explicitly NOT evidence (§3a). */
function isNonEvidence(s: string): boolean {
  const t = s.trim()
  return (
    /^https?\s*\d+$/i.test(t) ||
    /^http[\s/].*\b\d{3}\b/i.test(t) ||
    /^\d{3}$/.test(t) ||
    /^exit(\s*code)?\s*\d+$/i.test(t)
  )
}

function hasQuotedEvidence(line: string): boolean {
  const backtick = line.match(/`([^`]+)`/g) ?? []
  const dquote = line.match(/"([^"]+)"/g) ?? []
  const candidates = [...backtick, ...dquote]
    .map((s) => s.replace(/[`"]/g, '').trim())
    .filter((s) => s.length > 0)
  return candidates.some((c) => !isNonEvidence(c))
}

function snippet(text: string, max = 120): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length <= max ? clean : clean.slice(0, max) + '…'
}

/**
 * Extract runtime-behavior claims from arbitrary text, one per line that
 * contains at least one signal word.
 */
export function extractRuntimeClaims(text: string): readonly RuntimeClaim[] {
  const claims: RuntimeClaim[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine
    const matched = SIGNALS.filter((s) => s.re.test(line))
    if (matched.length === 0) continue
    const first = matched[0]!
    claims.push({
      text: line.trim(),
      signal: first.name,
      signals: matched.map((m) => m.name),
      label: detectLabel(line),
      hasQuotedEvidence: hasQuotedEvidence(line),
    })
  }
  return claims
}

/**
 * Verify that every runtime-behavior claim in `text` carries a claim-evidence
 * label and (for live-confirmed) a quoted row. Pure — no spawn, no I/O.
 */
export function verifyClaimEvidence(text: string): VerifierVerdict {
  const claims = extractRuntimeClaims(text)
  if (claims.length === 0) {
    return { kind: 'pass', claims, findings: [] }
  }

  // A document-level "I did not run this live" disclaimer makes unlabeled claims
  // honest code-only claims (the safe, non-overclaiming direction) rather than
  // bare-fact overclaims. A per-line label still wins over the doc default.
  const docCodeOnly = detectDocLevelCodeOnly(text)
  const effectiveLabel = (c: RuntimeClaim): ClaimEvidenceLabel | null =>
    c.label ?? (docCodeOnly ? 'code-only' : null)

  const findings: string[] = []

  const unlabeled = claims.filter((c) => effectiveLabel(c) === null)
  for (const c of unlabeled) {
    findings.push(
      `Runtime claim asserted as fact without a live-confirmed/code-only label ` +
        `and no document-level code-only disclaimer: "${snippet(c.text)}"`,
    )
  }

  const liveNoEvidence = claims.filter(
    (c) => effectiveLabel(c) === 'live-confirmed' && !c.hasQuotedEvidence,
  )
  for (const c of liveNoEvidence) {
    findings.push(
      `live-confirmed claim lacks a quoted evidence row (an exit code / HTTP ` +
        `status is not evidence): "${snippet(c.text)}"`,
    )
  }

  let kind: VerifierVerdictKind = 'pass'
  if (unlabeled.length > 0) kind = 'fail'
  else if (liveNoEvidence.length > 0) kind = 'needs-evidence'

  return { kind, claims, findings }
}
