/**
 * Test fixtures — reusable test data.
 */

import { AutonomyLevel, SessionState } from '../../src/shared/types.js'

export const fixtures = {
  autonomyState: {
    level: AutonomyLevel.Observer,
    promotedAt: null as string | null,
    promotionHistory: [] as Array<{ from: AutonomyLevel; to: AutonomyLevel; at: string }>,
    guardrails: {
      respectSessionLimits: true,
      maxConcurrentSessions: 3,
      yieldToUser: true,
      allowedActions: ['suggest'] as string[],
      blockedActions: ['git_push', 'install_package', 'modify_settings'] as string[],
    },
  },

  session: {
    id: 'test-session-001',
    state: SessionState.Running,
    startedAt: '2026-04-04T12:00:00Z',
    workingDir: '/tmp/test-project',
    pid: 12345,
  },

  memoryEntry: {
    id: 'mem-001',
    content: 'The user prefers TypeScript over JavaScript in all projects.',
    source: 'observation',
    createdAt: '2026-04-04T12:00:00Z',
    tags: ['preference', 'language'],
  },
} as const
