import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createExecutor, StepAction } from '../../../src/suggest/executor.js'
import type { Suggestion } from '../../../src/suggest/types.js'

function base(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'automation',
    title: 'Nightly backup',
    description: 'Make a backup every night.',
    status: 'approved',
    confidence: 0.8,
    evidence: [],
    tags: [],
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:00:00Z',
    actionable: true,
    estimatedComplexity: 'solo',
    attemptCount: 0,
    lastError: null,
    lastAttemptAt: null,
    nextRetryAt: null,
    allowRepoWrites: false,
    ...overrides,
  }
}

describe('Executor safety gates (Phase 13.12.18)', () => {
  let configBaseDir: string
  let skillsDir: string
  let automationsDir: string
  let browserRunsDir: string
  let runnerPath: string

  beforeEach(() => {
    configBaseDir = mkdtempSync(join(tmpdir(), 'scns-gate-cfg-'))
    skillsDir = mkdtempSync(join(tmpdir(), 'scns-gate-skills-'))
    automationsDir = mkdtempSync(join(tmpdir(), 'scns-gate-auto-'))
    browserRunsDir = mkdtempSync(join(tmpdir(), 'scns-gate-brun-'))
    runnerPath = join(browserRunsDir, 'runner.mjs')
    writeFileSync(runnerPath, `#!/usr/bin/env node\nprocess.exit(0)`)
    delete process.env.SCNS_ALLOW_REPO_WRITES
  })

  afterEach(() => {
    for (const d of [configBaseDir, skillsDir, automationsDir, browserRunsDir]) {
      rmSync(d, { recursive: true, force: true })
    }
  })

  function makeExecutor(level = 2) {
    return createExecutor({
      autonomyLevel: level,
      skillsDir,
      automationsDir,
      configBaseDir,
      browserRunsDir,
      browserRunnerPath: runnerPath,
    })
  }

  describe('automation gate', () => {
    it('accepts plan writing inside automationsDir', () => {
      const ex = makeExecutor()
      const sug = base({ type: 'automation' })
      const plan = ex.generatePlan(sug)
      const result = ex.execute(plan, sug)
      expect(result.gateDecision).toBeUndefined()
      expect(result.success).toBe(true)
    })

    it('rejects plan whose step target escapes automationsDir', () => {
      const ex = makeExecutor()
      const sug = base({ type: 'automation' })
      const plan = {
        suggestionId: sug.id,
        steps: [
          {
            order: 1,
            action: StepAction.CreateFile,
            description: 'malicious',
            target: join(configBaseDir, 'outside.sh'),
            content: '#!/usr/bin/env bash\n',
          },
        ],
        estimatedMinutes: 1,
        requiresUserApproval: false,
      }
      const result = ex.execute(plan, sug)
      expect(result.gateDecision?.ok).toBe(false)
      expect(result.gateDecision?.status).toBe('rejected')
      expect(result.gateDecision?.reason).toMatch(/outside the automation safety gate/)
      expect(existsSync(join(configBaseDir, 'outside.sh'))).toBe(false)
    })
  })

  describe('github-action gate', () => {
    it('marks needs-human when allowRepoWrites is false', () => {
      const ex = makeExecutor()
      const sug = base({ type: 'github-action', allowRepoWrites: false })
      const plan = ex.generatePlan(sug)
      const result = ex.execute(plan, sug)
      expect(result.gateDecision?.ok).toBe(false)
      expect(result.gateDecision?.status).toBe('needs-human')
      expect(result.gateDecision?.reason).toMatch(/allowRepoWrites=true/)
    })

    it('marks needs-human when env SCNS_ALLOW_REPO_WRITES not set even with flag', () => {
      const ex = makeExecutor()
      const sug = base({ type: 'github-action', allowRepoWrites: true })
      const plan = ex.generatePlan(sug)
      const result = ex.execute(plan, sug)
      expect(result.gateDecision?.status).toBe('needs-human')
      expect(result.gateDecision?.reason).toMatch(/SCNS_ALLOW_REPO_WRITES/)
    })

    it('allows the REAL generated plan when both opt-ins are set', () => {
      process.env.SCNS_ALLOW_REPO_WRITES = '1'
      try {
        // This case used to hand-build a step under `configBaseDir`, with a comment conceding
        // that "the built-in generator produces a relative target ... which is outside
        // configBaseDir. So we expect rejection UNLESS we rebuild the step manually". That made
        // the gate look functional while every plan the executor could actually produce was
        // rejected. It now exercises the generated plan, so a builder/gate disagreement fails.
        const repoRoot = mkdtempSync(join(tmpdir(), 'scns-gate-repo-'))
        try {
          const ex = createExecutor({
            autonomyLevel: 2,
            skillsDir,
            automationsDir,
            configBaseDir,
            browserRunsDir,
            browserRunnerPath: runnerPath,
            repoRoot,
          })
          const sug = base({ type: 'github-action', allowRepoWrites: true })
          const plan = ex.generatePlan(sug)

          expect(plan.steps[0]!.target).toBe(
            // basename, not split('/'): the generated target uses `\` on win32.
            join(repoRoot, '.github', 'workflows', basename(plan.steps[0]!.target!)),
          )
          const result = ex.execute(plan, sug)
          expect(result.gateDecision).toBeUndefined()
          expect(result.success).toBe(true)
        } finally {
          rmSync(repoRoot, { recursive: true, force: true })
        }
      } finally {
        delete process.env.SCNS_ALLOW_REPO_WRITES
      }
    })
  })

  describe('instruction gate', () => {
    it('accepts write to managed copilot-instructions.md', () => {
      const ex = makeExecutor()
      const sug = base({ type: 'instruction' })
      const plan = ex.generatePlan(sug)
      const result = ex.execute(plan, sug)
      expect(result.gateDecision).toBeUndefined()
      expect(result.success).toBe(true)
    })

    it('rejects write to a different file under configBaseDir', () => {
      const ex = makeExecutor()
      const sug = base({ type: 'instruction' })
      const plan = {
        suggestionId: sug.id,
        steps: [
          {
            order: 1,
            action: StepAction.AppendToBlock,
            description: 'wrong file',
            target: join(configBaseDir, 'CLAUDE.md'),
            content: 'hi',
            blockStart: '<!-- s -->',
            blockEnd: '<!-- e -->',
          },
        ],
        estimatedMinutes: 1,
        requiresUserApproval: false,
      }
      const result = ex.execute(plan, sug)
      expect(result.gateDecision?.ok).toBe(false)
      expect(result.gateDecision?.reason).toMatch(/may only write/)
    })
  })

  describe('browser-automation gate', () => {
    it('accepts plan inside browserRunsDir', () => {
      const ex = makeExecutor()
      const sug = base({
        type: 'browser-automation',
        browserPlan: { steps: [{ op: 'navigate', url: 'https://example.com' }] },
      })
      const plan = ex.generatePlan(sug)
      const result = ex.execute(plan, sug)
      expect(result.gateDecision).toBeUndefined()
      // step 1 CreateFile should succeed; runner spawn may or may not work
      // depending on the stub we dropped — but we just want no gate rejection.
      expect(existsSync(join(browserRunsDir, sug.id, 'plan.json'))).toBe(true)
    })

    it('rejects a browser plan whose step target is outside browserRunsDir', () => {
      const ex = makeExecutor()
      const sug = base({ type: 'browser-automation' })
      const plan = {
        suggestionId: sug.id,
        steps: [
          {
            order: 1,
            action: StepAction.CreateFile,
            description: 'bad',
            target: join(configBaseDir, 'leak.json'),
            content: '{}',
          },
        ],
        estimatedMinutes: 1,
        requiresUserApproval: false,
      }
      const result = ex.execute(plan, sug)
      expect(result.gateDecision?.ok).toBe(false)
      expect(result.gateDecision?.reason).toMatch(/outside the browser-automation safety gate/)
    })
  })

  describe('skill/agent/prompt gates', () => {
    it('allows skill writes to skillsDir', () => {
      const ex = makeExecutor()
      const sug = base({ type: 'skill' })
      const plan = ex.generatePlan(sug)
      const result = ex.execute(plan, sug)
      expect(result.gateDecision).toBeUndefined()
      expect(result.success).toBe(true)
    })
  })

  describe('the gate cannot be opted out of', () => {
    it("gates a plan whose target is outside the suggestion type's allowed dirs", () => {
      // This block used to contain "skips gate check when suggestion arg omitted", which asserted
      // that calling `execute(plan)` with no suggestion bypassed the gate entirely — certifying
      // the bypass as intended behaviour. The quality-gate arbiter's artifact path took exactly
      // that route, so approved suggestions were written to disk ungated. The suggestion is now a
      // required argument, so the bypass is unrepresentable and this asserts the gate instead.
      const ex = makeExecutor()
      const outside = join(mkdtempSync(join(tmpdir(), 'scns-gate-outside-')), 'legacy.md')
      const plan = {
        suggestionId: 'x',
        steps: [
          {
            order: 1,
            action: StepAction.CreateFile,
            description: 'legacy',
            target: outside,
            content: 'hi',
          },
        ],
        estimatedMinutes: 1,
        requiresUserApproval: false,
      }

      const result = ex.execute(plan, base({ type: 'skill' }))

      expect(result.gateDecision?.ok).toBe(false)
      expect(result.success).toBe(false)
      expect(existsSync(outside)).toBe(false)
    })
  })
})
