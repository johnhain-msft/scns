import { describe, it, expect } from 'vitest'
import {
  NULL_CAUSAL_PROVIDER,
  isNullCausalProvider,
  buildCausalUserPrompt,
  parseCausalResponse,
  CAUSAL_SYSTEM_PROMPT,
  type CausalCandidate,
} from '../../../src/memory/causal-provider.js'

function candidate(over: Partial<CausalCandidate> = {}): CausalCandidate {
  return {
    causeKey: 'cause0001',
    effectKey: 'effect0001',
    causeContent: 'the auto-merger refused because the working tree was dirty',
    effectContent: 'the merge was blocked and the PR stayed open',
    entity: 'auto-merger',
    causeFilePath: 'weekly/2026-W17.md',
    effectFilePath: 'weekly/2026-W17.md',
    ...over,
  }
}

describe('NULL_CAUSAL_PROVIDER', () => {
  it('infers zero edges for any input (default-OFF behaviour)', async () => {
    const edges = await NULL_CAUSAL_PROVIDER.infer({ candidates: [candidate(), candidate()] })
    expect(edges).toEqual([])
  })

  it('is detected by isNullCausalProvider', () => {
    expect(isNullCausalProvider(NULL_CAUSAL_PROVIDER)).toBe(true)
    expect(isNullCausalProvider(undefined)).toBe(true)
    expect(isNullCausalProvider(null)).toBe(true)
  })

  it('a custom provider is NOT the null provider', () => {
    const custom = { async infer() { return [] } }
    expect(isNullCausalProvider(custom)).toBe(false)
  })
})

describe('buildCausalUserPrompt', () => {
  it('includes each candidate id pair and content', () => {
    const prompt = buildCausalUserPrompt({
      candidates: [candidate({ causeKey: 'AAA', effectKey: 'BBB' })],
    })
    expect(prompt).toContain('AAA')
    expect(prompt).toContain('BBB')
    expect(prompt).toContain('auto-merger refused')
    expect(prompt).toContain('merge was blocked')
  })

  it('system prompt instructs JSON-array-only output', () => {
    expect(CAUSAL_SYSTEM_PROMPT).toMatch(/JSON array/i)
  })
})

describe('parseCausalResponse', () => {
  const cands = [
    candidate({ causeKey: 'AAA', effectKey: 'BBB' }),
    candidate({ causeKey: 'CCC', effectKey: 'DDD' }),
  ]

  it('parses a valid JSON array into edges', () => {
    const raw = JSON.stringify([
      { causeKey: 'AAA', effectKey: 'BBB', confidence: 0.9, rationale: 'dirty tree caused refusal' },
    ])
    const edges = parseCausalResponse(raw, cands)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ causeKey: 'AAA', effectKey: 'BBB', confidence: 0.9 })
    expect(edges[0]!.rationale).toContain('dirty tree')
  })

  it('strips code fences the model may add', () => {
    const raw = '```json\n[{"causeKey":"AAA","effectKey":"BBB","confidence":0.5}]\n```'
    const edges = parseCausalResponse(raw, cands)
    expect(edges).toHaveLength(1)
    expect(edges[0]!.causeKey).toBe('AAA')
  })

  it('strips a single-backtick wrapper (the real copilot --acp empty-array case)', () => {
    // Live 2026-06-25: the agent returned `[]` (single backticks) — must not throw/mis-parse.
    expect(parseCausalResponse('`[]`', cands)).toEqual([])
    const edges = parseCausalResponse(
      '`[{"causeKey":"AAA","effectKey":"BBB","confidence":0.8}]`',
      cands,
    )
    expect(edges).toHaveLength(1)
    expect(edges[0]!.causeKey).toBe('AAA')
  })

  it('strips a bare triple-fence with no language tag', () => {
    const raw = '```\n[{"causeKey":"AAA","effectKey":"BBB","confidence":0.6}]\n```'
    const edges = parseCausalResponse(raw, cands)
    expect(edges).toHaveLength(1)
  })

  it('extracts the JSON array when the model wraps it in prose', () => {
    const raw =
      'Here are the causal links I found:\n[{"causeKey":"CCC","effectKey":"DDD","confidence":0.75}]\nThat is all.'
    const edges = parseCausalResponse(raw, cands)
    expect(edges).toHaveLength(1)
    expect(edges[0]!.effectKey).toBe('DDD')
  })

  it('drops edges whose key pair is not among the candidates (no hallucinated keys)', () => {
    const raw = JSON.stringify([
      { causeKey: 'ZZZ', effectKey: 'YYY', confidence: 0.99 },
      { causeKey: 'AAA', effectKey: 'BBB', confidence: 0.8 },
    ])
    const edges = parseCausalResponse(raw, cands)
    expect(edges).toHaveLength(1)
    expect(edges[0]!.causeKey).toBe('AAA')
  })

  it('clamps confidence into [0,1] and drops non-numeric confidence', () => {
    const raw = JSON.stringify([
      { causeKey: 'AAA', effectKey: 'BBB', confidence: 5 },
      { causeKey: 'CCC', effectKey: 'DDD', confidence: 'high' },
    ])
    const edges = parseCausalResponse(raw, cands)
    expect(edges).toHaveLength(1)
    expect(edges[0]!.confidence).toBe(1)
  })

  it('returns [] for unparseable JSON (do-no-harm)', () => {
    expect(parseCausalResponse('not json at all', cands)).toEqual([])
    expect(parseCausalResponse('{"not":"an array"}', cands)).toEqual([])
  })

  it('returns [] for an empty candidate set', () => {
    expect(parseCausalResponse('[]', [])).toEqual([])
  })
})
