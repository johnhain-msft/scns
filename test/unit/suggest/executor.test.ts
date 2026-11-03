import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createExecutor, StepAction } from '../../../src/suggest/executor.js'
import type { ImplementationPlan } from '../../../src/suggest/executor.js'
import type { Suggestion } from '../../../src/suggest/types.js'

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'skill',
    title: 'Create git-commit helper skill',
    description: 'You frequently run the same git commit pattern.',
    status: 'approved',
    confidence: 0.85,
    evidence: [
      {
        source: 'tool-frequency',
        detail: 'Git used 45 times in last 7 days',
        observedAt: '2025-01-15T10:00:00Z',
        weight: 0.8,
      },
    ],
    tags: ['git', 'automation'],
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:00:00Z',
    ...overrides,
  }
}

describe('Executor', () => {
  let skillsDir: string
  let automationsDir: string
  let configBaseDir: string

  beforeEach(() => {
    skillsDir = mkdtempSync(join(tmpdir(), 'scns-skills-'))
    automationsDir = mkdtempSync(join(tmpdir(), 'scns-automations-'))
    configBaseDir = mkdtempSync(join(tmpdir(), 'scns-config-'))
  })

  afterEach(() => {
    rmSync(skillsDir, { recursive: true, force: true })
    rmSync(automationsDir, { recursive: true, force: true })
    rmSync(configBaseDir, { recursive: true, force: true })
  })

  describe('generatePlan', () => {
    it('generates CreateFile + ConfigureAgent steps for skill suggestions', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({ type: 'skill' })
      const plan = executor.generatePlan(suggestion)

      expect(plan.suggestionId).toBe(suggestion.id)
      expect(plan.steps).toHaveLength(2)
      expect(plan.steps[0]!.action).toBe(StepAction.CreateFile)
      expect(plan.steps[1]!.action).toBe(StepAction.ConfigureAgent)
    })

    it('generates ConfigureAgent-only step for mcp suggestions (artifact-only per 13.12.1)', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({ type: 'mcp', title: 'Install MCP filesystem server' })
      const plan = executor.generatePlan(suggestion)

      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0]!.action).toBe(StepAction.ConfigureAgent)
      expect(plan.steps.some((s) => s.action === StepAction.RunCommand)).toBe(false)
    })

    it('generates CreateFile-only step for automation suggestions (artifact-only per 13.12.1)', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({ type: 'automation', title: 'Auto-format on save' })
      const plan = executor.generatePlan(suggestion)

      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0]!.action).toBe(StepAction.CreateFile)
      expect(plan.steps.some((s) => s.action === StepAction.RunCommand)).toBe(false)
    })

    it('workflow-type throws NEEDS_HUMAN (13.12.1 amendment)', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({ type: 'workflow', title: 'PR review workflow' })
      expect(() => executor.generatePlan(suggestion)).toThrow(/workflow/)
    })

    /**
     * T030 / FR-037b (specs/003-label-integrity-defects) — REGRESSION PIN, must pass before AND after.
     *
     * T032 loosens the verdict's invocation condition, so `promote = true` can now be produced more
     * often. That is only safe because an `arm-promotion` NEVER auto-executes: it files a pending
     * suggestion and waits for John. This matters more than it looks — measured against the unmodified
     * gate, a 5-vs-5 sample with a large clean separation DOES clear the one-sided 95% bound
     * (LB +0.6860), so the bound is not the backstop at small n. THIS is the backstop.
     */
    it('T030 [FR-037b] arm-promotion NEVER auto-executes, at ANY autonomy level', () => {
      const suggestion = makeSuggestion({ type: 'arm-promotion', title: 'Promote multihop-iter' })
      // `autonomyLevel` is a createExecutor OPTION, not a Suggestion field. The first version of this
      // test spread it onto the suggestion, where `generatePlan` ignores it — so the loop ran the
      // identical level-0 assertion six times and levels 1,2,4,5 were unpinned across the whole suite.
      // A judge proved it by making the refusal conditional on `autonomyLevel !== 4`: 820 tests passed.
      for (const autonomyLevel of [0, 1, 2, 3, 4, 5]) {
        const executor = createExecutor({
          skillsDir,
          automationsDir,
          configBaseDir,
          autonomyLevel,
        })
        expect(
          () => executor.generatePlan(suggestion),
          `autonomy ${autonomyLevel} must refuse`,
        ).toThrow(/arm-promotion needs a human decision/)
      }
    })

    it('generates CreateFile + ConfigureAgent steps for agent suggestions', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({ type: 'agent', title: 'Code review agent' })
      const plan = executor.generatePlan(suggestion)

      expect(plan.steps).toHaveLength(2)
      expect(plan.steps[0]!.action).toBe(StepAction.CreateFile)
      expect(plan.steps[1]!.action).toBe(StepAction.ConfigureAgent)
    })

    it('sets correct estimatedMinutes for each type', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })

      expect(executor.generatePlan(makeSuggestion({ type: 'skill' })).estimatedMinutes).toBe(5)
      expect(executor.generatePlan(makeSuggestion({ type: 'mcp' })).estimatedMinutes).toBe(10)
      expect(executor.generatePlan(makeSuggestion({ type: 'automation' })).estimatedMinutes).toBe(
        15,
      )
      // workflow throws NEEDS_HUMAN (13.12.1); estimatedMinutes unused.
      expect(executor.generatePlan(makeSuggestion({ type: 'agent' })).estimatedMinutes).toBe(10)
    })

    it('generates CreateFile step for prompt suggestions', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({
        type: 'prompt' as Suggestion['type'],
        title: 'Add debug prompt',
      })
      const plan = executor.generatePlan(suggestion)

      expect(plan.steps.length).toBeGreaterThanOrEqual(1)
      expect(plan.steps[0]!.action).toBe(StepAction.CreateFile)
    })

    it('generates CreateFile step for extension suggestions', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({
        type: 'extension' as Suggestion['type'],
        title: 'Auto-test extension',
      })
      const plan = executor.generatePlan(suggestion)

      expect(plan.steps.length).toBeGreaterThanOrEqual(1)
      expect(plan.steps[0]!.action).toBe(StepAction.CreateFile)
      expect(plan.steps[0]!.target).toContain('.js')
    })

    // Was: "generates ModifyFile step for lsp suggestions", asserting only the ACTION of a step
    // that carried no `target` and therefore wrote nothing. That green test is why the `lsp` type
    // could sit dead long enough for the extractor to route around it via `instruction`.
    it('generates a targeted ConfigureLspServer step for lsp suggestions', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({
        type: 'lsp' as Suggestion['type'],
        title: 'Configure TS LSP',
        tags: ['lsp', 'typescript'],
      })
      const plan = executor.generatePlan(suggestion)

      expect(plan.steps.length).toBeGreaterThanOrEqual(1)
      expect(plan.steps[0]!.action).toBe(StepAction.ConfigureLspServer)
      expect(plan.steps[0]!.target).toBe(join(configBaseDir, '.copilot', 'lsp-config.json'))
      expect(JSON.parse(plan.steps[0]!.content!)).toEqual({
        typescript: {
          command: 'typescript-language-server',
          args: ['--stdio'],
          fileExtensions: expect.objectContaining({ '.ts': 'typescript' }),
        },
      })
    })

    it('generates CreateFile step for github-action suggestions', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({
        type: 'github-action' as Suggestion['type'],
        title: 'CI pipeline',
      })
      const plan = executor.generatePlan(suggestion)

      expect(plan.steps.length).toBeGreaterThanOrEqual(1)
      expect(plan.steps[0]!.action).toBe(StepAction.CreateFile)
      expect(plan.steps[0]!.target).toContain('.yml')
    })

    it('generates CreateFile step for agentic-workflow suggestions', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({
        type: 'agentic-workflow' as Suggestion['type'],
        title: 'Deploy workflow',
      })
      const plan = executor.generatePlan(suggestion)

      expect(plan.steps.length).toBeGreaterThanOrEqual(1)
      expect(plan.steps[0]!.action).toBe(StepAction.CreateFile)
    })

    it('generates AppendToBlock step for instruction suggestions (13.12.7)', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({
        type: 'instruction' as Suggestion['type'],
        title: 'Add code style instruction',
        description: 'Prefer single quotes for strings.',
      })
      const plan = executor.generatePlan(suggestion)

      expect(plan.steps.length).toBeGreaterThanOrEqual(1)
      expect(plan.steps[0]!.action).toBe(StepAction.AppendToBlock)
      expect(plan.steps[0]!.target).toBe(join(configBaseDir, '.copilot', 'copilot-instructions.md'))
      expect(plan.steps[0]!.content).toContain('Prefer single quotes')
    })

    it('sets correct estimatedMinutes for new types', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })

      expect(
        executor.generatePlan(makeSuggestion({ type: 'prompt' as Suggestion['type'] }))
          .estimatedMinutes,
      ).toBe(2)
      expect(
        executor.generatePlan(makeSuggestion({ type: 'extension' as Suggestion['type'] }))
          .estimatedMinutes,
      ).toBe(10)
      expect(
        executor.generatePlan(
          makeSuggestion({ type: 'lsp' as Suggestion['type'], tags: ['lsp', 'python'] }),
        ).estimatedMinutes,
      ).toBe(3)
      expect(
        executor.generatePlan(makeSuggestion({ type: 'github-action' as Suggestion['type'] }))
          .estimatedMinutes,
      ).toBe(15)
      expect(
        executor.generatePlan(makeSuggestion({ type: 'agentic-workflow' as Suggestion['type'] }))
          .estimatedMinutes,
      ).toBe(20)
      expect(
        executor.generatePlan(makeSuggestion({ type: 'instruction' as Suggestion['type'] }))
          .estimatedMinutes,
      ).toBe(2)
    })

    it('throws for unknown suggestion type', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({ type: 'totally-unknown' as Suggestion['type'] })

      expect(() => executor.generatePlan(suggestion)).toThrow(
        'No step builder for suggestion type: totally-unknown',
      )
    })

    it('assigns sequential step order starting at 1', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      // Use 'skill' (2 steps) since automation is now single-step.
      const plan = executor.generatePlan(makeSuggestion({ type: 'skill' }))

      expect(plan.steps[0]!.order).toBe(1)
      expect(plan.steps[1]!.order).toBe(2)
    })

    it('sets requiresUserApproval true at L0', () => {
      const executor = createExecutor({
        autonomyLevel: 0,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const plan = executor.generatePlan(makeSuggestion())
      expect(plan.requiresUserApproval).toBe(true)
    })

    it('sets requiresUserApproval true at L1', () => {
      const executor = createExecutor({
        autonomyLevel: 1,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const plan = executor.generatePlan(makeSuggestion())
      expect(plan.requiresUserApproval).toBe(true)
    })

    it('sets requiresUserApproval false at L2', () => {
      const executor = createExecutor({
        autonomyLevel: 2,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const plan = executor.generatePlan(makeSuggestion())
      expect(plan.requiresUserApproval).toBe(false)
    })

    it('sets requiresUserApproval false at L3', () => {
      const executor = createExecutor({
        autonomyLevel: 3,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const plan = executor.generatePlan(makeSuggestion())
      expect(plan.requiresUserApproval).toBe(false)
    })

    it('includes target path for CreateFile steps', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({ type: 'skill' })
      const plan = executor.generatePlan(suggestion)

      const createStep = plan.steps.find((s) => s.action === StepAction.CreateFile)
      expect(createStep?.target).toContain(suggestion.id)
    })

    it('includes content for CreateFile steps', () => {
      const executor = createExecutor({ skillsDir, automationsDir, configBaseDir })
      const suggestion = makeSuggestion({ type: 'skill' })
      const plan = executor.generatePlan(suggestion)

      const createStep = plan.steps.find((s) => s.action === StepAction.CreateFile)
      expect(createStep?.content).toBeDefined()
      expect(createStep!.content!.length).toBeGreaterThan(0)
    })
  })

  describe('canAutoExecute', () => {
    it('returns false at L0', () => {
      const executor = createExecutor({
        autonomyLevel: 0,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      expect(executor.canAutoExecute()).toBe(false)
    })

    it('returns false at L1', () => {
      const executor = createExecutor({
        autonomyLevel: 1,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      expect(executor.canAutoExecute()).toBe(false)
    })

    it('returns true at L2', () => {
      const executor = createExecutor({
        autonomyLevel: 2,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      expect(executor.canAutoExecute()).toBe(true)
    })

    it('returns true at L3', () => {
      const executor = createExecutor({
        autonomyLevel: 3,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      expect(executor.canAutoExecute()).toBe(true)
    })
  })

  describe('execute', () => {
    it('returns 0 steps completed at L0', () => {
      const executor = createExecutor({
        autonomyLevel: 0,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const plan = executor.generatePlan(makeSuggestion())
      const result = executor.execute(plan, makeSuggestion())

      expect(result.success).toBe(true)
      expect(result.stepsCompleted).toBe(0)
      expect(result.stepsTotal).toBe(plan.steps.length)
    })

    it('returns 0 steps completed at L1', () => {
      const executor = createExecutor({
        autonomyLevel: 1,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const plan = executor.generatePlan(makeSuggestion())
      const result = executor.execute(plan, makeSuggestion())

      expect(result.success).toBe(true)
      expect(result.stepsCompleted).toBe(0)
    })

    it('executes CreateFile and ConfigureAgent steps at L2', () => {
      const executor = createExecutor({
        autonomyLevel: 2,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const plan = executor.generatePlan(makeSuggestion({ type: 'skill' }))
      const result = executor.execute(plan, makeSuggestion({ type: 'skill' }))

      expect(result.success).toBe(true)
      expect(result.stepsCompleted).toBe(2)
      expect(result.filesCreated.length).toBeGreaterThan(0)
    })

    it('skips RunCommand steps at L2', () => {
      const executor = createExecutor({
        autonomyLevel: 2,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      // Phase 13.12.1: type-based plans no longer include RunCommand (those
      // types are artifact-only). Build a mixed plan manually to assert the
      // executor still skips RunCommand when autonomy < 3.
      const plan: ImplementationPlan = {
        suggestionId: '550e8400-e29b-41d4-a716-446655440099',
        steps: [
          {
            order: 1,
            action: StepAction.CreateFile,
            description: 'file',
            target: join(skillsDir, 'x.txt'),
            content: 'hi',
          },
          {
            order: 2,
            action: StepAction.RunCommand,
            description: 'cmd',
            content: 'echo hi',
          },
        ],
        estimatedMinutes: 5,
        requiresUserApproval: false,
      }
      const result = executor.execute(plan, makeSuggestion({ type: 'skill' }))

      // Only CreateFile should execute; RunCommand returns an error at L2.
      expect(result.stepsCompleted).toBe(1)
      expect(result.stepsTotal).toBe(2)
    })

    it('executes all steps including RunCommand at L3', () => {
      const executor = createExecutor({
        autonomyLevel: 3,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const suggestion = makeSuggestion({ type: 'skill' })
      const plan = executor.generatePlan(suggestion)
      const result = executor.execute(plan, suggestion)

      expect(result.stepsCompleted).toBe(plan.steps.length)
    })

    it('creates file at target path for CreateFile steps', () => {
      const executor = createExecutor({
        autonomyLevel: 2,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const suggestion = makeSuggestion({ type: 'skill' })
      const plan = executor.generatePlan(suggestion)
      executor.execute(plan, suggestion)

      const createStep = plan.steps.find((s) => s.action === StepAction.CreateFile)
      expect(existsSync(createStep!.target!)).toBe(true)
    })

    it('adds failed step to errors array and continues', () => {
      const executor = createExecutor({
        autonomyLevel: 2,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const suggestion = makeSuggestion({ type: 'skill' })
      const plan = executor.generatePlan(suggestion)

      // Corrupt the first step's target so writing it fails, while keeping it INSIDE the skill
      // gate — an out-of-gate path is now rejected wholesale before any step runs, which would
      // test the gate rather than per-step error recovery. A regular file standing where a parent
      // directory is expected makes the write fail with ENOTDIR.
      mkdirSync(skillsDir, { recursive: true })
      const blocker = join(skillsDir, 'blocker')
      writeFileSync(blocker, 'not a directory')
      const corruptedPlan = {
        ...plan,
        steps: [{ ...plan.steps[0]!, target: join(blocker, 'file.md') }, plan.steps[1]!],
      }

      const result = executor.execute(corruptedPlan, suggestion)
      expect(result.errors.length).toBeGreaterThan(0)
      // Should still attempt the second step
      expect(result.stepsCompleted).toBeGreaterThanOrEqual(1)
    })

    it('tracks filesCreated in execution result', () => {
      const executor = createExecutor({
        autonomyLevel: 2,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const suggestion = makeSuggestion({ type: 'skill' })
      const plan = executor.generatePlan(suggestion)
      const result = executor.execute(plan, suggestion)

      expect(result.filesCreated.length).toBeGreaterThan(0)
      for (const f of result.filesCreated) {
        expect(existsSync(f)).toBe(true)
      }
    })

    it('handles empty plan successfully', () => {
      const executor = createExecutor({
        autonomyLevel: 3,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const emptyPlan = {
        suggestionId: 'test',
        steps: [] as const,
        estimatedMinutes: 0,
        requiresUserApproval: false,
      }
      const result = executor.execute(emptyPlan, makeSuggestion({ type: 'skill' }))

      expect(result.success).toBe(true)
      expect(result.stepsCompleted).toBe(0)
      expect(result.stepsTotal).toBe(0)
      expect(result.errors).toHaveLength(0)
    })

    it('instruction plan appends bullet to managed block (13.12.7)', async () => {
      const executor = createExecutor({
        autonomyLevel: 2,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const suggestion = makeSuggestion({
        type: 'instruction' as Suggestion['type'],
        title: 'Prefer single quotes for strings',
        description: 'Always use single quotes in TS/JS code to match Prettier config.',
      })
      const plan = executor.generatePlan(suggestion)
      const result = executor.execute(plan, suggestion)

      expect(result.success).toBe(true)
      expect(result.stepsCompleted).toBeGreaterThan(0)

      const { readFileSync } = await import('node:fs')
      const targetPath = join(configBaseDir, '.copilot', 'copilot-instructions.md')
      expect(existsSync(targetPath)).toBe(true)
      const content = readFileSync(targetPath, 'utf-8')
      expect(content).toContain('<!-- SCNS:suggested-instructions:start -->')
      expect(content).toContain('<!-- SCNS:suggested-instructions:end -->')
      expect(content).toContain('single quotes')
    })

    it('instruction plan is idempotent when executed twice (13.12.7)', async () => {
      const executor = createExecutor({
        autonomyLevel: 2,
        skillsDir,
        automationsDir,
        configBaseDir,
      })
      const suggestion = makeSuggestion({
        type: 'instruction' as Suggestion['type'],
        title: 'Use Pino for logging',
        description: 'Never use console.log. Use Pino structured logging.',
      })
      const plan = executor.generatePlan(suggestion)
      executor.execute(plan, suggestion)
      executor.execute(plan, suggestion)

      const { readFileSync } = await import('node:fs')
      const targetPath = join(configBaseDir, '.copilot', 'copilot-instructions.md')
      const content = readFileSync(targetPath, 'utf-8')
      const matches = content.match(/Never use console\.log\. Use Pino structured logging\./g) ?? []
      expect(matches.length).toBe(1)
    })
  })
})
