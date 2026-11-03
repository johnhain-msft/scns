/**
 * T054 [US5] (specs/001-learning-memory-loop) — the AUTOMATED PROOF SUITE for SC-010/SC-011:
 * the full outward-safety behavioral table, exercised against the REAL kernel, the REAL SHIPPED
 * allowlist file (config/safety-allowlist.json — must be empty ⇒ deny-all), and the real outward
 * handlers. Run via: npm run test:integration -- outward safety-kernel
 *
 * | attempt                                            | required result                 |
 * |----------------------------------------------------|---------------------------------|
 * | ask_human (empty allowlist)                        | ALLOWED + audited, no egress    |
 * | consult_source host ∈ allowlist                    | allowed + audited               |
 * | consult_source host ∉ allowlist                    | REFUSED + audited               |
 * | any spend                                          | REFUSED (deny-all) + audited    |
 * | any diff touching kernel/allowlist (automated)     | REFUSED                         |
 * plus: verifyAuditChain() intact across all of the above; the guardrail files stay UNWRITTEN.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { createTestDb, type TestDb } from '../helpers/index.js'
import { createSafetyKernel } from '../../src/broker/services/safety-kernel/safety-kernel.js'
import {
  loadAllowlist,
  allowlistFrom,
} from '../../src/broker/services/safety-kernel/kernel-allowlist.js'
import {
  SAFETY_ALLOWLIST_PATH,
  SAFETY_KERNEL_DIR_PREFIX,
} from '../../src/broker/services/safety-kernel/protected-paths.js'
import {
  createAskHumanHandler,
  createConsultSourceHandler,
} from '../../src/broker/services/outward/index.js'
import { detectStagedKernelEdits } from '../../src/broker/services/quality-gate-arbiter.js'
import { commitRoutingPolicy } from '../../src/memory/routing-policy.js'

const REPO_ROOT = resolve(__dirname, '..', '..')
const ALLOWLIST_FILE = resolve(REPO_ROOT, SAFETY_ALLOWLIST_PATH)

let h: TestDb | null = null
afterEach(() => {
  h?.close()
  h = null
})

describe('T054 — outward safety: the full behavioral table on the REAL shipped allowlist', () => {
  it('the SHIPPED allowlist is EMPTY (deny-all) and loads fail-closed', () => {
    const shipped = loadAllowlist(ALLOWLIST_FILE)
    expect(shipped.egressHosts.size).toBe(0)
    expect(shipped.spendApis.size).toBe(0)
    const missing = loadAllowlist('/nonexistent/allowlist.json')
    expect(missing.egressHosts.size).toBe(0) // fail-closed to empty on ANY error
  })

  it('runs the whole table under one kernel; the audit chain survives; the guardrail file is untouched', async () => {
    const allowlistBefore = statSync(ALLOWLIST_FILE)
    h = createTestDb()
    const kernel = createSafetyKernel({ db: h.db, allowlist: loadAllowlist(ALLOWLIST_FILE) })
    const delivered: string[] = []
    const fetched: string[] = []
    const ask = createAskHumanHandler({
      kernel,
      deliver: (q) => {
        delivered.push(q)
        return `q-${delivered.length}`
      },
    })
    const consult = createConsultSourceHandler({
      kernel,
      fetchSource: async (url) => {
        fetched.push(url)
        return { status: 200, body: 'ok' }
      },
    })

    // Row 1 — ask_human under the EMPTY allowlist: ALLOWED + audited, zero egress/spend (SC-011).
    const asked = ask.askHuman({ question: 'Which conv should the cert run hold out?' })
    expect(asked.allowed).toBe(true)
    expect(delivered).toHaveLength(1)

    // Row 3 — consult_source host ∉ (empty ⇒ ALL hosts): REFUSED + audited, fetch never fires.
    const offList = await consult.consultSource({
      url: 'https://docs.example.com/guide',
      reason: 'off-list under the shipped deny-all',
    })
    expect(offList.allowed).toBe(false)
    expect(fetched).toEqual([])

    // Row 4 — ANY spend: REFUSED (deny-all) + audited, independent of destination.
    const spend = await consult.consultSource({
      url: 'https://api.stripe.com/v1/charges',
      reason: 'spend must always be refused',
    })
    expect(spend.allowed).toBe(false)
    expect(spend.detail).toMatch(/spend/i)
    expect(fetched).toEqual([])

    // Chain intact across the allow AND the two denies; guardrail file unwritten.
    const chain = kernel.verifyAuditChain()
    expect(chain.ok).toBe(true)
    expect(chain.count).toBeGreaterThanOrEqual(3)
    const auditRows = h.db.prepare('SELECT allow FROM kernel_audit ORDER BY id').all() as {
      allow: number
    }[]
    expect(auditRows.some((r) => r.allow === 1)).toBe(true) // allows audited
    expect(auditRows.some((r) => r.allow === 0)).toBe(true) // denies audited
    const allowlistAfter = statSync(ALLOWLIST_FILE)
    expect(allowlistAfter.mtimeMs).toBe(allowlistBefore.mtimeMs)
    expect(allowlistAfter.size).toBe(allowlistBefore.size)
  })

  it('Row 2 — consult_source host ∈ allowlist: allowed + audited (a HUMAN-populated list, injected)', async () => {
    h = createTestDb()
    const kernel = createSafetyKernel({
      db: h.db,
      allowlist: allowlistFrom({ hosts: ['docs.example.com'] }),
    })
    const fetched: string[] = []
    const consult = createConsultSourceHandler({
      kernel,
      fetchSource: async (url) => {
        fetched.push(url)
        return { status: 200, body: 'approved content' }
      },
    })
    const res = await consult.consultSource({
      url: 'https://docs.example.com/guide',
      reason: 'approved-source read',
    })
    expect(res.allowed).toBe(true)
    expect(res.body).toBe('approved content')
    expect(fetched).toEqual(['https://docs.example.com/guide'])
    expect(kernel.verifyAuditChain().ok).toBe(true)
  })

  it('Row 5 — a staged diff touching the kernel/allowlist is REFUSED by the arbiter parser (layer 3)', () => {
    const run = () => ({
      ok: true,
      stdout: `src/broker/server.ts\n${SAFETY_ALLOWLIST_PATH}\n${SAFETY_KERNEL_DIR_PREFIX}kernel-policy.ts\n`,
      stderr: '',
    })
    const flagged = detectStagedKernelEdits(run)
    expect(flagged).toContain(SAFETY_ALLOWLIST_PATH)
    expect(flagged).toContain(`${SAFETY_KERNEL_DIR_PREFIX}kernel-policy.ts`)
    expect(flagged).not.toContain('src/broker/server.ts')
  })

  it('Row 5b — the AUTOMATED evidence arbiter cannot write a guardrail path even with certified evidence', () => {
    const res = commitRoutingPolicy(SAFETY_ALLOWLIST_PATH, {
      arm: 'magma',
      committedAt: '2026-07-06T00:00:00.000Z',
      evidence: {
        deltaAcc: 0.1,
        sigma: 0.0267,
        hcopeLowerBound: 0.05,
        controlsPass: true,
        negControlN: 6,
        meanTokensDelta: -10,
        deterministicRuns: 2,
        gate: 'arm-frontier-accuracy',
        heldOut: true,
      },
    })
    expect(res.committed).toBe(false)
    expect(res.reason).toMatch(/human-owned|safety|guardrail/i)
  })
})
