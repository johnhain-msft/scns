/**
 * WS-0 Safety Kernel — immutable audit log tests (Gate 4).
 *
 * The audit is an append-only, hash-chained table. Every gated decision
 * (allow AND deny) is recorded. `verifyAuditChain` detects ANY tamper.
 *
 * RED-TEAM N6: mutate a committed row via raw SQL (the writer exposes no
 * UPDATE/DELETE path) and prove the chain verification reports the break.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  ensureKernelAuditTable,
  appendAudit,
  getAuditRows,
  verifyAuditChain,
  KERNEL_AUDIT_GENESIS_HASH,
} from '../../../../../src/broker/services/safety-kernel/kernel-audit.js'
import { createTestDb, type TestDb } from '../../../../helpers/db-harness.js'

let h: TestDb | null = null
afterEach(() => {
  h?.close()
  h = null
})
function freshDb(): TestDb {
  h = createTestDb()
  ensureKernelAuditTable(h.db)
  return h
}

describe('kernel-audit', () => {
  it('appends allow AND deny decisions and reads them back in order', () => {
    const { db } = freshDb()
    appendAudit(db, { actionKind: 'tool_call', sessionId: 's1', gate: 'default-allow', allow: true, detail: 'safe read' })
    appendAudit(db, { actionKind: 'tool_call', sessionId: 's1', gate: 'egress-allowlist', allow: false, detail: 'evil.example.com' })
    appendAudit(db, { actionKind: 'spend', sessionId: 's2', gate: 'no-spend', allow: false, detail: 'api.openai.com' })
    const rows = getAuditRows(db)
    expect(rows.length).toBe(3)
    expect(rows.map((r) => r.allow)).toEqual([true, false, false])
    expect(rows.map((r) => r.gate)).toEqual(['default-allow', 'egress-allowlist', 'no-spend'])
  })

  it('chains hashes: row 1 prev=GENESIS, each row prev = previous rowHash', () => {
    const { db } = freshDb()
    const r1 = appendAudit(db, { actionKind: 'tool_call', sessionId: 's', gate: 'default-allow', allow: true, detail: 'a' })
    const r2 = appendAudit(db, { actionKind: 'tool_call', sessionId: 's', gate: 'default-allow', allow: true, detail: 'b' })
    expect(r1.prevHash).toBe(KERNEL_AUDIT_GENESIS_HASH)
    expect(r2.prevHash).toBe(r1.rowHash)
    expect(r1.rowHash).not.toBe(r2.rowHash)
  })

  it('verifyAuditChain returns ok for an untouched chain', () => {
    const { db } = freshDb()
    for (let i = 0; i < 5; i++) {
      appendAudit(db, { actionKind: 'tool_call', sessionId: 's', gate: 'default-allow', allow: true, detail: `d${i}` })
    }
    const v = verifyAuditChain(db)
    expect(v.ok).toBe(true)
    expect(v.count).toBe(5)
    expect(v.brokenAtId).toBeUndefined()
  })

  it('N6: detects a tampered row (raw UPDATE) and reports the broken id', () => {
    const { db } = freshDb()
    appendAudit(db, { actionKind: 'tool_call', sessionId: 's', gate: 'default-allow', allow: true, detail: 'one' })
    appendAudit(db, { actionKind: 'egress', sessionId: 's', gate: 'egress-allowlist', allow: false, detail: 'two' })
    appendAudit(db, { actionKind: 'tool_call', sessionId: 's', gate: 'default-allow', allow: true, detail: 'three' })
    // Tamper: flip a recorded DENY into an apparent ALLOW on row 2.
    db.prepare('UPDATE kernel_audit SET allow = 1, detail = ? WHERE id = 2').run('two-tampered')
    const v = verifyAuditChain(db)
    expect(v.ok).toBe(false)
    expect(v.brokenAtId).toBe(2)
  })

  it('N6b: detects a deleted row (chain link break)', () => {
    const { db } = freshDb()
    appendAudit(db, { actionKind: 'tool_call', sessionId: 's', gate: 'default-allow', allow: true, detail: '1' })
    appendAudit(db, { actionKind: 'tool_call', sessionId: 's', gate: 'default-allow', allow: true, detail: '2' })
    appendAudit(db, { actionKind: 'tool_call', sessionId: 's', gate: 'default-allow', allow: true, detail: '3' })
    db.prepare('DELETE FROM kernel_audit WHERE id = 2').run()
    const v = verifyAuditChain(db)
    expect(v.ok).toBe(false)
    expect(v.brokenAtId).toBe(3)
  })

  it('LIMIT (documented, L0): tail-truncation of the newest row is NOT detected by the chain alone', () => {
    // Honest negative control / tripwire. A pure hash-chain cannot detect
    // deletion of the most-recent row(s): the remaining prefix still verifies
    // cleanly against GENESIS. Tail-truncation resistance needs an external
    // head-anchor (scheduled L0); out-of-band, every decision is also mirrored
    // to the append-only `events` table. This test PINS the known limitation
    // so the "detects deletion" claim stays honest — if a head-anchor is later
    // added, this expectation should flip to detected and the test updated.
    const { db } = freshDb()
    appendAudit(db, { actionKind: 'tool_call', sessionId: 's', gate: 'default-allow', allow: true, detail: '1' })
    appendAudit(db, { actionKind: 'tool_call', sessionId: 's', gate: 'default-allow', allow: true, detail: '2' })
    appendAudit(db, { actionKind: 'egress', sessionId: 's', gate: 'egress-allowlist', allow: false, detail: 'covering-tracks' })
    // Delete the NEWEST row (the deny an agent would most want to erase).
    db.prepare('DELETE FROM kernel_audit WHERE id = (SELECT MAX(id) FROM kernel_audit)').run()
    const v = verifyAuditChain(db)
    expect(v.ok).toBe(true) // ← documents the residual: tail-truncation NOT caught by the chain alone
    expect(v.count).toBe(2)
  })

  it('is deterministic: identical inputs in the same chain position yield identical hashes', () => {
    const a = freshDb()
    const rowA = appendAudit(a.db, { actionKind: 'tool_call', sessionId: 's', gate: 'default-allow', allow: true, detail: 'x', ts: '2026-01-01T00:00:00.000Z' })
    a.close()
    h = null
    const b = createTestDb()
    h = b
    ensureKernelAuditTable(b.db)
    const rowB = appendAudit(b.db, { actionKind: 'tool_call', sessionId: 's', gate: 'default-allow', allow: true, detail: 'x', ts: '2026-01-01T00:00:00.000Z' })
    expect(rowA.rowHash).toBe(rowB.rowHash)
  })
})

// ── T053 [US5] (specs/001-learning-memory-loop) — chain integrity across OUTWARD allow AND deny ──
import { statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { createSafetyKernel } from '../../../../../src/broker/services/safety-kernel/safety-kernel.js'
import { allowlistFrom } from '../../../../../src/broker/services/safety-kernel/kernel-allowlist.js'
import {
  createAskHumanHandler,
  createConsultSourceHandler,
} from '../../../../../src/broker/services/outward/index.js'

describe('T053 — verifyAuditChain stays intact across interleaved outward allows AND denies', () => {
  it('ask_human allow + consult allow + consult deny + spend deny ⇒ one unbroken hash chain', async () => {
    const h = createTestDb()
    try {
      const allowlistBefore = statSync(resolvePath('config/safety-allowlist.json'))
      const kernel = createSafetyKernel({
        db: h.db,
        allowlist: allowlistFrom({ hosts: ['docs.example.com'] }),
      })
      const ask = createAskHumanHandler({ kernel, deliver: () => 'q-1' })
      const consult = createConsultSourceHandler({
        kernel,
        fetchSource: async (url) => ({ status: 200, body: `ok ${url}` }),
      })
      expect(ask.askHuman({ question: 'may I?' }).allowed).toBe(true)
      expect(
        (await consult.consultSource({ url: 'https://docs.example.com/a', reason: 'r' })).allowed,
      ).toBe(true)
      expect(
        (await consult.consultSource({ url: 'https://evil.example.net/b', reason: 'r' })).allowed,
      ).toBe(false)
      expect(
        (
          await consult.consultSource({
            url: 'https://api.openai.com/v1/chat/completions',
            reason: 'r',
          })
        ).allowed,
      ).toBe(false)

      const chain = kernel.verifyAuditChain()
      expect(chain.ok).toBe(true)
      expect(chain.count).toBeGreaterThanOrEqual(4) // every allow AND deny is a chained row

      // The human-owned guardrail file was NEVER written by any of the above.
      const allowlistAfter = statSync(resolvePath('config/safety-allowlist.json'))
      expect(allowlistAfter.mtimeMs).toBe(allowlistBefore.mtimeMs)
      expect(allowlistAfter.size).toBe(allowlistBefore.size)
    } finally {
      h.close()
    }
  })
})
