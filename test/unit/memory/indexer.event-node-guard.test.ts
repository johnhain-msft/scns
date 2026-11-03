/**
 * WS-1 — indexer coexistence guard regression test.
 *
 * Event nodes live under synthetic `event-nodes/*` vault_files paths that have NO on-disk file, so
 * the incremental indexer (which cascade-deletes any stored path not returned by the vault scan)
 * would wipe them on the very next fast-path pass without the guard. This proves: (1) a re-index
 * with no on-disk `event-nodes/` file leaves the event-node chunks + sidecar INTACT, and (2) the
 * guard is NON-VACUOUS — a real source file that IS removed from disk is still cascade-deleted, so
 * the deletion path is genuinely active (the guard exempts only the synthetic prefix).
 *
 * A deterministic STUB embedder is injected so the test never forks the fastembed worker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import {
  openMemoryDb,
  closeMemoryDb,
  EVENT_CHUNK_INDEX_BASE,
  EMBEDDING_DIMENSIONS,
} from '../../../src/memory/db.js'
import { createVault } from '../../../src/memory/vault.js'
import { indexVaultSync } from '../../../src/memory/indexer.js'
import { writeEventNodes, type EventNodeRecord, type EmbedBatchFn } from '../../../src/memory/event-nodes.js'

const stubEmbed: EmbedBatchFn = async (texts) =>
  texts.map(() => ({ embedding: new Float32Array(EMBEDDING_DIMENSIONS), dimensions: EMBEDDING_DIMENSIONS }))

const EVENT_RECORDS: EventNodeRecord[] = [
  {
    eventKey: 'guard-ek-1',
    tau: '2026-04-01T00:00:00Z',
    entity: 'auto-merger',
    kind: 'broker-decision',
    decision: 'auto-merge',
    action: 'branch feat-y',
    outcome: 'merged (deadbeef)',
    content: 'On 2026-04-01T00:00:00Z, the broker auto-merge — branch feat-y: merged (deadbeef).',
    sourceRef: 'events#7',
  },
  {
    eventKey: 'guard-ek-2',
    tau: '2026-04-02T00:00:00Z',
    entity: 'dream-daemon',
    kind: 'proposal-outcome',
    decision: 'self-improvement proposal "Prune orphaned embeddings" [seed-z]',
    action: null,
    outcome: 'verdict: implemented',
    content:
      'On 2026-04-02T00:00:00Z, self-improvement proposal "Prune orphaned embeddings" [seed-z] targeting dream-daemon — verdict: implemented.',
    sourceRef: 'proposal_outcomes#2',
  },
]

describe('WS-1 — indexer event-node coexistence guard', () => {
  let rootDir: string
  let db: Database.Database
  let vault: ReturnType<typeof createVault>

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'ws1-guard-'))
    vault = createVault({ rootDir })
    db = openMemoryDb(':memory:')
  })
  afterEach(() => {
    closeMemoryDb(db)
    rmSync(rootDir, { recursive: true, force: true })
  })

  const eventChunkCount = (): number =>
    (
      db
        .prepare('SELECT COUNT(*) AS n FROM chunks WHERE chunk_index >= ?')
        .get(EVENT_CHUNK_INDEX_BASE) as { n: number }
    ).n
  const sidecarCount = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM event_nodes').get() as { n: number }).n
  const sourceChunkCount = (): number =>
    (
      db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_path = 'note.md'").get() as {
        n: number
      }
    ).n

  it('preserves event-node chunks + sidecar across a re-index with no on-disk event file', async () => {
    vault.write('note.md', 'A real source note about the auto-merger and its behaviour over time.')
    indexVaultSync(db, vault)
    expect(sourceChunkCount()).toBeGreaterThan(0)

    // Slow-path event nodes land under synthetic event-nodes/* paths (no on-disk file).
    await writeEventNodes(db, EVENT_RECORDS, { embed: stubEmbed, rebuildEdges: false })
    expect(eventChunkCount()).toBe(2)
    expect(sidecarCount()).toBe(2)

    // Fast-path re-index: event-nodes/* is NOT in the scanned set, but the guard exempts it.
    indexVaultSync(db, vault)
    expect(eventChunkCount()).toBe(2) // SURVIVED (would be 0 without the guard)
    expect(sidecarCount()).toBe(2)
    expect(sourceChunkCount()).toBeGreaterThan(0) // real source untouched
  })

  it('is NON-VACUOUS: a removed on-disk source file IS cascade-deleted while event nodes survive', async () => {
    vault.write('note.md', 'A real source note that will be deleted from disk to exercise the delete path.')
    indexVaultSync(db, vault)
    await writeEventNodes(db, EVENT_RECORDS, { embed: stubEmbed, rebuildEdges: false })
    expect(sourceChunkCount()).toBeGreaterThan(0)
    expect(eventChunkCount()).toBe(2)

    // Remove the real file from disk, then re-index.
    rmSync(join(rootDir, 'note.md'))
    indexVaultSync(db, vault)

    // Deletion path is genuinely active (proves the guard is non-vacuous)…
    expect(sourceChunkCount()).toBe(0)
    // …yet the synthetic event nodes are still exempted and survive.
    expect(eventChunkCount()).toBe(2)
    expect(sidecarCount()).toBe(2)
  })
})
