// Brain Agent — Phase 5
// Main loop: wake -> observe -> decide -> act
export {
  ExecutionStrategy,
  TaskComplexity,
  AgentRole,
  TaskInputSchema,
  type TaskInput,
  type ClassificationResult,
  type SubtaskPlan,
  type TaskFeatures,
} from './task-types.js'

export { createTaskClassifier, type ClassifierOptions } from './classifier.js'

export * from './state-types.js'
export * from './decision-tree.js'

export type { TemplateContext, PromptTemplate } from './template-types.js'
export {
  createTemplateEngine,
  substituteVariables,
  extractVariables,
  type TemplateEngineOptions,
} from './templates.js'

export { createTaskQueue, type TaskQueueOptions } from './task-queue.js'

export {
  createBrainAgent,
  type BrainAgentOptions,
  type BrainAgentDeps,
  type BrainAgentStatus,
} from './agent-loop.js'
