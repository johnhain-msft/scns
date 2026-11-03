/**
 * T050 [US5] (specs/001-learning-memory-loop) — the `ask_human` outward action (FR-019, SC-011).
 *
 * ask_human is the SAFE first outward action: it contacts NOBODY outside (no egress, no spend) —
 * it delivers a clarifying question to the human through an injected channel, routed through the
 * single safetyKernel.check chokepoint so the attempt is AUDITED. With the shipped EMPTY (deny-all)
 * allowlist the call is ALLOWED (nothing external happens) while all egress stays blocked — internal
 * answering keeps working.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../../../../helpers/index.js'
import { createSafetyKernel } from '../../../../../src/broker/services/safety-kernel/safety-kernel.js'
import { createAskHumanHandler } from '../../../../../src/broker/services/outward/ask-human.js'

let h: TestDb | null = null
afterEach(() => {
  h?.close()
  h = null
})

function setup() {
  h = createTestDb()
  const kernel = createSafetyKernel({ db: h.db }) // EMPTY allowlist — deny-all egress/spend
  const delivered: { question: string }[] = []
  const handler = createAskHumanHandler({
    kernel,
    deliver: (q) => {
      delivered.push({ question: q })
      return 'q-1'
    },
  })
  const auditRows = () =>
    h!.db
      .prepare('SELECT detail, payload FROM kernel_audit ORDER BY id')
      .all() as { detail: string; payload: string | null }[]
  return { kernel, handler, delivered, auditRows }
}

describe('T050 — ask_human: allowed + audited under the deny-all allowlist, zero egress/spend', () => {
  it('POSITIVE: the question is delivered to the human channel and the decision is AUDITED', () => {
    const { handler, delivered, auditRows } = setup()
    const res = handler.askHuman({ question: 'Which vault should the soak run target?' })
    expect(res.allowed).toBe(true)
    expect(res.questionId).toBe('q-1')
    expect(delivered).toEqual([{ question: 'Which vault should the soak run target?' }])
    const audits = auditRows()
    expect(audits.length).toBeGreaterThan(0)
    expect(audits.some((a) => (a.payload ?? '').includes('ask_human'))).toBe(true)
  })

  it('NEGATIVE (input validation): an empty or >2000-char question is refused before any delivery', () => {
    const { handler, delivered } = setup()
    expect(handler.askHuman({ question: '' }).allowed).toBe(false)
    expect(handler.askHuman({ question: 'x'.repeat(2001) }).allowed).toBe(false)
    expect(delivered).toEqual([])
  })

  it('NEGATIVE (fail-safe): a throwing delivery channel yields allowed:false, never an exception', () => {
    h = createTestDb()
    const kernel = createSafetyKernel({ db: h.db })
    const handler = createAskHumanHandler({
      kernel,
      deliver: () => {
        throw new Error('channel down')
      },
    })
    const res = handler.askHuman({ question: 'still safe?' })
    expect(res.allowed).toBe(false)
    expect(res.detail).toMatch(/channel|deliver/i)
  })

  it('the audit chain stays INTACT across ask_human decisions (T053 leg)', () => {
    const { kernel, handler } = setup()
    handler.askHuman({ question: 'first?' })
    handler.askHuman({ question: 'second?' })
    const chain = kernel.verifyAuditChain()
    expect(chain.ok).toBe(true)
    expect(chain.count).toBeGreaterThanOrEqual(2)
  })
})
