/**
 * WS-2 Phase B3 — causal inference + WHY read + regression guard (B3.5 tests 4-6).
 *
 * Proves the END-TO-END B3 measurement path over CONVERSATION event nodes, all with a MOCK provider
 * (NO spawn) + STUB embedder (NO fastembed):
 *   #4 `ingestConversationEventNodes` (segment → writeEventNodes → `runCausalEdgeInference`) over the
 *      populated event/outcome source persists `memory_causal` and materializes `memory_edges(causal)`
 *      the beam/WHY-reader consume — Alg 3 slow-path E_new = Φ(N(n), H) (Eq 8), WS-2b.
 *   #5 `retrieveContext({intentRouting:true})` on a WHY query naming a tagged entity returns the causal
 *      chain (the entity-anchored `causalNeighborhood WHERE entity=?` read); `intentRouting:false`
 *      does NOT causal-route (byte-identical default path — proven byte-for-byte in #6).
 *   #6 REGRESSION GUARD: a DEFAULT `indexVault` builds NO event nodes / NO causal edges (B3 storage is
 *      opt-in), and the B3 pipeline under the NULL extractor is byte-identical to the baseline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { openMemoryDb, closeMemoryDb, EMBEDDING_DIMENSIONS } from '../../../src/memory/db.js'
import { createVault } from '../../../src/memory/vault.js'
import { indexVaultSync } from '../../../src/memory/indexer.js'
import { countEventNodes, type EmbedBatchFn } from '../../../src/memory/event-nodes.js'
import {
  ingestConversationEventNodes,
  type IngestConversationEventsDeps,
} from '../../../src/memory/conversation-segmenter.js'
import {
  NULL_CONVERSATION_EVENT_EXTRACTOR,
  type ConversationEventExtractor,
  type ExtractedConversationEvent,
} from '../../../src/memory/conversation-event-extractor.js'
import { retrieveContext } from '../../../src/memory/retrieval-context.js'
import type { GazetteerEntry } from '../../../src/memory/entities/gazetteer.js'
import type { CausalProvider, CausalEdge } from '../../../src/memory/causal-provider.js'

const stubEmbed: EmbedBatchFn = async (texts) =>
  texts.map(() => ({ embedding: new Float32Array(EMBEDDING_DIMENSIONS), dimensions: EMBEDDING_DIMENSIONS }))

const GAZ: readonly GazetteerEntry[] = [
  { canonical: 'Caroline', kind: 'concept', aliases: ['caroline'] },
  { canonical: 'Melanie', kind: 'concept', aliases: ['melanie'] },
]

const CONVERSATION: Record<string, unknown> = {
  speaker_a: 'Caroline',
  speaker_b: 'Melanie',
  session_1_date_time: '2:00 pm on 8 May, 2023',
  session_1: [{ speaker: 'Caroline', dia_id: 'D1:1', text: 'I decided to join a grief support group.' }],
  session_2_date_time: '3:30 pm on 20 May, 2023',
  session_2: [{ speaker: 'Caroline', dia_id: 'D2:1', text: 'The support group really helped me cope.' }],
}

const mockExtractor: ConversationEventExtractor = {
  async extract(ep): Promise<readonly ExtractedConversationEvent[]> {
    if (ep.episodeId === 'session_1')
      return [
        {
          entity: 'Caroline',
          decision: 'join a grief support group',
          action: 'attended the first meeting',
          outcome: 'felt less alone',
          content: 'Caroline decided to join a grief support group to process losing her mom.',
        },
      ]
    if (ep.episodeId === 'session_2')
      return [
        {
          entity: 'Caroline',
          decision: null,
          action: 'kept attending the grief support group',
          outcome: 'started to cope with her grief',
          content: 'The grief support group helped Caroline start to cope with her grief.',
        },
      ]
    return []
  },
}

/** A scripted causal provider that echoes each candidate back as a high-confidence edge (no spawn). */
function scriptedProvider(confidence = 0.9): CausalProvider {
  return {
    async infer({ candidates }) {
      return candidates.map(
        (c): CausalEdge => ({
          causeKey: c.causeKey,
          effectKey: c.effectKey,
          confidence,
          rationale: `scripted: ${c.entity}`,
        }),
      )
    },
  }
}

function countRows(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

const mockDeps = (provider: CausalProvider): IngestConversationEventsDeps => ({
  extractor: mockExtractor,
  gazetteer: GAZ,
  embed: stubEmbed,
  rebuildEdges: false,
  causalProvider: provider,
  minConfidence: 0.7,
})

describe('B3 #4 — ingestConversationEventNodes: segment → write → causal inference', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  it('persists memory_causal + materializes memory_edges(causal) over cross-session event nodes', async () => {
    const res = await ingestConversationEventNodes(db, CONVERSATION, mockDeps(scriptedProvider(0.9)))

    expect(res.segmented).toBe(2)
    expect(res.wrote.written).toBe(2)
    // Node-quality diagnostic: the candidate is event-sourced (decision→outcome), NOT chunk-pair.
    expect(res.eventCausalCandidates).toBeGreaterThanOrEqual(1)
    expect(res.chunkCausalCandidates).toBe(0)

    expect(res.causal.ran).toBe(true)
    expect(res.causal.persisted).toBeGreaterThanOrEqual(1)
    expect(res.causal.materialized).toBeGreaterThanOrEqual(1)
    expect(countRows(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(res.causal.persisted)
    expect(countRows(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='causal'")).toBe(
      res.causal.materialized,
    )
    // The edge is anchored on the canonical entity (so the WHERE entity=? WHY read can find it).
    const row = db.prepare('SELECT entity FROM memory_causal LIMIT 1').get() as { entity: string }
    expect(row.entity).toBe('Caroline')
  })

  it('applies the confidence gate (below-threshold edges are not persisted)', async () => {
    const res = await ingestConversationEventNodes(db, CONVERSATION, mockDeps(scriptedProvider(0.4)))
    expect(res.causal.rejectedLowConfidence).toBeGreaterThanOrEqual(1)
    expect(res.causal.persisted).toBe(0)
    expect(countRows(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(0)
  })

  it('forwards maxCandidates to the batched causal judge (M1 cap seam)', async () => {
    // 3 dated sessions ⇒ ≥2 consecutive Caroline event pairs (uncapped); a cap of 1 ⇒ the single
    // batched judge prompt sees AT MOST 1 candidate (this is the M1 timeout-avoidance seam).
    const conv3: Record<string, unknown> = {
      speaker_a: 'Caroline',
      speaker_b: 'Melanie',
      session_1_date_time: '2:00 pm on 8 May, 2023',
      session_1: [{ speaker: 'Caroline', dia_id: 'D1:1', text: 'I decided to join a grief support group.' }],
      session_2_date_time: '3:30 pm on 20 May, 2023',
      session_2: [{ speaker: 'Caroline', dia_id: 'D2:1', text: 'The support group helped me cope with loss.' }],
      session_3_date_time: '9:00 am on 2 June, 2023',
      session_3: [{ speaker: 'Caroline', dia_id: 'D3:1', text: 'I started volunteering to help other grievers.' }],
    }
    const extractor3: ConversationEventExtractor = {
      async extract(ep): Promise<readonly ExtractedConversationEvent[]> {
        const byEp: Record<string, ExtractedConversationEvent> = {
          session_1: { entity: 'Caroline', decision: 'join a grief support group', action: 'attended', outcome: 'felt supported', content: 'Caroline decided to join a grief support group after losing her mom.' },
          session_2: { entity: 'Caroline', decision: null, action: 'kept attending', outcome: 'began to cope', content: 'The grief support group helped Caroline begin to cope with her loss.' },
          session_3: { entity: 'Caroline', decision: 'volunteer to help other grievers', action: 'signed up', outcome: 'found new purpose', content: 'Caroline decided to volunteer to help other grievers and found new purpose.' },
        }
        const e = byEp[ep.episodeId]
        return e ? [e] : []
      },
    }
    const seen: number[] = []
    const capturing: CausalProvider = {
      async infer({ candidates }) {
        seen.push(candidates.length)
        return []
      },
    }
    const res = await ingestConversationEventNodes(db, conv3, {
      extractor: extractor3,
      gazetteer: GAZ,
      embed: stubEmbed,
      rebuildEdges: false,
      causalProvider: capturing,
      minConfidence: 0.7,
      maxCandidates: 1,
    })
    expect(res.eventCausalCandidates).toBeGreaterThanOrEqual(2) // TRUE uncapped diagnostic count
    expect(seen.length).toBe(1) // one batched judge call
    expect(seen[0]).toBeLessThanOrEqual(1) // the judge saw AT MOST the cap
  })
})

describe('B3 #5 — WHY read path (intentRouting) over the inferred causal edges', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  const WHY_QUERY = 'Why did the grief support group help Caroline cope?'

  it('intentRouting:true returns the causal chain for the tagged entity', async () => {
    await ingestConversationEventNodes(db, CONVERSATION, mockDeps(scriptedProvider(0.9)))

    const ctx = await retrieveContext(db, WHY_QUERY, { intentRouting: true }, { gazetteer: GAZ })
    expect(ctx.intent).toBe('WHY')
    expect(ctx.nResults).toBeGreaterThanOrEqual(1)
    expect(ctx.text).toContain('Caroline')
    expect(ctx.text).toContain('→ led to →') // formatCausalChain rendering (WHY subspace)
    expect(ctx.text).toContain('scripted: Caroline') // the judge rationale surfaced
  })

  it('intentRouting:false does NOT causal-route (no chain formatting)', async () => {
    await ingestConversationEventNodes(db, CONVERSATION, mockDeps(scriptedProvider(0.9)))

    const ctx = await retrieveContext(db, WHY_QUERY, { intentRouting: false }, { gazetteer: GAZ })
    expect(ctx.text).not.toContain('→ led to →')
  })
})

describe('B3 #6 — regression guard: prod indexVault untouched + NULL-extractor byte-identity', () => {
  let db: Database.Database
  let rootDir: string
  let vault: ReturnType<typeof createVault>
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    rootDir = mkdtempSync(join(tmpdir(), 'b3-guard-'))
    vault = createVault({ rootDir })
  })
  afterEach(() => {
    closeMemoryDb(db)
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('a DEFAULT indexVault builds NO event nodes / NO causal edges (B3 storage is opt-in)', async () => {
    vault.write('note.md', 'Caroline attended the grief support group on Tuesdays and it helped.')
    indexVaultSync(db, vault)

    // Prod default path: B3 added nothing.
    expect(countEventNodes(db).total).toBe(0)
    expect(countRows(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(0)
    expect(countRows(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='causal'")).toBe(0)

    // NON-VACUOUS: the OPT-IN path DOES populate both (so the zeros above are a real guard).
    const res = await ingestConversationEventNodes(db, CONVERSATION, mockDeps(scriptedProvider(0.9)))
    expect(countEventNodes(db).total).toBe(res.wrote.written)
    expect(countEventNodes(db).total).toBeGreaterThan(0)
    expect(countRows(db, 'SELECT COUNT(*) n FROM memory_causal')).toBeGreaterThan(0)
  })

  it('the B3 pipeline under the NULL extractor is byte-identical to the baseline', async () => {
    vault.write('note.md', 'Caroline attended the grief support group on Tuesdays and it helped her cope.')
    indexVaultSync(db, vault)
    const query = 'grief support group'

    const baseline = await retrieveContext(db, query, { intentRouting: false }, { gazetteer: GAZ })

    // Run the full B3 pipeline with the NULL extractor (default-OFF control).
    const res = await ingestConversationEventNodes(db, CONVERSATION, {
      extractor: NULL_CONVERSATION_EVENT_EXTRACTOR,
      gazetteer: GAZ,
      embed: stubEmbed,
      rebuildEdges: false,
      causalProvider: scriptedProvider(0.9),
      minConfidence: 0.7,
    })
    expect(res.segmented).toBe(0)
    expect(res.wrote.written).toBe(0)
    expect(res.causal.ran).toBe(false) // no event nodes ⇒ no candidates ⇒ inert

    const after = await retrieveContext(db, query, { intentRouting: false }, { gazetteer: GAZ })
    expect(after.text).toBe(baseline.text) // byte-identical
    expect(after.chunkIds).toEqual(baseline.chunkIds)
    expect(countEventNodes(db).total).toBe(0)
  })
})
