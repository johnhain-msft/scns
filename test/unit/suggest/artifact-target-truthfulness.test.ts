/**
 * ARTIFACT-TARGET TRUTHFULNESS — the invariant that only ever existed as a doc comment.
 *
 * `proposal-spec.ts` claimed location facts "come from one shared location map, so the scan ...
 * and the sentence that tells John where this one would land can never disagree." Nothing enforced
 * it across the module boundary that mattered. The sentence he reviewed said
 * `<repo>/.github/instructions`; the approval wrote `~/.github/copilot-instructions.md`. Both
 * modules' own tests were green, because each asserted against its own private constant.
 *
 * This file asserts the CROSS-MODULE fact instead: for every suggestion type that writes a file,
 * the path `buildProposalSpec` shows the human is the path `generatePlan` actually targets. It is
 * deliberately written to fail on drift in EITHER direction — changing one constant without the
 * other breaks it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutor, StepAction } from '../../../src/suggest/executor.js'
import {
  buildProposalSpec,
  DEFAULT_ARTIFACT_LOCATIONS,
} from '../../../src/suggest/proposal-spec.js'
import { SuggestionType, type Suggestion } from '../../../src/suggest/types.js'
import type { TriageResult } from '../../../src/suggest/proposal-triage.js'

const NOVEL: TriageResult = { outcome: 'novel' } as TriageResult

function makeSuggestion(overrides: Partial<Suggestion>): Suggestion {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    type: SuggestionType.Instruction,
    title: 'Prefer single quotes',
    description: 'Prefer single quotes for strings.',
    status: 'approved',
    confidence: 0.9,
    actionable: true,
    estimatedComplexity: 'solo',
    tags: [],
    evidence: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attemptCount: 0,
    nextRetryAt: null,
    ...overrides,
  } as Suggestion
}

/**
 * The types whose approval writes to ONE known file. Each names the tags the executor needs to
 * resolve the artifact, so the case is executable rather than hypothetical.
 */
const FILE_WRITING_TYPES: readonly { type: string; tags: readonly string[] }[] = [
  { type: SuggestionType.Instruction, tags: [] },
  { type: SuggestionType.Lsp, tags: ['lsp', 'python'] },
]

describe('artifact-target truthfulness', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'scns-target-truth-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  for (const { type, tags } of FILE_WRITING_TYPES) {
    it(`tells the human the same path the executor writes, for type "${type}"`, () => {
      const suggestion = makeSuggestion({ type: type as Suggestion['type'], tags: [...tags] })

      const spec = buildProposalSpec(suggestion, NOVEL, {
        home,
        config: join(home, '.copilot'),
        scns: join(home, '.scns'),
        repo: '/some/unrelated/repo',
      })

      const executor = createExecutor({
        configBaseDir: home,
        skillsDir: join(home, '.scns', 'skills'),
        automationsDir: join(home, '.scns', 'automations'),
      })
      const plan = executor.generatePlan(suggestion)
      const written = plan.steps.find((s) => s.target !== undefined)?.target

      expect(written, `type "${type}" generated no step with a target`).toBeDefined()
      // The exact string John reads must contain the exact path that gets written. Substring
      // rather than equality because the sentence is prose; the path inside it must be literal.
      expect(spec.whatApprovalDoes).toContain(written!)
    })

    it(`never points type "${type}" at a repository working tree`, () => {
      const suggestion = makeSuggestion({ type: type as Suggestion['type'], tags: [...tags] })
      const repo = '/some/unrelated/repo'

      const spec = buildProposalSpec(suggestion, NOVEL, {
        home,
        config: join(home, '.copilot'),
        scns: join(home, '.scns'),
        repo,
      })

      // These artifacts are user-scope machine preferences derived from cross-project observation.
      // Describing them as landing in whatever repo happened to be `process.cwd()` at triage time
      // is how a global preference came to be advertised as a commit into an unrelated project.
      expect(spec.whatApprovalDoes).not.toContain(repo)
    })
  }

  it('gives every file-writing location map entry a `file`, not just a `dir`', () => {
    for (const { type } of FILE_WRITING_TYPES) {
      const loc = DEFAULT_ARTIFACT_LOCATIONS[type]
      expect(loc, `no location entry for "${type}"`).toBeDefined()
      expect(loc!.file, `"${type}" writes one known file and must advertise it exactly`).toBeTypeOf(
        'function',
      )
    }
  })

  it('routes an lsp suggestion to the LSP registry, never to an instructions file', () => {
    const executor = createExecutor({
      configBaseDir: home,
      skillsDir: join(home, '.scns', 'skills'),
      automationsDir: join(home, '.scns', 'automations'),
    })
    const plan = executor.generatePlan(
      makeSuggestion({ type: SuggestionType.Lsp as Suggestion['type'], tags: ['lsp', 'python'] }),
    )

    // The original defect in one assertion: configuring a language server must not degrade into
    // appending a sentence of prose to a markdown file.
    expect(plan.steps.map((s) => s.action)).not.toContain(StepAction.AppendToBlock)
    expect(plan.steps[0]!.action).toBe(StepAction.ConfigureLspServer)
    expect(plan.steps[0]!.target).toBe(join(home, '.copilot', 'lsp-config.json'))
  })
})

/**
 * Every type, no exceptions. `lsp` shipped for months as a member of the enum that no code path
 * could reach: its gate returned `writableDirs: []` and its builder emitted a step with no
 * `target`. Eight tests covered that dead path and all eight were green, because each asserted a
 * property the defect happened to satisfy (the step's `action`) and none asserted the property it
 * violated (the step's `target`). The project already had the right instinct — enumerate every
 * `SuggestionType` — but aimed it at the dashboard dropdown instead of the executor.
 *
 * So: each type must be reachable as an artifact (a targeted step, permitted by its own gate) or
 * explicitly declared human-only. "Present in the enum but silently inert" is now a failure.
 */
/** Tags some builders need to resolve a concrete artifact. */
const RESOLVING_TAGS: Readonly<Record<string, readonly string[]>> = {
  lsp: ['lsp', 'python'],
}

describe('no dead suggestion types', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'scns-dead-type-'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  for (const type of Object.values(SuggestionType)) {
    it(`type "${type}" is executable or refuses out loud, never silently inert`, async () => {
      const suggestion = makeSuggestion({
        type: type as Suggestion['type'],
        tags: [...(RESOLVING_TAGS[type] ?? [])],
        // `github-action` deliberately requires an explicit opt-in before touching a repo. Grant
        // it here so the case tests path agreement instead of stopping at the intended guard.
        ...(type === SuggestionType.GithubAction ? { allowRepoWrites: true } : {}),
      })
      // Repo writes are guarded by BOTH a per-suggestion flag and an operator env var. Satisfying
      // both keeps the case aimed at path agreement rather than re-testing the intended guard.
      if (type === SuggestionType.GithubAction) vi.stubEnv('SCNS_ALLOW_REPO_WRITES', '1')
      const executor = createExecutor({
        configBaseDir: home,
        skillsDir: join(home, '.scns', 'skills'),
        automationsDir: join(home, '.scns', 'automations'),
        // Sandboxed explicitly. Left to its `process.cwd()` default, the repo-writing types write
        // into the checkout running the tests — this case created a real `.github/workflows/`
        // entry in the working tree before this was pinned down.
        repoRoot: join(home, 'repo'),
        autonomyLevel: 2,
      })

      let plan
      try {
        plan = executor.generatePlan(suggestion)
      } catch (err) {
        // A thrown NEEDS_HUMAN (human required) or INVALID_STATE (required payload absent) is a
        // LOUD refusal — the brain escalates and John sees it. That is
        // the acceptable alternative to executing. Silent inertness is what this test forbids.
        expect(
          ['NEEDS_HUMAN', 'INVALID_STATE'],
          `type "${type}" failed to plan for a reason other than a stated refusal`,
        ).toContain((err as { code?: string }).code)
        return
      }

      // Reachable means it actually names a destination. A step with no target is the exact shape
      // the dead `lsp` path had: it plans, it passes, and it writes nothing.
      const targeted = plan.steps.filter((s) => s.target !== undefined)
      expect(targeted.length, `type "${type}" planned no step with a target`).toBeGreaterThan(0)

      // ...and the safety gate must permit the very path the plan targets. `lsp` returned
      // `writableDirs: []`, so its own gate rejected every plan it could ever produce.
      const result = await executor.execute(plan, suggestion)
      if (
        result.gateDecision?.status === 'needs-human' &&
        /is not installed/.test(result.gateDecision.reason ?? '')
      ) {
        // The LSP preflight escalating because the server binary is absent on
        // THIS host (e.g. no pyright on the CI runner) is a loud refusal with
        // an install hint — the opposite of the silent inertness this test
        // forbids. Any other needs-human/rejection still fails below.
        return
      }
      expect(
        result.gateDecision?.ok,
        `type "${type}" is gate-blocked from its own target: ${result.gateDecision?.reason ?? ''}`,
      ).not.toBe(false)
    })
  }
})
