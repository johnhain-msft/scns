/**
 * Session-aware pruning evaluator (#73) — decide what is still applicable.
 *
 * ## The mechanism
 *
 * Adapted from two primary sources, taking the algorithm rather than the platform:
 *
 *   - **Mem0 §2.1** — extract candidates, compare them against the RELATED context, and emit a
 *     structured operation (`ADD`/`UPDATE`/`DELETE`/`NOOP`) rather than a similarity score. Here
 *     the candidates are existing SCNS records, the related context is the project work snapshot,
 *     and the operations are `keep` / `retire` / `revise` / `uncertain`.
 *   - **Zep/Graphiti §2.2.3** — a fact's VALIDITY is separate from its storage time, and it ends
 *     when a superseding fact begins. So a memory is retired because its applicability demonstrably
 *     ended, never because it is old, rarely retrieved, or unmentioned.
 *
 * ## Division of authority
 *
 * The semantic model may only PROPOSE. Deterministic code decides what stands:
 *
 *   1. pinned memories are kept, full stop;
 *   2. every destructive verdict must cite evidence that EXISTS in the snapshot;
 *   3. `unavailable` evidence yields `uncertain` for everything destructive;
 *   4. contrary evidence (live unresolved coordination on the memory's own session) blocks a
 *      `coordination-bound` retirement;
 *   5. a `revise` without replacement text is not a revision;
 *   6. an omitted, malformed or failed assessment is `uncertain` — never `keep` and never `retire`.
 *
 * `uncertain` is the honest non-destructive default. It is deliberately NOT `keep`: "we do not
 * know" is a different statement from "this still applies", and the preview reports it as such.
 */

import { logger } from '../shared/logger.js'
import { summarizeWorkContext, type WorkContextSnapshot } from './work-context.js'

const log = logger.child({ module: 'pruning-evaluator' })

export type PruningVerdict = 'keep' | 'retire' | 'revise' | 'uncertain'

/** How a memory's applicability is bounded. `unknown` is a real state, not a placeholder. */
export type Applicability =
  | 'durable'
  | 'project-requirement'
  | 'task-bound'
  | 'coordination-bound'
  | 'unknown'

const VERDICTS: ReadonlySet<string> = new Set(['keep', 'retire', 'revise', 'uncertain'])
const APPLICABILITIES: ReadonlySet<string> = new Set([
  'durable',
  'project-requirement',
  'task-bound',
  'coordination-bound',
  'unknown',
])

export interface PruningCandidate {
  readonly path: string
  readonly memoryId: string
  readonly rule: string
  readonly body: string
  readonly category: string
  readonly sessionId: string | null
  readonly createdAt: string
  readonly pinned: boolean
  readonly criticStatus: string | null
}

/** What a provider is allowed to say. Everything here is a PROPOSAL, not a decision. */
export interface ProviderProposal {
  readonly memoryId: string
  readonly verdict: PruningVerdict
  readonly applicability: Applicability
  readonly rationale: string
  readonly evidenceRefs: readonly string[]
  readonly contraryEvidence?: readonly string[]
  readonly revisedRule?: string
  readonly revisedBody?: string
}

export interface PruningDecision {
  readonly memoryId: string
  readonly path: string
  readonly verdict: PruningVerdict
  readonly applicability: Applicability
  readonly rationale: string
  readonly evidenceRefs: readonly string[]
  readonly contraryEvidence: readonly string[]
  readonly revisedRule?: string
  readonly revisedBody?: string
  /** `guard` = decided by deterministic policy; `provider` = the proposal stood. */
  readonly source: 'guard' | 'provider'
  /** The provider's original verdict when a guard changed it. */
  readonly proposedVerdict?: PruningVerdict
}

export interface PruningAssessmentRequest {
  readonly candidates: readonly PruningCandidate[]
  readonly snapshot: WorkContextSnapshot
}

export interface PruningProvider {
  assess(req: PruningAssessmentRequest): Promise<readonly ProviderProposal[]>
}

export interface EvaluatePruningOptions {
  readonly candidates: readonly PruningCandidate[]
  readonly snapshot: WorkContextSnapshot
  readonly provider?: PruningProvider
}

export interface PruningEvaluationResult {
  readonly decisions: readonly PruningDecision[]
  /** Destructive proposals a guard reduced to `uncertain`. */
  readonly downgraded: number
  /** True when the provider threw — reported so a caller never reads silence as agreement. */
  readonly evaluatorFailed: boolean
  readonly providerError: string | null
}

// ── Null provider ────────────────────────────────────────────────────────────

/**
 * Assesses nothing. With no evaluator wired up the honest answer is "unknown", so this returns
 * no proposals at all and every candidate lands on `uncertain`. It deliberately does NOT default
 * to `keep`: a preview that says "kept 40 memories" when nothing was assessed is a false report.
 */
export const NULL_PRUNING_PROVIDER: PruningProvider = {
  async assess(): Promise<readonly ProviderProposal[]> {
    return []
  },
}

const NULL_MARKER = Symbol.for('scns.pruningEvaluator.nullProvider')
;(NULL_PRUNING_PROVIDER as unknown as Record<symbol, boolean>)[NULL_MARKER] = true

export function isNullPruningProvider(p: PruningProvider | undefined | null): boolean {
  if (!p) return true
  return Boolean((p as unknown as Record<symbol, boolean>)[NULL_MARKER])
}

// ── Evidence index ───────────────────────────────────────────────────────────

/**
 * The set of evidence identifiers a decision may cite. A reference outside this set is not
 * "extra colour" — it is an unverifiable claim, and the decision that rests on it is downgraded.
 */
export function buildEvidenceIndex(snap: WorkContextSnapshot): ReadonlySet<string> {
  const refs = new Set<string>()
  for (const s of snap.sessions) refs.add(`session:${s.id}`)
  for (const t of [...snap.openTasks, ...snap.completedTasks]) refs.add(`task:${t.id}`)
  for (const m of snap.unreadMessages) refs.add(`message:${m.id}`)
  for (const i of snap.openIntents) refs.add(`intent:${i.filePath}`)
  // Orphaned rows were observed in the broker DB just as directly as the scoped ones. They
  // block removal because they are unattributable, not because they are unreal — so a decision
  // that cites one is making a verifiable claim, not an unverifiable one.
  for (const m of snap.orphanedMessages) refs.add(`message:${m.id}`)
  for (const i of snap.orphanedIntents) refs.add(`intent:${i.filePath}`)
  for (const t of snap.humanTurns) refs.add(`turn:${t.sessionId}#${t.turnIndex}`)
  return refs
}

/** Unresolved coordination that touches this memory's own session. */
function contraryCoordination(
  snap: WorkContextSnapshot,
  candidate: PruningCandidate,
): string[] {
  const sessionId = candidate.sessionId
  if (!sessionId) return []
  const live = new Set(snap.activeSessionIds)
  const out: string[] = []
  for (const m of snap.unreadMessages) {
    const involves = m.senderId === sessionId || m.receiverId === sessionId
    const stillLive =
      (m.senderId !== null && live.has(m.senderId)) ||
      (m.receiverId !== null && live.has(m.receiverId))
    if (involves && stillLive) {
      out.push(`unread message:${m.id} still links ${m.senderId ?? '?'}→${m.receiverId ?? '?'}`)
    }
  }
  for (const i of snap.openIntents) {
    if (i.sessionId === sessionId && live.has(i.sessionId)) {
      out.push(`open intent:${i.filePath} still held by live session ${i.sessionId}`)
    }
  }
  return out
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Sources a destructive verdict depends on being READABLE.
 *
 * Not because the verdict must cite all of them — it must cite what it actually used — but
 * because these are the sources that could CONTRADICT it. If one of them could not be read, the
 * absence of a contradiction in it proves nothing, and `contraryCoordination` silently finds
 * nothing to object to. Concretely: when `sessions` is unreadable, `activeSessionIds` is empty,
 * so every unread message looks like it belongs to a dead session and the coordination guard
 * no-ops. Treating that silence as agreement is exactly the absence-as-evidence failure the whole
 * design refuses, so a blind source downgrades the verdict instead.
 *
 * `coordinationAttributable` is the same failure reached by a different route: `sessions` reads
 * fine, but a coordination row resolving to no session row at all is held out of the scoped
 * inventory, so `contraryCoordination` again finds nothing to object to. A truncated inventory's
 * silence is worth no more than an unread source's. `inventoryComplete` closes the third route to
 * the same place: a query that hit its row cap read a SAMPLE, and the objection may be in the tail
 * it never saw.
 */
const CONTRADICTION_SOURCES = [
  ['sessionsAvailable', 'sessions (which sessions are still live)'],
  ['messagesAvailable', 'unread messages (unresolved coordination)'],
  ['intentsAvailable', 'open file intents (work still held by a session)'],
  ['tasksAvailable', 'task transitions (whether the bound work is really closed)'],
  [
    'tasksAttributable',
    'the project behind some tasks (rows read from the broker that belong to no known project)',
  ],
  [
    'coordinationAttributable',
    'the sessions behind some unresolved coordination (rows the broker can no longer attribute)',
  ],
  [
    'inventoryComplete',
    'the evidence past a row cap (the inventory is a truncated sample, not the whole record)',
  ],
] as const

function blindContradictionSources(snap: WorkContextSnapshot): string[] {
  return CONTRADICTION_SOURCES.filter(([key]) => !snap.completeness[key]).map(([, label]) => label)
}

export async function evaluatePruningCandidates(
  opts: EvaluatePruningOptions,
): Promise<PruningEvaluationResult> {
  const { candidates, snapshot, provider = NULL_PRUNING_PROVIDER } = opts

  // Pinned memories never reach the evaluator: they are not a judgement call.
  const assessable = candidates.filter((c) => !c.pinned)

  let proposals: readonly ProviderProposal[] = []
  let evaluatorFailed = false
  let providerError: string | null = null
  if (assessable.length > 0) {
    try {
      proposals = await provider.assess({ candidates: assessable, snapshot })
    } catch (err) {
      evaluatorFailed = true
      providerError = err instanceof Error ? err.message : String(err)
      log.warn({ err: providerError }, 'pruning evaluator provider failed — all candidates uncertain')
    }
  }

  const byId = new Map(proposals.map((p) => [p.memoryId, p]))
  const evidence = buildEvidenceIndex(snapshot)
  const blindSources = blindContradictionSources(snapshot)

  const decisions: PruningDecision[] = []
  let downgraded = 0

  for (const candidate of candidates) {
    if (candidate.pinned) {
      decisions.push({
        memoryId: candidate.memoryId,
        path: candidate.path,
        verdict: 'keep',
        applicability: 'durable',
        rationale: 'pinned by the user — the critic and the evaluator may not remove it',
        evidenceRefs: [],
        contraryEvidence: [],
        source: 'guard',
      })
      continue
    }

    const proposal = byId.get(candidate.memoryId)
    if (!proposal) {
      decisions.push({
        memoryId: candidate.memoryId,
        path: candidate.path,
        verdict: 'uncertain',
        applicability: 'unknown',
        rationale: evaluatorFailed
          ? `evaluator failed before assessing this memory (${providerError})`
          : 'no assessment returned — the evaluator omitted this memory',
        evidenceRefs: [],
        contraryEvidence: [],
        source: 'guard',
      })
      continue
    }

    const guarded = applyGuards({ candidate, proposal, snapshot, evidence, blindSources })
    if (guarded.verdict !== proposal.verdict) downgraded++
    decisions.push(guarded)
  }

  return { decisions, downgraded, evaluatorFailed, providerError }
}

/**
 * Re-check an already-approved destructive decision against a FRESH snapshot.
 *
 * Content hashes prove the reviewed BYTES are unchanged; this proves the reviewed PREMISES still
 * hold. A retirement justified by "that coordination ended" must not execute after the peer has
 * sent a new message, even though every file hash still matches.
 *
 * Runs the same guards as the original evaluation, with no provider involved — it can only
 * invalidate a decision, never create or upgrade one.
 */
export function recheckDecision(args: {
  readonly decision: PruningDecision
  readonly candidate: PruningCandidate
  readonly snapshot: WorkContextSnapshot
}): { stands: boolean; reason: string } {
  const { decision, candidate, snapshot } = args
  if (decision.verdict !== 'retire' && decision.verdict !== 'revise') {
    return { stands: true, reason: 'non-destructive decision' }
  }
  if (candidate.pinned) {
    return { stands: false, reason: 'the memory has been pinned since the plan was reviewed' }
  }

  const proposal: ProviderProposal = {
    memoryId: decision.memoryId,
    verdict: decision.verdict,
    applicability: decision.applicability,
    rationale: decision.rationale,
    evidenceRefs: decision.evidenceRefs,
    ...(decision.revisedRule ? { revisedRule: decision.revisedRule } : {}),
    ...(decision.revisedBody ? { revisedBody: decision.revisedBody } : {}),
  }
  const regraded = applyGuards({
    candidate,
    proposal,
    snapshot,
    evidence: buildEvidenceIndex(snapshot),
    blindSources: blindContradictionSources(snapshot),
  })
  if (regraded.verdict === decision.verdict) return { stands: true, reason: 'premises still hold' }
  return {
    stands: false,
    reason: `work evidence changed since the plan was reviewed — ${regraded.rationale}`,
  }
}

function applyGuards(args: {
  candidate: PruningCandidate
  proposal: ProviderProposal
  snapshot: WorkContextSnapshot
  evidence: ReadonlySet<string>
  blindSources: readonly string[]
}): PruningDecision {
  const { candidate, proposal, snapshot, evidence, blindSources } = args
  const base = {
    memoryId: candidate.memoryId,
    path: candidate.path,
    applicability: proposal.applicability,
    evidenceRefs: proposal.evidenceRefs,
    contraryEvidence: proposal.contraryEvidence ?? [],
  }

  const uncertain = (rationale: string, contrary: readonly string[] = []): PruningDecision => ({
    ...base,
    verdict: 'uncertain',
    rationale,
    contraryEvidence: [...(proposal.contraryEvidence ?? []), ...contrary],
    source: 'guard',
    proposedVerdict: proposal.verdict,
  })

  // Non-destructive verdicts stand as proposed.
  if (proposal.verdict === 'keep' || proposal.verdict === 'uncertain') {
    return { ...base, verdict: proposal.verdict, rationale: proposal.rationale, source: 'provider' }
  }

  // 1. Nothing destructive may stand while a source that could CONTRADICT it was unreadable.
  //    An empty result from a source we never read is silence, not agreement.
  if (blindSources.length > 0) {
    return uncertain(
      `work evidence is ${snapshot.completeness.level}: could not read ${blindSources.join('; ')}` +
        `${snapshot.completeness.gaps.length > 0 ? ` (${snapshot.completeness.gaps.join('; ')})` : ''} — ` +
        'silence from evidence that could not be read, or could not be attributed to a session, ' +
        'is not proof this memory expired',
    )
  }

  // 2. A destructive verdict must cite evidence, and that evidence must exist.
  if (proposal.evidenceRefs.length === 0) {
    return uncertain(
      'the evaluator proposed removal without citing any evidence that this memory’s applicability ended',
    )
  }
  const unknownRefs = proposal.evidenceRefs.filter((r) => !evidence.has(r))
  if (unknownRefs.length > 0) {
    return uncertain(
      `cited evidence not present in the work snapshot: ${unknownRefs.join(', ')} — refusing an unverifiable claim`,
    )
  }

  // 3. A revision must actually supply the surviving text.
  if (proposal.verdict === 'revise') {
    const revisedRule = proposal.revisedRule?.trim()
    if (!revisedRule) {
      return uncertain('revise proposed without a replacement rule (revisedRule missing)')
    }
    if (revisedRule === candidate.rule.trim()) {
      return uncertain('revise proposed but the replacement rule is identical to the original')
    }
  }

  // 4. Live, unresolved coordination on this memory's own session blocks its retirement.
  if (proposal.applicability === 'coordination-bound') {
    const contrary = contraryCoordination(snapshot, candidate)
    if (contrary.length > 0) {
      return uncertain(
        'coordination for this memory’s session is still unresolved — no current mention is not proof it ended',
        contrary,
      )
    }
  }

  const revisedRule = proposal.revisedRule?.trim()
  const revisedBody = proposal.revisedBody?.trim()
  return {
    ...base,
    verdict: proposal.verdict,
    rationale: proposal.rationale,
    source: 'provider',
    ...(proposal.verdict === 'revise' && revisedRule ? { revisedRule } : {}),
    ...(proposal.verdict === 'revise'
      ? { revisedBody: revisedBody && revisedBody.length > 0 ? revisedBody : revisedRule! }
      : {}),
  }
}

// ── Prompt + parsing (used by real providers) ────────────────────────────────

export const PRUNING_SYSTEM_PROMPT = `You review stored project memories against the CURRENT state
of work and decide whether each one is still applicable.

You are given (a) candidate memories and (b) an evidence snapshot of the project: live sessions,
open and closed tasks, unresolved coordination, and what the human actually typed.

For each candidate return exactly one verdict:
  - "keep"      — still applicable. Durable lessons, safety rules and standing project
                  requirements stay, even if nothing currently mentions them.
  - "retire"    — its applicability has ENDED. Only when the evidence SHOWS the end: explicit
                  supersession by the human, a completed or cancelled task it was bound to, or a
                  coordination scope that demonstrably closed.
  - "revise"    — it mixes a durable lesson with an expired clause. Supply "revisedRule" (and
                  optionally "revisedBody") containing ONLY the part that still applies.
  - "uncertain" — you cannot tell from the evidence given.

Hard rules:
  - Age, low retrieval, an empty session list, or simply not being mentioned are NOT reasons to
    retire anything. Silence is not evidence.
  - Every "retire" and "revise" MUST cite evidence in "evidenceRefs" using the exact identifiers
    from the snapshot: "session:<id>", "task:<id>", "message:<id>", "intent:<path>",
    "turn:<sessionId>#<index>". A citation that is not in the snapshot invalidates the verdict.
  - If the evidence does not support removal, answer "uncertain". That is a correct answer.
  - Classify "applicability" as one of: durable, project-requirement, task-bound,
    coordination-bound, unknown.

Return ONE JSON array. Each element:
{"memoryId": string, "verdict": "keep"|"retire"|"revise"|"uncertain",
 "applicability": string, "rationale": string, "evidenceRefs": string[],
 "contraryEvidence"?: string[], "revisedRule"?: string, "revisedBody"?: string}

Only output the JSON array. No prose, no fences.`

export function buildPruningUserPrompt(req: PruningAssessmentRequest): string {
  const lines: string[] = ['CURRENT WORK EVIDENCE', '']
  lines.push(summarizeWorkContext(req.snapshot))
  lines.push('', 'CANDIDATE MEMORIES', '')
  for (const c of req.candidates) {
    lines.push(`- memoryId: ${c.memoryId}`)
    lines.push(`  rule: ${JSON.stringify(c.rule)}`)
    if (c.body && c.body !== c.rule) {
      lines.push(`  body: ${JSON.stringify(c.body.slice(0, 600))}`)
    }
    lines.push(`  category: ${c.category}`)
    lines.push(`  recordedInSession: ${c.sessionId ?? 'unknown'}`)
    lines.push(`  recordedAt: ${c.createdAt}`)
    if (c.criticStatus) lines.push(`  priorCriticStatus: ${c.criticStatus}`)
  }
  return lines.join('\n')
}

/** The exact text a provider sends: the policy, then the evidence and candidates. */
export function buildPruningPrompt(req: PruningAssessmentRequest): string {
  return `${PRUNING_SYSTEM_PROMPT}\n\n${buildPruningUserPrompt(req)}`
}

/**
 * Parse a provider response into proposals. Anything malformed is DISCARDED rather than coerced:
 * a dropped entry becomes `uncertain` downstream, whereas a coerced one would be a fabricated
 * judgement about a real memory.
 */
export function parsePruningResponse(raw: string): readonly ProviderProposal[] {
  let parsed: unknown
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
    parsed = JSON.parse(cleaned)
  } catch {
    log.warn('pruning evaluator response was not valid JSON — no proposals accepted')
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: ProviderProposal[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const memoryId = typeof o['memoryId'] === 'string' ? o['memoryId'].trim() : ''
    const verdict = typeof o['verdict'] === 'string' ? o['verdict'] : ''
    if (!memoryId || !VERDICTS.has(verdict)) continue
    const applicabilityRaw = typeof o['applicability'] === 'string' ? o['applicability'] : ''
    const applicability = (
      APPLICABILITIES.has(applicabilityRaw) ? applicabilityRaw : 'unknown'
    ) as Applicability
    const evidenceRefs = Array.isArray(o['evidenceRefs'])
      ? (o['evidenceRefs'] as unknown[]).filter((r): r is string => typeof r === 'string')
      : []
    const contraryEvidence = Array.isArray(o['contraryEvidence'])
      ? (o['contraryEvidence'] as unknown[]).filter((r): r is string => typeof r === 'string')
      : []
    const revisedRule = typeof o['revisedRule'] === 'string' ? o['revisedRule'] : undefined
    const revisedBody = typeof o['revisedBody'] === 'string' ? o['revisedBody'] : undefined
    out.push({
      memoryId,
      verdict: verdict as PruningVerdict,
      applicability,
      rationale: typeof o['rationale'] === 'string' ? o['rationale'].slice(0, 500) : '',
      evidenceRefs,
      ...(contraryEvidence.length > 0 ? { contraryEvidence } : {}),
      ...(revisedRule ? { revisedRule: revisedRule.slice(0, 1000) } : {}),
      ...(revisedBody ? { revisedBody: revisedBody.slice(0, 4000) } : {}),
    })
  }
  return out
}
