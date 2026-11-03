import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHandoffStore } from '../../../src/context/handoff-store.js'
import { createHandoffGenerator } from '../../../src/context/handoff-generator.js'
import { HandoffStatus, type HandoffDocument } from '../../../src/context/handoff-types.js'

// ── Helpers ──────────────────────────────────────────────────────────

let testDir: string

function makeTestDir(): string {
  const dir = join(tmpdir(), `scns-handoff-test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeDoc(overrides?: Partial<{ sessionId: string; currentTask: string }>): HandoffDocument {
  const gen = createHandoffGenerator()
  return gen.generate({
    sessionId: overrides?.sessionId ?? 'sess-1',
    currentTask: overrides?.currentTask ?? 'Test task',
    pendingWork: [{ description: 'Work item', priority: 'normal' }],
    completedWork: ['Done item'],
    keyDecisions: [{ description: 'Decision', rationale: 'Reason' }],
    resumptionInstructions: 'Continue testing',
  })
}

// ── Setup / teardown ─────────────────────────────────────────────────

beforeEach(() => {
  testDir = makeTestDir()
})

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true })
  }
})

// ── Tests ────────────────────────────────────────────────────────────

describe('createHandoffStore', () => {
  describe('save', () => {
    it('writes markdown and JSON files', () => {
      const store = createHandoffStore({ rootDir: testDir })
      const doc = makeDoc()
      const path = store.save(doc)

      expect(path).toContain(doc.id)
      expect(existsSync(join(testDir, `${doc.id}.md`))).toBe(true)
      expect(existsSync(join(testDir, `${doc.id}.json`))).toBe(true)

      const jsonContent = JSON.parse(readFileSync(join(testDir, `${doc.id}.json`), 'utf-8'))
      expect(jsonContent.id).toBe(doc.id)
      expect(jsonContent.sourceSessionId).toBe(doc.sourceSessionId)
      expect(jsonContent.status).toBe(HandoffStatus.Ready)
    })

    it('creates rootDir if it does not exist', () => {
      const nestedDir = join(testDir, 'deep', 'nested')
      const store = createHandoffStore({ rootDir: nestedDir })
      const doc = makeDoc()
      store.save(doc)

      expect(existsSync(nestedDir)).toBe(true)
      expect(existsSync(join(nestedDir, `${doc.id}.md`))).toBe(true)
    })
  })

  describe('load', () => {
    it('reads back the correct document', () => {
      const store = createHandoffStore({ rootDir: testDir })
      const doc = makeDoc()
      store.save(doc)

      const loaded = store.load(doc.id)
      expect(loaded).not.toBeNull()
      expect(loaded!.id).toBe(doc.id)
      expect(loaded!.sourceSessionId).toBe(doc.sourceSessionId)
      expect(loaded!.currentTask).toBe(doc.currentTask)
    })

    it('returns null for missing ID', () => {
      const store = createHandoffStore({ rootDir: testDir })
      expect(store.load('nonexistent')).toBeNull()
    })
  })

  describe('loadLatest', () => {
    it('finds the most recent handoff for a session', () => {
      const store = createHandoffStore({ rootDir: testDir })
      const doc1 = makeDoc({ sessionId: 'sess-A', currentTask: 'First' })
      const doc2 = makeDoc({ sessionId: 'sess-A', currentTask: 'Second' })
      const docOther = makeDoc({ sessionId: 'sess-B' })

      store.save(doc1)
      store.save(doc2)
      store.save(docOther)

      const latest = store.loadLatest('sess-A')
      expect(latest).not.toBeNull()
      // Both have same sessionId; the one with the later createdAt wins
      expect(latest!.sourceSessionId).toBe('sess-A')
    })

    it('returns null when no handoffs for session', () => {
      const store = createHandoffStore({ rootDir: testDir })
      store.save(makeDoc({ sessionId: 'sess-X' }))
      expect(store.loadLatest('sess-Y')).toBeNull()
    })
  })

  describe('list', () => {
    it('returns all handoffs', () => {
      const store = createHandoffStore({ rootDir: testDir })
      store.save(makeDoc({ sessionId: 'a' }))
      store.save(makeDoc({ sessionId: 'b' }))
      store.save(makeDoc({ sessionId: 'c' }))

      const all = store.list()
      expect(all).toHaveLength(3)
    })

    it('filters by status', () => {
      const store = createHandoffStore({ rootDir: testDir })
      const doc = makeDoc()
      store.save(doc)
      store.markConsumed(doc.id, 'target-1')

      const ready = store.list({ status: HandoffStatus.Ready })
      expect(ready).toHaveLength(0)

      const consumed = store.list({ status: HandoffStatus.Consumed })
      expect(consumed).toHaveLength(1)
      expect(consumed[0]!.status).toBe(HandoffStatus.Consumed)
    })

    it('filters by sessionId', () => {
      const store = createHandoffStore({ rootDir: testDir })
      store.save(makeDoc({ sessionId: 'sess-X' }))
      store.save(makeDoc({ sessionId: 'sess-Y' }))
      store.save(makeDoc({ sessionId: 'sess-X' }))

      const filtered = store.list({ sessionId: 'sess-X' })
      expect(filtered).toHaveLength(2)
      expect(filtered.every((s) => s.sourceSessionId === 'sess-X')).toBe(true)
    })
  })

  describe('markConsumed', () => {
    it('updates metadata to consumed status', () => {
      const store = createHandoffStore({ rootDir: testDir })
      const doc = makeDoc()
      store.save(doc)

      store.markConsumed(doc.id, 'target-sess')

      const meta = JSON.parse(readFileSync(join(testDir, `${doc.id}.json`), 'utf-8'))
      expect(meta.status).toBe(HandoffStatus.Consumed)
      expect(meta.targetSessionId).toBe('target-sess')
    })
  })

  describe('markExpired', () => {
    it('updates metadata to expired status', () => {
      const store = createHandoffStore({ rootDir: testDir })
      const doc = makeDoc()
      store.save(doc)

      store.markExpired(doc.id)

      const meta = JSON.parse(readFileSync(join(testDir, `${doc.id}.json`), 'utf-8'))
      expect(meta.status).toBe(HandoffStatus.Expired)
    })
  })

  describe('cleanup', () => {
    it('removes old files beyond maxAge', () => {
      const store = createHandoffStore({ rootDir: testDir })
      const doc = makeDoc()
      store.save(doc)

      // Backdate the files to 60 days ago
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      utimesSync(join(testDir, `${doc.id}.json`), oldDate, oldDate)
      utimesSync(join(testDir, `${doc.id}.md`), oldDate, oldDate)

      const deleted = store.cleanup(30)
      expect(deleted).toBe(1)
      expect(existsSync(join(testDir, `${doc.id}.md`))).toBe(false)
      expect(existsSync(join(testDir, `${doc.id}.json`))).toBe(false)
    })

    it('respects maxAge parameter', () => {
      const store = createHandoffStore({ rootDir: testDir })
      const doc = makeDoc()
      store.save(doc)

      // Backdate to 10 days ago
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      utimesSync(join(testDir, `${doc.id}.json`), tenDaysAgo, tenDaysAgo)
      utimesSync(join(testDir, `${doc.id}.md`), tenDaysAgo, tenDaysAgo)

      // maxAge 30 days: should NOT delete
      expect(store.cleanup(30)).toBe(0)
      expect(existsSync(join(testDir, `${doc.id}.json`))).toBe(true)

      // maxAge 5 days: SHOULD delete
      expect(store.cleanup(5)).toBe(1)
      expect(existsSync(join(testDir, `${doc.id}.json`))).toBe(false)
    })

    it('returns 0 when nothing to clean', () => {
      const store = createHandoffStore({ rootDir: testDir })
      store.save(makeDoc())
      expect(store.cleanup(30)).toBe(0)
    })
  })
})
