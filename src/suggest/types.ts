/**
 * Suggestion types — core schemas and type definitions for the suggestion system.
 */

import { z } from 'zod'

/** All supported suggestion types */
export const SuggestionType = {
  Skill: 'skill',
  Agent: 'agent',
  Mcp: 'mcp',
  Automation: 'automation',
  Workflow: 'workflow',
  Prompt: 'prompt',
  Extension: 'extension',
  Lsp: 'lsp',
  GithubAction: 'github-action',
  AgenticWorkflow: 'agentic-workflow',
  Instruction: 'instruction',
  /**
   * A certified arm promotion: the offline reward learner's challenger beat the incumbent with a
   * positive one-sided 95% lower bound, so the retrieval arm SCNS serves should change. Payload
   * lives in `armPromotion`. NEVER auto-executable — flipping what the human is served is his
   * call, so the executor throws NEEDS_HUMAN for this type.
   */
  ArmPromotion: 'arm-promotion',
  /**
   * Phase 13.12.12: proposes a new tag for the lesson taxonomy. Payload lives
   * in the `tagProposal` field; executor applies the tag to the named
   * lessons' frontmatter and registers it in `~/.scns/memory/.taxonomy.yml`.
   */
  TagProposal: 'tag-proposal',
  /**
   * Phase 13.12.18: browser-automation runs. Payload lives in the
   * `browserPlan` field (list of navigate/click/type/screenshot steps).
   * Executor materializes the plan under `~/.scns/browser-runs/<id>/plan.json`
   * and invokes the bundled `browser-automation` skill runner. Artifacts
   * (screenshots, log, final-state.json) stay under that run directory.
   */
  BrowserAutomation: 'browser-automation',
} as const

export type SuggestionType = (typeof SuggestionType)[keyof typeof SuggestionType]

/**
 * Types whose implementation is a deterministic artifact write the executor handles
 * end-to-end (safety-gated paths under `~/.copilot` / `~/.scns`), or a deliberate
 * NEEDS_HUMAN refusal (`workflow`, `arm-promotion`).
 *
 * Spawning a repo agent for these is a category error: the agent works in a worktree of
 * the focus repo, the quality gate judges its staged REPO diff with npm build/test/lint,
 * and the real artifact write (`applyArtifact`) only happens after a PASS the agent
 * structurally cannot earn — the artifact does not live in the repo, so there is no
 * legitimate repo diff to stage. That mismatch is what kept approved lsp / instruction /
 * tag-proposal items cycling approve → gate-fail ×N → gate-exhausted → needs-human →
 * re-asked in weekly review (observed 2026-09-14..10-05).
 *
 * `github-action` is deliberately ABSENT: its artifact is repo content, so the
 * spawn-agent + repo-gate path is the right one. An unknown/future type also returns
 * false — the spawn path is the conservative default for work this list has not vetted.
 */
const DIRECT_ARTIFACT_TYPES: ReadonlySet<string> = new Set([
  SuggestionType.Skill,
  SuggestionType.Agent,
  SuggestionType.Mcp,
  SuggestionType.Automation,
  SuggestionType.Workflow,
  SuggestionType.Prompt,
  SuggestionType.Extension,
  SuggestionType.Lsp,
  SuggestionType.AgenticWorkflow,
  SuggestionType.Instruction,
  SuggestionType.ArmPromotion,
  SuggestionType.TagProposal,
  SuggestionType.BrowserAutomation,
])

export function isDirectArtifactType(type: string): boolean {
  return DIRECT_ARTIFACT_TYPES.has(type)
}

/** Lifecycle status of a suggestion */
export const SuggestionStatus = {
  Pending: 'pending',
  Approved: 'approved',
  Rejected: 'rejected',
  Implemented: 'implemented',
  /**
   * Phase 13.12.1 amendment: suggestion cannot be auto-executed and needs a
   * human planner (e.g. `workflow`-type suggestions which describe a multi-step
   * process, not an artifact). Terminal status — brain will NOT retry.
   */
  NeedsHuman: 'needs-human',
  /**
   * Phase 13.12.2: executor refused to run because the current autonomy level
   * is below the minimum required by the plan (e.g. `RunCommand` needs L3).
   * Not terminal — when autonomy is raised to or above `blockedMetadata.requiredLevel`,
   * the brain resets this back to `approved` on the next tick.
   */
  BlockedAutonomy: 'blocked-autonomy',
  /**
   * Phase 13.12.9: executor has returned a non-terminal failure (no
   * `nextStatus`) for 5 consecutive wake cycles. The brain will NOT retry
   * automatically — operator intervention (manual retry or delete) is
   * required. Unlike `blocked-autonomy` this can come from any error source.
   */
  Failed: 'failed',
  /**
   * Phase 13.12.20: suggestion has spawned a team (via ApprovedSuggestions)
   * and the brain is waiting for `team_completed` event before running
   * self-critique and transitioning to `implemented` / `failed` /
   * `needs-human`. The `inflightTeamId` field on the suggestion links the
   * record back to the running team.
   */
  InProgress: 'in-progress',
} as const

export type SuggestionStatus = (typeof SuggestionStatus)[keyof typeof SuggestionStatus]

const suggestionTypeValues = Object.values(SuggestionType) as [SuggestionType, ...SuggestionType[]]
const suggestionStatusValues = Object.values(SuggestionStatus) as [
  SuggestionStatus,
  ...SuggestionStatus[],
]

/**
 * The two meanings of `needs-human`, made explicit (John's ruling, 2026-08-04).
 *
 * `gate-refused`   — a safety gate declined to run this; it needs re-judging (13.12.16).
 * `gate-exhausted` — the quality gate ran out of attempts building it (FR-056b). The IDEA was
 *                    never judged; only the build failed.
 */
export const escalationKindValues = ['gate-refused', 'gate-exhausted'] as const
export type EscalationKind = (typeof escalationKindValues)[number]

/** Zod schema for a single suggestion */
export const SuggestionSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(suggestionTypeValues),
  title: z.string().min(1),
  description: z.string(),
  status: z.enum(suggestionStatusValues).default('pending'),
  confidence: z.number().min(0).max(1),
  evidence: z.array(
    z.object({
      source: z.string(),
      detail: z.string(),
      observedAt: z.string().datetime(),
      weight: z.number().min(0).max(1).default(0.5),
    }),
  ),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  reviewedAt: z.string().datetime().optional(),
  reviewReason: z.string().optional(),
  /**
   * FR-048/FR-050 (E10): the most recent MACHINE verdict, kept separate from `reviewReason`.
   *
   * `reviewReason` used to be a single slot that whoever wrote last owned, so a quality-gate
   * `qg-pass` or a `self-critique: …` line silently replaced the words John typed at the weekly
   * review. His approval rationale is the scarcest signal the system has — it is the half of
   * accept-vs-waste the corpus was missing entirely — and a machine string must never be able to
   * occupy the slot reserved for it. The machine verdict is still recorded, just as the machine's.
   */
  machineReason: z.string().optional(),
  /**
   * Which KIND of `needs-human` this is (John's ruling, 2026-08-04).
   *
   * `needs-human` means two unrelated things — "a safety gate refused this; rebuild it" (13.12.16)
   * and "the quality gate exhausted its retries; decide" (FR-056b) — and they want opposite
   * handling almost everywhere: one is re-triaged, the other resumed; one suppresses duplicate
   * proposals, the other must not. Recovering the difference by sniffing `machineReason` and
   * `attemptCount` was duplicated across five readers and got the live artefact `65a914f4` wrong
   * (it carries `qg-fail:` with `attemptCount: 0`, predating the counting).
   *
   * Written by the producer, read via `escalation.ts`. Optional because files predating the split
   * do not carry it — those fall back to the old discriminator rather than silently declassifying.
   */
  escalation: z.enum(escalationKindValues).optional(),
  /**
   * FR-051a (E10): the verdict the HUMAN actually gave, recorded separately from `status`.
   *
   * `status` is a mechanical fact ("this work ran and landed"); the verdict is a judgement ("I want
   * this"). They agree on the ordinary path and diverge on the one the weekly review deliberately
   * supports: a backfill answer onto an already-terminal item keeps its status and attaches only a
   * reason (`weekly-session.ts`). Before this field existed, the Monday sweep re-derived the label
   * from `status` while attaching `reviewReason` — the last thing John typed — as its justification,
   * so a REJECTION of an already-`implemented` item was banked as verdict `implemented`, which
   * `humanOutcomeOfVerdict` scores as `accepted` (1). Measured on the built dist:
   *
   *     status: implemented | John typed: reject -> banked: implemented | gradient: 1
   *
   * That is a sign flip on human accept-vs-waste, the single metric `docs/NORTH_STAR.md` names, with
   * his rejection sentence filed as the supporting evidence. Recording what he actually said is what
   * lets the sweep label his words correctly instead of inferring a label that contradicts them.
   *
   * Absent on every pre-existing item, which is why readers fall back to `status` rather than
   * treating absence as a verdict.
   */
  reviewVerdict: z.enum(['approve', 'reject', 'defer', 'explain']).optional(),
  implementationPlan: z.string().optional(),
  /**
   * Phase 13.2: whether the brain should treat this as a concrete action
   * (skill/automation/mcp/etc.) vs. advisory noise (e.g., "work at 10:00").
   * Non-actionable suggestions are still surfaced in the dashboard for
   * transparency but are ignored by the suggestion→task promoter.
   */
  actionable: z.boolean().default(true),
  /** Phase 13.2: rough complexity hint for team-shape selection. */
  estimatedComplexity: z.enum(['solo', 'team', 'complex']).default('solo'),
  /** Phase 13.2: optional list of role hints for team assembly. */
  suggestedRoles: z.array(z.string()).optional(),
  /**
   * Phase 13.12.2: metadata attached when status is `blocked-autonomy`.
   * `requiredLevel` is the minimum autonomy level the executor needs to
   * run this plan; once the live autonomy level reaches this, the brain
   * automatically moves the suggestion back to `approved`.
   */
  blockedMetadata: z
    .object({
      requiredLevel: z.number().int().min(0).max(3),
      blockedAt: z.string().datetime(),
    })
    .optional(),
  /**
   * Phase 13.12.9: number of times executor.execute() has returned
   * success:false (without a terminal nextStatus) for this suggestion.
   * Reset to 0 on manual retry, auto-reset on autonomy raise for matching
   * failures, or by a successful execution (which moves to `implemented`).
   */
  attemptCount: z.number().int().min(0).default(0),
  /** Phase 13.12.9: last error message reported by executor (truncated). */
  lastError: z.string().nullable().default(null),
  /** Phase 13.12.9: ISO timestamp of the most recent failed attempt. */
  lastAttemptAt: z.string().datetime().nullable().default(null),
  /**
   * Phase 13.12.9: ISO timestamp before which the brain must NOT retry this
   * suggestion (exponential backoff). null = no backoff, eligible now.
   */
  nextRetryAt: z.string().datetime().nullable().default(null),
  /**
   * Phase 13.12.12: payload for `tag-proposal` suggestions. Names the tag to
   * apply, the lessons to apply it to, and the scope in which it should be
   * registered in the taxonomy.
   */
  tagProposal: z
    .object({
      tagName: z.string().min(1),
      scope: z.enum(['global', 'project', 'agent']),
      project: z.string().optional(),
      agent: z.string().optional(),
      candidateLessonIds: z.array(z.string()).min(1),
      rationale: z.string().default(''),
    })
    .optional(),
  /**
   * Payload for `arm-promotion` suggestions — the reward learner's certified verdict, kept
   * machine-readable so a downstream executor can act on the exact numbers John was shown rather
   * than re-deriving them from prose.
   */
  armPromotion: z
    .object({
      challenger: z.string().min(1),
      incumbent: z.string().min(1),
      /** One-sided 95% Welch lower bound on (challenger − incumbent) mean human outcome. */
      deltaLowerBound: z.number(),
      nChallenger: z.number().int().min(0),
      nIncumbent: z.number().int().min(0),
      challengerMean: z.number(),
      incumbentMean: z.number(),
    })
    .optional(),
  /**
   * Phase 13.12.18: payload for `browser-automation` suggestions.
   * A list of simple browser steps the runner will execute in order.
   * Only a whitelisted set of step shapes is permitted so the executor
   * can validate plans statically.
   */
  browserPlan: z
    .object({
      steps: z
        .array(
          z.object({
            op: z.enum(['navigate', 'click', 'type', 'waitFor', 'screenshot', 'extractText']),
            url: z.string().url().optional(),
            selector: z.string().optional(),
            text: z.string().optional(),
            ms: z.number().int().min(0).max(60_000).optional(),
            path: z.string().optional(),
          }),
        )
        .min(1)
        .max(50),
    })
    .optional(),
  /**
   * Phase 13.12.18: opt-in flag granting this suggestion permission to write
   * inside the repository (currently used only by `github-action` plans).
   * Must also be paired with env `SCNS_ALLOW_REPO_WRITES=1`; otherwise the
   * executor refuses and the brain marks the suggestion `needs-human`.
   */
  allowRepoWrites: z.boolean().default(false),
  /**
   * Phase 13.12.20: when the brain spawns a team for this suggestion, the
   * team id is persisted here so the team_completed event listener can map
   * the stagedDiff back to the source suggestion. Cleared on terminal
   * transition (implemented / failed / needs-human).
   */
  inflightTeamId: z.string().nullable().default(null),
})

export type Suggestion = z.infer<typeof SuggestionSchema>

/**
 * Phase 13.9.5 — Input schema for POST /api/suggestions.
 *
 * Subset of `SuggestionSchema` covering only fields a client may supply.
 * The server fills id (new uuid), status (always "pending"), createdAt/
 * updatedAt (now), and default evidence/tags when omitted. Any client-
 * supplied id/status/timestamps are ignored.
 */
export const SuggestionInputSchema = z.object({
  title: z.string().min(1),
  type: z.enum(suggestionTypeValues),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z
    .array(
      z.object({
        source: z.string(),
        detail: z.string(),
        observedAt: z.string().datetime(),
        weight: z.number().min(0).max(1).default(0.5),
      }),
    )
    .optional(),
  tags: z.array(z.string()).optional(),
  actionable: z.boolean().optional(),
  estimatedComplexity: z.enum(['solo', 'team', 'complex']).optional(),
  suggestedRoles: z.array(z.string()).optional(),
  implementationPlan: z.string().optional(),
})

export type SuggestionInput = z.infer<typeof SuggestionInputSchema>

/** A single piece of evidence supporting a suggestion */
export interface Evidence {
  readonly source: string
  readonly detail: string
  readonly observedAt: string
  readonly weight: number
}
