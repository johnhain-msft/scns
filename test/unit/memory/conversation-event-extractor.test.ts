/**
 * WS-2 Phase B3 — conversation event EXTRACTOR seam unit tests.
 *
 * The LLM-extraction seam that turns a conversation SESSION (a batch of speaker turns) into
 * structured decision→observation→outcome EVENTS — the MAGMA event node ⟨c, τ, v, A⟩ (Eq 3), the
 * App C.1 "event extraction at ingest" fast-path. Mirrors `fact-extractor-provider.ts`: the actual
 * transport is injected, the DEFAULT is a NULL extractor (default-OFF ⇒ zero events), and the pure
 * prompt/parser are validated here with NO process spawn.
 *
 * Field mapping: the paper's OBSERVATION term (the observable event between the decision and its
 * outcome) is carried by {@link ExtractedConversationEvent.action} so it maps 1:1 onto the WS-1
 * `EventNodeRecord.action` column without touching the persisted schema.
 */
import { describe, it, expect } from 'vitest'
import {
  NULL_CONVERSATION_EVENT_EXTRACTOR,
  isNullConversationEventExtractor,
  buildConversationEventUserPrompt,
  parseConversationEventResponse,
  CONVERSATION_EVENT_SYSTEM_PROMPT,
  MAX_EVENTS_PER_EPISODE,
  MAX_EVENT_CONTENT_CHARS,
  type ConversationEventExtractor,
  type ConversationEpisodeInput,
} from '../../../src/memory/conversation-event-extractor.js'

const EPISODE: ConversationEpisodeInput = {
  episodeId: 'session_3',
  speakers: ['Caroline', 'Melanie'],
  turns: [
    { speaker: 'Caroline', text: 'I finally joined a grief support group last week.' },
    { speaker: 'Melanie', text: 'That is a big step. How did it feel?' },
    { speaker: 'Caroline', text: 'It really helped me start to cope with losing my mom.' },
  ],
}

describe('conversation-event-extractor :: NULL default (default-OFF)', () => {
  it('the NULL extractor emits zero events for any episode', async () => {
    const events = await NULL_CONVERSATION_EVENT_EXTRACTOR.extract(EPISODE)
    expect(events).toEqual([])
  })

  it('isNullConversationEventExtractor identifies the null seam (and a real one)', () => {
    expect(isNullConversationEventExtractor(NULL_CONVERSATION_EVENT_EXTRACTOR)).toBe(true)
    expect(isNullConversationEventExtractor(undefined)).toBe(true)
    const real: ConversationEventExtractor = { async extract() { return [] } }
    expect(isNullConversationEventExtractor(real)).toBe(false)
  })
})

describe('conversation-event-extractor :: buildConversationEventUserPrompt', () => {
  it('renders the episode id, speakers, and every turn', () => {
    const prompt = buildConversationEventUserPrompt(EPISODE)
    expect(prompt).toContain('session_3')
    expect(prompt).toContain('Caroline')
    expect(prompt).toContain('Melanie')
    expect(prompt).toContain('grief support group')
    expect(prompt).toContain('helped me start to cope')
  })

  it('the system prompt asks for decision→observation→outcome JSON events (App C.1)', () => {
    expect(CONVERSATION_EVENT_SYSTEM_PROMPT).toMatch(/decision/i)
    expect(CONVERSATION_EVENT_SYSTEM_PROMPT).toMatch(/observation/i)
    expect(CONVERSATION_EVENT_SYSTEM_PROMPT).toMatch(/outcome/i)
    expect(CONVERSATION_EVENT_SYSTEM_PROMPT).toMatch(/JSON array/i)
  })

  it('the system prompt requests the full App-C.1 structured schema', () => {
    for (const field of ['entities', 'topic', 'relationships', 'semantic_facts', 'dates_mentioned', 'summary']) {
      expect(CONVERSATION_EVENT_SYSTEM_PROMPT).toContain(field)
    }
  })
})

// ── App C.1 Event Extraction Prompt (JSON-Structured) — the literal paper schema ──────────────────
// Target Schema (App C.1): {entities[], topic, relationships[], semantic_facts[], dates_mentioned[],
// summary}. SCNS ALSO keeps the decision→observation→outcome triple + content (the causal-subspace
// input the WHY judge consumes) — course-correction #4: add the C.1 fields, do NOT discard the triple.
describe('conversation-event-extractor :: App C.1 structured schema', () => {
  it('parses the full C.1 schema alongside the decision/observation/outcome triple', () => {
    const raw = JSON.stringify([
      {
        entities: ['Caroline', 'Riverdale'],
        topic: 'grief support',
        relationships: ['Caroline attends a support group'],
        semantic_facts: ['Caroline joined a grief support group', 'the group meets weekly'],
        dates_mentioned: ['last week'],
        summary: 'Caroline joined a grief support group last week.',
        entity: 'Caroline',
        decision: 'join a grief support group',
        observation: 'attended the first weekly meeting',
        outcome: 'started to cope with her loss',
        content: 'Caroline joined a grief support group and it helped her cope with losing her mom.',
      },
    ])
    const [ev] = parseConversationEventResponse(raw)
    expect(ev!.entities).toEqual(['Caroline', 'Riverdale'])
    expect(ev!.topic).toBe('grief support')
    expect(ev!.relationships).toEqual(['Caroline attends a support group'])
    expect(ev!.semanticFacts).toEqual(['Caroline joined a grief support group', 'the group meets weekly'])
    expect(ev!.datesMentioned).toEqual(['last week'])
    expect(ev!.summary).toBe('Caroline joined a grief support group last week.')
    // The triple + content are preserved (observation → action).
    expect(ev!.decision).toBe('join a grief support group')
    expect(ev!.action).toBe('attended the first weekly meeting')
    expect(ev!.outcome).toBe('started to cope with her loss')
  })

  it('falls back to the C.1 summary as the node content when content is absent', () => {
    const raw = JSON.stringify([{ entity: 'Melanie', summary: 'Melanie moved to Riverdale for a new job.' }])
    const [ev] = parseConversationEventResponse(raw)
    expect(ev!.content).toBe('Melanie moved to Riverdale for a new job.')
  })

  it('derives the primary entity from C.1 entities[] when the entity field is absent', () => {
    const raw = JSON.stringify([{ entities: ['Bob', 'Seattle'], content: 'Bob went diving off Seattle.' }])
    const [ev] = parseConversationEventResponse(raw)
    expect(ev!.entity).toBe('Bob')
  })

  it('do-no-harm: a legacy element without C.1 fields parses with empty/null C.1 defaults', () => {
    const [ev] = parseConversationEventResponse(JSON.stringify([{ content: 'A plain event with no C.1 fields.' }]))
    expect(ev!.entities).toEqual([])
    expect(ev!.topic).toBeNull()
    expect(ev!.relationships).toEqual([])
    expect(ev!.semanticFacts).toEqual([])
    expect(ev!.datesMentioned).toEqual([])
    expect(ev!.summary).toBeNull()
    expect(ev!.content).toBe('A plain event with no C.1 fields.')
  })
})

describe('conversation-event-extractor :: parseConversationEventResponse (do-no-harm)', () => {
  it('parses a well-formed JSON array, mapping the paper OBSERVATION onto action', () => {
    const raw = JSON.stringify([
      {
        entity: 'Caroline',
        decision: 'join a grief support group',
        observation: 'attended the first weekly meeting',
        outcome: 'started to cope with her loss',
        content: 'Caroline joined a grief support group and it helped her cope with losing her mom.',
      },
    ])
    const events = parseConversationEventResponse(raw)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      entity: 'Caroline',
      decision: 'join a grief support group',
      action: 'attended the first weekly meeting', // paper's OBSERVATION
      outcome: 'started to cope with her loss',
      content: 'Caroline joined a grief support group and it helped her cope with losing her mom.',
      // App C.1 fields default to empty/null when absent from the input (do-no-harm).
      entities: [],
      topic: null,
      relationships: [],
      semanticFacts: [],
      datesMentioned: [],
      summary: null,
    })
  })

  it('accepts an "action" key as an alias for observation', () => {
    const raw = JSON.stringify([
      { entity: 'Melanie', action: 'moved to Riverdale', outcome: 'started a new job', content: 'Melanie moved to Riverdale for a new job.' },
    ])
    const events = parseConversationEventResponse(raw)
    expect(events).toHaveLength(1)
    expect(events[0]!.action).toBe('moved to Riverdale')
    expect(events[0]!.decision).toBeNull()
  })

  it('strips markdown code fences before parsing', () => {
    const raw = '```json\n[{"content":"Caroline adopted a dog named Biscuit."}]\n```'
    const events = parseConversationEventResponse(raw)
    expect(events).toHaveLength(1)
    expect(events[0]!.content).toBe('Caroline adopted a dog named Biscuit.')
    expect(events[0]!.entity).toBeNull()
  })

  it('drops events with blank/missing content (content is the node text)', () => {
    const raw = JSON.stringify([
      { entity: 'Caroline', decision: 'x', content: '   ' },
      { entity: 'Caroline', content: 'A real event with content.' },
    ])
    const events = parseConversationEventResponse(raw)
    expect(events).toHaveLength(1)
    expect(events[0]!.content).toBe('A real event with content.')
  })

  it('caps the number of events per episode and dedups identical content', () => {
    const many = Array.from({ length: MAX_EVENTS_PER_EPISODE + 5 }, (_, i) => ({
      content: `distinct event number ${i}`,
    }))
    expect(parseConversationEventResponse(JSON.stringify(many))).toHaveLength(MAX_EVENTS_PER_EPISODE)

    const dupes = JSON.stringify([
      { content: 'same event' },
      { content: 'same event' },
      { content: 'other event' },
    ])
    expect(parseConversationEventResponse(dupes)).toHaveLength(2)
  })

  it('trims and hard-caps content length', () => {
    const long = 'C'.repeat(MAX_EVENT_CONTENT_CHARS + 200)
    const events = parseConversationEventResponse(JSON.stringify([{ content: `  ${long}  ` }]))
    expect(events).toHaveLength(1)
    expect(events[0]!.content.length).toBe(MAX_EVENT_CONTENT_CHARS)
  })

  it('returns [] for non-JSON / non-array / empty input (never throws)', () => {
    expect(parseConversationEventResponse('not json at all')).toEqual([])
    expect(parseConversationEventResponse('{"content":"an object not an array"}')).toEqual([])
    expect(parseConversationEventResponse('')).toEqual([])
  })
})
