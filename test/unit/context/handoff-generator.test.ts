import { describe, it, expect } from 'vitest'
import { createHandoffGenerator } from '../../../src/context/handoff-generator.js'
import { HandoffStatus } from '../../../src/context/handoff-types.js'
import type { HandoffInput, SessionInfo, TeamInfo } from '../../../src/context/handoff-generator.js'

// ── Helpers ──────────────────────────────────────────────────────────

function fullInput(): HandoffInput {
  return {
    sessionId: 'sess-abc',
    currentTask: 'Implementing feature X',
    pendingWork: [
      { description: 'Write tests', priority: 'high' },
      { description: 'Update docs', priority: 'low' },
      { description: 'Fix critical bug', priority: 'critical' },
      { description: 'Refactor module', priority: 'normal' },
    ],
    completedWork: ['Set up project', 'Designed schema'],
    blockedWork: [
      { description: 'Deploy to prod', blockedBy: 'CI pipeline broken', since: '2024-01-01' },
    ],
    keyDecisions: [
      {
        description: 'Use Zod for validation',
        rationale: 'Type-safe runtime checks',
        alternatives: ['Joi', 'io-ts'],
      },
      { description: 'ESM over CJS', rationale: 'Modern standard' },
    ],
    discoveredFacts: ['API has rate limit of 100/min', 'DB max connections is 20'],
    warnings: ['Memory usage is high', 'Test coverage below 80%'],
    filesModified: [
      { path: 'src/index.ts', changeType: 'modified', summary: 'Added exports' },
      { path: 'src/utils.ts', changeType: 'modified' },
    ],
    filesCreated: ['src/new-file.ts'],
    filesDeleted: ['src/old-file.ts'],
    relevantMemoryRefs: ['mem-001', 'mem-002'],
    suggestedMemoryUpdates: ['Update API rate limit info', 'Record new schema design'],
    resumptionInstructions: 'Continue with feature X implementation. Run tests first.',
  }
}

function fullSessionInfo(): SessionInfo {
  return {
    purpose: 'Implement Phase 8 handoff system',
    workingDir: '/home/user/project',
    startedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
    status: 'active',
  }
}

function fullTeamInfo(): TeamInfo {
  return { teamId: 'team-alpha', role: 'implementer', phase: 'phase-8' }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('createHandoffGenerator', () => {
  describe('generate', () => {
    it('generates a handoff document with all fields populated', () => {
      const gen = createHandoffGenerator({
        getSessionInfo: () => fullSessionInfo(),
        getTeamInfo: () => fullTeamInfo(),
      })
      const doc = gen.generate(fullInput())

      expect(doc.id).toBeTruthy()
      expect(doc.sourceSessionId).toBe('sess-abc')
      expect(doc.targetSessionId).toBeNull()
      expect(doc.status).toBe(HandoffStatus.Ready)
      expect(doc.sessionPurpose).toBe('Implement Phase 8 handoff system')
      expect(doc.workingDir).toBe('/home/user/project')
      expect(doc.elapsedMinutes).toBeGreaterThan(0)
      expect(doc.currentTask).toBe('Implementing feature X')
      expect(doc.pendingWork).toHaveLength(4)
      expect(doc.completedWork).toHaveLength(2)
      expect(doc.blockedWork).toHaveLength(1)
      expect(doc.keyDecisions).toHaveLength(2)
      expect(doc.discoveredFacts).toHaveLength(2)
      expect(doc.warnings).toHaveLength(2)
      expect(doc.filesModified).toHaveLength(2)
      expect(doc.filesCreated).toHaveLength(1)
      expect(doc.filesDeleted).toHaveLength(1)
      expect(doc.teamId).toBe('team-alpha')
      expect(doc.teamRole).toBe('implementer')
      expect(doc.teamPhase).toBe('phase-8')
      expect(doc.relevantMemoryRefs).toHaveLength(2)
      expect(doc.suggestedMemoryUpdates).toHaveLength(2)
      expect(doc.resumptionInstructions).toContain('Continue with feature X')
    })

    it('generates a handoff with minimal input (just sessionId)', () => {
      const gen = createHandoffGenerator()
      const doc = gen.generate({ sessionId: 'sess-min' })

      expect(doc.id).toBeTruthy()
      expect(doc.sourceSessionId).toBe('sess-min')
      expect(doc.status).toBe(HandoffStatus.Ready)
      expect(doc.sessionPurpose).toBe('Unknown')
      expect(doc.currentTask).toBeNull()
      expect(doc.pendingWork).toHaveLength(0)
      expect(doc.completedWork).toHaveLength(0)
      expect(doc.blockedWork).toHaveLength(0)
      expect(doc.keyDecisions).toHaveLength(0)
      expect(doc.teamId).toBeNull()
      expect(doc.resumptionInstructions).toBe('')
    })

    it('sorts pending work by priority', () => {
      const gen = createHandoffGenerator()
      const doc = gen.generate({
        sessionId: 's1',
        pendingWork: [
          { description: 'Low', priority: 'low' },
          { description: 'Critical', priority: 'critical' },
          { description: 'Normal', priority: 'normal' },
          { description: 'High', priority: 'high' },
        ],
      })

      expect(doc.pendingWork[0]!.priority).toBe('critical')
      expect(doc.pendingWork[1]!.priority).toBe('high')
      expect(doc.pendingWork[2]!.priority).toBe('normal')
      expect(doc.pendingWork[3]!.priority).toBe('low')
    })

    it('includes team context when available', () => {
      const gen = createHandoffGenerator({
        getTeamInfo: () => ({ teamId: 't-1', role: 'lead', phase: 'design' }),
      })
      const doc = gen.generate({ sessionId: 's1' })
      expect(doc.teamId).toBe('t-1')
      expect(doc.teamRole).toBe('lead')
      expect(doc.teamPhase).toBe('design')
    })

    it('sets null team context when no team info', () => {
      const gen = createHandoffGenerator({ getTeamInfo: () => null })
      const doc = gen.generate({ sessionId: 's1' })
      expect(doc.teamId).toBeNull()
      expect(doc.teamRole).toBeNull()
      expect(doc.teamPhase).toBeNull()
    })

    it('calculates elapsed minutes from session start', () => {
      const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString()
      const gen = createHandoffGenerator({
        getSessionInfo: () => ({
          purpose: 'test',
          workingDir: '/tmp',
          startedAt: tenMinAgo,
          status: 'active',
        }),
      })
      const doc = gen.generate({ sessionId: 's1' })
      expect(doc.elapsedMinutes).toBeGreaterThanOrEqual(9)
      expect(doc.elapsedMinutes).toBeLessThanOrEqual(11)
    })
  })

  describe('toMarkdown', () => {
    it('renders to markdown containing all sections', () => {
      const gen = createHandoffGenerator({
        getSessionInfo: () => fullSessionInfo(),
        getTeamInfo: () => fullTeamInfo(),
      })
      const doc = gen.generate(fullInput())
      const md = gen.toMarkdown(doc)

      expect(md).toContain('# Session Handoff:')
      expect(md).toContain('## Source Session')
      expect(md).toContain('## Current Task')
      expect(md).toContain('## Pending Work')
      expect(md).toContain('## Completed Work')
      expect(md).toContain('## Blocked Work')
      expect(md).toContain('## Key Decisions')
      expect(md).toContain('## Discovered Facts')
      expect(md).toContain('## Warnings')
      expect(md).toContain('## Files Changed')
      expect(md).toContain('## Team Context')
      expect(md).toContain('## Memory References')
      expect(md).toContain('## Suggested Memory Updates')
      expect(md).toContain('## Resumption Instructions')
      expect(md).toContain(`*Generated at ${doc.createdAt} | Status: ${doc.status}*`)
    })

    it('omits empty sections from markdown', () => {
      const gen = createHandoffGenerator()
      const doc = gen.generate({ sessionId: 's1' })
      const md = gen.toMarkdown(doc)

      expect(md).not.toContain('## Pending Work')
      expect(md).not.toContain('## Completed Work')
      expect(md).not.toContain('## Blocked Work')
      expect(md).not.toContain('## Key Decisions')
      expect(md).not.toContain('## Discovered Facts')
      expect(md).not.toContain('## Warnings')
      expect(md).not.toContain('## Files Changed')
      expect(md).not.toContain('## Team Context')
      expect(md).not.toContain('## Memory References')
      expect(md).not.toContain('## Suggested Memory Updates')
      expect(md).not.toContain('## Resumption Instructions')
      // Always present
      expect(md).toContain('## Source Session')
      expect(md).toContain('## Current Task')
    })

    it('file changes are listed correctly in table', () => {
      const gen = createHandoffGenerator()
      const doc = gen.generate({
        sessionId: 's1',
        filesModified: [{ path: 'src/a.ts', changeType: 'modified', summary: 'Refactored' }],
        filesCreated: ['src/b.ts'],
        filesDeleted: ['src/c.ts'],
      })
      const md = gen.toMarkdown(doc)

      expect(md).toContain('| src/a.ts | modified | Refactored |')
      expect(md).toContain('| src/b.ts | created | |')
      expect(md).toContain('| src/c.ts | deleted | |')
    })

    it('decisions include rationale in markdown', () => {
      const gen = createHandoffGenerator()
      const doc = gen.generate({
        sessionId: 's1',
        keyDecisions: [{ description: 'Use TypeScript', rationale: 'Type safety is important' }],
      })
      const md = gen.toMarkdown(doc)

      expect(md).toContain('**Use TypeScript**: Type safety is important')
    })
  })

  describe('fromMarkdown', () => {
    it('round-trips correctly from markdown', () => {
      const gen = createHandoffGenerator({
        getSessionInfo: () => fullSessionInfo(),
        getTeamInfo: () => fullTeamInfo(),
      })
      const original = gen.generate(fullInput())
      const md = gen.toMarkdown(original)
      const parsed = gen.fromMarkdown(md)

      expect(parsed.id).toBe(original.id)
      expect(parsed.sourceSessionId).toBe(original.sourceSessionId)
      expect(parsed.sessionPurpose).toBe(original.sessionPurpose)
      expect(parsed.workingDir).toBe(original.workingDir)
      expect(parsed.elapsedMinutes).toBe(original.elapsedMinutes)
      expect(parsed.currentTask).toBe(original.currentTask)
      expect(parsed.pendingWork).toHaveLength(original.pendingWork.length)
      expect(parsed.completedWork).toEqual(original.completedWork)
      expect(parsed.blockedWork).toHaveLength(original.blockedWork.length)
      expect(parsed.keyDecisions).toHaveLength(original.keyDecisions.length)
      expect(parsed.discoveredFacts).toEqual(original.discoveredFacts)
      expect(parsed.warnings).toEqual(original.warnings)
      expect(parsed.filesModified).toHaveLength(original.filesModified.length)
      expect(parsed.filesCreated).toEqual(original.filesCreated)
      expect(parsed.filesDeleted).toEqual(original.filesDeleted)
      expect(parsed.teamId).toBe(original.teamId)
      expect(parsed.teamRole).toBe(original.teamRole)
      expect(parsed.teamPhase).toBe(original.teamPhase)
      expect(parsed.relevantMemoryRefs).toEqual(original.relevantMemoryRefs)
      expect(parsed.suggestedMemoryUpdates).toEqual(original.suggestedMemoryUpdates)
      expect(parsed.resumptionInstructions).toBe(original.resumptionInstructions)
      expect(parsed.status).toBe(original.status)
    })

    it('parses pending work with priorities correctly', () => {
      const gen = createHandoffGenerator()
      const doc = gen.generate({
        sessionId: 's1',
        pendingWork: [
          { description: 'Task A', priority: 'critical' },
          { description: 'Task B', priority: 'low' },
        ],
      })
      const md = gen.toMarkdown(doc)
      const parsed = gen.fromMarkdown(md)

      expect(parsed.pendingWork[0]!.description).toBe('Task A')
      expect(parsed.pendingWork[0]!.priority).toBe('critical')
      expect(parsed.pendingWork[1]!.description).toBe('Task B')
      expect(parsed.pendingWork[1]!.priority).toBe('low')
    })

    it('parses minimal markdown correctly', () => {
      const gen = createHandoffGenerator()
      const doc = gen.generate({ sessionId: 's-min' })
      const md = gen.toMarkdown(doc)
      const parsed = gen.fromMarkdown(md)

      expect(parsed.id).toBe(doc.id)
      expect(parsed.currentTask).toBeNull()
      expect(parsed.pendingWork).toHaveLength(0)
    })
  })

  describe('validate', () => {
    it('complete document scores 100%', () => {
      const gen = createHandoffGenerator({
        getSessionInfo: () => fullSessionInfo(),
        getTeamInfo: () => fullTeamInfo(),
      })
      const doc = gen.generate(fullInput())
      const result = gen.validate(doc)

      expect(result.valid).toBe(true)
      expect(result.completeness).toBe(100)
      expect(result.missingFields).toHaveLength(0)
    })

    it('minimal document identifies missing fields', () => {
      const gen = createHandoffGenerator()
      const doc = gen.generate({ sessionId: 's1' })
      const result = gen.validate(doc)

      expect(result.completeness).toBeLessThan(100)
      expect(result.missingFields.length).toBeGreaterThan(0)
      expect(result.missingFields).toContain('currentTask')
      expect(result.missingFields).toContain('pendingWork')
      expect(result.missingFields).toContain('resumptionInstructions')
    })

    it('warns on missing resumption instructions', () => {
      const gen = createHandoffGenerator({
        getSessionInfo: () => fullSessionInfo(),
      })
      const doc = gen.generate({
        sessionId: 's1',
        currentTask: 'task',
        pendingWork: [{ description: 'work', priority: 'normal' }],
        completedWork: ['done'],
        keyDecisions: [{ description: 'd', rationale: 'r' }],
        filesModified: [{ path: 'f.ts', changeType: 'modified' }],
        discoveredFacts: ['fact'],
        // no resumptionInstructions
      })
      const result = gen.validate(doc)

      expect(result.warnings).toContain(
        'Missing resumption instructions — the next session may lack context',
      )
    })

    it('marks document as valid when completeness >= 50%', () => {
      const gen = createHandoffGenerator()
      const doc = gen.generate({
        sessionId: 's1',
        currentTask: 'work',
        pendingWork: [{ description: 'task', priority: 'normal' }],
        completedWork: ['done'],
        resumptionInstructions: 'Continue',
      })
      const result = gen.validate(doc)
      expect(result.valid).toBe(true)
      expect(result.completeness).toBeGreaterThanOrEqual(50)
    })
  })

  describe('markConsumed', () => {
    it('updates status and targetSessionId', () => {
      const gen = createHandoffGenerator()
      const doc = gen.generate({ sessionId: 's1' })

      expect(doc.status).toBe(HandoffStatus.Ready)
      expect(doc.targetSessionId).toBeNull()

      const consumed = gen.markConsumed(doc, 'sess-target')

      expect(consumed.status).toBe(HandoffStatus.Consumed)
      expect(consumed.targetSessionId).toBe('sess-target')
      // Original fields preserved
      expect(consumed.id).toBe(doc.id)
      expect(consumed.sourceSessionId).toBe(doc.sourceSessionId)
    })
  })

  describe('edge cases', () => {
    it('generates unique IDs for each document', () => {
      const gen = createHandoffGenerator()
      const doc1 = gen.generate({ sessionId: 's1' })
      const doc2 = gen.generate({ sessionId: 's1' })
      expect(doc1.id).not.toBe(doc2.id)
    })

    it('handles blocked work with special characters', () => {
      const gen = createHandoffGenerator()
      const doc = gen.generate({
        sessionId: 's1',
        blockedWork: [
          { description: 'Deploy v2.0', blockedBy: 'CI/CD pipeline', since: '2024-01-01' },
        ],
      })
      const md = gen.toMarkdown(doc)
      expect(md).toContain('⛔ Deploy v2.0 — blocked by: CI/CD pipeline')
    })
  })
})
