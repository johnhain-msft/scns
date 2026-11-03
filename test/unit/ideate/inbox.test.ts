/**
 * D1 — the ideation inbox: a filesystem store under a caller-supplied rootDir
 * (production: ~/.scns/ideation/). Tests use a temp dir so nothing touches the
 * real inbox. Covers the append→list→get round-trip, the D2 markOutcome hook,
 * status transitions, malformed-file tolerance, and write isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdeationInbox } from '../../../src/ideate/inbox.js'
import { IdeationRecordSchema, IdeationStatus } from '../../../src/ideate/types.js'
import type { IdeationProposal } from '../../../src/ideate/types.js'

const proposal = (n: number): IdeationProposal => ({
  title: `Idea ${n}`,
  rationale: `Because ${n}`,
  expectedValue: `Value ${n}`,
  implementationSketch: `Sketch ${n}`,
  testableSuccessCriterion: `Test ${n}`,
})

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scns-ideate-inbox-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('createIdeationInbox', () => {
  it('creates the root dir if missing and appends records with new status', () => {
    const nested = join(root, 'deep', 'inbox')
    const inbox = createIdeationInbox(nested)
    const recs = inbox.append([proposal(1), proposal(2)], { model: 'claude-opus-4.8' })
    expect(recs).toHaveLength(2)
    expect(existsSync(nested)).toBe(true)
    for (const r of recs) {
      expect(r.status).toBe(IdeationStatus.New)
      expect(r.source).toBe('llm-ideation')
      expect(r.model).toBe('claude-opus-4.8')
      expect(IdeationRecordSchema.safeParse(r).success).toBe(true)
    }
  })

  it('round-trips append → list → get', () => {
    const inbox = createIdeationInbox(root)
    const [a, b] = inbox.append([proposal(1), proposal(2)])
    const listed = inbox.list()
    expect(listed.map((r) => r.id).sort()).toEqual([a.id, b.id].sort())
    expect(inbox.get(a.id)?.title).toBe('Idea 1')
  })

  it('returns null for an unknown id', () => {
    const inbox = createIdeationInbox(root)
    expect(inbox.get('00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('records an outcome (D2 hook) and persists it', () => {
    const inbox = createIdeationInbox(root)
    const [rec] = inbox.append([proposal(1)])
    expect(rec.outcome).toBeNull()
    const updated = inbox.markOutcome(rec.id, {
      result: 'implemented',
      detail: 'merged in PR #9',
      recordedAt: new Date().toISOString(),
    })
    expect(updated?.outcome?.result).toBe('implemented')
    // persisted across a fresh handle
    const reopened = createIdeationInbox(root)
    expect(reopened.get(rec.id)?.outcome?.result).toBe('implemented')
  })

  it('transitions status and persists it', () => {
    const inbox = createIdeationInbox(root)
    const [rec] = inbox.append([proposal(1)])
    const updated = inbox.setStatus(rec.id, IdeationStatus.Accepted)
    expect(updated?.status).toBe(IdeationStatus.Accepted)
    expect(createIdeationInbox(root).get(rec.id)?.status).toBe(IdeationStatus.Accepted)
  })

  it('skips malformed files in list without throwing', () => {
    const inbox = createIdeationInbox(root)
    inbox.append([proposal(1)])
    writeFileSync(join(root, 'garbage.json'), '{ not json', 'utf-8')
    writeFileSync(join(root, 'wrong-schema.json'), JSON.stringify({ hello: 'world' }), 'utf-8')
    expect(inbox.list()).toHaveLength(1)
  })

  it('only writes inside the root dir and rejects path-traversal ids', () => {
    const inbox = createIdeationInbox(root)
    inbox.append([proposal(1), proposal(2)])
    // exactly two record files (+ nothing escaped)
    const files = readdirSync(root).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(2)
    expect(inbox.get('../escape')).toBeNull()
    expect(inbox.markOutcome('../escape', { result: 'no-action', detail: '', recordedAt: new Date().toISOString() })).toBeNull()
  })
})
