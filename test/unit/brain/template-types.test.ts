import { describe, it, expect } from 'vitest'
import type { TemplateContext, PromptTemplate } from '../../../src/brain/template-types.js'

describe('TemplateContext', () => {
  it('accepts a full context with all fields', () => {
    const ctx: TemplateContext = {
      taskDescription: 'Build a REST API',
      taskComplexity: 'moderate',
      taskStrategy: 'parallel',
      subtaskDescription: 'Implement user endpoint',
      subtaskDependencies: ['auth-module', 'db-schema'],
      role: 'implementer',
      agentName: 'agent-1',
      teamId: 'team-abc',
      teamSize: 3,
      memoryContext: 'Previous work on auth',
      userPreferences: 'Prefer functional style',
      soulContext: 'SCNS is an autonomous agent system',
      sessionId: 'sess-123',
      brokerUrl: 'http://localhost:3000',
      workingDir: '/home/user/project',
      previousResults: ['Auth module completed', 'DB schema created'],
      conversationSummary: 'User wants a REST API',
    }
    expect(ctx.taskDescription).toBe('Build a REST API')
    expect(ctx.role).toBe('implementer')
    expect(ctx.subtaskDependencies).toEqual(['auth-module', 'db-schema'])
    expect(ctx.previousResults).toHaveLength(2)
  })

  it('accepts a minimal context with only required fields', () => {
    const ctx: TemplateContext = {
      taskDescription: 'Fix a bug',
      role: 'reviewer',
    }
    expect(ctx.taskDescription).toBe('Fix a bug')
    expect(ctx.role).toBe('reviewer')
    expect(ctx.memoryContext).toBeUndefined()
    expect(ctx.teamId).toBeUndefined()
  })

  it('accepts empty arrays for previousResults and subtaskDependencies', () => {
    const ctx: TemplateContext = {
      taskDescription: 'Refactor module',
      role: 'planner',
      previousResults: [],
      subtaskDependencies: [],
    }
    expect(ctx.previousResults).toEqual([])
    expect(ctx.subtaskDependencies).toEqual([])
  })
})

describe('PromptTemplate', () => {
  it('accepts a valid template definition', () => {
    const tmpl: PromptTemplate = {
      id: 'researcher-default',
      role: 'researcher',
      name: 'Default Researcher',
      description: 'Template for research agents',
      template: 'You are a research agent.\n\n## Task\n{{taskDescription}}',
      requiredVars: ['taskDescription', 'role'],
      optionalVars: ['memoryContext', 'teamId'],
    }
    expect(tmpl.id).toBe('researcher-default')
    expect(tmpl.role).toBe('researcher')
    expect(tmpl.requiredVars).toContain('taskDescription')
    expect(tmpl.optionalVars).toContain('memoryContext')
  })

  it('accepts a template with no optional vars', () => {
    const tmpl: PromptTemplate = {
      id: 'custom-simple',
      role: 'tester',
      name: 'Simple Tester',
      description: 'Minimal test template',
      template: '{{taskDescription}}',
      requiredVars: ['taskDescription'],
      optionalVars: [],
    }
    expect(tmpl.optionalVars).toHaveLength(0)
    expect(tmpl.requiredVars).toHaveLength(1)
  })
})
