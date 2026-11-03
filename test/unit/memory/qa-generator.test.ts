import { describe, it, expect } from 'vitest'
import {
  ADAPTIVE_QA_SYSTEM_PROMPT,
  dynamicInstructionFor,
  buildQaUserPrompt,
  parseQaResponse,
  NULL_GENERATOR,
  isNullGenerator,
  QA_NOT_FOUND,
  type QaGenerator,
} from '../../../src/memory/qa-generator.js'

// MAGMA App C.2 (Query-Adaptive QA generator). Persona + fixed instructions extracted verbatim from
// ~/Downloads/magma.pdf → /tmp/magma_raw.txt:~1564-1600; OSS answer_formatter.py:531 build_qa_prompt.
// The per-category "dynamic instruction" is chosen by SCNS's OWN classifyIntent — NEVER the LoCoMo
// gold category (that would be an oracle leak).

describe('ADAPTIVE_QA_SYSTEM_PROMPT — faithful to App C.2', () => {
  it('carries the precision-QA persona and the context-only + abstain + concise rules', () => {
    const p = ADAPTIVE_QA_SYSTEM_PROMPT
    expect(p.toLowerCase()).toContain('precision qa assistant')
    expect(p.toLowerCase()).toContain('only')
    expect(p).toContain(QA_NOT_FOUND)
    expect(p.toLowerCase()).toContain('concise')
  })
})

describe('dynamicInstructionFor — SCNS classifyIntent → C.2 category instruction (no oracle label)', () => {
  it('maps WHEN → Temporal', () => {
    expect(dynamicInstructionFor('WHEN').toLowerCase()).toMatch(/date|temporal|duration/)
  })
  it('maps WHY → Open-Domain/Inference', () => {
    expect(dynamicInstructionFor('WHY').toLowerCase()).toMatch(/infer|reason|hypothet/)
  })
  it('maps ENTITY → Single-hop/Factual', () => {
    expect(dynamicInstructionFor('ENTITY').toLowerCase()).toMatch(/specific entity|name|method|extract/)
  })
  it('maps DEFAULT → Multi-hop (connect related facts)', () => {
    expect(dynamicInstructionFor('DEFAULT').toLowerCase()).toMatch(/connect|related facts|across/)
  })
})

describe('buildQaUserPrompt — context + question + dynamic instruction, no oracle leak', () => {
  const ctx = 'Relevant SCNS memories:\nCaroline: I joined the LGBTQ support group on 7 May 2023.'
  it('includes the retrieved context, the question, and the intent-derived instruction', () => {
    const u = buildQaUserPrompt({ question: 'When did Caroline join the support group?', context: ctx, intent: 'WHEN' })
    expect(u).toContain('support group')
    expect(u).toContain('7 May 2023')
    expect(u.toLowerCase()).toMatch(/date|temporal|duration/) // WHEN → temporal instruction present
  })
  it('does NOT contain a gold answer or a numeric category (anti-oracle)', () => {
    const u = buildQaUserPrompt({ question: 'q', context: ctx, intent: 'DEFAULT' })
    expect(u.toLowerCase()).not.toContain('gold')
    expect(u.toLowerCase()).not.toContain('category')
  })
})

describe('parseQaResponse — abstain detection + cleanup', () => {
  it('flags the exact abstain sentinel as notFound', () => {
    const r = parseQaResponse('Information not found')
    expect(r.notFound).toBe(true)
  })
  it('detects the abstain sentinel case-insensitively even with trailing punctuation', () => {
    expect(parseQaResponse('information not found.').notFound).toBe(true)
  })
  it('returns a trimmed answer for a normal response, notFound=false', () => {
    const r = parseQaResponse('  Adoption agencies  ')
    expect(r.answer).toBe('Adoption agencies')
    expect(r.notFound).toBe(false)
  })
  it('strips a leading "Answer:" label the model sometimes echoes', () => {
    expect(parseQaResponse('Answer: mental health').answer).toBe('mental health')
  })
})

describe('NULL_GENERATOR — default-OFF, inert', () => {
  it('abstains without spawning', async () => {
    const g: QaGenerator = NULL_GENERATOR
    const r = await g.generate({ question: 'q', context: 'c', intent: 'DEFAULT' })
    expect(r.notFound).toBe(true)
    expect(r.answer).toBe('')
  })
  it('is detectable via isNullGenerator', () => {
    expect(isNullGenerator(NULL_GENERATOR)).toBe(true)
    expect(isNullGenerator(undefined)).toBe(true)
    expect(isNullGenerator({ generate: async () => ({ answer: 'x', notFound: false }) })).toBe(false)
  })
})
