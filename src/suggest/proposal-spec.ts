/**
 * PROPOSAL SPEC — the factual skeleton that makes a proposal reviewable.
 *
 * Measured problem this fixes: of 146 suggestions on disk, ZERO carried an `implementationPlan`,
 * even though the field exists (`types.ts`) and the file format round-trips it
 * (`suggestion-file.ts`). Proposals stated why SCNS noticed a pattern and never what the thing is
 * or what approving it would do, so the review was unanswerable:
 *
 *   "i don't know what these suggestions are asking of me. that is a fundamental fix in this flow"
 *   "copilot llm already has the ability to edit files... what *is* a file-management extension?"
 *
 * The skeleton is deterministic and always available — it is the GUARANTEE. Model prose is layered
 * on top and may be absent; it never replaces a fact. Facts about where an artifact lands come from
 * one shared location map, so the scan that looks for existing artifacts and the sentence that
 * tells John where this one would land can never disagree.
 *
 * NOTE ON SCOPE: this map is DESCRIPTIVE (where artifacts live, for scanning and explaining). The
 * executor's `resolveGates` is PRESCRIPTIVE security policy (where writes are permitted). They are
 * deliberately kept separate — wiring human-facing text into a safety gate would let a wording
 * change alter what is writable.
 *
 * ⚠ CORRECTION (2026-08-05). The guarantee in the paragraph above was NOT true as written. It held
 * between the scan and the sentence — both read this map — but the EXECUTOR never did, so the
 * sentence John reviewed ("files would be written under <repo>/.github/instructions") named a
 * directory nothing has ever written to, while the approval actually appended to a file in his
 * home. Both modules' tests passed, because each asserted against its own constant. Destinations
 * now come from `artifact-targets.ts`, which the executor imports too, and
 * `test/unit/suggest/artifact-target-truthfulness.test.ts` fails if they diverge again. What stays
 * separate is the GATE — the permission policy — not the destination.
 */
import { join } from 'node:path'
import { SuggestionType, type Suggestion } from './types.js'
import type { TriageResult } from './proposal-triage.js'
import type { CapabilityScanSpec } from './capability-overlap.js'
import { COPILOT_CONFIG_DIR, lspConfigPath, suggestedInstructionsPath } from './artifact-targets.js'

/** The roots every artifact home is expressed relative to. */
export interface ArtifactRoots {
  readonly home: string
  readonly config: string
  readonly scns: string
  readonly repo: string
}

export interface ArtifactLocation {
  readonly dir: (roots: ArtifactRoots) => string
  /**
   * The EXACT path an approval writes, when the artifact is a known file rather than a new file in
   * a directory. `dir` stays the scan target; this is what John is told. Kept distinct because
   * saying "under ~/.copilot" when the write is a managed block inside one specific file is the
   * kind of almost-true that made the original defect survive review.
   */
  readonly file?: (roots: ArtifactRoots) => string
  /** How to describe the artifact in one noun phrase. */
  readonly noun: string
}

export const DEFAULT_ARTIFACT_LOCATIONS: Partial<Record<string, ArtifactLocation>> = {
  [SuggestionType.Skill]: { dir: (r) => join(r.config, 'skills'), noun: 'a skill' },
  [SuggestionType.Agent]: { dir: (r) => join(r.config, 'agents'), noun: 'an agent definition' },
  [SuggestionType.Prompt]: { dir: (r) => join(r.config, 'prompts'), noun: 'a prompt' },
  [SuggestionType.Extension]: {
    dir: (r) => join(r.home, '.github', 'extensions'),
    noun: 'an extension',
  },
  [SuggestionType.Automation]: {
    dir: (r) => join(r.scns, 'automations'),
    noun: 'a scheduled automation',
  },
  [SuggestionType.Mcp]: { dir: (r) => join(r.config, 'mcp'), noun: 'an MCP server registration' },
  [SuggestionType.GithubAction]: {
    dir: (r) => join(r.repo, '.github', 'workflows'),
    noun: 'a GitHub Actions workflow',
  },
  [SuggestionType.Instruction]: {
    dir: (r) => join(r.home, COPILOT_CONFIG_DIR),
    file: (r) => suggestedInstructionsPath(r.home),
    noun: 'a line of standing guidance',
  },
  [SuggestionType.Lsp]: {
    dir: (r) => join(r.home, COPILOT_CONFIG_DIR),
    file: (r) => lspConfigPath(r.home),
    noun: 'a language-server registration',
  },
  [SuggestionType.AgenticWorkflow]: {
    dir: (r) => join(r.config, 'skills'),
    noun: 'an agentic workflow',
  },
  [SuggestionType.TagProposal]: {
    dir: (r) => join(r.scns, 'memory'),
    noun: 'a lesson-taxonomy tag',
  },
}

/** Scan targets derived from the same map the spec text quotes. Single source of truth. */
export function capabilityScanSpecs(roots: ArtifactRoots): readonly CapabilityScanSpec[] {
  return Object.entries(DEFAULT_ARTIFACT_LOCATIONS).map(([kind, loc]) => ({
    kind,
    dir: loc!.dir(roots),
  }))
}

export interface ProposalSpec {
  readonly whatItIs: string
  readonly whatApprovalDoes: string
  readonly whoDoesTheWork: string
  readonly ifYouSayNo: string
  readonly noveltyStatus: 'novel' | 'unverified'
  readonly noveltyNote: string
  /** Model prose. Optional by design — the skeleton above stands on its own. */
  readonly elaboration?: string
}

function whoFor(complexity: Suggestion['estimatedComplexity']): string {
  if (complexity === 'team') return 'a team of agents (planner + implementer + reviewer)'
  if (complexity === 'complex') return 'a full team, with a review gate before anything merges'
  return 'a single agent'
}

export function buildProposalSpec(
  suggestion: Suggestion,
  triage: TriageResult,
  roots: ArtifactRoots,
  elaboration?: string,
): ProposalSpec {
  if (triage.outcome === 'duplicate') {
    throw new Error(
      'refusing to build a reviewable spec for a duplicate proposal — duplicates are auto-rejected and must never reach a human',
    )
  }

  const loc = DEFAULT_ARTIFACT_LOCATIONS[suggestion.type]
  const noun = loc?.noun ?? `a ${suggestion.type}`
  const where = loc ? (loc.file ?? loc.dir)(roots) : '(no standard location for this type)'

  const novelty =
    triage.outcome === 'novel'
      ? {
          noveltyStatus: 'novel' as const,
          noveltyNote:
            'Checked against the capabilities already built here and against what the assistant can already do natively; no overlap was found.',
        }
      : {
          noveltyStatus: 'unverified' as const,
          noveltyNote:
            'Whether this duplicates something that already exists has NOT been verified — the overlap check did not complete. Treat the case for it as unproven.',
        }

  return {
    whatItIs: `${noun} named "${suggestion.title.replace(/^\s*(create|add|build)\s+/i, '')}".`,
    whatApprovalDoes: `Approving queues the work; ${loc?.file ? 'the file written would be' : 'files would be written under'} ${where}. Nothing runs until you approve.`,
    whoDoesTheWork: `The work would be carried out by ${whoFor(suggestion.estimatedComplexity)}.`,
    ifYouSayNo:
      'Saying no records your reason and drops the proposal. It is not raised again unless the evidence behind it changes materially.',
    ...novelty,
    ...(elaboration ? { elaboration } : {}),
  }
}

/** Markdown for the suggestion's `## Implementation Plan` block and the weekly packet. */
export function renderProposalSpec(spec: ProposalSpec): string {
  const lines = [
    `**What this is** — ${spec.whatItIs}`,
    ``,
    // Never pad. If nobody worked out the behaviour, say so — that gap is the honest answer to
    // "what IS this?", and it is what makes `explain` the right verdict rather than a guess.
    spec.elaboration
      ? `**What it would do** — ${spec.elaboration}`
      : '**What it would do** — has not been worked out yet. This was raised from an observed pattern, not from a worked design.',
    ``,
    `**If you approve** — ${spec.whatApprovalDoes} ${spec.whoDoesTheWork}`,
    ``,
    `**If you say no** — ${spec.ifYouSayNo}`,
    ``,
    spec.noveltyStatus === 'novel'
      ? `**Not a duplicate** — ${spec.noveltyNote}`
      : `**⚠ Novelty unverified** — ${spec.noveltyNote}`,
  ]
  return lines.join('\n')
}
