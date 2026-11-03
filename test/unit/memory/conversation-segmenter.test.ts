/**
 * WS-2 Phase B3 — conversation SEGMENTER unit tests (B3.5 tests 1-3).
 *
 * The one genuinely NEW piece of B3: turn a LoCoMo conversation (sessions of speaker turns) into
 * clean MAGMA event nodes ⟨c, τ, v, A⟩ (Eq 3) with a REAL per-session event-time τ (via
 * `parseSessionDateTime`), the acting person canonicalized against the gazetteer, and a
 * decision→observation(→action)→outcome triple — extracted by an injected LLM extractor (Alg 2
 * fast-path segmentation, App C.1 event extraction). Unit tests inject a MOCK extractor (NO spawn)
 * and a STUB embedder (NO fastembed worker); the real deny-all extractor runs only in the harness.
 *
 * The point (see plan §B2.1): consecutive event nodes for an entity now span SESSIONS, so
 * `buildEventCausalCandidates` yields CROSS-SESSION decision→outcome pairs — not the within-session
 * turn-adjacency (goodbye→goodbye) the deterministic per-turn path was measured to produce.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openMemoryDb, closeMemoryDb, EMBEDDING_DIMENSIONS } from '../../../src/memory/db.js'
import {
  buildEventCausalCandidates,
  countEventNodes,
  writeEventNodes,
  type EmbedBatchFn,
} from '../../../src/memory/event-nodes.js'
import type { GazetteerEntry } from '../../../src/memory/entities/gazetteer.js'
import {
  parseSessionDateTime,
  tauMsToIso,
  groupLocomoConversation,
  segmentConversation,
} from '../../../src/memory/conversation-segmenter.js'
import {
  NULL_CONVERSATION_EVENT_EXTRACTOR,
  type ConversationEventExtractor,
  type ExtractedConversationEvent,
} from '../../../src/memory/conversation-event-extractor.js'

const stubEmbed: EmbedBatchFn = async (texts) =>
  texts.map(() => ({ embedding: new Float32Array(EMBEDDING_DIMENSIONS), dimensions: EMBEDDING_DIMENSIONS }))

/** Oracle/speaker-style gazetteer (the LoCoMo entity vocabulary, held constant across arms). */
const GAZ: readonly GazetteerEntry[] = [
  { canonical: 'Caroline', kind: 'concept', aliases: ['caroline'] },
  { canonical: 'Melanie', kind: 'concept', aliases: ['melanie'] },
]

/** A LoCoMo-shaped conversation: two dated sessions for Caroline + one undated (unparseable τ). */
const CONVERSATION: Record<string, unknown> = {
  speaker_a: 'Caroline',
  speaker_b: 'Melanie',
  session_1_date_time: '2:00 pm on 8 May, 2023',
  session_1: [
    { speaker: 'Caroline', dia_id: 'D1:1', text: 'I decided to join a grief support group after losing my mom.' },
    { speaker: 'Melanie', dia_id: 'D1:2', text: 'That is a brave and healthy step.' },
  ],
  session_2_date_time: '3:30 pm on 20 May, 2023',
  session_2: [
    { speaker: 'Caroline', dia_id: 'D2:1', text: 'The support group really helped me start to cope.' },
  ],
  session_3_date_time: 'sometime later', // unparseable ⇒ skipped (τ is required)
  session_3: [{ speaker: 'Melanie', dia_id: 'D3:1', text: 'Good to hear.' }],
}

/** Mock extractor: scripts one CROSS-SESSION Caroline event per dated session (decision→observation→outcome). */
const mockExtractor: ConversationEventExtractor = {
  async extract(ep): Promise<readonly ExtractedConversationEvent[]> {
    if (ep.episodeId === 'session_1') {
      return [
        {
          entity: 'Caroline',
          decision: 'join a grief support group',
          action: 'attended the first weekly meeting',
          outcome: 'felt less alone',
          content: 'Caroline decided to join a grief support group and attended the first meeting.',
        },
      ]
    }
    if (ep.episodeId === 'session_2') {
      return [
        {
          entity: 'Caroline',
          decision: null,
          action: 'kept attending the grief support group',
          outcome: 'started to cope with losing her mom',
          content: 'The grief support group helped Caroline start to cope with her loss.',
        },
      ]
    }
    return []
  },
}

describe('conversation-segmenter :: time helpers', () => {
  it('parseSessionDateTime parses a LoCoMo session date to epoch ms (UTC)', () => {
    expect(parseSessionDateTime('2:00 pm on 8 May, 2023')).toBe(Date.UTC(2023, 4, 8, 14, 0))
    expect(parseSessionDateTime('12:05 am on 1 January, 2024')).toBe(Date.UTC(2024, 0, 1, 0, 5))
    expect(parseSessionDateTime('garbage')).toBeNull()
    expect(parseSessionDateTime(undefined)).toBeNull()
  })

  it('tauMsToIso renders a deterministic ISO-8601 event time', () => {
    expect(tauMsToIso(Date.UTC(2023, 4, 8, 14, 0))).toBe('2023-05-08T14:00:00.000Z')
  })
})

describe('conversation-segmenter :: groupLocomoConversation', () => {
  it('groups turns by session with speakers + parsed τ, in session order', () => {
    const episodes = groupLocomoConversation(CONVERSATION)
    expect(episodes.map((e) => e.episodeId)).toEqual(['session_1', 'session_2', 'session_3'])
    expect(episodes[0]!.speakers).toEqual(['Caroline', 'Melanie'])
    expect(episodes[0]!.tauMs).toBe(Date.UTC(2023, 4, 8, 14, 0))
    expect(episodes[0]!.turns).toHaveLength(2)
    expect(episodes[0]!.turns[0]).toMatchObject({ speaker: 'Caroline', ref: 'D1:1' })
    expect(episodes[0]!.turns[0]!.text).toContain('grief support group')
    expect(episodes[2]!.tauMs).toBeNull() // unparseable date
  })
})

describe('conversation-segmenter :: segmentConversation (B3.5 #1)', () => {
  it('produces event nodes with real session-τ, canonical entity, and decision/observation/outcome', async () => {
    const records = await segmentConversation(CONVERSATION, { extractor: mockExtractor, gazetteer: GAZ })

    // session_3 has no parseable τ ⇒ contributes nothing; two Caroline events remain.
    expect(records).toHaveLength(2)

    const first = records[0]!
    expect(first.kind).toBe('conversation-event')
    expect(first.entity).toBe('Caroline') // canonicalized against the gazetteer
    expect(first.tau).toBe(tauMsToIso(Date.UTC(2023, 4, 8, 14, 0))) // real session-τ via parseSessionDateTime
    expect(first.decision).toBe('join a grief support group')
    expect(first.action).toBe('attended the first weekly meeting') // paper's OBSERVATION
    expect(first.outcome).toBe('felt less alone')
    expect(first.content).toContain('grief support group')
    expect(first.sourceRef).toContain('session_1')

    // Stable-sorted ascending by τ: session_1 (May 8) precedes session_2 (May 20).
    expect(records[0]!.tau < records[1]!.tau).toBe(true)
    // Distinct, re-chunk-proof event keys.
    expect(new Set(records.map((r) => r.eventKey)).size).toBe(2)
  })

  it('with the NULL extractor emits zero event nodes (default-OFF control)', async () => {
    const records = await segmentConversation(CONVERSATION, {
      extractor: NULL_CONVERSATION_EVENT_EXTRACTOR,
      gazetteer: GAZ,
    })
    expect(records).toEqual([])
  })

  it('anchors the node on the App-C.1 entities[] list when the primary entity is unresolvable', async () => {
    // The primary `entity` is a non-gazetteer surface form; only entities[] carries a gazetteer name.
    const c1Extractor: ConversationEventExtractor = {
      async extract() {
        return [
          {
            entity: 'she', // unresolvable pronoun
            entities: ['the clinic', 'Melanie'], // C.1 proper nouns; Melanie ∈ gazetteer
            decision: null,
            action: null,
            outcome: null,
            content: 'The subject visited the clinic for a follow-up.', // no gazetteer name in content
          },
        ]
      },
    }
    const oneSession: Record<string, unknown> = {
      speaker_a: 'Caroline',
      speaker_b: 'Melanie',
      session_1_date_time: '2:00 pm on 8 May, 2023',
      session_1: [{ speaker: 'Caroline', dia_id: 'D1:1', text: 'a turn' }],
    }
    const records = await segmentConversation(oneSession, { extractor: c1Extractor, gazetteer: GAZ })
    expect(records).toHaveLength(1)
    expect(records[0]!.entity).toBe('Melanie') // resolved from the C.1 entities[] list (object permanence)
  })
})

describe('conversation-segmenter :: persistence + cross-session candidates (B3.5 #2, #3)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  it('writeEventNodes of segmented records is idempotent (re-run adds 0)', async () => {
    const records = await segmentConversation(CONVERSATION, { extractor: mockExtractor, gazetteer: GAZ })
    const first = await writeEventNodes(db, records, { embed: stubEmbed, rebuildEdges: false })
    expect(first.written).toBe(2)
    expect(countEventNodes(db).byKind).toEqual({ 'conversation-event': 2 })

    const second = await writeEventNodes(db, records, { embed: stubEmbed, rebuildEdges: false })
    expect(second.written).toBe(0)
    expect(second.skippedExisting).toBe(2)
    expect(countEventNodes(db).total).toBe(2)
  })

  it('buildEventCausalCandidates yields a CROSS-SESSION (cause→effect) pair for the entity', async () => {
    const records = await segmentConversation(CONVERSATION, { extractor: mockExtractor, gazetteer: GAZ })
    await writeEventNodes(db, records, { embed: stubEmbed, rebuildEdges: false })

    const candidates = buildEventCausalCandidates(db)
    expect(candidates).toHaveLength(1)
    const c = candidates[0]!
    expect(c.entity).toBe('Caroline')
    // cause = the earlier session (the decision), effect = the later session (the outcome).
    expect(c.causeContent).toContain('decided to join a grief support group')
    expect(c.effectContent).toContain('helped Caroline start to cope')
    // Genuinely cross-session decision→outcome, not within-session turn adjacency.
    expect(c.causeContent).not.toEqual(c.effectContent)
  })
})

describe('conversation-segmenter :: LEARNED (non-gazetteer) entity extraction (A-div2)', () => {
  it('keeps a non-gazetteer proper noun as a LEARNED entity (not null) + populates entities[], dropping noise', async () => {
    // EMPTY gazetteer ⇒ nothing can be gazetteer-resolved; every kept entity must be LEARNED.
    const EMPTY_GAZ: readonly GazetteerEntry[] = []
    const extractor: ConversationEventExtractor = {
      async extract(): Promise<readonly ExtractedConversationEvent[]> {
        return [
          {
            entity: 'Zephyrina', // non-gazetteer proper noun (was previously collapsed to null)
            entities: ['Zephyrina', 'Riverdale', 'she', 'the clinic'], // 2 proper nouns + 2 noise
            decision: 'moved to a new town',
            action: null,
            outcome: null,
            content: 'Zephyrina moved to Riverdale to start a new job.',
          },
        ]
      },
    }
    const conv: Record<string, unknown> = {
      speaker_a: 'Zephyrina',
      speaker_b: 'Bob',
      session_1_date_time: '2:00 pm on 8 May, 2023',
      session_1: [{ speaker: 'Zephyrina', dia_id: 'D1:1', text: 'a turn' }],
    }

    const records = await segmentConversation(conv, { extractor, gazetteer: EMPTY_GAZ })
    expect(records).toHaveLength(1)
    const r = records[0]!

    // Primary anchor is the LEARNED canonical (lowercased) — NOT null as the old gazetteer collapse did.
    expect(r.entity).toBe('zephyrina')
    // Full learned list: proper nouns kept (lowercased, deduped); pronoun/common-noun noise dropped.
    expect(r.entities).toEqual(['zephyrina', 'riverdale'])
  })
})
