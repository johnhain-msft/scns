/**
 * Deterministic prompt-authorship classifier — the FALLBACK label source for the GATE settle.
 *
 * ## Why this exists
 * `findGateAnsweredPriorId` used to settle an ACCEPT on ANY next >=12-char prompt in the session. But
 * the live experience log is MAJORITY MACHINE-AUTHORED — measured read-only on 2026-07-24 over
 * `~/.scns/memory/experience.db` (752 rows):
 *
 *   - 445 (56.3%) `You are ...` agent-spawn prompts
 *   -  14 ( 1.8%) `Agent "X" ... has finished processing and is now idle` notices
 *   - 331 (41.9%) possibly-human
 *
 * So "the next prompt" was MORE LIKELY to be a machine than the human. That is **authorship bias** —
 * a third bias source on top of the position/presentation bias that Joachims et al. (SIGIR 2005,
 * "Accurately Interpreting Clickthrough Data as Implicit Feedback") warns about, and which
 * `docs/research/intent-prior-art.md` §3 already ADOPTS as a caution ("an accept is SCNS's click").
 * Two of the three recorded ACCEPTs were provably machine-settled (experience rows 382 and 678).
 *
 * ## What this module is NOT
 * This is a **negative filter**: it recognizes known machine shapes with high precision. It CANNOT
 * prove a prompt is human — a `human` verdict only means "no machine marker matched". The
 * authoritative mechanism is the Copilot CLI transcript ORACLE in `session-transcript.ts`, which
 * reads the CLI's own record of which turns the human actually typed. This classifier is the
 * fail-safe used only when that store is unreadable or its override path is misconfigured; when it
 * is in use the broker says so at startup (see `describeAuthorshipFallback`).
 *
 * Its one known blind spot is PINNED by a test: a sub-agent task brief with no role preamble
 * (experience row 680 — the actual contaminator) is not detectable by shape alone.
 */

/** GATE's own question-generation worker meta-prompt must never be read as a human answer. */
export const GATE_WORKER_MARKER = 'SCNS GATE clarifying-question worker'

export type PromptAuthor = 'human' | 'machine'

export interface AuthorshipVerdict {
  readonly author: PromptAuthor
  /** Which rule decided this — persisted as provenance so a label is always explainable. */
  readonly rule: string
}

export interface MachineRule {
  readonly name: string
  readonly test: (normalized: string) => boolean
}

/**
 * Machine-shape rules, each grounded in a prompt shape actually observed in the live store.
 * Ordered most-specific first; the first match wins and names the verdict.
 */
export const MACHINE_RULES: readonly MachineRule[] = [
  {
    // Copilot CLI background-agent completion notice. Real rows 681, 383-adjacent (14 live rows).
    name: 'agent-completion-notice',
    test: (s) =>
      s.includes('has finished processing and is now idle') ||
      s.includes('use read_agent with agent_id'),
  },
  {
    // Runtime-injected blocks that arrive in the prompt slot but were never typed by a human.
    name: 'system-injected-block',
    test: (s) => /^<(system[_-]reminder|skill-context|system_notification)\b/.test(s),
  },
  {
    // Agent role preamble — the single largest machine class (445 live rows), e.g.
    // "You are a strict news-desk fact-checker...", "You are worker-... on team __fleet__",
    // "You are the SCNS claim verifier", "You are now in fleet mode".
    name: 'agent-role-preamble',
    test: (s) => /^you are\b/.test(s),
  },
  {
    // GATE's own worker meta-prompt (recursion guard, mirrors the existing cli.ts isGateWorker check).
    name: 'gate-worker-meta-prompt',
    test: (s) => s.includes(GATE_WORKER_MARKER.toLowerCase()),
  },
  {
    // Orchestrator dispatch brief. A prompt that INSTRUCTS the reader to open a brief under an
    // `.orchestrator/` directory is machine-authored by construction: that tree is written by the
    // orchestrator for its sub-agents. Added 2026-10-12 after three `slidesmith`/deck-reviewer
    // dispatch briefs from an unrelated project were harvested into the global vault as
    // `type: prohibition` and injected into every session's briefing. The `agent-role-preamble`
    // rule already caught those three; this rule covers the sibling case the module docs name as
    // the known blind spot — a brief with no role preamble.
    //
    // The test requires the dispatch shape (an imperative verb within the same sentence as the
    // path), NOT the bare path: this classifier feeds ~a dozen call sites whose verdicts persist
    // (gate settle, experience-store `prompt_origin`), and a human debugging the orchestrator
    // mentions the path too — "why does .orchestrator/deck-x/kickoff-build-5.md skip row 2?"
    // must stay human.
    name: 'orchestrator-dispatch-brief',
    test: (s) =>
      /\b(?:read|open|follow|execute|consult)\b[^.?!\n]{0,60}\.orchestrator[/\\]/.test(s),
  },
]

/**
 * True when a Copilot CLI transcript turn is a runtime injection rather than something the human
 * typed. The CLI stores these in `turns.user_message` alongside real prompts (observed: a
 * `<skill-context name="handoff">` turn in sessions 4f2c4f11, 8e09dd25 and ac6054d2), so the oracle
 * must filter them or it would treat a skill preamble as the human's answer. Blank turns are
 * likewise not human.
 */
export function isSystemInjectedTurn(text: string | null | undefined): boolean {
  const s = (text ?? '').trim()
  if (s === '') return true
  return /^<(system[_-]reminder|skill-context|system_notification)\b/.test(s.toLowerCase())
}

/**
 * Classify who authored a prompt from its shape alone. Fail-safe and allocation-light; never throws.
 * Blank input is `machine` so an ACCEPT is never settled on nothing.
 */
export function classifyPromptAuthorship(prompt: string | null | undefined): AuthorshipVerdict {
  const raw = (prompt ?? '').trim()
  if (raw === '') return { author: 'machine', rule: 'empty-prompt' }
  const s = raw.toLowerCase()
  for (const rule of MACHINE_RULES) {
    try {
      if (rule.test(s)) return { author: 'machine', rule: rule.name }
    } catch {
      /* a broken rule must never block the loop */
    }
  }
  return { author: 'human', rule: 'no-machine-marker' }
}

/**
 * The operator-facing warning shown at broker startup when the settle is running on this classifier
 * instead of the transcript oracle. Names the degradation explicitly rather than failing quietly.
 */
export function describeAuthorshipFallback(reason: string): string {
  return (
    `SCNS GATE: transcript oracle UNAVAILABLE (${reason}) — falling back to shape-based authorship ` +
    `classification. ACCEPT labels remain fail-closed but are WEAKER: a machine-authored prompt with ` +
    `no recognized marker (e.g. a sub-agent task brief) can still be read as a human answer. ` +
    `Set SCNS_COPILOT_SESSION_STORE to the Copilot CLI session-store.db to restore ground truth.`
  )
}
