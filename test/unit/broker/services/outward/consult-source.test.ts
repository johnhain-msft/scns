/**
 * T051 [US5] (specs/001-learning-memory-loop) — the `consult_source` outward action (FR-020/021).
 *
 * consult_source READS an approved source. safetyKernel.checkEgress runs FIRST: host ∈ allowlist ⇒
 * allowed + audited; host ∉ allowlist (the shipped allowlist is EMPTY ⇒ every host) ⇒ REFUSED +
 * audited and the fetch NEVER fires; a spend API ⇒ refused deny-all regardless of destination.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../../../../helpers/index.js'
import { createSafetyKernel } from '../../../../../src/broker/services/safety-kernel/safety-kernel.js'
import { allowlistFrom } from '../../../../../src/broker/services/safety-kernel/kernel-allowlist.js'
import { createConsultSourceHandler } from '../../../../../src/broker/services/outward/consult-source.js'

let h: TestDb | null = null
afterEach(() => {
  h?.close()
  h = null
})

function setup(opts?: { hosts?: string[]; spendApis?: string[] }) {
  h = createTestDb()
  const kernel = createSafetyKernel({ db: h.db, allowlist: opts ? allowlistFrom(opts) : undefined })
  const fetched: string[] = []
  const handler = createConsultSourceHandler({
    kernel,
    fetchSource: async (url) => {
      fetched.push(url)
      return { status: 200, body: `content of ${url}` }
    },
  })
  const audits = () =>
    h!.db.prepare('SELECT detail FROM kernel_audit ORDER BY id').all() as { detail: string }[]
  return { kernel, handler, fetched, audits }
}

describe('T051 — consult_source: allowlist-gated read, spend always refused', () => {
  it('POSITIVE: an allowlisted host is consulted and the ALLOW is audited', async () => {
    const { handler, fetched, audits } = setup({ hosts: ['docs.example.com'] })
    const res = await handler.consultSource({
      url: 'https://docs.example.com/guide',
      reason: 'verify the deployment steps',
    })
    expect(res.allowed).toBe(true)
    expect(res.body).toContain('content of https://docs.example.com/guide')
    expect(fetched).toEqual(['https://docs.example.com/guide'])
    expect(audits().some((a) => a.detail.includes('docs.example.com'))).toBe(true)
  })

  it('NEGATIVE: an off-list host is REFUSED + audited and the fetch never fires (deny-all default)', async () => {
    const { kernel, handler, fetched, audits } = setup() // EMPTY allowlist
    const res = await handler.consultSource({
      url: 'https://evil.example.net/exfil',
      reason: 'just checking',
    })
    expect(res.allowed).toBe(false)
    expect(fetched).toEqual([]) // no egress happened
    expect(audits().some((a) => a.detail.includes('evil.example.net'))).toBe(true)
    expect(kernel.verifyAuditChain().ok).toBe(true) // denies are chained too
  })

  it('NEGATIVE: a spend API is refused even when its HOST is on the egress allowlist', async () => {
    const { handler, fetched } = setup({ hosts: ['api.openai.com'] })
    const res = await handler.consultSource({
      url: 'https://api.openai.com/v1/chat/completions',
      reason: 'tempting but no',
    })
    expect(res.allowed).toBe(false)
    expect(res.detail).toMatch(/spend/i)
    expect(fetched).toEqual([])
  })

  it('NEGATIVE (validation): a malformed URL or empty/overlong reason refuses before the kernel', async () => {
    const { handler, fetched } = setup({ hosts: ['docs.example.com'] })
    expect((await handler.consultSource({ url: 'not-a-url', reason: 'x' })).allowed).toBe(false)
    expect(
      (await handler.consultSource({ url: 'https://docs.example.com/', reason: '' })).allowed,
    ).toBe(false)
    expect(
      (
        await handler.consultSource({
          url: 'https://docs.example.com/',
          reason: 'r'.repeat(501),
        })
      ).allowed,
    ).toBe(false)
    expect(fetched).toEqual([])
  })

  it('NEGATIVE (fail-safe): a throwing fetch yields allowed:true fetch-failed detail, never an exception', async () => {
    h = createTestDb()
    const kernel = createSafetyKernel({
      db: h.db,
      allowlist: allowlistFrom({ hosts: ['docs.example.com'] }),
    })
    const handler = createConsultSourceHandler({
      kernel,
      fetchSource: async () => {
        throw new Error('network down')
      },
    })
    const res = await handler.consultSource({
      url: 'https://docs.example.com/x',
      reason: 'resilience',
    })
    expect(res.allowed).toBe(true) // the kernel allowed it; the fetch itself failed
    expect(res.body).toBeUndefined()
    expect(res.detail).toMatch(/fetch failed|network down/i)
  })
})
