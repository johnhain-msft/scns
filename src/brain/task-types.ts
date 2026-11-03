import { z } from 'zod'

// Execution strategies
export const ExecutionStrategy = {
  Parallel: 'parallel',
  Sequential: 'sequential',
  Hybrid: 'hybrid',
  Solo: 'solo',
} as const
export type ExecutionStrategy = (typeof ExecutionStrategy)[keyof typeof ExecutionStrategy]

// Task complexity levels
export const TaskComplexity = {
  Trivial: 'trivial',
  Simple: 'simple',
  Moderate: 'moderate',
  Complex: 'complex',
} as const
export type TaskComplexity = (typeof TaskComplexity)[keyof typeof TaskComplexity]

// Task input for classification
export const TaskInputSchema = z.object({
  description: z.string().min(1),
  context: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
  estimatedSubtasks: z.number().optional(),
})
export type TaskInput = z.infer<typeof TaskInputSchema>

// Classification result
export interface ClassificationResult {
  readonly strategy: ExecutionStrategy
  readonly complexity: TaskComplexity
  readonly confidence: number
  readonly subtasks: readonly SubtaskPlan[]
  readonly reasoning: string
  readonly features: TaskFeatures
}

// Individual subtask plan
export interface SubtaskPlan {
  readonly id: string
  readonly description: string
  readonly dependencies: readonly string[]
  readonly estimatedMinutes: number
  readonly role: AgentRole
}

// Agent roles for subtask assignment
export const AgentRole = {
  Researcher: 'researcher',
  Implementer: 'implementer',
  Reviewer: 'reviewer',
  Tester: 'tester',
  Planner: 'planner',
} as const
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole]

// Features extracted from task description for classification
export interface TaskFeatures {
  readonly subtaskCount: number
  readonly hasDependencyChain: boolean
  readonly hasParallelOpportunity: boolean
  readonly hasIOOverlap: boolean
  readonly keywordSignals: readonly string[]
  readonly estimatedTotalMinutes: number
}
