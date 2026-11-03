/**
 * Session-aware pruning evaluator (#73).
 *
 * The mechanism that turns "what is still applicable?" into a reviewable decision. It follows
 * Mem0's compare-and-propose shape (candidate vs related evidence ⇒ a structured operation) and
 * Zep/Graphiti's validity treatment (applicability ENDS on a superseding fact, separately from
 * storage time) — adapted to SCNS records, not adopted as a second memory platform.
 *
 * The invariants these tests pin are the safety ones:
 *   - a semantic model may PROPOSE; deterministic code decides what is allowed to stand;
 *   - every destructive verdict must cite evidence that actually exists in the snapshot;
 *   - absence of evidence yields `uncertain`, never `retire`;
 *   - pinned and durable lessons survive age, silence and empty session lists.
 */

import { describe, it, expect } from 'vitest'
import {
  evaluatePruningCandidates,
  buildEvidenceIndex,
  NULL_PRUNING_PROVIDER,
  parsePruningResponse,
  buildPruningPrompt,
  buildPruningUserPrompt,
  type PruningCandidate,
  type PruningProvider,
  type ProviderProposal,
} from '../../../src/memory/pruning-evaluator.js'
import type { WorkContextSnapshot } from '../../../src/memory/work-context.js'

function snapshot(over: Partial<WorkContextSnapshot> = {}): WorkContextSnapshot {
  return {
    capturedAt: '2026-09-17T10:00:00.000Z',
    projectId: 'proj-alpha',
    projectRoot: 'C:/work/project',
    brokerDbPath: 'C:/work/broker.db',
    sessions: [],
    activeSessionIds: [],
    openTasks: [],
    completedTasks: [],
    unreadMessages: [],
    openIntents: [],
    orphanedMessages: [],
    orphanedTasks: [],
    orphanedIntents: [],
    scopedOutCoordination: { messages: 0, intents: 0, tasks: 0 },
    humanTurns: [],
    completeness: {
      level: 'complete',
      brokerReachable: true,
      sessionsAvailable: true,
      tasksAvailable: true,
      messagesAvailable: true,
      intentsAvailable: true,
      transcriptsAvailable: true,
      coordinationAttributable: true,
      tasksAttributable: true,
      inventoryComplete: true,
      gaps: [],
    },
    ...over,
  }
}

function candidate(over: Partial<PruningCandidate> = {}): PruningCandidate {
  return {
    path: 'negative/m1.md',
    memoryId: 'm1',
    rule: 'Wait for the handoff session before implementing',
    body: 'Wait for the handoff session before implementing.',
    category: 'correction',
    sessionId: 's-old',
    createdAt: '2026-09-01T00:00:00.000Z',
    pinned: false,
    criticStatus: null,
    ...over,
  }
}

function providerReturning(proposals: readonly ProviderProposal[]): PruningProvider {
  return { assess: async () => proposals }
}

describe('pruning evaluator', () => {
  it('retires a temporary instruction when the coordination demonstrably ended', async () => {
    const snap = snapshot({
      sessions: [
        {
          id: 's-now',
          purpose: 'implement pruning',
          workingDir: 'C:/work/project',
          status: 'active',
          live: true,
          archived: false,
          lastHeartbeat: null,
          createdAt: null,
        },
      ],
      activeSessionIds: ['s-now'],
      completedTasks: [
        {
          id: 12,
          teamId: 't1',
          subject: 'Handoff session coordination',
          description: null,
          status: 'completed',
          owner: null,
          createdAt: null,
          updatedAt: '2026-09-16T00:00:00.000Z',
        },
      ],
      humanTurns: [
        {
          sessionId: 's-now',
          turnIndex: 0,
          text: 'the handoff is finished, implement it now',
          timestampMs: 1,
        },
      ],
    })

    const result = await evaluatePruningCandidates({
      candidates: [candidate()],
      snapshot: snap,
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'retire',
          applicability: 'coordination-bound',
          rationale: 'the handoff coordination completed and the human asked for implementation',
          evidenceRefs: ['task:12', 'turn:s-now#0'],
        },
      ]),
    })

    expect(result.decisions).toHaveLength(1)
    const d = result.decisions[0]!
    expect(d.verdict).toBe('retire')
    expect(d.evidenceRefs).toEqual(['task:12', 'turn:s-now#0'])
    expect(d.source).toBe('provider')
    // Arm C regression guard (#73 round-2): the orphan fix below must not become a blanket
    // downgrade. Complete evidence with nothing unattributable still reaches a real verdict.
    expect(snap.completeness.coordinationAttributable).toBe(true)
    expect(result.downgraded).toBe(0)
  })

  // ── Orphaned coordination (#73 round-2 N1) ───────────────────────────────────
  //
  // `sessions` reads fine, so no source is blind in the old sense — but a coordination row
  // that resolves to no session row at all means the inventory the coordination guard checks
  // is TRUNCATED. An empty objection from a truncated inventory is silence, not agreement.

  it('refuses a destructive verdict while coordination could not be attributed to any session', async () => {
    const snap = snapshot({
      sessions: [
        {
          id: 's-now',
          purpose: 'implement pruning',
          workingDir: 'C:/work/project',
          status: 'active',
          live: true,
          archived: false,
          lastHeartbeat: null,
          createdAt: null,
        },
      ],
      activeSessionIds: ['s-now'],
      completedTasks: [
        {
          id: 12,
          teamId: 't1',
          subject: 'Handoff session coordination',
          description: null,
          status: 'completed',
          owner: null,
          createdAt: null,
          updatedAt: '2026-09-16T00:00:00.000Z',
        },
      ],
      orphanedMessages: [
        {
          id: 'm-orphan',
          senderId: 's-old',
          receiverId: null,
          content: 'still blocked on you',
          createdAt: null,
        },
      ],
      completeness: {
        level: 'partial',
        brokerReachable: true,
        sessionsAvailable: true,
        tasksAvailable: true,
        messagesAvailable: true,
        intentsAvailable: true,
        transcriptsAvailable: true,
        coordinationAttributable: false,
        tasksAttributable: true,
        inventoryComplete: true,
        gaps: ['1 unread message references session s-old, which is no longer in the broker'],
      },
    })

    const result = await evaluatePruningCandidates({
      candidates: [candidate({ sessionId: 's-old' })],
      snapshot: snap,
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'retire',
          applicability: 'coordination-bound',
          rationale: 'no coordination remains for this memory',
          evidenceRefs: ['task:12'],
        },
      ]),
    })

    const d = result.decisions[0]!
    expect(d.verdict).toBe('uncertain')
    expect(d.source).toBe('guard')
    expect(d.rationale).toMatch(/s-old|no longer in the broker|orphan/i)
    expect(result.downgraded).toBe(1)
  })

  it('lets an unattributable row be cited as evidence rather than treating it as nonexistent', async () => {
    const snap = snapshot({
      orphanedMessages: [
        {
          id: 'm-orphan',
          senderId: null,
          receiverId: null,
          content: 'did you ever land the fix?',
          createdAt: null,
        },
      ],
      orphanedIntents: [
        { filePath: 'src/ghost.ts', sessionId: 's-old', intent: 'edit', declaredAt: null },
      ],
      completeness: {
        level: 'partial',
        brokerReachable: true,
        sessionsAvailable: true,
        tasksAvailable: true,
        messagesAvailable: true,
        intentsAvailable: true,
        transcriptsAvailable: true,
        coordinationAttributable: false,
        tasksAttributable: true,
        inventoryComplete: true,
        gaps: ['orphaned coordination'],
      },
    })

    // An orphaned row is an OBSERVED fact — it was read out of the broker DB. It is not
    // attributable, which is why it blocks removal, but citing it must not be rejected as an
    // unverifiable claim.
    const index = buildEvidenceIndex(snap)
    expect(index.has('message:m-orphan')).toBe(true)
    expect(index.has('intent:src/ghost.ts')).toBe(true)

    const result = await evaluatePruningCandidates({
      candidates: [candidate()],
      snapshot: snap,
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'keep',
          applicability: 'coordination-bound',
          rationale: 'the orphaned message still points at this memory',
          evidenceRefs: ['message:m-orphan', 'intent:src/ghost.ts'],
        },
      ]),
    })

    const d = result.decisions[0]!
    expect(d.verdict).toBe('keep')
    expect(d.evidenceRefs).toEqual(['message:m-orphan', 'intent:src/ghost.ts'])
  })

  it('keeps a pinned memory regardless of what the provider proposes', async () => {
    const result = await evaluatePruningCandidates({
      candidates: [candidate({ pinned: true })],
      snapshot: snapshot(),
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'retire',
          applicability: 'task-bound',
          rationale: 'looks stale',
          evidenceRefs: [],
        },
      ]),
    })

    const d = result.decisions[0]!
    expect(d.verdict).toBe('keep')
    expect(d.source).toBe('guard')
    expect(d.rationale).toMatch(/pinned/i)
  })

  it('downgrades a destructive verdict that cites no evidence', async () => {
    const result = await evaluatePruningCandidates({
      candidates: [candidate()],
      snapshot: snapshot(),
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'retire',
          applicability: 'task-bound',
          rationale: 'no session mentions this any more',
          evidenceRefs: [],
        },
      ]),
    })

    const d = result.decisions[0]!
    expect(d.verdict).toBe('uncertain')
    expect(d.rationale).toMatch(/evidence/i)
    // Silence about a memory is not proof its applicability ended.
    expect(result.downgraded).toBe(1)
  })

  it('downgrades a verdict citing evidence that does not exist in the snapshot', async () => {
    const result = await evaluatePruningCandidates({
      candidates: [candidate()],
      snapshot: snapshot({
        completedTasks: [
          {
            id: 7,
            teamId: null,
            subject: 'real task',
            description: null,
            status: 'completed',
            owner: null,
            createdAt: null,
            updatedAt: null,
          },
        ],
      }),
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'retire',
          applicability: 'task-bound',
          rationale: 'task 999 closed',
          evidenceRefs: ['task:999'],
        },
      ]),
    })

    const d = result.decisions[0]!
    expect(d.verdict).toBe('uncertain')
    expect(d.rationale).toMatch(/task:999/)
  })

  it('never retires anything when the broker evidence was unavailable', async () => {
    const snap = snapshot({
      completeness: {
        level: 'unavailable',
        brokerReachable: false,
        sessionsAvailable: false,
        tasksAvailable: false,
        messagesAvailable: false,
        intentsAvailable: false,
        transcriptsAvailable: false,
        coordinationAttributable: false,
        tasksAttributable: true,
        inventoryComplete: true,
        gaps: ['broker database not found'],
      },
    })

    const result = await evaluatePruningCandidates({
      candidates: [candidate()],
      snapshot: snap,
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'retire',
          applicability: 'coordination-bound',
          rationale: 'nothing references it',
          evidenceRefs: ['task:12'],
        },
      ]),
    })

    const d = result.decisions[0]!
    expect(d.verdict).toBe('uncertain')
    expect(d.rationale).toMatch(/evidence|unavailable/i)
  })

  it('protects a coordination-bound rule while its session still holds unresolved coordination', async () => {
    const snap = snapshot({
      sessions: [
        {
          id: 's-old',
          purpose: 'peer session',
          workingDir: 'C:/work/project',
          status: 'active',
          live: true,
          archived: false,
          lastHeartbeat: null,
          createdAt: null,
        },
      ],
      activeSessionIds: ['s-old'],
      unreadMessages: [
        {
          id: 'msg-1',
          senderId: 's-other',
          receiverId: 's-old',
          content: 'still waiting on your branch',
          createdAt: '2026-09-17T09:00:00.000Z',
        },
      ],
      completedTasks: [
        {
          id: 12,
          teamId: null,
          subject: 'something else',
          description: null,
          status: 'completed',
          owner: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
    })

    const result = await evaluatePruningCandidates({
      candidates: [candidate({ sessionId: 's-old' })],
      snapshot: snap,
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'retire',
          applicability: 'coordination-bound',
          rationale: 'coordination looks done',
          evidenceRefs: ['task:12'],
        },
      ]),
    })

    const d = result.decisions[0]!
    expect(d.verdict).toBe('uncertain')
    expect(d.contraryEvidence.join(' ')).toMatch(/msg-1|unread/i)
  })

  it('allows a superseded phase restriction to retire inside a still-open session', async () => {
    const snap = snapshot({
      sessions: [
        {
          id: 's-old',
          purpose: 'planning then implementation',
          workingDir: 'C:/work/project',
          status: 'active',
          live: true,
          archived: false,
          lastHeartbeat: null,
          createdAt: null,
        },
      ],
      activeSessionIds: ['s-old'],
      humanTurns: [
        {
          sessionId: 's-old',
          turnIndex: 3,
          text: 'begin local implementation now',
          timestampMs: 2,
        },
      ],
    })

    const result = await evaluatePruningCandidates({
      candidates: [candidate({ sessionId: 's-old' })],
      snapshot: snap,
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'retire',
          applicability: 'task-bound',
          rationale: 'the planning-only restriction was explicitly superseded by the human',
          evidenceRefs: ['turn:s-old#3'],
        },
      ]),
    })

    expect(result.decisions[0]!.verdict).toBe('retire')
  })

  it('accepts a revision that keeps the durable clause and drops the expired one', async () => {
    const snap = snapshot({
      humanTurns: [
        { sessionId: 's-now', turnIndex: 1, text: 'planning is over', timestampMs: 1 },
      ],
      sessions: [
        {
          id: 's-now',
          purpose: 'p',
          workingDir: '',
          status: 'active',
          live: true,
          archived: false,
          lastHeartbeat: null,
          createdAt: null,
        },
      ],
      activeSessionIds: ['s-now'],
    })

    const result = await evaluatePruningCandidates({
      candidates: [
        candidate({
          rule: 'Use hub-and-spoke networking and do not implement in this handoff session',
          body: 'Use hub-and-spoke networking and do not implement in this handoff session.',
        }),
      ],
      snapshot: snap,
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'revise',
          applicability: 'project-requirement',
          rationale: 'the network requirement is durable; the session restriction expired',
          evidenceRefs: ['turn:s-now#1'],
          revisedRule: 'Use hub-and-spoke networking',
          revisedBody: 'Use hub-and-spoke networking.',
        },
      ]),
    })

    const d = result.decisions[0]!
    expect(d.verdict).toBe('revise')
    expect(d.revisedRule).toBe('Use hub-and-spoke networking')
    expect(d.revisedBody).toBe('Use hub-and-spoke networking.')
  })

  it('downgrades a revision that supplies no replacement text', async () => {
    const snap = snapshot({
      sessions: [
        {
          id: 's-now',
          purpose: 'p',
          workingDir: '',
          status: 'active',
          live: true,
          archived: false,
          lastHeartbeat: null,
          createdAt: null,
        },
      ],
      activeSessionIds: ['s-now'],
      humanTurns: [{ sessionId: 's-now', turnIndex: 1, text: 'done', timestampMs: 1 }],
    })

    const result = await evaluatePruningCandidates({
      candidates: [candidate()],
      snapshot: snap,
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'revise',
          applicability: 'project-requirement',
          rationale: 'needs rewording',
          evidenceRefs: ['turn:s-now#1'],
        },
      ]),
    })

    expect(result.decisions[0]!.verdict).toBe('uncertain')
    expect(result.decisions[0]!.rationale).toMatch(/replacement|revisedRule/i)
  })

  it('refuses a destructive verdict when the sources that could contradict it were unreadable', async () => {
    // Only the sessions table is unreadable. `activeSessionIds` is therefore empty — which must
    // NOT be read as "no coordination is live". This is the F1 regression: the contrary-evidence
    // guard silently no-ops when its own input is missing.
    const snap = snapshot({
      completeness: {
        level: 'partial',
        brokerReachable: true,
        sessionsAvailable: false,
        tasksAvailable: true,
        messagesAvailable: true,
        intentsAvailable: true,
        transcriptsAvailable: true,
        coordinationAttributable: true,
        tasksAttributable: true,
        inventoryComplete: true,
        gaps: ['sessions could not be read'],
      },
      completedTasks: [
        {
          id: 12,
          teamId: null,
          subject: 'closed',
          description: null,
          status: 'completed',
          owner: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      unreadMessages: [
        {
          id: 'm-open',
          senderId: 's-old',
          receiverId: 's-other',
          content: 'still blocked',
          createdAt: null,
        },
      ],
    })

    const result = await evaluatePruningCandidates({
      candidates: [candidate({ sessionId: 's-old' })],
      snapshot: snap,
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'retire',
          applicability: 'coordination-bound',
          rationale: 'the task closed',
          evidenceRefs: ['task:12'],
        },
      ]),
    })

    expect(result.decisions[0]!.verdict).toBe('uncertain')
    expect(result.decisions[0]!.rationale).toMatch(/sessions/i)
  })

  it.each([
    ['sessionsAvailable', { sessionsAvailable: false }],
    ['messagesAvailable', { messagesAvailable: false }],
    ['intentsAvailable', { intentsAvailable: false }],
    ['tasksAvailable', { tasksAvailable: false }],
    ['coordinationAttributable', { coordinationAttributable: false }],
    ['tasksAttributable', { tasksAttributable: false }],
    ['inventoryComplete', { inventoryComplete: false }],
  ])(
    'refuses a destructive verdict when %s is false, even with an otherwise valid citation',
    async (_name, override) => {
      const snap = snapshot({
        completeness: {
          level: 'partial',
          brokerReachable: true,
          sessionsAvailable: true,
          tasksAvailable: true,
          messagesAvailable: true,
          intentsAvailable: true,
          transcriptsAvailable: true,
          coordinationAttributable: true,
          tasksAttributable: true,
          inventoryComplete: true,
          gaps: ['one source unreadable'],
          ...override,
        },
        completedTasks: [
          {
            id: 12,
            teamId: null,
            subject: 'closed',
            description: null,
            status: 'completed',
            owner: null,
            createdAt: null,
            updatedAt: null,
          },
        ],
      })

      const result = await evaluatePruningCandidates({
        candidates: [candidate()],
        snapshot: snap,
        provider: providerReturning([
          {
            memoryId: 'm1',
            verdict: 'retire',
            applicability: 'task-bound',
            rationale: 'the task closed',
            evidenceRefs: ['task:12'],
          },
        ]),
      })

      expect(result.decisions[0]!.verdict).toBe('uncertain')
    },
  )

  it('still allows a cited retirement when only the transcript oracle was missing', async () => {
    const snap = snapshot({
      completeness: {
        level: 'partial',
        brokerReachable: true,
        sessionsAvailable: true,
        tasksAvailable: true,
        messagesAvailable: true,
        intentsAvailable: true,
        transcriptsAvailable: false,
        coordinationAttributable: true,
        tasksAttributable: true,
        inventoryComplete: true,
        gaps: ['human-turn transcript unavailable'],
      },
      completedTasks: [
        {
          id: 12,
          teamId: null,
          subject: 'closed',
          description: null,
          status: 'completed',
          owner: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
    })

    const result = await evaluatePruningCandidates({
      candidates: [candidate()],
      snapshot: snap,
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'retire',
          applicability: 'task-bound',
          rationale: 'the bound task completed',
          evidenceRefs: ['task:12'],
        },
      ]),
    })

    // Every source that could contradict this was readable, and the citation is real.
    expect(result.decisions[0]!.verdict).toBe('retire')
  })

  it.each(['idle', 'waiting', 'running'])(
    'treats a %s session as live coordination, not as an ended one',
    async (status) => {
      const snap = snapshot({
        sessions: [
          {
            id: 's-old',
            purpose: 'resumed peer',
            workingDir: '',
            status,
            live: true,
            archived: false,
            lastHeartbeat: null,
            createdAt: null,
          },
        ],
        activeSessionIds: ['s-old'],
        unreadMessages: [
          {
            id: 'm-open',
            senderId: 's-old',
            receiverId: 's-other',
            content: 'still blocked',
            createdAt: null,
          },
        ],
        completedTasks: [
          {
            id: 12,
            teamId: null,
            subject: 'closed',
            description: null,
            status: 'completed',
            owner: null,
            createdAt: null,
            updatedAt: null,
          },
        ],
      })

      const result = await evaluatePruningCandidates({
        candidates: [candidate({ sessionId: 's-old' })],
        snapshot: snap,
        provider: providerReturning([
          {
            memoryId: 'm1',
            verdict: 'retire',
            applicability: 'coordination-bound',
            rationale: 'looks done',
            evidenceRefs: ['task:12'],
          },
        ]),
      })

      expect(result.decisions[0]!.verdict).toBe('uncertain')
      expect(result.decisions[0]!.contraryEvidence.join(' ')).toMatch(/m-open/)
    },
  )

  it('records uncertain — not keep — when the provider throws', async () => {
    const provider: PruningProvider = {
      assess: async () => {
        throw new Error('ACP transport failed')
      },
    }

    const result = await evaluatePruningCandidates({
      candidates: [candidate()],
      snapshot: snapshot(),
      provider,
    })

    const d = result.decisions[0]!
    expect(d.verdict).toBe('uncertain')
    expect(d.rationale).toMatch(/ACP transport failed|evaluator/i)
    expect(result.evaluatorFailed).toBe(true)
  })

  it('marks a candidate the provider omitted as uncertain', async () => {
    const result = await evaluatePruningCandidates({
      candidates: [candidate(), candidate({ memoryId: 'm2', path: 'negative/m2.md' })],
      snapshot: snapshot(),
      provider: providerReturning([
        {
          memoryId: 'm1',
          verdict: 'keep',
          applicability: 'durable',
          rationale: 'still applies',
          evidenceRefs: [],
        },
      ]),
    })

    const byId = new Map(result.decisions.map((d) => [d.memoryId, d]))
    expect(byId.get('m1')!.verdict).toBe('keep')
    expect(byId.get('m2')!.verdict).toBe('uncertain')
    expect(byId.get('m2')!.rationale).toMatch(/omitted|no assessment/i)
  })

  it('the null provider assesses nothing and returns uncertain', async () => {
    const result = await evaluatePruningCandidates({
      candidates: [candidate()],
      snapshot: snapshot(),
      provider: NULL_PRUNING_PROVIDER,
    })

    expect(result.decisions[0]!.verdict).toBe('uncertain')
    expect(result.decisions[0]!.rationale).toMatch(/no .*evaluator/i)
  })

  it('parses a provider response and discards malformed entries', () => {
    const parsed = parsePruningResponse(
      '```json\n' +
        JSON.stringify([
          {
            memoryId: 'm1',
            verdict: 'retire',
            applicability: 'task-bound',
            rationale: 'done',
            evidenceRefs: ['task:1'],
          },
          { memoryId: 'm2', verdict: 'explode', rationale: 'nope' },
          { verdict: 'keep' },
        ]) +
        '\n```',
    )

    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.memoryId).toBe('m1')
  })

  it('returns no proposals for an unparseable response rather than inventing them', () => {
    expect(parsePruningResponse('I think you should delete everything.')).toEqual([])
  })

  it('builds a prompt that carries the candidates, the evidence and the refusal rule', () => {
    const req = {
      candidates: [candidate()],
      snapshot: snapshot({
        sessions: [
          {
            id: 's-now',
            purpose: 'implement pruning',
            workingDir: '',
            status: 'active',
            live: true,
            archived: false,
            lastHeartbeat: null,
            createdAt: null,
          },
        ],
        activeSessionIds: ['s-now'],
      }),
    }
    const userPrompt = buildPruningUserPrompt(req)
    const fullPrompt = buildPruningPrompt(req)

    expect(userPrompt).toContain('m1')
    expect(userPrompt).toContain('Wait for the handoff session before implementing')
    expect(userPrompt).toContain('s-now')
    // The policy the provider actually sends must state that silence is not evidence.
    expect(fullPrompt).toMatch(/uncertain/i)
    expect(fullPrompt).toMatch(/silence is not evidence/i)
    expect(fullPrompt).toContain(userPrompt)
  })
})
