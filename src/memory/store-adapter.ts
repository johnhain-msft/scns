/**
 * The extension's `scns_memory_store` write path (#49).
 *
 * `indexVaultSync` writes chunks + FTS rows but cannot await the embedding
 * worker, and the injected briefing ranks by VECTOR similarity — so without
 * the awaited backfill a fresh memory was keyword-searchable (which masked
 * the gap) yet unbriefable until the throttled `memory-reindex` task ran,
 * up to ~20 minutes later. Awaiting the file-scoped backfill makes the
 * contract simple: if it stored, it's briefable.
 *
 * Degrades safely: an embedding failure must not turn a successful store
 * into an error. The memory is still stored and keyword-searchable, and the
 * scheduled re-index embeds it later — exactly the pre-fix behavior.
 * (One pre-existing exception to "stored ⇒ briefable": a store the indexer
 * classifies as low-signal is pruned to zero chunks and was never briefable.)
 */
import { posix } from 'node:path'
import type Database from 'better-sqlite3'
import type { Vault } from './vault.js'
import { backfillEmbeddingsForFile } from './indexer.js'
import { logger } from '../shared/logger.js'

export interface MemoryStoreResult {
  readonly stored: boolean
  readonly key: string
}

export interface MemoryStoreDeps {
  readonly db: Database.Database
  readonly vault: Vault
  /** The broker's configured sync indexer (carries its entity-index options). */
  readonly indexVaultSync: (db: Database.Database, vault: Vault) => unknown
}

export function createMemoryStore(deps: MemoryStoreDeps): {
  store: (key: string, value: string) => Promise<MemoryStoreResult>
} {
  return {
    store: async (key: string, value: string): Promise<MemoryStoreResult> => {
      // Canonicalize BEFORE writing: the indexer records file_path as the
      // vault-relative POSIX path from listFiles(), so a non-canonical key
      // (`.\note.md`, `sub\note.md`, `a//b.md`) would write + index fine but
      // make the file-scoped backfill below match zero rows — silently
      // reopening the #49 gap. Backslash keys are a real shape on the
      // native-Windows work machine.
      const canonicalKey = posix.normalize(key.replace(/\\/g, '/'))
      deps.vault.write(canonicalKey, value)
      // Re-index after store so search sees new content immediately
      deps.indexVaultSync(deps.db, deps.vault)
      try {
        await backfillEmbeddingsForFile(deps.db, canonicalKey)
      } catch (err) {
        logger.warn(
          { err, key: canonicalKey },
          'post-store embedding backfill failed — memory is stored and keyword-searchable, briefable after the next scheduled re-index',
        )
      }
      return { stored: true, key: canonicalKey }
    },
  }
}
