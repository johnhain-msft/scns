/**
 * ACP transport for the session-aware pruning evaluator (#73).
 *
 * The evaluator is the only component allowed to reason about applicability, so its transport is
 * where a model could do damage if it were an agent rather than a reader. These tests pin that it
 * is not: deny-all, text-only, ephemeral, bounded — and that EVERY failure mode yields no
 * proposals, which the evaluator turns into `uncertain`. A broken transport must never be able to
 * cause a deletion, and must never look like agreement either.
 *
 * A fake client is injected; nothing here spawns a process.
 */

import { describe, it, expect } from 'vitest'
import {
  createAcpPruningEvaluator,
  DEFAULT_PRUNING_ATTEMPT_TIMEOUT_MS,
  DEFAULT_PRUNING_BATCH_SIZE,
} from '../../../src/memory/pruning-evaluator-acp.js'
import {
  evaluatePruningCandidates,
  type PruningCandidate,
} from '../../../src/memory/pruning-evaluator.js'
import type { WorkContextSnapshot } from '../../../src/memory/work-context.js'

function snapshot(): WorkContextSnapshot {
  return {
    capturedAt: '2026-09-17T10:00:00.000Z',
    projectId: 'proj-alpha',
    projectRoot: 'C:/work/project',
    brokerDbPath: 'C:/work/broker.db',
    sessions: [
      {
        id: 's-now',
        purpose: 'implement',
        workingDir: '',
        status: 'active',
        live: true,
        archived: false,
        lastHeartbeat: null,
        createdAt: null,
      },
    ],
    activeSessionIds: ['s-now'],
    openTasks: [],
    completedTasks: [
      {
        id: 12,
        teamId: null,
        subject: 'handoff coordination',
        description: null,
        status: 'completed',
        owner: null,
        createdAt: null,
        updatedAt: null,
      },
    ],
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
  }
}

function candidate(id: string): PruningCandidate {
  return {
    path: `negative/${id}.md`,
    memoryId: id,
    rule: `rule for ${id}`,
    body: `body for ${id}`,
    category: 'correction',
    sessionId: 's-old',
    createdAt: '2026-09-01T00:00:00.000Z',
    pinned: false,
    criticStatus: null,
  }
}

function fakeClient(respond: (prompt: string) => string, hooks: Record<string, boolean> = {}) {
  return {
    async initialize() {
      hooks['initialized'] = true
    },
    async createSession() {
      return 'session-1'
    },
    async sendPrompt(_s: string, prompt: string) {
      hooks['prompted'] = true
      return { stopReason: 'end_turn', output: respond(prompt) }
    },
    async close() {
      hooks['closed'] = true
    },
  }
}

describe('createAcpPruningEvaluator — transport (injected fake client, no spawn)', () => {
  it('refuses to construct without an isolated cwd', () => {
    expect(() => createAcpPruningEvaluator({ cwd: '   ' })).toThrow(/isolated cwd/i)
  })

  it('runs a deny-all, text-only session and parses the JSON proposals', async () => {
    const hooks: Record<string, boolean> = {}
    let sentPrompt = ''
    let clientOpts: Record<string, unknown> | undefined

    const provider = createAcpPruningEvaluator({
      cwd: '/tmp/scns-prune-isolated',
      createClient: (opts) => {
        clientOpts = opts as unknown as Record<string, unknown>
        return fakeClient((p) => {
          sentPrompt = p
          return JSON.stringify([
            {
              memoryId: 'm1',
              verdict: 'retire',
              applicability: 'coordination-bound',
              rationale: 'the handoff task closed',
              evidenceRefs: ['task:12'],
            },
          ])
        }, hooks) as never
      },
    })

    const proposals = await provider.assess({
      candidates: [candidate('m1')],
      snapshot: snapshot(),
    })

    expect(hooks['initialized']).toBe(true)
    expect(hooks['closed']).toBe(true) // ephemeral: always torn down
    expect(proposals).toHaveLength(1)
    expect(proposals[0]!.verdict).toBe('retire')

    // The evidence and the refusal policy both reach the model.
    expect(sentPrompt).toContain('task#12')
    expect(sentPrompt).toContain('rule for m1')
    expect(sentPrompt).toMatch(/silence is not evidence/i)

    // Think-only: it can read evidence, it can never run a tool or edit a file.
    expect(clientOpts?.['allowAllTools']).toBe(false)
    expect(clientOpts?.['permissionPolicy']).toBeDefined()
  })

  it('yields no proposals when the transport throws — and the evaluator reads that as uncertain', async () => {
    const hooks: Record<string, boolean> = {}
    const provider = createAcpPruningEvaluator({
      cwd: '/tmp/scns-prune-isolated',
      createClient: () =>
        ({
          async initialize() {
            throw new Error('spawn failed')
          },
          async createSession() {
            return 's'
          },
          async sendPrompt() {
            return { stopReason: 'end_turn', output: '' }
          },
          async close() {
            hooks['closed'] = true
          },
        }) as never,
    })

    const proposals = await provider.assess({
      candidates: [candidate('m1')],
      snapshot: snapshot(),
    })
    expect(proposals).toEqual([])
    expect(hooks['closed']).toBe(true)

    // Do no harm: a dead transport can neither delete anything nor claim agreement.
    const result = await evaluatePruningCandidates({
      candidates: [candidate('m1')],
      snapshot: snapshot(),
      provider,
    })
    expect(result.decisions[0]!.verdict).toBe('uncertain')
  })

  it('yields no proposals for an unparseable response rather than inventing them', async () => {
    const provider = createAcpPruningEvaluator({
      cwd: '/tmp/scns-prune-isolated',
      createClient: () => fakeClient(() => 'Sure! I would delete all of them.') as never,
    })
    expect(
      await provider.assess({ candidates: [candidate('m1')], snapshot: snapshot() }),
    ).toEqual([])
  })

  it('is bounded: a hanging transport times out into no proposals', async () => {
    const provider = createAcpPruningEvaluator({
      cwd: '/tmp/scns-prune-isolated',
      attemptTimeoutMs: 20,
      createClient: () =>
        ({
          async initialize() {},
          async createSession() {
            return 's'
          },
          async sendPrompt() {
            return new Promise(() => {
              /* never settles */
            })
          },
          async close() {},
        }) as never,
    })

    const proposals = await provider.assess({
      candidates: [candidate('m1')],
      snapshot: snapshot(),
    })
    expect(proposals).toEqual([])
  })

  it('splits candidates into bounded batches, one session per batch', async () => {
    let sessions = 0
    const provider = createAcpPruningEvaluator({
      cwd: '/tmp/scns-prune-isolated',
      batchSize: 2,
      createClient: () => {
        sessions++
        return fakeClient(() => '[]') as never
      },
    })

    await provider.assess({
      candidates: [candidate('m1'), candidate('m2'), candidate('m3'), candidate('m4'), candidate('m5')],
      snapshot: snapshot(),
    })
    expect(sessions).toBe(3) // ceil(5 / 2)
  })

  it('exposes sane bounded defaults', () => {
    expect(DEFAULT_PRUNING_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(0)
    expect(DEFAULT_PRUNING_ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(600_000)
    expect(DEFAULT_PRUNING_BATCH_SIZE).toBeGreaterThan(0)
  })
})
