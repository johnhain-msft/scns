/**
 * D1 — parseIdeationResponse is a PURE function turning the agent's raw text
 * into validated IdeationProposal[]. It must be robust to the ways an LLM wraps
 * JSON (markdown fences, leading prose, an object envelope) and must DROP any
 * malformed entry rather than trust it.
 */
import { describe, it, expect } from 'vitest'
import { parseIdeationResponse } from '../../../src/ideate/parse.js'
import { IdeationProposalSchema } from '../../../src/ideate/types.js'

const valid = {
  title: 'Add a telemetry-anomaly agent',
  rationale: 'Spikes in tool errors go unnoticed.',
  expectedValue: 'Faster detection of regressions.',
  implementationSketch: 'New src/agents/anomaly.ts consuming otel jsonl.',
  testableSuccessCriterion: 'Unit test: injecting a spike yields one alert record.',
}

function arr(n: number): string {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({ ...valid, title: `${valid.title} ${i}` })))
}

describe('parseIdeationResponse', () => {
  it('parses a clean JSON array', () => {
    const res = parseIdeationResponse(arr(2))
    expect(res.proposals).toHaveLength(2)
    expect(res.dropped).toBe(0)
    for (const p of res.proposals) expect(IdeationProposalSchema.safeParse(p).success).toBe(true)
  })

  it('parses JSON wrapped in a ```json fenced block', () => {
    const res = parseIdeationResponse('```json\n' + arr(1) + '\n```')
    expect(res.proposals).toHaveLength(1)
  })

  it('parses JSON wrapped in a bare ``` fenced block', () => {
    const res = parseIdeationResponse('```\n' + arr(1) + '\n```')
    expect(res.proposals).toHaveLength(1)
  })

  it('parses an array preceded by prose', () => {
    const res = parseIdeationResponse('Sure! Here are my ideas:\n\n' + arr(2) + '\n\nHope these help.')
    expect(res.proposals).toHaveLength(2)
  })

  it('parses an object envelope { "proposals": [...] }', () => {
    const res = parseIdeationResponse(JSON.stringify({ proposals: [valid] }))
    expect(res.proposals).toHaveLength(1)
  })

  it('parses a single bare object as a one-element list', () => {
    const res = parseIdeationResponse(JSON.stringify(valid))
    expect(res.proposals).toHaveLength(1)
  })

  it('drops entries missing required fields and counts them', () => {
    const mixed = JSON.stringify([valid, { title: 'incomplete' }, { ...valid, rationale: '' }])
    const res = parseIdeationResponse(mixed)
    expect(res.proposals).toHaveLength(1)
    expect(res.dropped).toBe(2)
  })

  it('ignores unknown extra fields but keeps the proposal', () => {
    const res = parseIdeationResponse(JSON.stringify([{ ...valid, junk: 123 }]))
    expect(res.proposals).toHaveLength(1)
  })

  it('caps the result at max', () => {
    const res = parseIdeationResponse(arr(10), { max: 3 })
    expect(res.proposals).toHaveLength(3)
  })

  it('returns empty for garbage / no JSON', () => {
    expect(parseIdeationResponse('I could not think of anything.').proposals).toHaveLength(0)
    expect(parseIdeationResponse('').proposals).toHaveLength(0)
    expect(parseIdeationResponse('{ not valid json ]').proposals).toHaveLength(0)
  })

  it('coerces non-string scalar fields by dropping them (no silent stringify)', () => {
    const res = parseIdeationResponse(JSON.stringify([{ ...valid, title: 42 }]))
    expect(res.proposals).toHaveLength(0)
    expect(res.dropped).toBe(1)
  })
})
