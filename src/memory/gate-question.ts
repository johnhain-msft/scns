/**
 * GATE Part B (provider) — the informative clarifying-QUESTION generator ("what to ask").
 *
 * The faithful GATE mechanism (GATE — Generative Active Task Elicitation, Li/Tamkin/Goodman/Andreas,
 * ICLR 2024, arXiv:2310.11589; the "Generative open-ended questions" policy in the authors' code):
 * prompt an LM to generate the SINGLE most informative clarifying question that would reveal the most
 * about the user's desired behavior BEYOND what has already been asked, addressing a DIFFERENT aspect
 * than prior questions, kept BITE-SIZED (ask ONE concrete thing, not many). Informativeness is delegated
 * to the LM IN THE PROMPT — no explicit information-gain math — exactly as the paper implements it.
 *
 * This module is PURE: the prompt builder + response parser + the provider seam and a CI-safe NULL
 * provider. The real transport (a deny-all `copilot --acp` spawn) is `gate-question-acp.ts`.
 */

/** One prior clarifying exchange in this elicitation (drives the "different aspect" de-dup). */
export interface ClarifyingExchange {
  readonly question: string
  readonly answer: string
}

export interface ClarifyingQuestionRequest {
  /** The under-determined user request the question should disambiguate (GATE's `task_description`). */
  readonly taskDescription: string
  /** Prior clarifying Q&A this session, so a follow-up covers a NEW aspect. Default none. */
  readonly history?: readonly ClarifyingExchange[]
}

/** The provider seam — a single async call that yields ONE clarifying question ('' if none/failure). */
export interface GateQuestionProvider {
  generate(req: ClarifyingQuestionRequest): Promise<string>
}

/** Max characters for a parsed clarifying question (bite-sized; bounds a runaway generation). */
export const MAX_QUESTION_CHARS = 300

/** The system framing for the elicitation turn (think-only; generate a question, take no action). */
export const GATE_QUESTION_SYSTEM_PROMPT =
  'You are a coding assistant that ELICITS a user\'s under-specified intent by asking ONE concise ' +
  'clarifying question. You do not perform the task or take any action — you only ask the single most ' +
  'informative question that will most reduce ambiguity about what the user actually wants.'

/**
 * A stable substring of {@link GATE_QUESTION_SYSTEM_PROMPT} used as a RECURSION GUARD: when GATE spawns a
 * deny-all `copilot --acp` worker to generate a question, that worker's own prompt turn (if it reaches
 * the live /context path) carries this signature — the briefing must NOT elicit on it (no infinite loop).
 */
export const GATE_WORKER_SIGNATURE = 'a coding assistant that ELICITS'

function formatHistory(history: readonly ClarifyingExchange[]): string {
  if (history.length === 0) return '(none yet)'
  return history.map((h) => `Q: ${h.question}\nA: ${h.answer}`).join('\n')
}

/**
 * Build the GATE open-ended clarifying-question prompt (verbatim structure from the paper's authors'
 * code): task description + prior Q&A + the "most informative question, beyond what's already asked,
 * different aspect, bite-sized, output the question and nothing else" instruction.
 */
export function buildClarifyingQuestionPrompt(req: ClarifyingQuestionRequest): string {
  const history = formatHistory(req.history ?? [])
  return [
    `The user asked a coding assistant to help with the following, but the request is under-specified:`,
    ``,
    `"${req.taskDescription.trim()}"`,
    ``,
    `Previous clarifying questions and answers:`,
    history,
    ``,
    `Generate the most informative clarifying question that, when answered, will reveal the most about`,
    `the user's desired behavior beyond what has already been asked above. Address a different aspect`,
    `than the questions already asked. Keep it bite-sized — ask one concrete thing, not too much at`,
    `once. Generate the question and nothing else:`,
  ].join('\n')
}

/**
 * Extract ONE clean question from raw LM output. Robust to the model prepending chatter or wrapping the
 * question in quotes: prefer the first line that IS a question (ends with '?', else contains '?'),
 * truncate at the first '?', strip surrounding quotes, and bound the length. Returns '' for empty output
 * (the caller fails safe on '').
 */
export function parseClarifyingQuestion(raw: string): string {
  if (!raw) return ''
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return ''
  // Skip prepended chatter ("Sure! Here is a question:") — prefer an actual question line.
  const candidate =
    lines.find((l) => l.endsWith('?')) ?? lines.find((l) => l.includes('?')) ?? lines[0]!
  // Drop any trailing same-line chatter after the question mark.
  const q = candidate.includes('?') ? candidate.slice(0, candidate.indexOf('?') + 1) : candidate
  // strip a single pair of surrounding quotes (straight or smart)
  const unquoted = q.replace(/^["'“”]+/, '').replace(/["'“”]+$/, '').trim()
  if (unquoted === '') return ''
  return unquoted.length > MAX_QUESTION_CHARS ? unquoted.slice(0, MAX_QUESTION_CHARS).trim() : unquoted
}

/** CI-safe default: never spawns, always yields no question (GATE stays inert unless a real provider is wired). */
export const NULL_GATE_QUESTION_PROVIDER: GateQuestionProvider = {
  async generate(): Promise<string> {
    return ''
  },
}
