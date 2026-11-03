import { describe, it, expect, beforeEach } from 'vitest'
import { createSuggestionGenerator } from '../../../src/suggest/generator.js'
import { createConfidenceScorer } from '../../../src/suggest/confidence.js'
import { createEvidenceGatherer } from '../../../src/suggest/evidence.js'
import type { Suggestion } from '../../../src/suggest/types.js'
import type { DetectedPatterns, ProjectFocusPattern } from '../../../src/observe/pattern-detector.js'
import type { MemorySeedReaders } from '../../../src/suggest/memory-self-improvement.js'
import type { NeighborhoodChunk } from '../../../src/memory/entities/neighborhood.js'
import type { FamilyStat } from '../../../src/selfopt/ideation-gate.js'

// ── Minimal in-memory store (mirrors generator.test.ts) ──
function createMockStore() {
  const m = new Map<string, Suggestion>()
  return {
    save: (s: Suggestion) => void m.set(s.id, s),
    get: (id: string) => m.get(id) ?? null,
    list: () => [...m.values()],
    updateStatus: () => null,
    findSimilar: () => null,
    getRejectedTitles: () => [] as string[],
    remove: (id: string) => m.delete(id),
  }
}

function makeProjectPattern(overrides?: Partial<ProjectFocusPattern>): ProjectFocusPattern {
  return {
    repoCounts: new Map([['scns', 30]]),
    topRepos: ['scns'],
    fileTypeCounts: new Map([['ts', 50]]),
    recentFocus: 'scns',
    repoActivityCounts: new Map([['scns', 80]]),
    ...overrides,
  }
}

function makeDetectedPatterns(overrides?: Partial<DetectedPatterns>): DetectedPatterns {
  return {
    workSchedule: undefined,
    toolFrequency: undefined,
    projectFocus: makeProjectPattern(),
    observationCount: 200,
    windowStart: '2025-01-01T00:00:00.000Z',
    windowEnd: '2025-01-07T23:59:59.000Z',
    ...overrides,
  } as DetectedPatterns
}

/** Readers giving each named entity a fixed neighborhood size; everything else 0. */
function readersWithActivity(activity: Record<string, number>): MemorySeedReaders {
  return {
    neighborhood: (entity: string): readonly NeighborhoodChunk[] => {
      const n = activity[entity] ?? 0
      return Array.from({ length: n }, (_, i) => ({
        chunkId: i,
        filePath: `f/${entity}.md`,
        content: 'x',
        chunkIndex: i,
        mtimeMs: 1000 + i,
      }))
    },
    outcomes: (entity: string) => ({
      entity,
      total: 0,
      landed: 0,
      failed: 0,
      families: new Map(),
    }),
  }
}

function selfImprovementTitles(results: readonly Suggestion[]): string[] {
  return results.filter((s) => s.tags.includes('self-improvement')).map((s) => s.title)
}

describe('generator — memory-derived self-improvement wiring (D2a, default-OFF)', () => {
  let store: ReturnType<typeof createMockStore>
  let deps: Parameters<typeof createSuggestionGenerator>[0]

  beforeEach(() => {
    store = createMockStore()
    deps = {
      scorer: createConfidenceScorer(),
      evidenceGatherer: createEvidenceGatherer(),
      store: store as unknown as Parameters<typeof createSuggestionGenerator>[0]['store'],
    }
  })

  it('OFF (no memory dep): emits the static hardcoded self-improvement seeds, unchanged', () => {
    const gen = createSuggestionGenerator(deps, { maxSuggestionsPerCycle: 50 })
    const out = gen.generateFromAllSources(makeDetectedPatterns())
    const titles = selfImprovementTitles(out)
    // the three static SCNS_SELF_IMPROVEMENT_SEEDS titles
    expect(titles.some((t) => t.includes('require a final'))).toBe(true)
    expect(titles.some((t) => t.includes('health-watchdog'))).toBe(true)
    // none of the memory-derived entity-anchored titles
    expect(titles.some((t) => t.includes('quality-gate arbiter finalizes'))).toBe(false)
  })

  it('ON + hot graph: emits memory-derived entity-anchored seeds, NOT the static menu (no dup)', () => {
    const gen = createSuggestionGenerator({
      ...deps,
      selfImprovementMemory: {
        enabled: true,
        readers: readersWithActivity({ 'quality-gate': 35, broker: 22 }),
      },
    }, { maxSuggestionsPerCycle: 50 })
    const out = gen.generateFromAllSources(makeDetectedPatterns())
    const titles = selfImprovementTitles(out)
    expect(titles.some((t) => t.includes('quality-gate arbiter finalizes'))).toBe(true)
    expect(titles.some((t) => t.includes('broker port'))).toBe(true)
    // the static seeds must NOT also be emitted (memory path replaces them)
    expect(titles.some((t) => t.includes('require a final'))).toBe(false)
    // memory-derived suggestions are tagged with their gazetteer entity
    const qg = out.find((s) => s.title.includes('quality-gate arbiter finalizes'))
    expect(qg!.tags).toContain('quality-gate')
  })

  it('ON but SCNS not under active development: emits nothing (same trigger as today)', () => {
    const gen = createSuggestionGenerator({
      ...deps,
      selfImprovementMemory: {
        enabled: true,
        readers: readersWithActivity({ 'quality-gate': 35 }),
      },
    }, { maxSuggestionsPerCycle: 50 })
    const out = gen.generateFromAllSources(
      makeDetectedPatterns({
        projectFocus: makeProjectPattern({
          repoCounts: new Map([['other', 10]]),
          topRepos: ['other'],
          recentFocus: 'other',
          repoActivityCounts: new Map([['other', 40]]),
        }),
      }),
    )
    expect(selfImprovementTitles(out)).toHaveLength(0)
  })

  it('ON + SCNS active but COLD graph: falls back to the static hardcoded seeds (safe)', () => {
    const gen = createSuggestionGenerator(
      {
        ...deps,
        selfImprovementMemory: { enabled: true, readers: readersWithActivity({}) },
      },
      { maxSuggestionsPerCycle: 50 },
    )
    const out = gen.generateFromAllSources(makeDetectedPatterns())
    const titles = selfImprovementTitles(out)
    expect(titles.some((t) => t.includes('require a final'))).toBe(true)
    expect(titles.some((t) => t.includes('quality-gate arbiter finalizes'))).toBe(false)
  })

  it('enabled:false dep present: still the static path (regression-lock honors the flag)', () => {
    const gen = createSuggestionGenerator({
      ...deps,
      selfImprovementMemory: {
        enabled: false,
        readers: readersWithActivity({ 'quality-gate': 35 }),
      },
    }, { maxSuggestionsPerCycle: 50 })
    const out = gen.generateFromAllSources(makeDetectedPatterns())
    const titles = selfImprovementTitles(out)
    expect(titles.some((t) => t.includes('require a final'))).toBe(true)
    expect(titles.some((t) => t.includes('quality-gate arbiter finalizes'))).toBe(false)
  })

  it('ON + gate ENFORCE + regressing history: downgrades memory path back to the static menu', () => {
    const failingStats = new Map<string, FamilyStat>([['qg-verdict-event', { landed: 0, failed: 5 }]])
    const gen = createSuggestionGenerator(
      {
        ...deps,
        selfImprovementMemory: {
          enabled: true,
          readers: readersWithActivity({ 'quality-gate': 35 }),
          gate: { enforce: true, familyStats: () => failingStats },
        },
      },
      { maxSuggestionsPerCycle: 50 },
    )
    const titles = selfImprovementTitles(gen.generateFromAllSources(makeDetectedPatterns()))
    // candidate landing rate 0 < baseline prior 0.5 ⇒ regression ⇒ fall back to static
    expect(titles.some((t) => t.includes('require a final'))).toBe(true)
    expect(titles.some((t) => t.includes('quality-gate arbiter finalizes'))).toBe(false)
  })

  it('ON + gate ENFORCE but healthy history: keeps the memory-derived path', () => {
    const goodStats = new Map<string, FamilyStat>([['qg-verdict-event', { landed: 4, failed: 0 }]])
    const gen = createSuggestionGenerator(
      {
        ...deps,
        selfImprovementMemory: {
          enabled: true,
          readers: readersWithActivity({ 'quality-gate': 35 }),
          gate: { enforce: true, familyStats: () => goodStats },
        },
      },
      { maxSuggestionsPerCycle: 50 },
    )
    const titles = selfImprovementTitles(gen.generateFromAllSources(makeDetectedPatterns()))
    expect(titles.some((t) => t.includes('quality-gate arbiter finalizes'))).toBe(true)
    expect(titles.some((t) => t.includes('require a final'))).toBe(false)
  })
})
