import { describe, it, expect } from 'vitest'
import {
  TaskInputSchema,
  ExecutionStrategy,
  TaskComplexity,
  AgentRole,
} from '../../../src/brain/task-types.js'

describe('ExecutionStrategy', () => {
  it('has correct string values', () => {
    expect(ExecutionStrategy.Parallel).toBe('parallel')
    expect(ExecutionStrategy.Sequential).toBe('sequential')
    expect(ExecutionStrategy.Hybrid).toBe('hybrid')
    expect(ExecutionStrategy.Solo).toBe('solo')
  })

  it('has exactly 4 strategies', () => {
    expect(Object.keys(ExecutionStrategy)).toHaveLength(4)
  })
})

describe('TaskComplexity', () => {
  it('has correct string values', () => {
    expect(TaskComplexity.Trivial).toBe('trivial')
    expect(TaskComplexity.Simple).toBe('simple')
    expect(TaskComplexity.Moderate).toBe('moderate')
    expect(TaskComplexity.Complex).toBe('complex')
  })

  it('has exactly 4 levels', () => {
    expect(Object.keys(TaskComplexity)).toHaveLength(4)
  })
})

describe('AgentRole', () => {
  it('has correct string values', () => {
    expect(AgentRole.Researcher).toBe('researcher')
    expect(AgentRole.Implementer).toBe('implementer')
    expect(AgentRole.Reviewer).toBe('reviewer')
    expect(AgentRole.Tester).toBe('tester')
    expect(AgentRole.Planner).toBe('planner')
  })

  it('has exactly 5 roles', () => {
    expect(Object.keys(AgentRole)).toHaveLength(5)
  })
})

describe('TaskInputSchema', () => {
  it('validates correct input with all fields', () => {
    const input = {
      description: 'Build a REST API',
      context: 'Using Express and TypeScript',
      constraints: ['must use TypeScript', 'TDD required'],
      dependencies: ['express', 'zod'],
      estimatedSubtasks: 3,
    }
    const result = TaskInputSchema.parse(input)
    expect(result.description).toBe('Build a REST API')
    expect(result.context).toBe('Using Express and TypeScript')
    expect(result.constraints).toEqual(['must use TypeScript', 'TDD required'])
    expect(result.dependencies).toEqual(['express', 'zod'])
    expect(result.estimatedSubtasks).toBe(3)
  })

  it('validates minimal input with only description', () => {
    const result = TaskInputSchema.parse({ description: 'Fix a bug' })
    expect(result.description).toBe('Fix a bug')
    expect(result.context).toBeUndefined()
    expect(result.constraints).toBeUndefined()
    expect(result.dependencies).toBeUndefined()
    expect(result.estimatedSubtasks).toBeUndefined()
  })

  it('rejects empty description', () => {
    expect(() => TaskInputSchema.parse({ description: '' })).toThrow()
  })

  it('rejects missing description', () => {
    expect(() => TaskInputSchema.parse({})).toThrow()
  })

  it('accepts empty arrays for constraints and dependencies', () => {
    const result = TaskInputSchema.parse({
      description: 'Do something',
      constraints: [],
      dependencies: [],
    })
    expect(result.constraints).toEqual([])
    expect(result.dependencies).toEqual([])
  })

  it('rejects non-string description', () => {
    expect(() => TaskInputSchema.parse({ description: 42 })).toThrow()
  })
})
