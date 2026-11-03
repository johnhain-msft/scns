import { describe, it, expect, vi } from 'vitest'
import {
  createAcpOverlapChecker,
  createAcpElaborationWriter,
} from '../../../src/suggest/proposal-triage-acp.js'
import { SuggestionType, type Suggestion } from '../../../src/suggest/types.js'

function fakeClient(output: string | (() => Promise<string>)) {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue('sess-1'),
    sendPrompt: vi.fn().mockImplementation(async () => ({
      output: typeof output === 'string' ? output : await output(),
    })),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

const suggestion = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  type: SuggestionType.Extension,
  title: 'Create file-management extension',
  description: 'Used edit and create 225 times.',
  confidence: 0.6,
  status: 'pending',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  evidence: [],
  tags: [],
  actionable: true,
  estimatedComplexity: 'solo',
} as unknown as Suggestion

describe('createAcpOverlapChecker', () => {
  it('refuses to run against a non-isolated cwd', () => {
    expect(() => createAcpOverlapChecker({ cwd: '' })).toThrow(/isolated cwd/)
  })

  it('returns the raw answer for the deterministic parser to judge', async () => {
    const client = fakeClient('DUPLICATE: the built-in file editing tools')
    const check = createAcpOverlapChecker({
      cwd: '/tmp/iso',
      createClient: () => client as never,
    })
    await expect(check('does this duplicate anything?')).resolves.toContain('DUPLICATE:')
    expect(client.close).toHaveBeenCalled()
  })

  it('runs deny-all so the check can never execute a tool', async () => {
    const created: unknown[] = []
    const check = createAcpOverlapChecker({
      cwd: '/tmp/iso',
      createClient: (o) => {
        created.push(o)
        return fakeClient('NOVEL') as never
      },
    })
    await check('q')
    expect((created[0] as { allowAllTools: boolean }).allowAllTools).toBe(false)
  })

  // Must THROW, not return '' — triage reads a throw as "unverified" and an empty string could be
  // misparsed. A transport outage must never look like an answer.
  it('propagates a timeout so triage records unverified', async () => {
    const client = fakeClient(() => new Promise<string>(() => {}))
    const check = createAcpOverlapChecker({
      cwd: '/tmp/iso',
      attemptTimeoutMs: 20,
      createClient: () => client as never,
    })
    await expect(check('q')).rejects.toThrow(/timed out/)
    expect(client.close).toHaveBeenCalled()
  })
})

describe('createAcpElaborationWriter', () => {
  it('never asks the model to argue for novelty (NEGATIVE CONTROL on framing)', async () => {
    let sent = ''
    const write = createAcpElaborationWriter({
      cwd: '/tmp/iso',
      createClient: () =>
        ({
          initialize: vi.fn().mockResolvedValue(undefined),
          createSession: vi.fn().mockResolvedValue('s'),
          sendPrompt: vi.fn().mockImplementation(async (_s: string, p: string) => {
            sent = p
            return { output: 'It would do X.' }
          }),
          close: vi.fn().mockResolvedValue(undefined),
        }) as never,
    })
    await write(suggestion)
    const lower = sent.toLowerCase()
    for (const banned of ['why is this unique', 'explain why', 'justify', 'make the case']) {
      expect(lower).not.toContain(banned)
    }
    expect(lower).toContain('do not claim it is novel')
  })

  it('degrades to no prose when the transport fails, rather than failing the pass', async () => {
    const write = createAcpElaborationWriter({
      cwd: '/tmp/iso',
      createClient: () =>
        ({
          initialize: vi.fn().mockRejectedValue(new Error('spawn failed')),
          createSession: vi.fn(),
          sendPrompt: vi.fn(),
          close: vi.fn().mockResolvedValue(undefined),
        }) as never,
    })
    await expect(write(suggestion)).resolves.toBe('')
  })
})
