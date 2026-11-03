/**
 * Integration test — Negative Sentiment Memory Pipeline
 *
 * Tests the full flow: sentiment analysis → negative memory store → retrieval → search
 * Uses real vault (temp directory), real store, real analyzer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeSentiment } from '../../../src/memory/sentiment-analyzer.js'
import { createNegativeMemoryStore } from '../../../src/memory/negative-memory-store.js'
import { createVault } from '../../../src/memory/vault.js'

describe('sentiment-pipeline integration', () => {
  let tmpDir: string
  let store: ReturnType<typeof createNegativeMemoryStore>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scns-sentiment-'))
    const vault = createVault({ rootDir: tmpDir })
    store = createNegativeMemoryStore(vault)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('detects negative sentiment and stores via heuristic path', () => {
    const text =
      "why would you lie about taking screenshots? this is broken and you didn't actually test it"
    const analysis = analyzeSentiment(text)

    expect(analysis.isNegative).toBe(true)
    expect(analysis.overallScore).toBeGreaterThanOrEqual(0.7)

    const mem = store.storeFromHeuristic({
      originalText: text,
      dontRule: analysis.dontRule,
      category: analysis.signals[0]!.type,
      recommendedTarget: analysis.recommendedTarget,
      confidence: analysis.overallScore,
      sessionId: 'test-session-1',
    })

    expect(mem.id).toBeDefined()

    // Verify retrieval
    const all = store.list()
    expect(all).toHaveLength(1)
    expect(all[0]!.originalText).toBe(text)
    expect(all[0]!.sessionId).toBe('test-session-1')
  })

  it('stores via tool path with full metadata', () => {
    const mem = store.storeFromTool({
      feedback: 'Stop claiming work is done without actually testing it',
      context: 'User found dashboard was broken after agent said it was fixed',
      category: 'behavior-complaint',
      target: 'agent-profile',
      severity: 'critical',
      sessionId: 'test-session-2',
    })

    expect(mem.id).toBeDefined()
    expect(mem.dontRule).toBe('Stop claiming work is done without actually testing it')
    expect(mem.category).toBe('behavior-complaint')
    expect(mem.recommendedTarget).toBe('agent-profile')

    // Verify search
    const results = store.search('claiming work done')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]!.dontRule).toContain('claiming work is done')
  })

  it('does NOT flag normal developer conversation as negative', () => {
    const normalTexts = [
      'Can you fix the CSS in the header component?',
      'The tests are failing because of a missing import',
      'I need you to refactor this function to use async/await',
      "Let's debug this together — what's happening at line 42?",
    ]

    for (const text of normalTexts) {
      const analysis = analyzeSentiment(text)
      expect(analysis.isNegative).toBe(false)
    }
  })

  it('detects multiple types of negative sentiment in sequence', () => {
    const frustrated = 'why would you skip the tests? I told you three times — this is broken'
    const correction = 'you keep ignoring my instructions. stop doing that and actually test things'

    const a1 = analyzeSentiment(frustrated)
    const a2 = analyzeSentiment(correction)

    expect(a1.isNegative).toBe(true)
    expect(a2.isNegative).toBe(true)

    store.storeFromHeuristic({
      originalText: frustrated,
      dontRule: a1.dontRule,
      category: a1.signals[0]!.type,
      recommendedTarget: a1.recommendedTarget,
      confidence: a1.overallScore,
    })

    store.storeFromHeuristic({
      originalText: correction,
      dontRule: a2.dontRule,
      category: a2.signals[0]!.type,
      recommendedTarget: a2.recommendedTarget,
      confidence: a2.overallScore,
    })

    expect(store.count()).toBe(2)

    // Both should be retrievable
    const all = store.list()
    expect(all).toHaveLength(2)
  })

  it('respects target filtering when listing', () => {
    store.storeFromTool({
      feedback: 'Never skip manual testing',
      target: 'agent-profile',
    })
    store.storeFromTool({
      feedback: 'Always run e2e tests before claiming done',
      target: 'instructions',
    })
    store.storeFromTool({
      feedback: 'Do not use console.log',
      target: 'agent-profile',
    })

    const profileOnly = store.list({ target: 'agent-profile' })
    expect(profileOnly).toHaveLength(2)

    const instructionsOnly = store.list({ target: 'instructions' })
    expect(instructionsOnly).toHaveLength(1)
  })

  it('end-to-end: analyze → store → search → retrieve by ID', () => {
    const text = 'you need to stop lying about testing. manual testing CANNOT BE IGNORED'
    const analysis = analyzeSentiment(text)
    expect(analysis.isNegative).toBe(true)

    const stored = store.storeFromHeuristic({
      originalText: text,
      dontRule: analysis.dontRule,
      category: analysis.signals[0]!.type,
      recommendedTarget: analysis.recommendedTarget,
      confidence: analysis.overallScore,
    })

    // Retrieve by ID
    const byId = store.getById(stored.id)
    expect(byId).toBeDefined()
    expect(byId!.dontRule).toBe(analysis.dontRule)

    // Search
    const searchResults = store.search('manual testing')
    expect(searchResults.length).toBeGreaterThanOrEqual(1)
  })
})
