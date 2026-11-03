import { describe, it, expect } from 'vitest'
import { createTaskClassifier } from '../../../src/brain/classifier.js'
import type { TaskInput } from '../../../src/brain/task-types.js'

function classify(description: string, extra?: Partial<TaskInput>) {
  const classifier = createTaskClassifier()
  return classifier.classify({ description, ...extra })
}

function features(description: string, extra?: Partial<TaskInput>) {
  const classifier = createTaskClassifier()
  return classifier.extractFeatures({ description, ...extra })
}

// ── Feature Extraction ──────────────────────────────────────────────

describe('extractFeatures', () => {
  it('extracts parallel signals from "do A and B and C"', () => {
    const f = features('do A and B and C')
    expect(f.hasParallelOpportunity).toBe(true)
    expect(f.keywordSignals).toEqual(expect.arrayContaining(['and']))
  })

  it('extracts sequential signals from "first do X, then Y"', () => {
    const f = features('first do X, then Y')
    expect(f.hasDependencyChain).toBe(true)
    expect(f.keywordSignals).toEqual(expect.arrayContaining(['then']))
  })

  it('detects I/O overlap from "shared database"', () => {
    const f = features('update shared database tables')
    expect(f.hasIOOverlap).toBe(true)
  })

  it('counts subtasks from bullet points', () => {
    const f = features('Tasks:\n- build auth\n- build payments\n- build email')
    expect(f.subtaskCount).toBeGreaterThanOrEqual(3)
  })

  it('counts subtasks from numbered lists', () => {
    const f = features('1. design schema 2. implement API 3. write tests 4. deploy')
    expect(f.subtaskCount).toBeGreaterThanOrEqual(4)
  })

  it('counts subtasks from comma-separated items', () => {
    const f = features('implement login, registration, and password reset')
    expect(f.subtaskCount).toBeGreaterThanOrEqual(3)
  })

  it('uses estimatedSubtasks hint when provided', () => {
    const f = features('do stuff', { estimatedSubtasks: 7 })
    expect(f.subtaskCount).toBe(7)
  })

  it('returns simple features for no signals', () => {
    const f = features('deploy')
    expect(f.subtaskCount).toBeLessThanOrEqual(1)
    expect(f.hasDependencyChain).toBe(false)
    expect(f.hasParallelOpportunity).toBe(false)
    expect(f.hasIOOverlap).toBe(false)
    expect(f.keywordSignals.length).toBe(0)
  })
})

// ── Strategy Classification ─────────────────────────────────────────

describe('strategy classification', () => {
  it('"Fix a typo in README" → Solo, Trivial', () => {
    const r = classify('Fix a typo in README')
    expect(r.strategy).toBe('solo')
    expect(r.complexity).toBe('trivial')
  })

  it('"Add a new button to the homepage" → Solo, Simple', () => {
    const r = classify('Add a new button to the homepage')
    expect(r.strategy).toBe('solo')
    expect(r.complexity).toBe('simple')
  })

  it('"Build user auth and payment processing and email service" → Parallel, Moderate', () => {
    const r = classify('Build user auth and payment processing and email service')
    expect(r.strategy).toBe('parallel')
    expect(r.complexity).toBe('moderate')
  })

  it('"First design the schema, then implement the API, then write tests" → Sequential, Moderate', () => {
    const r = classify('First design the schema, then implement the API, then write tests')
    expect(r.strategy).toBe('sequential')
    expect(r.complexity).toBe('moderate')
  })

  it('"Research competitors and simultaneously build prototype" → Hybrid, Moderate', () => {
    const r = classify('Research competitors and simultaneously build prototype')
    expect(r.strategy).toBe('hybrid')
    expect(r.complexity).toBe('moderate')
  })

  it('"Refactor the entire microservice architecture across 8 services" → Parallel, Complex', () => {
    const r = classify('Refactor the entire microservice architecture across 8 services')
    expect(r.strategy).toBe('parallel')
    expect(r.complexity).toBe('complex')
  })

  it('"Update the config value" → Solo, Trivial', () => {
    const r = classify('Update the config value')
    expect(r.strategy).toBe('solo')
    expect(r.complexity).toBe('trivial')
  })

  it('"Implement login page, registration page, and password reset independently" → Parallel, Simple', () => {
    const r = classify('Implement login page, registration page, and password reset independently')
    expect(r.strategy).toBe('parallel')
    expect(r.complexity).toBe('simple')
  })

  it('"Step 1: gather requirements. Step 2: design API. Step 3: implement. Step 4: test." → Sequential, Complex', () => {
    const r = classify(
      'Step 1: gather requirements. Step 2: design API. Step 3: implement. Step 4: test.',
    )
    expect(r.strategy).toBe('sequential')
    expect(r.complexity).toBe('complex')
  })

  it('"Research best practices, then implement auth (JWT + OAuth simultaneously), then integrate" → Hybrid, Complex', () => {
    const r = classify(
      'Research best practices, then implement auth (JWT + OAuth simultaneously), then integrate',
    )
    expect(r.strategy).toBe('hybrid')
    expect(r.complexity).toBe('complex')
  })

  it('single word task "deploy" → Solo, Trivial', () => {
    const r = classify('deploy')
    expect(r.strategy).toBe('solo')
    expect(r.complexity).toBe('trivial')
  })

  it('task with constraints influences complexity', () => {
    const r = classify('Add a button', {
      constraints: ['must use TypeScript', 'TDD required', 'accessibility compliant'],
    })
    // Constraints add complexity signal
    expect(r.complexity).not.toBe('trivial')
  })

  it('task with external dependencies increases complexity', () => {
    const r = classify('Add a button', {
      dependencies: ['react', 'tailwind', 'storybook'],
    })
    expect(r.complexity).not.toBe('trivial')
  })

  it('ambiguous task produces lower confidence', () => {
    const r = classify('do stuff')
    expect(r.confidence).toBeLessThan(0.7)
  })

  it('clear parallel task produces high confidence', () => {
    const r = classify(
      'Build auth service and payment service and notification service independently',
    )
    expect(r.confidence).toBeGreaterThanOrEqual(0.7)
  })

  it('conflicting signals reduce confidence', () => {
    const r = classify('Build A and B independently, but first do C then D after E')
    expect(r.confidence).toBeLessThan(0.8)
  })
})

// ── Subtask Decomposition ───────────────────────────────────────────

describe('subtask decomposition', () => {
  it('solo produces single subtask', () => {
    const r = classify('Fix a typo')
    expect(r.subtasks).toHaveLength(1)
    expect(r.subtasks[0]!.dependencies).toHaveLength(0)
  })

  it('parallel produces independent subtasks with empty dependencies', () => {
    const r = classify('Build auth and payments and email')
    expect(r.subtasks.length).toBeGreaterThanOrEqual(2)
    for (const st of r.subtasks) {
      expect(st.dependencies).toHaveLength(0)
    }
  })

  it('sequential produces chained subtasks where each depends on previous', () => {
    const r = classify('First design the schema, then implement the API, then write tests')
    expect(r.subtasks.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < r.subtasks.length; i++) {
      expect(r.subtasks[i]!.dependencies).toContain(r.subtasks[i - 1]!.id)
    }
  })

  it('hybrid produces phased subtasks', () => {
    const r = classify('Research competitors and simultaneously build prototype, then integrate')
    expect(r.subtasks.length).toBeGreaterThanOrEqual(2)
    // At least one subtask should have a dependency (the integration phase)
    const hasDeps = r.subtasks.some((s) => s.dependencies.length > 0)
    expect(hasDeps).toBe(true)
  })

  it('assigns Researcher role for research subtasks', () => {
    const r = classify('Research best practices and implement the solution')
    const researchTask = r.subtasks.find((s) => s.description.toLowerCase().includes('research'))
    expect(researchTask?.role).toBe('researcher')
  })

  it('assigns Implementer role for implementation subtasks', () => {
    const r = classify('Implement auth and implement payments')
    const implTask = r.subtasks.find((s) => s.description.toLowerCase().includes('implement'))
    expect(implTask?.role).toBe('implementer')
  })

  it('assigns Tester role for test subtasks', () => {
    const r = classify('First implement, then test the solution')
    const testTask = r.subtasks.find((s) => s.description.toLowerCase().includes('test'))
    expect(testTask?.role).toBe('tester')
  })

  it('subtask IDs are unique', () => {
    const r = classify('Build auth and payments and email and notifications')
    const ids = r.subtasks.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('estimated minutes distributed across subtasks', () => {
    const r = classify('Build auth and payments and email')
    for (const st of r.subtasks) {
      expect(st.estimatedMinutes).toBeGreaterThan(0)
    }
    const total = r.subtasks.reduce((sum, s) => sum + s.estimatedMinutes, 0)
    expect(total).toBe(r.features.estimatedTotalMinutes)
  })
})

// ── Confidence Scoring ──────────────────────────────────────────────

describe('confidence scoring', () => {
  it('clear parallel → confidence ≥ 0.7', () => {
    const r = classify('Build A and B and C independently')
    expect(r.confidence).toBeGreaterThanOrEqual(0.7)
  })

  it('clear sequential → confidence ≥ 0.7', () => {
    const r = classify('First do X, then do Y, then do Z')
    expect(r.confidence).toBeGreaterThanOrEqual(0.7)
  })

  it('ambiguous → confidence < 0.7', () => {
    const r = classify('stuff')
    expect(r.confidence).toBeLessThan(0.7)
  })

  it('with estimatedSubtasks hint → confidence boosted', () => {
    const withHint = classify('do some work', { estimatedSubtasks: 3 })
    const without = classify('do some work')
    expect(withHint.confidence).toBeGreaterThan(without.confidence)
  })

  it('conflicting signals → confidence reduced', () => {
    // both parallel "and" and sequential "then/after"
    const r = classify('Build A and B independently, then after that do C and D')
    expect(r.confidence).toBeLessThan(0.8)
  })
})

// ── Reasoning ───────────────────────────────────────────────────────

describe('reasoning', () => {
  it('includes human-readable reasoning string', () => {
    const r = classify('Fix a typo')
    expect(r.reasoning).toBeTruthy()
    expect(typeof r.reasoning).toBe('string')
    expect(r.reasoning.length).toBeGreaterThan(0)
  })
})
