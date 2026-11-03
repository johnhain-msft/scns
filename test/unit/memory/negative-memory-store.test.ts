/**
 * Unit tests for negative memory store — vault-based CRUD operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createVault } from '../../../src/memory/vault.js'
import { createNegativeMemoryStore } from '../../../src/memory/negative-memory-store.js'
import type { NegativeMemoryStore } from '../../../src/memory/negative-memory-store.js'

let tmpDir: string
let store: NegativeMemoryStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'scns-neg-mem-'))
  const vault = createVault({ rootDir: tmpDir })
  store = createNegativeMemoryStore(vault)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('NegativeMemoryStore', () => {
  // ── storeFromTool ──────────────────────────────────────────────

  it('stores a negative memory from the Copilot tool', () => {
    const mem = store.storeFromTool({
      feedback: 'Never claim to have verified something without actually doing it',
      context: 'You said you took screenshots but you never did',
      category: 'behavior-complaint',
      target: 'custom-instruction',
      severity: 'high',
      sessionId: 'sess-001',
    })

    expect(mem.id).toBeTruthy()
    expect(mem.dontRule).toBe('Never claim to have verified something without actually doing it')
    expect(mem.category).toBe('behavior-complaint')
    expect(mem.recommendedTarget).toBe('custom-instruction')
    expect(mem.confidence).toBe(0.95)
    expect(mem.source).toBe('copilot-tool')
    expect(mem.sessionId).toBe('sess-001')
    expect(mem.targetApplied).toBe(false)
    expect(mem.createdAt).toBeTruthy()
    expect(mem.originalText).toContain('Never claim to have verified')
    expect(mem.originalText).toContain('Context:')
  })

  it('stores with default values when optional fields omitted', () => {
    const mem = store.storeFromTool({
      feedback: 'Stop ignoring test failures',
    })

    expect(mem.category).toBe('behavior-complaint')
    expect(mem.recommendedTarget).toBe('general')
    expect(mem.confidence).toBe(0.6) // low severity default
    expect(mem.sessionId).toBeNull()
  })

  it('maps severity to confidence correctly', () => {
    const high = store.storeFromTool({ feedback: 'test', severity: 'high' })
    const med = store.storeFromTool({ feedback: 'test', severity: 'medium' })
    const low = store.storeFromTool({ feedback: 'test', severity: 'low' })

    expect(high.confidence).toBe(0.95)
    expect(med.confidence).toBe(0.8)
    expect(low.confidence).toBe(0.6)
  })

  // ── storeFromHeuristic ─────────────────────────────────────────

  it('stores a negative memory from heuristic detection', () => {
    const mem = store.storeFromHeuristic({
      originalText: 'why would you lie about taking screenshots?',
      dontRule: 'Do not claim to have performed verification without actually doing it',
      category: 'behavior-complaint',
      recommendedTarget: 'custom-instruction',
      confidence: 0.9,
      sessionId: 'sess-002',
    })

    expect(mem.id).toBeTruthy()
    expect(mem.source).toBe('heuristic')
    expect(mem.dontRule).toContain('Do not claim')
    expect(mem.confidence).toBe(0.9)
  })

  it('truncates originalText at 2000 chars', () => {
    const longText = 'x'.repeat(5000)
    const mem = store.storeFromHeuristic({
      originalText: longText,
      dontRule: 'test rule',
      category: 'frustration',
      recommendedTarget: 'general',
      confidence: 0.8,
    })

    expect(mem.originalText.length).toBe(2000)
  })

  // ── list ───────────────────────────────────────────────────────

  it('lists all stored negative memories', () => {
    store.storeFromTool({ feedback: 'first rule' })
    store.storeFromTool({ feedback: 'second rule' })
    store.storeFromTool({ feedback: 'third rule' })

    const all = store.list()
    expect(all).toHaveLength(3)
    const rules = all.map((m) => m.dontRule)
    expect(rules).toContain('first rule')
    expect(rules).toContain('second rule')
    expect(rules).toContain('third rule')
  })

  it('filters by target', () => {
    store.storeFromTool({ feedback: 'rule a', target: 'skill' })
    store.storeFromTool({ feedback: 'rule b', target: 'general' })
    store.storeFromTool({ feedback: 'rule c', target: 'skill' })

    const skills = store.list({ target: 'skill' })
    expect(skills).toHaveLength(2)
    expect(skills.every((m) => m.recommendedTarget === 'skill')).toBe(true)
  })

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      store.storeFromTool({ feedback: `rule ${i}` })
    }

    const limited = store.list({ limit: 3 })
    expect(limited).toHaveLength(3)
  })

  // ── search ─────────────────────────────────────────────────────

  it('searches negative memories by keyword', () => {
    store.storeFromTool({ feedback: 'Never lie about running tests' })
    store.storeFromTool({ feedback: 'Always check the dashboard visually' })
    store.storeFromTool({ feedback: 'Stop ignoring regression failures' })

    const results = store.search('tests running')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]!.dontRule).toContain('tests')
  })

  it('returns empty for empty query', () => {
    store.storeFromTool({ feedback: 'some rule' })
    expect(store.search('')).toHaveLength(0)
    expect(store.search('   ')).toHaveLength(0)
  })

  // ── getById ────────────────────────────────────────────────────

  it('retrieves a specific memory by ID', () => {
    const mem = store.storeFromTool({ feedback: 'specific rule' })
    const found = store.getById(mem.id)

    expect(found).not.toBeNull()
    expect(found!.id).toBe(mem.id)
    expect(found!.dontRule).toBe('specific rule')
  })

  it('returns null for non-existent ID', () => {
    expect(store.getById('non-existent-id')).toBeNull()
  })

  // ── count ──────────────────────────────────────────────────────

  it('counts total negative memories', () => {
    expect(store.count()).toBe(0)
    store.storeFromTool({ feedback: 'rule 1' })
    store.storeFromTool({ feedback: 'rule 2' })
    expect(store.count()).toBe(2)
  })

  // ── persistence ────────────────────────────────────────────────

  it('persists across store instances (same vault dir)', () => {
    store.storeFromTool({ feedback: 'persistent rule' })

    // Create a new store instance pointing at the same dir
    const vault2 = createVault({ rootDir: tmpDir })
    const store2 = createNegativeMemoryStore(vault2)

    const all = store2.list()
    expect(all).toHaveLength(1)
    expect(all[0]!.dontRule).toBe('persistent rule')
  })
})

// ── W5.4 — promptOrigin provenance (human vs machine, first-class) ──

describe('promptOrigin provenance (W5.4)', () => {
  it('stamps human-shaped tool feedback as promptOrigin=human', () => {
    const mem = store.storeFromTool({
      feedback: 'stop rewriting my commit messages without asking',
    })
    expect(mem.promptOrigin).toBe('human')
    expect(mem.promptOriginRule).toBe('no-machine-marker')
  })

  it('stamps machine-shaped tool feedback as promptOrigin=machine', () => {
    const mem = store.storeFromTool({
      feedback: 'You are a strict news-desk fact-checker and the run failed',
    })
    expect(mem.promptOrigin).toBe('machine')
    expect(mem.promptOriginRule).toBe('agent-role-preamble')
  })

  it('stamps heuristic entries as promptOrigin=machine', () => {
    const mem = store.storeFromHeuristic({
      originalText: 'user seemed frustrated about retries',
      dontRule: 'do not retry the same command blindly',
      category: 'frustration',
      recommendedTarget: 'general',
      confidence: 0.7,
    })
    expect(mem.promptOrigin).toBe('machine')
    expect(mem.promptOriginRule).toBe('heuristic-pipeline')
  })

  it('round-trips promptOrigin through the vault file', () => {
    const mem = store.storeFromTool({ feedback: 'please stop doing X in my repo' })
    const reloaded = store.getById(mem.id)
    expect(reloaded?.promptOrigin).toBe('human')
    expect(reloaded?.promptOriginRule).toBe('no-machine-marker')
  })

  it('parses legacy files without promptOrigin as unknown', () => {
    const vault = createVault({ rootDir: tmpDir })
    vault.write(
      'negative/legacy-1.md',
      '---\nid: legacy-1\ndontRule: old rule with no provenance\ncategory: frustration\ntarget: general\nconfidence: 0.6\nsource: heuristic\ntargetApplied: false\ncreatedAt: 2026-01-01T00:00:00.000Z\n---\nold rule with no provenance',
    )
    const reloaded = store.getById('legacy-1')
    expect(reloaded).not.toBeNull()
    expect(reloaded?.promptOrigin).toBe('unknown')
  })
})

// ── Blind-review finding 1 — transport signal outranks prose shape ──

describe('transportOrigin gate (blind-review finding 1)', () => {
  it('team-agent transport forces promptOrigin=machine even for human-shaped text', () => {
    const mem = store.storeFromTool({
      feedback: 'stop rewriting my commit messages without asking',
      transportOrigin: 'team-agent',
    })
    expect(mem.promptOrigin).toBe('machine')
    expect(mem.promptOriginRule).toBe('team-mode-transport')
  })

  it('interactive transport still classifies by prose shape', () => {
    const human = store.storeFromTool({
      feedback: 'stop rewriting my commit messages',
      transportOrigin: 'interactive',
    })
    expect(human.promptOrigin).toBe('human')
    const machine = store.storeFromTool({
      feedback: 'You are a strict fact-checker agent and this failed',
      transportOrigin: 'interactive',
    })
    expect(machine.promptOrigin).toBe('machine')
  })
})
