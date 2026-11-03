import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSuggestionStore } from '../../../src/suggest/suggestion-store.js'
import { SuggestionType, type Suggestion } from '../../../src/suggest/types.js'
import { triagePendingProposals } from '../../../src/suggest/proposal-triage-run.js'
import { DUPLICATE_REASON_PREFIX } from '../../../src/suggest/proposal-triage.js'
import { DEFAULT_ARTIFACT_LOCATIONS } from '../../../src/suggest/proposal-spec.js'

let dir: string
let repo: string
let store: ReturnType<typeof createSuggestionStore>
let roots: { home: string; config: string; scns: string; repo: string }

function sugg(o: Partial<Suggestion> & { id: string }): Suggestion {
  return {
    type: SuggestionType.Extension,
    title: `Create ${o.id} extension`,
    description: 'a description',
    confidence: 0.5,
    status: 'pending',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    evidence: [],
    tags: [],
    actionable: true,
    estimatedComplexity: 'solo',
    ...o,
  } as Suggestion
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-triage-run-'))
  repo = mkdtempSync(join(tmpdir(), 'scns-triage-repo-'))
  store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
  roots = { home: dir, config: join(dir, '.copilot'), scns: join(dir, '.scns'), repo }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

/**
 * Create a real on-disk artifact so the deterministic scan has something to collide with.
 *
 * The directory is derived from the shared location map rather than hardcoded. A hardcoded
 * `join(repo, '.github', 'extensions')` here silently stopped colliding the moment the map moved,
 * which is the same "each test asserts against its own private copy of the path" failure that let
 * the executor and the proposal spec disagree about where an approval lands.
 */
function existingExtension(name: string): void {
  const d = DEFAULT_ARTIFACT_LOCATIONS[SuggestionType.Extension]!.dir(roots)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `${name}.md`), '# existing')
}

describe('triagePendingProposals', () => {
  it('auto-rejects a proposal that duplicates an artifact already on disk', async () => {
    const id = randomUUID()
    store.save(sugg({ id, title: 'Create file-management extension', tags: ['file-management'] }))
    existingExtension('file-management')

    const r = await triagePendingProposals({ store, roots })

    expect(r.rejected).toBe(1)
    expect(store.get(id)?.status).toBe('rejected')
  })

  it('records the auto-rejection as a MACHINE reason, never a human one', async () => {
    const id = randomUUID()
    store.save(sugg({ id, title: 'Create file-management extension', tags: ['file-management'] }))
    existingExtension('file-management')

    await triagePendingProposals({ store, roots })

    const reason = store.get(id)?.reviewReason ?? ''
    expect(reason).toContain(DUPLICATE_REASON_PREFIX)
    expect(reason.startsWith('human:')).toBe(false)
  })

  // "so that it doesn't pop up again"
  it('leaves a rejected duplicate rejected on a second pass, without re-asking the model', async () => {
    const id = randomUUID()
    store.save(sugg({ id, title: 'Create file-management extension', tags: ['file-management'] }))
    existingExtension('file-management')

    await triagePendingProposals({ store, roots })
    const ask = vi.fn()
    const second = await triagePendingProposals({ store, roots, askNeutral: ask })

    expect(second.rejected).toBe(0)
    expect(ask).not.toHaveBeenCalled()
    expect(store.get(id)?.status).toBe('rejected')
  })

  it('gives a surviving proposal an implementationPlan it did not have', async () => {
    const id = randomUUID()
    store.save(sugg({ id, title: 'Create code-search extension', tags: ['code-search'] }))
    const ask = vi.fn().mockResolvedValue('NOVEL')

    const r = await triagePendingProposals({ store, roots, askNeutral: ask })

    expect(r.specced).toBe(1)
    const plan = store.get(id)?.implementationPlan ?? ''
    expect(plan).toContain('What this is')
    expect(plan).toContain('If you approve')
  })

  it('keeps a proposal pending when novelty cannot be verified, and says so', async () => {
    const id = randomUUID()
    store.save(sugg({ id, title: 'Create code-search extension', tags: ['code-search'] }))
    const ask = vi.fn().mockRejectedValue(new Error('acp down'))

    const r = await triagePendingProposals({ store, roots, askNeutral: ask })

    expect(store.get(id)?.status).toBe('pending')
    expect(r.unverified).toBe(1)
    expect((store.get(id)?.implementationPlan ?? '').toLowerCase()).toContain('not been verified')
  })

  // NEGATIVE CONTROL: a model outage must not quietly bin the backlog.
  it('never auto-rejects when the neutral check is unavailable', async () => {
    const id = randomUUID()
    store.save(sugg({ id, title: 'Create code-search extension', tags: ['code-search'] }))

    const r = await triagePendingProposals({ store, roots })

    expect(r.rejected).toBe(0)
    expect(store.get(id)?.status).toBe('pending')
  })

  it('does not re-spec a proposal that already has a plan', async () => {
    const id = randomUUID()
    store.save(
      sugg({
        id,
        title: 'Create code-search extension',
        tags: ['code-search'],
        implementationPlan: 'already written',
      }),
    )
    const ask = vi.fn().mockResolvedValue('NOVEL')

    const r = await triagePendingProposals({ store, roots, askNeutral: ask })

    expect(r.specced).toBe(0)
    expect(ask).not.toHaveBeenCalled()
    expect(store.get(id)?.implementationPlan).toBe('already written')
  })

  it('leaves non-pending proposals alone', async () => {
    const id = randomUUID()
    store.save(sugg({ id, title: 'Create code-search extension' }))
    // `save()` always writes into pending/; move it out the way the product does.
    store.updateStatus(id, 'implemented', 'shipped')
    const r = await triagePendingProposals({ store, roots, askNeutral: vi.fn() })
    expect(r.specced).toBe(0)
    expect(store.get(id)?.status).toBe('implemented')
  })

  // A flaky transport that answers with undefined must not crash the pass or bin the queue.
  it('degrades to unverified when the checker returns a malformed answer', async () => {
    const id = randomUUID()
    store.save(sugg({ id, title: 'Create code-search extension' }))
    const ask = vi.fn().mockResolvedValue(undefined as unknown as string)

    const r = await triagePendingProposals({ store, roots, askNeutral: ask })

    expect(r.rejected).toBe(0)
    expect(r.unverified).toBe(1)
    expect(store.get(id)?.status).toBe('pending')
  })

  it('reports zero work on an empty queue (NEGATIVE CONTROL)', async () => {
    const r = await triagePendingProposals({ store, roots })
    expect(r).toEqual({ rejected: 0, specced: 0, unverified: 0 })
  })
})

describe('sibling dedup — two proposals for the same thing must not both reach a human', () => {
  it('keeps the strongest of a near-duplicate pair and rejects the other', async () => {
    const strong = randomUUID()
    const weak = randomUUID()
    store.save(sugg({ id: strong, title: 'Create CI/CD workflow for scns', confidence: 0.8 }))
    store.save(
      sugg({ id: weak, title: 'Create CI/CD with test workflow for scns', confidence: 0.4 }),
    )

    const r = await triagePendingProposals({
      store,
      roots,
      askNeutral: vi.fn().mockResolvedValue('NOVEL'),
    })

    expect(store.get(strong)?.status).toBe('pending')
    expect(store.get(weak)?.status).toBe('rejected')
    expect(store.get(weak)?.reviewReason).toContain('Create CI/CD workflow for scns')
    expect(r.rejected).toBe(1)
  })

  it('marks the sibling rejection as a machine decision, not a human one', async () => {
    const a = randomUUID()
    const b = randomUUID()
    store.save(sugg({ id: a, title: 'Create CI/CD workflow for scns', confidence: 0.8 }))
    store.save(sugg({ id: b, title: 'Create CI/CD with test workflow for scns', confidence: 0.4 }))

    await triagePendingProposals({ store, roots, askNeutral: vi.fn().mockResolvedValue('NOVEL') })

    expect(store.get(b)?.reviewReason?.startsWith('human:')).toBe(false)
  })

  // NEGATIVE CONTROL: same shape, different project — both are real and must both survive.
  it('does not collapse proposals for different projects', async () => {
    const a = randomUUID()
    const b = randomUUID()
    store.save(sugg({ id: a, title: 'Create CI/CD workflow for scns', confidence: 0.8 }))
    store.save(sugg({ id: b, title: 'Create CI/CD workflow for hermes-agent', confidence: 0.8 }))

    const r = await triagePendingProposals({
      store,
      roots,
      askNeutral: vi.fn().mockResolvedValue('NOVEL'),
    })

    expect(store.get(a)?.status).toBe('pending')
    expect(store.get(b)?.status).toBe('pending')
    expect(r.rejected).toBe(0)
  })

  it('never spends a model call on a proposal already collapsed into a sibling', async () => {
    const a = randomUUID()
    const b = randomUUID()
    store.save(sugg({ id: a, title: 'Create CI/CD workflow for scns', confidence: 0.8 }))
    store.save(sugg({ id: b, title: 'Create CI/CD with test workflow for scns', confidence: 0.4 }))
    const ask = vi.fn().mockResolvedValue('NOVEL')

    await triagePendingProposals({ store, roots, askNeutral: ask })

    expect(ask).toHaveBeenCalledTimes(1)
  })
})

// Regression from the second rehearsal: a similarity threshold deleted BOTH proposals for two
// different projects. Neither may be lost.
describe('sibling dedup must never delete a whole project', () => {
  it('keeps proposals for two different projects even when the wording is near-identical', async () => {
    const h1 = randomUUID()
    const h2 = randomUUID()
    const l1 = randomUUID()
    store.save(sugg({ id: h1, title: 'Create CI/CD workflow for hermes-agent', confidence: 0.8 }))
    store.save(
      sugg({ id: h2, title: 'Create CI/CD with test workflow for hermes-agent', confidence: 0.4 }),
    )
    store.save(
      sugg({ id: l1, title: 'Create CI/CD with test workflow for lethe', confidence: 0.5 }),
    )

    await triagePendingProposals({ store, roots, askNeutral: vi.fn().mockResolvedValue('NOVEL') })

    expect(store.get(h1)?.status).toBe('pending')
    expect(store.get(h2)?.status).toBe('rejected')
    expect(store.get(l1)?.status).toBe('pending')
  })
})

describe('triagePendingProposals — learns from its own implementation history', () => {
  it('auto-rejects a proposal whose twin is already in implemented/ (lsp ca64e7a1 case)', async () => {
    // Live failure this closes: "Configure TypeScript LSP" was implemented 2026-04-17
    // (73e80eb6), re-proposed 2026-09-14 (ca64e7a1), surfaced as "novelty unverified",
    // got approved, and burned a 5-attempt gate budget writing nothing.
    const twin = randomUUID()
    store.save(
      sugg({
        id: twin,
        type: SuggestionType.Lsp,
        title: 'Configure TypeScript LSP (TypeScript Language Server)',
        tags: ['lsp', 'typescript'],
      }),
    )
    store.updateStatus(twin, 'implemented', 'landed long ago', undefined, { author: 'machine' })

    const id = randomUUID()
    store.save(
      sugg({
        id,
        type: SuggestionType.Lsp,
        title: 'Configure TypeScript LSP (typescript-language-server)',
        tags: ['lsp', 'typescript', 'codebase-improvement'],
      }),
    )

    const r = await triagePendingProposals({ store, roots })

    expect(r.rejected).toBe(1)
    const rejected = store.get(id)
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.machineReason ?? '').toContain(DUPLICATE_REASON_PREFIX)
    expect(rejected?.machineReason ?? '').toContain(twin)
  })

  it('auto-rejects an lsp proposal whose server is already registered in lsp-config.json', async () => {
    const cfgDir = join(dir, '.copilot')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(
      join(cfgDir, 'lsp-config.json'),
      JSON.stringify({ lspServers: { typescript: { command: 'typescript-language-server' } } }),
    )

    const id = randomUUID()
    store.save(
      sugg({
        id,
        type: SuggestionType.Lsp,
        title: 'Configure TypeScript LSP (typescript-language-server)',
        tags: ['lsp', 'typescript'],
      }),
    )

    const r = await triagePendingProposals({ store, roots })

    expect(r.rejected).toBe(1)
    expect(store.get(id)?.status).toBe('rejected')
  })

  it('an implemented suggestion of a DIFFERENT kind does not block the proposal', async () => {
    const twin = randomUUID()
    store.save(
      sugg({
        id: twin,
        type: SuggestionType.Skill,
        title: 'Create typescript skill',
        tags: ['skill', 'typescript'],
      }),
    )
    store.updateStatus(twin, 'implemented', 'landed', undefined, { author: 'machine' })

    const id = randomUUID()
    store.save(
      sugg({
        id,
        type: SuggestionType.Lsp,
        title: 'Configure TypeScript LSP (typescript-language-server)',
        tags: ['lsp', 'typescript'],
      }),
    )

    const r = await triagePendingProposals({ store, roots })

    expect(r.rejected).toBe(0)
    expect(store.get(id)?.status).toBe('pending')
  })
})
