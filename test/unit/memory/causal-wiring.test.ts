/**
 * Unit tests for the M1.3 L2 causal go-live wiring (cli ⇄ dream-daemon seam).
 *
 * Locks DEFAULT-OFF and the do-no-harm lifecycle of the real ACP provider factory
 * WITHOUT a real git worktree or a real `copilot --acp` spawn (all injected).
 */

import { describe, it, expect, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  buildCausalDreamConfig,
  CAUSAL_PHASE_ENV,
  type IsolatedWorktreeHandle,
} from '../../../src/memory/causal-wiring.js'
import type {
  CausalCandidate,
  CausalEdge,
  CausalProvider,
} from '../../../src/memory/causal-provider.js'

// The wiring only stores the handle; it never calls a DB method ⇒ a stub is enough.
const fakeDb = {} as Database.Database

const candidate: CausalCandidate = {
  causeKey: 'c1',
  effectKey: 'e1',
  causeContent: 'the auto-merger refused because the tree was dirty',
  effectContent: 'the dream daemon left an uncommitted edit',
  entity: 'auto-merger',
  causeFilePath: 'MEMORY.md',
  effectFilePath: 'MEMORY.md',
}

describe('buildCausalDreamConfig — default-OFF', () => {
  it('causalEdgeInference is FALSE when the env opt-in is absent', () => {
    const cfg = buildCausalDreamConfig(fakeDb, '/repo', { env: {} })
    expect(cfg.causalEdgeInference).toBe(false)
  })

  it(`causalEdgeInference is FALSE when ${CAUSAL_PHASE_ENV} is "0"`, () => {
    const cfg = buildCausalDreamConfig(fakeDb, '/repo', { env: { [CAUSAL_PHASE_ENV]: '0' } })
    expect(cfg.causalEdgeInference).toBe(false)
  })

  it(`causalEdgeInference is TRUE only when ${CAUSAL_PHASE_ENV} === "1"`, () => {
    const cfg = buildCausalDreamConfig(fakeDb, '/repo', { env: { [CAUSAL_PHASE_ENV]: '1' } })
    expect(cfg.causalEdgeInference).toBe(true)
  })

  it('passes the live memory DB handle through unchanged', () => {
    const cfg = buildCausalDreamConfig(fakeDb, '/repo', { env: {} })
    expect(cfg.memoryDb).toBe(fakeDb)
  })
})

describe('buildCausalDreamConfig — real ACP provider factory (do-no-harm lifecycle)', () => {
  it('infers NOTHING and creates NO worktree/spawn when there are no candidates', async () => {
    const makeWorktree = vi.fn()
    const makeProvider = vi.fn()
    const cfg = buildCausalDreamConfig(fakeDb, '/repo', { env: {}, makeWorktree, makeProvider })

    const edges = await cfg.makeCausalAcpProvider().infer({ candidates: [] })

    expect(edges).toEqual([])
    expect(makeWorktree).not.toHaveBeenCalled()
    expect(makeProvider).not.toHaveBeenCalled()
  })

  it('creates an isolated worktree, runs the provider, returns edges, and ALWAYS cleans up', async () => {
    const cleanup = vi.fn()
    const worktree: IsolatedWorktreeHandle = { cwd: '/tmp/wt-xyz', cleanup }
    const makeWorktree = vi.fn(() => worktree)
    const expected: CausalEdge[] = [{ causeKey: 'c1', effectKey: 'e1', confidence: 0.9 }]
    const innerInfer = vi.fn(async () => expected)
    const provider: CausalProvider = { infer: innerInfer }
    const makeProvider = vi.fn(() => provider)

    const cfg = buildCausalDreamConfig(fakeDb, '/repo', { env: {}, makeWorktree, makeProvider })
    const req = { candidates: [candidate] }
    const edges = await cfg.makeCausalAcpProvider().infer(req)

    expect(makeWorktree).toHaveBeenCalledWith('/repo')
    expect(makeProvider).toHaveBeenCalledWith('/tmp/wt-xyz')
    expect(innerInfer).toHaveBeenCalledWith(req)
    expect(edges).toBe(expected)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('tears the worktree down even when the provider throws', async () => {
    const cleanup = vi.fn()
    const makeWorktree = vi.fn((): IsolatedWorktreeHandle => ({ cwd: '/tmp/wt-err', cleanup }))
    const makeProvider = vi.fn(
      (): CausalProvider => ({
        infer: async () => {
          throw new Error('acp boom')
        },
      }),
    )

    const cfg = buildCausalDreamConfig(fakeDb, '/repo', { env: {}, makeWorktree, makeProvider })

    await expect(cfg.makeCausalAcpProvider().infer({ candidates: [candidate] })).rejects.toThrow(
      'acp boom',
    )
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})
