/**
 * Prompt template type definitions for the Brain Agent.
 * Pure data types — no logic, no side effects.
 */

/** Template variable context — all data available for substitution */
export interface TemplateContext {
  // Task info
  readonly taskDescription: string
  readonly taskComplexity?: string
  readonly taskStrategy?: string
  readonly subtaskDescription?: string
  readonly subtaskDependencies?: readonly string[]

  // Agent info
  readonly role: string
  readonly agentName?: string
  readonly teamId?: string
  readonly teamSize?: number

  // Memory context
  readonly memoryContext?: string
  readonly userPreferences?: string
  readonly soulContext?: string

  // Session info
  readonly sessionId?: string
  readonly brokerUrl?: string
  readonly workingDir?: string

  // History
  readonly previousResults?: readonly string[]
  readonly conversationSummary?: string
}

/** Template definition */
export interface PromptTemplate {
  readonly id: string
  readonly role: string
  readonly name: string
  readonly description: string
  readonly template: string
  readonly requiredVars: readonly string[]
  readonly optionalVars: readonly string[]
}
