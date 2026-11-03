/**
 * Phase 13.12.1 — Artifact-only suggestion types must never generate RunCommand steps.
 *
 * At autonomy L2 the brain can auto-execute plans but RunCommand is gated at L3+.
 * Types like automation/skill/agent/instruction/prompt/extension/mcp should only
 * WRITE ARTIFACTS — installing or invoking them is a separate, explicit action.
 *
 * If these types emit RunCommand steps, their plans permanently fail at L2,
 * looping on every brain wake and flooding logs (see dogfood finding
 * 2026-04-17 — 7 stuck suggestions).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createExecutor, StepAction } from '../../../src/suggest/executor.js'
import type { Suggestion, SuggestionType } from '../../../src/suggest/types.js'

function makeSuggestion(type: SuggestionType, overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type,
    title: `Sample ${type} suggestion`,
    description: 'Generated for artifact-only assertion.',
    status: 'approved',
    confidence: 0.9,
    evidence: [
      {
        source: 'unit-test',
        detail: 'fixture',
        observedAt: '2026-04-17T00:00:00Z',
        weight: 0.5,
      },
    ],
    tags: [],
    createdAt: '2026-04-17T00:00:00Z',
    updatedAt: '2026-04-17T00:00:00Z',
    actionable: true,
    estimatedComplexity: 'solo',
    ...overrides,
  }
}

const ARTIFACT_ONLY_TYPES: readonly SuggestionType[] = [
  'automation',
  'skill',
  'agent',
  'instruction',
  'prompt',
  'extension',
  'mcp',
]

describe('Executor — artifact-only types never generate RunCommand steps', () => {
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

  for (const type of ARTIFACT_ONLY_TYPES) {
    for (const autonomyLevel of [0, 1, 2, 3]) {
      it(`type=${type} at autonomy L${autonomyLevel} has no RunCommand step`, () => {
        const executor = createExecutor({
          autonomyLevel,
          skillsDir,
          automationsDir,
          configBaseDir,
        })
        const plan = executor.generatePlan(makeSuggestion(type))
        const runCommandSteps = plan.steps.filter((s) => s.action === StepAction.RunCommand)
        expect(runCommandSteps).toEqual([])
      })
    }
  }

  it('automation plan executes successfully end-to-end at L2 with no errors', () => {
    const executor = createExecutor({
      autonomyLevel: 2,
      skillsDir,
      automationsDir,
      configBaseDir,
    })
    const suggestion = makeSuggestion('automation')
    const plan = executor.generatePlan(suggestion)
    const result = executor.execute(plan, suggestion)

    // Must succeed — previously failed because of the gated chmod RunCommand
    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.stepsCompleted).toBe(plan.steps.length)
    expect(result.filesCreated.length).toBeGreaterThan(0)
  })

  it('mcp plan executes successfully end-to-end at L2 with no errors', () => {
    const executor = createExecutor({
      autonomyLevel: 2,
      skillsDir,
      automationsDir,
      configBaseDir,
    })
    const suggestion = makeSuggestion('mcp')
    const plan = executor.generatePlan(suggestion)
    const result = executor.execute(plan, suggestion)

    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.stepsCompleted).toBe(plan.steps.length)
  })
})

describe('Executor — workflow-type needs human planner (13.12.1 amendment)', () => {
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

  it('generatePlan throws ScnsError(NEEDS_HUMAN) for workflow type', () => {
    const executor = createExecutor({
      autonomyLevel: 2,
      skillsDir,
      automationsDir,
      configBaseDir,
    })
    const suggestion = makeSuggestion('workflow')
    try {
      executor.generatePlan(suggestion)
      expect.fail('generatePlan should have thrown for workflow type')
    } catch (err) {
      expect(err).toBeDefined()
      // ScnsError has a `code` property — runtime check without importing
      // the class to keep test assertions focused on behavior.
      const maybe = err as { code?: string; message?: string }
      expect(maybe.code).toBe('NEEDS_HUMAN')
      expect(maybe.message).toContain('workflow')
    }
  })
})
