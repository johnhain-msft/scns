import { describe, it, expect } from 'vitest'
import {
  NULL_FACT_EXTRACTOR,
  isNullFactExtractor,
  buildFactExtractionUserPrompt,
  parseFactExtractionResponse,
  FACT_EXTRACTION_SYSTEM_PROMPT,
  MAX_FACT_CHARS,
  MAX_FACTS_PER_SOURCE,
  type FactSourceChunk,
} from '../../../src/memory/fact-extractor-provider.js'

function chunk(over: Partial<FactSourceChunk> = {}): FactSourceChunk {
  return {
    id: '0',
    path: 'chain_c.md',
    content: 'The Riverdale Settlement House is notable for its century-old pipe organ.',
    ...over,
  }
}

describe('NULL_FACT_EXTRACTOR', () => {
  it('extracts zero facts for any input (default-OFF behaviour)', async () => {
    const facts = await NULL_FACT_EXTRACTOR.extract({ chunks: [chunk(), chunk({ id: '1' })] })
    expect(facts).toEqual([])
  })

  it('is detected by isNullFactExtractor', () => {
    expect(isNullFactExtractor(NULL_FACT_EXTRACTOR)).toBe(true)
    expect(isNullFactExtractor(undefined)).toBe(true)
    expect(isNullFactExtractor(null)).toBe(true)
  })

  it('a custom extractor is NOT the null extractor', () => {
    const custom = { async extract() { return [] } }
    expect(isNullFactExtractor(custom)).toBe(false)
  })
})

describe('buildFactExtractionUserPrompt', () => {
  it('includes each passage id and text', () => {
    const prompt = buildFactExtractionUserPrompt({
      chunks: [chunk({ id: 'src-7', content: 'Melanie volunteers at Riverdale.' })],
    })
    expect(prompt).toContain('src-7')
    expect(prompt).toContain('Melanie volunteers at Riverdale')
  })

  it('system prompt instructs JSON-array-only output and reference resolution', () => {
    expect(FACT_EXTRACTION_SYSTEM_PROMPT).toMatch(/JSON array/i)
    expect(FACT_EXTRACTION_SYSTEM_PROMPT).toMatch(/self-contained|resolve/i)
  })
})

describe('parseFactExtractionResponse', () => {
  const ids = ['0', '1']

  it('parses a valid JSON array into facts', () => {
    const raw = JSON.stringify([
      { sourceId: '0', content: 'Riverdale, where Melanie volunteers, is notable for its pipe organ.' },
    ])
    const facts = parseFactExtractionResponse(raw, ids)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ sourceId: '0' })
    expect(facts[0]!.content).toContain('pipe organ')
  })

  it('strips code fences the model may add', () => {
    const raw = '```json\n[{"sourceId":"1","content":"a fact"}]\n```'
    const facts = parseFactExtractionResponse(raw, ids)
    expect(facts).toHaveLength(1)
    expect(facts[0]!.sourceId).toBe('1')
  })

  it('strips a single-backtick wrapper (the real copilot --acp empty-array case)', () => {
    expect(parseFactExtractionResponse('`[]`', ids)).toEqual([])
    const facts = parseFactExtractionResponse('`[{"sourceId":"0","content":"x fact"}]`', ids)
    expect(facts).toHaveLength(1)
  })

  it('extracts the JSON array when the model wraps it in prose', () => {
    const raw = 'Here are the facts:\n[{"sourceId":"0","content":"a notable fact"}]\nDone.'
    const facts = parseFactExtractionResponse(raw, ids)
    expect(facts).toHaveLength(1)
    expect(facts[0]!.content).toBe('a notable fact')
  })

  it('drops facts whose sourceId is not among the inputs (no hallucinated attachment)', () => {
    const raw = JSON.stringify([
      { sourceId: '99', content: 'orphan fact' },
      { sourceId: '0', content: 'grounded fact' },
    ])
    const facts = parseFactExtractionResponse(raw, ids)
    expect(facts).toHaveLength(1)
    expect(facts[0]!.content).toBe('grounded fact')
  })

  it('drops blank content and trims/normalises whitespace', () => {
    const raw = JSON.stringify([
      { sourceId: '0', content: '   ' },
      { sourceId: '1', content: '  multi   space\n\nfact  ' },
    ])
    const facts = parseFactExtractionResponse(raw, ids)
    expect(facts).toHaveLength(1)
    expect(facts[0]!.content).toBe('multi space fact')
  })

  it('caps content length to MAX_FACT_CHARS', () => {
    const raw = JSON.stringify([{ sourceId: '0', content: 'x'.repeat(MAX_FACT_CHARS + 200) }])
    const facts = parseFactExtractionResponse(raw, ids)
    expect(facts[0]!.content.length).toBe(MAX_FACT_CHARS)
  })

  it('de-duplicates identical (sourceId, content) pairs', () => {
    const raw = JSON.stringify([
      { sourceId: '0', content: 'same fact' },
      { sourceId: '0', content: 'same fact' },
    ])
    expect(parseFactExtractionResponse(raw, ids)).toHaveLength(1)
  })

  it('caps facts per source to MAX_FACTS_PER_SOURCE', () => {
    const items = Array.from({ length: MAX_FACTS_PER_SOURCE + 3 }, (_, i) => ({
      sourceId: '0',
      content: `fact number ${i}`,
    }))
    const facts = parseFactExtractionResponse(JSON.stringify(items), ids)
    expect(facts).toHaveLength(MAX_FACTS_PER_SOURCE)
  })

  it('returns [] for unparseable JSON (do-no-harm)', () => {
    expect(parseFactExtractionResponse('not json at all', ids)).toEqual([])
    expect(parseFactExtractionResponse('{"not":"an array"}', ids)).toEqual([])
  })

  it('returns [] for an empty valid-id set', () => {
    expect(parseFactExtractionResponse('[{"sourceId":"0","content":"x"}]', [])).toEqual([])
  })
})
