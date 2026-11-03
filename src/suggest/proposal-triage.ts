/**
 * PROPOSAL TRIAGE — decide `duplicate` / `novel` / `unverified` before any prose is written.
 *
 * Two rules shape this module, both from John:
 *
 *  1. "make sure however we create this that we aren't prompting the llm to explain why its unique
 *     if it isn't." ⇒ the model is never asked to justify novelty. It gets a NEUTRAL question with
 *     the real list of existing capabilities and must answer in a fixed, decidable format. Framing
 *     that presupposes the answer manufactures the answer.
 *
 *  2. "if it isn't [unique] we can make the recommendation rejected by machine/duplicate so that it
 *     doesn't pop up again." ⇒ duplicates are auto-rejected with a MACHINE reason and must not
 *     resurface.
 *
 * Three outcomes, because two would force a lie:
 *   - `duplicate`   — established, either by disk scan or by the neutral check. Auto-rejectable.
 *   - `novel`       — the neutral check affirmatively found no overlap. Only this earns prose.
 *   - `unverified`  — we could not establish either. NOT auto-rejected (that would silently discard
 *                     good proposals) and NOT treated as novel (that would generate uniqueness
 *                     claims we never established). It reaches the human labelled as unproven.
 */
import { assessOverlap, artifactNameFor, type ExistingCapability } from './capability-overlap.js'
import { SuggestionType, type Suggestion } from './types.js'

/**
 * Machine-verdict marker. Deliberately NOT prefixed `human:` — `outcome-writer` forwards the same
 * field to the learner, so a machine rejection must never be mistakable for one of John's reasons.
 */
export const DUPLICATE_REASON_PREFIX = 'duplicate-capability:'

/**
 * A work item is rejected for a DIFFERENT reason than an artifact, and says so. Conflating the two
 * is what killed three good self-improvement proposals in the first rehearsal.
 */
export const ALREADY_DONE_REASON_PREFIX = 'already-done:'

export type ProposalKind = 'artifact' | 'work-item'

/** Types that always propose a NEW CAPABILITY ARTIFACT — "do we already have this?" applies. */
const ARTIFACT_TYPES: readonly string[] = [
  SuggestionType.Skill,
  SuggestionType.Agent,
  SuggestionType.Prompt,
  SuggestionType.Extension,
  SuggestionType.Mcp,
  SuggestionType.GithubAction,
  SuggestionType.Automation,
]

/** "Create/add/install a <thing>" reads as a new artifact even under an ambiguous type. */
const ARTIFACT_TITLE =
  /^\s*(?:create|add|install|configure|set\s+up)\b.*\b(?:skill|extension|integration|mcp|workflow|agent|prompt|instruction|automation|lsp|server)\b/i

/**
 * Which question to ask.
 *
 * For an ARTIFACT ("create a file-management extension") the useful question is whether the
 * capability already exists. For a WORK ITEM ("emit a structured event when a worktree is
 * reclaimed") that question is a category error — of course a tool to edit files exists; the real
 * question is whether the change has already been made, and after that it is John's call.
 */
export function classifyProposal(suggestion: Suggestion): ProposalKind {
  if (ARTIFACT_TYPES.includes(suggestion.type)) return 'artifact'
  return ARTIFACT_TITLE.test(suggestion.title) ? 'artifact' : 'work-item'
}

export type TriageOutcome = 'duplicate' | 'novel' | 'unverified'

export interface TriageResult {
  readonly outcome: TriageOutcome
  /** Present only for `duplicate`. */
  readonly machineReason?: string
  readonly duplicates: readonly ExistingCapability[]
  /** What the decision was based on, for the audit trail. */
  readonly basis: 'disk-scan' | 'neutral-check' | 'none'
}

/** Answers the neutral overlap question. Injected so triage stays pure and testable. */
export type NeutralOverlapChecker = (question: string) => Promise<string>

/**
 * A question that does not know what answer it wants. It supplies the proposal, the concrete list
 * of what already exists, and an explicit instruction to include capability built into the host
 * tool — the blind spot a disk scan cannot cover, and the one that made the file-management
 * proposal unanswerable.
 */
export function buildNeutralOverlapQuestion(
  suggestion: Suggestion,
  existing: readonly ExistingCapability[],
): string {
  const name = artifactNameFor(suggestion)
  const inventory =
    existing.length > 0
      ? existing.map((e) => `  - ${e.kind}: ${e.name}`).join('\n')
      : '  (no locally-built artifacts of any kind)'

  return [
    `A proposal has been generated to create a ${suggestion.type} called "${name}".`,
    ``,
    `Proposal description:`,
    `  ${suggestion.description}`,
    ``,
    `Capabilities already built locally:`,
    inventory,
    ``,
    `Consider BOTH the locally-built capabilities above AND capability that is already native to`,
    `the coding assistant and its standard tools (for example: reading, editing and creating files,`,
    `running shell commands, searching code, browsing the web).`,
    ``,
    `Does this proposal duplicate capability that already exists?`,
    ``,
    `Answer with exactly one line, in one of these two forms:`,
    `  DUPLICATE: <the specific existing capability it duplicates>`,
    `  NOVEL`,
  ].join('\n')
}

/**
 * The work-item question. Deliberately offers UNKNOWN: this session has no repo access, so "I
 * cannot tell" is usually the truthful answer — and a truthful UNKNOWN keeps the proposal alive
 * for John, which is the correct default for a change only he can prioritise.
 */
export function buildWorkItemQuestion(suggestion: Suggestion): string {
  return [
    `A proposal has been raised to make this change to a software project:`,
    ``,
    `  ${suggestion.title}`,
    `  ${suggestion.description}`,
    ``,
    `This is a unit of work, not a request for a new tool. Do NOT consider whether tools exist`,
    `that could perform the change — assume they do.`,
    ``,
    `The only question: has this specific change already been made?`,
    ``,
    `Answer with exactly one line, in one of these three forms:`,
    `  DONE: <the specific evidence that it is already in place>`,
    `  NOT-DONE`,
    `  UNKNOWN`,
    ``,
    `Answer UNKNOWN unless you have concrete evidence. Do not guess.`,
  ].join('\n')
}

function parseWorkItemAnswer(raw: string): { done: true; what: string } | { done: false } | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  const done = text.match(/^\s*DONE\s*:\s*(.+)$/im)
  if (done?.[1]) return { done: true, what: done[1].trim() }
  if (/^\s*NOT-DONE\s*$/im.test(text)) return { done: false }
  return null
}

function parseNeutralAnswer(raw: string): { duplicate: true; what: string } | { duplicate: false } | null {
  // A malformed answer (undefined/non-string from a flaky transport) must degrade to "unverified",
  // never crash the pass and never be read as a licence to auto-reject.
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  const dup = text.match(/^\s*DUPLICATE\s*:\s*(.+)$/im)
  if (dup?.[1]) return { duplicate: true, what: dup[1].trim() }
  if (/^\s*NOVEL\s*$/im.test(text)) return { duplicate: false }
  return null
}

/**
 * Disk scan first (free and certain), neutral check only when the scan is inconclusive. A proven
 * duplicate never costs a model call.
 */
export async function triageProposal(
  suggestion: Suggestion,
  existing: readonly ExistingCapability[],
  askNeutral?: NeutralOverlapChecker,
): Promise<TriageResult> {
  // A work item never faces the capability question — see `classifyProposal`.
  if (classifyProposal(suggestion) === 'work-item') {
    if (!askNeutral) return { outcome: 'unverified', duplicates: [], basis: 'none' }
    let raw: string
    try {
      raw = await askNeutral(buildWorkItemQuestion(suggestion))
    } catch {
      return { outcome: 'unverified', duplicates: [], basis: 'none' }
    }
    const done = parseWorkItemAnswer(raw)
    if (done === null) return { outcome: 'unverified', duplicates: [], basis: 'none' }
    if (done.done) {
      return {
        outcome: 'duplicate',
        machineReason: `${ALREADY_DONE_REASON_PREFIX} ${done.what}`,
        duplicates: [],
        basis: 'neutral-check',
      }
    }
    return { outcome: 'novel', duplicates: [], basis: 'neutral-check' }
  }

  const scan = assessOverlap(suggestion, existing)

  if (scan.verdict === 'duplicate') {
    return {
      outcome: 'duplicate',
      machineReason: `${DUPLICATE_REASON_PREFIX} ${scan.reason}`,
      duplicates: scan.duplicates,
      basis: 'disk-scan',
    }
  }

  if (!askNeutral) {
    return { outcome: 'unverified', duplicates: [], basis: 'none' }
  }

  let answer: string
  try {
    answer = await askNeutral(buildNeutralOverlapQuestion(suggestion, existing))
  } catch {
    return { outcome: 'unverified', duplicates: [], basis: 'none' }
  }

  const parsed = parseNeutralAnswer(answer)
  if (parsed === null) {
    return { outcome: 'unverified', duplicates: [], basis: 'none' }
  }

  if (parsed.duplicate) {
    return {
      outcome: 'duplicate',
      machineReason: `${DUPLICATE_REASON_PREFIX} ${parsed.what}`,
      duplicates: [],
      basis: 'neutral-check',
    }
  }

  return { outcome: 'novel', duplicates: [], basis: 'neutral-check' }
}
