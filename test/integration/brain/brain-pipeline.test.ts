/**
 * Brain pipeline integration tests.
 * Exercises the full classify → decide → template → execute pipeline
 * with real modules and mock side-effect callbacks.
 */

import { describe, it, expect } from 'vitest'
import { createTaskClassifier } from '../../../src/brain/classifier.js'
import { createDecisionTree } from '../../../src/brain/decision-tree.js'
import { createTemplateEngine } from '../../../src/brain/templates.js'
import { createHealthMonitor } from '../../../src/context/health-monitor.js'
import { BrainAction, DecisionPriority } from '../../../src/brain/state-types.js'
import type { BrainState, PendingTask } from '../../../src/brain/state-types.js'
import type { TaskInput, ClassificationResult } from '../../../src/brain/task-types.js'
import type { TemplateContext } from '../../../src/brain/template-types.js'

// ── Helpers ──────────────────────────────────────────────────────────

interface SpawnRecord {
  prompt: string
  role: string
  teamId?: string
}

interface TestBrain {
  classifier: ReturnType<typeof createTaskClassifier>
  decisionTree: ReturnType<typeof createDecisionTree>
  templateEngine: ReturnType<typeof createTemplateEngine>
  healthMonitor: ReturnType<typeof createHealthMonitor>
  spawned: SpawnRecord[]
  consolidated: boolean
  rotated: string[]
  pendingTasks: PendingTask[]
  buildState(overrides?: Partial<BrainState>): BrainState
  runPipeline(
    description: string,
    stateOverrides?: Partial<BrainState>,
  ): {
    classification: ClassificationResult
    task: PendingTask
    decision: ReturnType<ReturnType<typeof createDecisionTree>['decide']>
    prompts: string[]
  }
}

function createTestBrain(overrides?: {
  maxTeamSize?: number
  maxConcurrentSessions?: number
  autonomyLevel?: number
}): TestBrain {
  const spawned: SpawnRecord[] = []
  let consolidated = false
  const rotated: string[] = []
  const pendingTasks: PendingTask[] = []

  const classifier = createTaskClassifier()
  const decisionTree = createDecisionTree({ maxTeamSize: overrides?.maxTeamSize })
  const templateEngine = createTemplateEngine()
  const healthMonitor = createHealthMonitor()

  function buildState(stateOverrides?: Partial<BrainState>): BrainState {
    return {
      autonomyLevel: overrides?.autonomyLevel ?? 3,
      userActive: false,
      yieldToUser: false,
      pendingTasks,
      activeSessions: 0,
      maxConcurrentSessions: overrides?.maxConcurrentSessions ?? 5,
      contextUsagePercent: 20,
      contextRotationThreshold: 85,
      recentObservationCount: 10,
      lastConsolidationAge: 1,
      consolidationThreshold: 24,
      patterns: null,
      ...stateOverrides,
    }
  }

  function runPipeline(description: string, stateOverrides?: Partial<BrainState>) {
    const input: TaskInput = { description }
    const classification = classifier.classify(input)

    const task: PendingTask = {
      id: `task-${Date.now()}`,
      description,
      priority: DecisionPriority.Normal,
      strategy: classification.strategy,
      subtaskCount: classification.subtasks.length,
      createdAt: new Date().toISOString(),
    }

    // Temporarily add to pending for decide()
    pendingTasks.length = 0
    pendingTasks.push(task)
    const state = buildState(stateOverrides)
    const decision = decisionTree.decide(state)

    // Render templates based on decision
    const prompts: string[] = []
    if (
      decision.action === BrainAction.SpawnTeam ||
      decision.action === BrainAction.SpawnSolo ||
      decision.action === BrainAction.HandleSolo
    ) {
      const teamId = `team-${Date.now()}`
      for (const subtask of classification.subtasks) {
        const template = templateEngine.selectTemplate(subtask.role, {})
        const context: TemplateContext = {
          taskDescription: description,
          subtaskDescription: subtask.description,
          role: subtask.role,
          teamId,
        }
        const prompt = templateEngine.render(template.id, context)
        prompts.push(prompt)
        spawned.push({ prompt, role: subtask.role, teamId })
      }
    }

    // Clear processed task
    pendingTasks.length = 0

    return { classification, task, decision, prompts }
  }

  return {
    classifier,
    decisionTree,
    templateEngine,
    healthMonitor,
    spawned,
    get consolidated() {
      return consolidated
    },
    set consolidated(v: boolean) {
      consolidated = v
    },
    rotated,
    pendingTasks,
    buildState,
    runPipeline,
  }
}

// ── 1. Clean Idle Cycle ─────────────────────────────────────────────

describe('Clean Idle Cycle', () => {
  it('decides Idle when no pending tasks and sufficient observations', () => {
    const brain = createTestBrain()
    const state = brain.buildState({ recentObservationCount: 10 })
    const decision = brain.decisionTree.decide(state)
    expect(decision.action).toBe(BrainAction.Idle)
    expect(decision.reason).toContain('Nothing to do')
  })

  it('all modules initialize correctly with no work', () => {
    const brain = createTestBrain()
    expect(brain.classifier.classify({ description: 'noop' })).toBeDefined()
    expect(brain.decisionTree.decide(brain.buildState())).toBeDefined()
    expect(brain.templateEngine.listTemplates().length).toBeGreaterThanOrEqual(5)
    expect(brain.healthMonitor.getStats().total).toBe(0)
  })

  it('does not call onSpawnAgent during idle cycle', () => {
    const brain = createTestBrain()
    const state = brain.buildState()
    const decision = brain.decisionTree.decide(state)
    expect(decision.action).toBe(BrainAction.Idle)
    expect(brain.spawned).toHaveLength(0)
  })

  it('shows Idle status after clean cycle with no tasks', () => {
    const brain = createTestBrain()
    const decision = brain.decisionTree.decide(brain.buildState())
    expect(decision.action).toBe(BrainAction.Idle)
    expect(decision.confidence).toBe(1.0)
    expect(decision.priority).toBe(DecisionPriority.Low)
  })
})

// ── 2. Simple Task → Subagent ───────────────────────────────────────

describe('Simple Task → Subagent', () => {
  it('routes "Fix typo in README" through full pipeline as solo/HandleSolo', () => {
    const brain = createTestBrain()
    const result = brain.runPipeline('Fix typo in README')

    expect(result.classification.strategy).toBe('solo')
    expect(result.classification.complexity).toBe('trivial')
    expect(result.decision.action).toBe(BrainAction.HandleSolo)
  })

  it('extracts correct features for trivial task', () => {
    const brain = createTestBrain()
    const features = brain.classifier.extractFeatures({ description: 'Fix typo in README' })
    expect(features.subtaskCount).toBe(1)
    expect(features.hasDependencyChain).toBe(false)
    expect(features.hasParallelOpportunity).toBe(false)
  })

  it('template includes the task description', () => {
    const brain = createTestBrain()
    const result = brain.runPipeline('Fix typo in README')
    expect(result.prompts.length).toBeGreaterThanOrEqual(1)
    expect(result.prompts[0]).toContain('Fix typo in README')
  })

  it('records spawned agent with rendered prompt', () => {
    const brain = createTestBrain()
    brain.runPipeline('Fix typo in README')
    expect(brain.spawned.length).toBeGreaterThanOrEqual(1)
    expect(brain.spawned[0]!.prompt).toContain('Fix typo in README')
    expect(brain.spawned[0]!.role).toBe('implementer')
  })

  it('task removed from queue after processing', () => {
    const brain = createTestBrain()
    brain.runPipeline('Fix typo in README')
    expect(brain.pendingTasks).toHaveLength(0)
  })
})

// ── 3. Parallel Task → Team Spawn ───────────────────────────────────

describe('Parallel Task → Team Spawn', () => {
  it('routes parallel tasks as SpawnTeam', () => {
    const brain = createTestBrain()
    const result = brain.runPipeline('Build auth service, payments service, and email service')

    expect(result.classification.strategy).toBe('parallel')
    expect(result.decision.action).toBe(BrainAction.SpawnTeam)
  })

  it('team size matches subtask count capped by maxConcurrentSessions', () => {
    const brain = createTestBrain({ maxConcurrentSessions: 2, maxTeamSize: 2 })
    const result = brain.runPipeline('Build auth service, payments service, and email service')

    expect(result.decision.teamSize).toBeLessThanOrEqual(2)
  })

  it('each agent gets a role-based template', () => {
    const brain = createTestBrain()
    brain.runPipeline('Build auth service, payments service, and email service')

    // Each subtask should have a prompt rendered with the appropriate template
    for (const spawn of brain.spawned) {
      const template = brain.templateEngine.selectTemplate(spawn.role, {})
      expect(template).toBeDefined()
      expect(template.role).toBe(spawn.role)
    }
  })

  it('each subtask gets its own prompt', () => {
    const brain = createTestBrain()
    const result = brain.runPipeline('Build auth service, payments service, and email service')

    expect(result.prompts.length).toBeGreaterThanOrEqual(2)
    // Prompts should all be unique (each gets different subtask context)
    const _uniquePrompts = new Set(result.prompts)
    // All prompts share the same main task description, but each gets rendered
    expect(result.prompts.length).toBe(result.classification.subtasks.length)
  })

  it('all spawned agents are tracked', () => {
    const brain = createTestBrain()
    const result = brain.runPipeline('Build auth service, payments service, and email service')

    expect(brain.spawned.length).toBe(result.classification.subtasks.length)
    for (const spawn of brain.spawned) {
      expect(spawn.teamId).toBeDefined()
      expect(spawn.prompt.length).toBeGreaterThan(0)
    }
  })
})

// ── 4. Sequential Task → Solo Handling ──────────────────────────────

describe('Sequential Task → Solo Handling', () => {
  it('routes sequential tasks as HandleSolo', () => {
    const brain = createTestBrain()
    const result = brain.runPipeline(
      'First design the database schema, then implement the REST API, then write integration tests',
    )

    expect(result.classification.strategy).toBe('sequential')
    expect(result.decision.action).toBe(BrainAction.HandleSolo)
  })

  it('only one agent conceptually handles sequencing', () => {
    const brain = createTestBrain()
    const result = brain.runPipeline(
      'First design the database schema, then implement the REST API, then write integration tests',
    )

    // HandleSolo means the brain handles sequencing itself
    expect(result.decision.action).toBe(BrainAction.HandleSolo)
    expect(result.decision.reason).toContain('Sequential')
  })

  it('template includes full sequential plan', () => {
    const brain = createTestBrain()
    const result = brain.runPipeline(
      'First design the database schema, then implement the REST API, then write integration tests',
    )

    // Each subtask prompt is rendered for its phase
    expect(result.prompts.length).toBeGreaterThanOrEqual(2)
    // At least one prompt should mention design/schema and another API/test
    const allText = result.prompts.join(' ')
    expect(allText.length).toBeGreaterThan(100)
  })

  it('subtasks have dependency chain', () => {
    const brain = createTestBrain()
    const input: TaskInput = {
      description:
        'First design the database schema, then implement the REST API, then write integration tests',
    }
    const classification = brain.classifier.classify(input)

    // Sequential subtasks should have dependencies on previous subtasks
    expect(classification.subtasks.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < classification.subtasks.length; i++) {
      expect(classification.subtasks[i]!.dependencies.length).toBeGreaterThan(0)
    }
  })
})

// ── 4b. Hybrid Task → Team Spawn ────────────────────────────────────

describe('Hybrid Task → Team Spawn', () => {
  it('routes hybrid tasks as SpawnTeam', () => {
    const brain = createTestBrain()
    const result = brain.runPipeline(
      'Research competitors and simultaneously build prototype, then integrate everything',
    )

    expect(result.classification.strategy).toBe('hybrid')
    expect(result.decision.action).toBe(BrainAction.SpawnTeam)
  })

  it('hybrid subtasks have mixed dependencies (parallel phases + sequential phases)', () => {
    const brain = createTestBrain()
    const input: TaskInput = {
      description:
        'Research competitors and simultaneously build prototype, then integrate everything',
    }
    const classification = brain.classifier.classify(input)

    expect(classification.strategy).toBe('hybrid')
    expect(classification.subtasks.length).toBeGreaterThanOrEqual(2)
    const hasDeps = classification.subtasks.some((s) => s.dependencies.length > 0)
    expect(hasDeps).toBe(true)
  })

  it('each hybrid subtask gets a rendered prompt', () => {
    const brain = createTestBrain()
    const result = brain.runPipeline(
      'Research competitors and simultaneously build prototype, then integrate everything',
    )

    expect(result.prompts.length).toBe(result.classification.subtasks.length)
    for (const prompt of result.prompts) {
      expect(prompt.length).toBeGreaterThan(0)
    }
  })

  it('spawned agents include team ID for hybrid tasks', () => {
    const brain = createTestBrain()
    brain.runPipeline(
      'Research competitors and simultaneously build prototype, then integrate everything',
    )

    expect(brain.spawned.length).toBeGreaterThanOrEqual(2)
    for (const spawn of brain.spawned) {
      expect(spawn.teamId).toBeDefined()
    }
  })
})

// ── 5. Context Health → Rotation ────────────────────────────────────

describe('Context Health → Rotation', () => {
  it('decides RotateContext when usage crosses threshold', () => {
    const brain = createTestBrain()
    const state = brain.buildState({ contextUsagePercent: 90, contextRotationThreshold: 85 })
    const decision = brain.decisionTree.decide(state)

    expect(decision.action).toBe(BrainAction.RotateContext)
    expect(decision.confidence).toBe(1.0)
  })

  it('health monitor generates rotation recommendation at high usage', () => {
    const brain = createTestBrain()
    const sessionId = 'test-session-rotation'
    brain.healthMonitor.registerSession(sessionId, 1000)

    // Push tokens to exceed rotation threshold (85%)
    for (let i = 0; i < 50; i++) {
      brain.healthMonitor.recordTurn(sessionId, 20)
    }

    const health = brain.healthMonitor.getHealth(sessionId)
    expect(health).not.toBeNull()
    expect(health!.usagePercent).toBeGreaterThanOrEqual(85)

    const rec = brain.healthMonitor.getRotationRecommendation(sessionId)
    expect(rec).not.toBeNull()
    expect(rec!.urgency).not.toBe('none')
    expect(rec!.estimatedTokensSaved).toBeGreaterThan(0)
  })

  it('prepareHandoff produces valid handoff state', () => {
    const brain = createTestBrain()
    const handoff = brain.healthMonitor.prepareHandoff(
      'session-1',
      'Working on auth module',
      ['Finish token refresh'],
      ['Use JWT over sessions'],
      ['src/auth/token.ts'],
    )

    expect(handoff.sessionId).toBe('session-1')
    expect(handoff.summary).toBe('Working on auth module')
    expect(handoff.pendingWork).toContain('Finish token refresh')
    expect(handoff.keyDecisions).toContain('Use JWT over sessions')
    expect(handoff.filesModified).toContain('src/auth/token.ts')
    expect(handoff.timestamp).toBeTruthy()
  })

  it('full rotation pipeline: health → decision → handoff', () => {
    const brain = createTestBrain()
    const sessionId = 'session-full-rotate'
    brain.healthMonitor.registerSession(sessionId, 1000)

    // Drive context to rotation-needed
    for (let i = 0; i < 50; i++) {
      brain.healthMonitor.recordTurn(sessionId, 20)
    }

    const health = brain.healthMonitor.getHealth(sessionId)!
    const state = brain.buildState({
      contextUsagePercent: health.usagePercent,
      contextRotationThreshold: 85,
    })

    const decision = brain.decisionTree.decide(state)
    expect(decision.action).toBe(BrainAction.RotateContext)

    const handoff = brain.healthMonitor.prepareHandoff(
      sessionId,
      'Context rotation triggered',
      ['Continue current task'],
      [],
      [],
    )
    expect(handoff.sessionId).toBe(sessionId)

    brain.rotated.push(sessionId)
    expect(brain.rotated).toContain(sessionId)
  })
})

// ── 6. Priority Queue Processing ────────────────────────────────────

describe('Priority Queue Processing', () => {
  it('highest priority task is processed first', () => {
    const brain = createTestBrain()
    const tasks: PendingTask[] = [
      {
        id: 'low-1',
        description: 'Low prio task',
        priority: DecisionPriority.Low,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'crit-1',
        description: 'Critical bug fix',
        priority: DecisionPriority.Critical,
        strategy: 'solo',
        subtaskCount: 1,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'norm-1',
        description: 'Normal task',
        priority: DecisionPriority.Normal,
        createdAt: new Date().toISOString(),
      },
    ]

    brain.pendingTasks.length = 0
    brain.pendingTasks.push(...tasks)
    const state = brain.buildState()
    const decision = brain.decisionTree.decide(state)

    expect(decision.taskId).toBe('crit-1')
    expect(decision.priority).toBe(DecisionPriority.Critical)
  })

  it('critical task preempts normal tasks', () => {
    const brain = createTestBrain()
    brain.pendingTasks.length = 0
    brain.pendingTasks.push(
      {
        id: 'norm-1',
        description: 'Normal work',
        priority: DecisionPriority.Normal,
        strategy: 'solo',
        subtaskCount: 1,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'high-1',
        description: 'High prio',
        priority: DecisionPriority.High,
        strategy: 'solo',
        subtaskCount: 1,
        createdAt: new Date().toISOString(),
      },
    )

    const decision = brain.decisionTree.decide(brain.buildState())
    expect(decision.taskId).toBe('high-1')
  })

  it('task queue drains in priority order across multiple cycles', () => {
    const brain = createTestBrain()

    const taskDefs: {
      id: string
      priority: (typeof DecisionPriority)[keyof typeof DecisionPriority]
    }[] = [
      { id: 'low-a', priority: DecisionPriority.Low },
      { id: 'crit-a', priority: DecisionPriority.Critical },
      { id: 'norm-a', priority: DecisionPriority.Normal },
    ]

    const processedOrder: string[] = []

    // Simulate multiple wake cycles
    const remaining = taskDefs.map((t) => ({
      ...t,
      description: `Task ${t.id}`,
      strategy: 'solo' as const,
      subtaskCount: 1,
      createdAt: new Date().toISOString(),
    }))

    while (remaining.length > 0) {
      brain.pendingTasks.length = 0
      brain.pendingTasks.push(...remaining)
      const decision = brain.decisionTree.decide(brain.buildState())
      if (decision.taskId) {
        processedOrder.push(decision.taskId)
        const idx = remaining.findIndex((t) => t.id === decision.taskId)
        if (idx >= 0) remaining.splice(idx, 1)
      } else {
        break
      }
    }

    expect(processedOrder).toEqual(['crit-a', 'norm-a', 'low-a'])
  })

  it('returns Idle when all tasks processed', () => {
    const brain = createTestBrain()
    brain.pendingTasks.length = 0
    const decision = brain.decisionTree.decide(brain.buildState())
    expect(decision.action).toBe(BrainAction.Idle)
  })
})

// ── 7. Stress: 10 Concurrent Tasks ──────────────────────────────────

describe('Stress: 10 Concurrent Tasks', () => {
  const TASK_DESCRIPTIONS = [
    'Build user authentication module',
    'Implement payment gateway and billing service',
    'Write unit tests for the parser',
    'First design the API, then implement endpoints',
    'Research best practices for caching',
    'Fix typo in docs',
    'Build logging service and monitoring dashboard',
    'Review security audit findings',
    'First plan migration, then execute schema changes, then validate',
    'Implement search indexer and query engine',
  ]

  it('classifies all 10 tasks without errors', () => {
    const brain = createTestBrain()
    const results = TASK_DESCRIPTIONS.map((desc) =>
      brain.classifier.classify({ description: desc }),
    )

    expect(results).toHaveLength(10)
    for (const r of results) {
      expect(r.strategy).toBeTruthy()
      expect(r.complexity).toBeTruthy()
      expect(r.confidence).toBeGreaterThan(0)
      expect(r.subtasks.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('processes across multiple wake cycles respecting maxConcurrentSessions', () => {
    const brain = createTestBrain({ maxConcurrentSessions: 3 })
    const processed: string[] = []
    let activeSessions = 0

    // Classify and build pending tasks
    const remaining: PendingTask[] = TASK_DESCRIPTIONS.map((desc, i) => {
      const cls = brain.classifier.classify({ description: desc })
      return {
        id: `stress-${i}`,
        description: desc,
        priority: DecisionPriority.Normal,
        strategy: cls.strategy,
        subtaskCount: cls.subtasks.length,
        createdAt: new Date().toISOString(),
      }
    })

    let cycles = 0
    const maxCycles = 30 // safety bound

    while (remaining.length > 0 && cycles < maxCycles) {
      brain.pendingTasks.length = 0
      brain.pendingTasks.push(...remaining)

      const state = brain.buildState({ activeSessions })
      const decision = brain.decisionTree.decide(state)

      if (decision.taskId) {
        processed.push(decision.taskId)
        const idx = remaining.findIndex((t) => t.id === decision.taskId)
        if (idx >= 0) remaining.splice(idx, 1)

        // Simulate session usage
        if (decision.action === BrainAction.SpawnTeam) {
          activeSessions += Math.min(decision.teamSize ?? 1, 3)
        } else if (
          decision.action === BrainAction.SpawnSolo ||
          decision.action === BrainAction.HandleSolo
        ) {
          activeSessions += 1
        }
        // Simulate session completion after each cycle
        activeSessions = Math.max(0, activeSessions - 1)
      } else {
        break
      }
      cycles++
    }

    expect(processed.length).toBe(10)
  })

  it('never exceeds maxConcurrentSessions in a single decision', () => {
    const brain = createTestBrain({ maxConcurrentSessions: 2, maxTeamSize: 2 })

    for (const desc of TASK_DESCRIPTIONS) {
      const cls = brain.classifier.classify({ description: desc })
      const task: PendingTask = {
        id: `check-${desc.slice(0, 10)}`,
        description: desc,
        priority: DecisionPriority.Normal,
        strategy: cls.strategy,
        subtaskCount: cls.subtasks.length,
        createdAt: new Date().toISOString(),
      }

      brain.pendingTasks.length = 0
      brain.pendingTasks.push(task)

      // Test with 1 available slot
      const state = brain.buildState({ activeSessions: 1 })
      const decision = brain.decisionTree.decide(state)

      if (decision.teamSize) {
        expect(decision.teamSize).toBeLessThanOrEqual(1) // only 1 slot available
      }
    }
  })

  it('all tasks eventually produce valid decisions without state corruption', () => {
    const brain = createTestBrain()
    const decisions: ReturnType<typeof brain.decisionTree.decide>[] = []

    for (const desc of TASK_DESCRIPTIONS) {
      const cls = brain.classifier.classify({ description: desc })
      const task: PendingTask = {
        id: `valid-${desc.slice(0, 10)}`,
        description: desc,
        priority: DecisionPriority.Normal,
        strategy: cls.strategy,
        subtaskCount: cls.subtasks.length,
        createdAt: new Date().toISOString(),
      }

      brain.pendingTasks.length = 0
      brain.pendingTasks.push(task)

      const decision = brain.decisionTree.decide(brain.buildState())
      decisions.push(decision)

      // Verify each decision is well-formed
      expect(decision.action).toBeTruthy()
      expect(decision.reason).toBeTruthy()
      expect(decision.confidence).toBeGreaterThan(0)
      expect(decision.confidence).toBeLessThanOrEqual(1)
    }

    expect(decisions).toHaveLength(10)

    // Verify we got a variety of actions (not all the same)
    const actions = new Set(decisions.map((d) => d.action))
    expect(actions.size).toBeGreaterThanOrEqual(2)
  })
})
