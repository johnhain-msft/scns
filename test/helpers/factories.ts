/**
 * Test factories — create test objects with sensible defaults + overrides.
 */

import { AutonomyLevel, SessionState } from '../../src/shared/types.js'

let counter = 0

function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter.toString().padStart(3, '0')}`
}

export function resetFactoryCounter(): void {
  counter = 0
}

export interface SessionInput {
  id?: string
  state?: SessionState
  startedAt?: string
  workingDir?: string
  pid?: number
}

export function buildSession(overrides: SessionInput = {}) {
  return {
    id: overrides.id ?? nextId('session'),
    state: overrides.state ?? SessionState.Running,
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    workingDir: overrides.workingDir ?? '/tmp/test-project',
    pid: overrides.pid ?? Math.floor(Math.random() * 65536),
  }
}

export interface MemoryEntryInput {
  id?: string
  content?: string
  source?: string
  createdAt?: string
  tags?: string[]
}

export function buildMemoryEntry(overrides: MemoryEntryInput = {}) {
  return {
    id: overrides.id ?? nextId('mem'),
    content: overrides.content ?? 'Test memory entry content.',
    source: overrides.source ?? 'test',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    tags: overrides.tags ?? ['test'],
  }
}

export interface AutonomyStateInput {
  level?: AutonomyLevel
}

export function buildAutonomyState(overrides: AutonomyStateInput = {}) {
  return {
    level: overrides.level ?? AutonomyLevel.Observer,
    promotedAt: null as string | null,
    promotionHistory: [] as Array<{ from: AutonomyLevel; to: AutonomyLevel; at: string }>,
    guardrails: {
      respectSessionLimits: true,
      maxConcurrentSessions: 3,
      yieldToUser: true,
      allowedActions: ['suggest'],
      blockedActions: ['git_push', 'install_package', 'modify_settings'],
    },
  }
}
