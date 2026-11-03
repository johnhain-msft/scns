/**
 * Incremental indexer — scans vault files, detects changes via mtime,
 * chunks changed files, generates embeddings, upserts into SQLite.
 */

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { Vault } from './vault.js'
import { chunkText, type ChunkConfig } from './chunker.js'
import { generateEmbeddingsBatch, serializeEmbedding } from './embeddings.js'
import { rebuildMemoryEdges } from './entities/edges.js'
import { buildSemanticEdges, type SemanticEdgeOptions } from './semantic-edges.js'
import { isLowSignalContent } from './causal-edges.js'
import { EVENT_NODE_PATH_PREFIX } from './db.js'
import { isRetiredRevision, loadActiveRetirementPaths } from './retirement-ledger.js'
import type { GazetteerEntry } from './entities/gazetteer.js'
import {
  isNullFactExtractor,
  MAX_FACT_CHARS,
  type FactSourceChunk,
  type LlmFactExtractor,
} from './fact-extractor-provider.js'
import { logger } from '../shared/logger.js'

/**
 * chunk_index base for DERIVED fact nodes (MAGMA node-model). Source chunks carry small
 * sequential indices from the chunker; fact nodes attach to the SAME file (facts-as-chunks)
 * so they need a disjoint index range to satisfy UNIQUE(file_path, chunk_index). 1e6 is far
 * above any real chunk count, so source/fact indices can never collide.
 */
const FACT_CHUNK_INDEX_BASE = 1_000_000

/**
 * Default passages per extractor call (one ACP spawn) — env `FACT_EXTRACT_BATCH_SIZE`. D3
 * productionized extraction: a real vault has FAR more curated chunks than the old single
 * `MAX_EXTRACT_PASSAGES=60` cap could cover (the rest were silently dropped), so a pass's source
 * chunks are split into deterministic batches and the extractor is called once PER BATCH.
 *
 * The default (8) is EVIDENCE-BASED, not a guess: measured on a /tmp copy of the live vault, one
 * real deny-all `copilot --acp` round-trip takes ~47 s at 6 passages, ~120–142 s at 10–12, and
 * TIMES OUT (>120 s, 0 facts) at 30 — the latency is noisy and grows with prompt size. A modest
 * batch returns reliably within the timeout (vs the plan's a-priori 20–40 guess, which times out).
 *
 * Extraction fuses CROSS-passage relations, so batches are ordered by (file_path, chunk_index): a
 * file's own chunks are ALWAYS contiguous (intra-file fusion is preserved at any N), and
 * alphabetically-adjacent related files cluster, so cross-file fusion survives small N too (the D1
 * depth-2 proof passes at N=3). The whole-pass passage bound is `batchSize × maxBatches`.
 */
export const DEFAULT_FACT_EXTRACT_BATCH_SIZE = 8

/**
 * Default per-pass spawn budget — env `SCNS_EXTRACT_MAX_BATCHES`. At most this many extractor calls
 * (`copilot --acp` spawns) run in ONE index/backfill pass, so a full re-index of a large vault
 * converges over several BOUNDED passes (the missing-only backfill skips already-enriched files)
 * instead of one unbounded run that could spawn hundreds of sessions. Small by design.
 */
export const DEFAULT_FACT_EXTRACT_MAX_BATCHES = 4

function resolveFactBatchSize(opt?: number): number {
  if (typeof opt === 'number' && Number.isFinite(opt) && opt > 0) return Math.floor(opt)
  const env = parseInt(process.env.FACT_EXTRACT_BATCH_SIZE ?? '', 10)
  if (Number.isFinite(env) && env > 0) return env
  return DEFAULT_FACT_EXTRACT_BATCH_SIZE
}

function resolveFactMaxBatches(opt?: number): number {
  if (typeof opt === 'number' && Number.isFinite(opt) && opt > 0) return Math.floor(opt)
  const env = parseInt(process.env.SCNS_EXTRACT_MAX_BATCHES ?? '', 10)
  if (Number.isFinite(env) && env > 0) return env
  return DEFAULT_FACT_EXTRACT_MAX_BATCHES
}

/**
 * File-path prefixes excluded from the SEARCH index (NOT from the vault itself).
 *
 * Daily logs are raw telemetry — file-change / session-hook / learning event lines —
 * that the dream daemon consolidates into the curated tiers (MEMORY.md, weekly/, monthly/).
 * Indexing them floods hybrid search with mechanical event noise (~94% of chunks), so they
 * are excluded here while every curated tier (sessions/, weekly/, monthly/, MEMORY.md,
 * lessons/, USER.md, SOUL.md, negative/) stays searchable. Consolidation is unaffected: it
 * reads daily logs by explicit path / its own listFiles call, not via the index.
 *
 * Files already indexed under an excluded prefix are removed on the next pass (they fall out
 * of the scanned set and are treated as deleted), so no separate prune is needed.
 */
export const DEFAULT_INDEX_EXCLUDE_PREFIXES: readonly string[] = ['daily/']

function isIndexExcluded(path: string, excludePrefixes: readonly string[]): boolean {
  return excludePrefixes.some((prefix) => path.startsWith(prefix))
}

/**
 * Options for the M1.1 deterministic entity/temporal edge layer. DEFAULT-OFF: when
 * `extractEntities` is falsy the indexer behaves byte-identically to today (no entity/edge writes).
 */
export interface EntityIndexOptions {
  /** Recompute deterministic entity + temporal edges after the index pass. Default OFF. */
  readonly extractEntities?: boolean
  /** Override the gazetteer (defaults to the curated SCNS_GAZETTEER). */
  readonly gazetteer?: readonly GazetteerEntry[]
  /**
   * Recompute the deterministic SEMANTIC edge tier (embedding-similarity KNN) after the
   * index pass. Default OFF. Independent of `extractEntities`, but when both run the
   * semantic build is ordered AFTER the entity rebuild (which unscoped-deletes all edges).
   */
  readonly buildSemantic?: boolean
  /** Tuning for the semantic edge build (topN / maxDistance / excludeSameFile). */
  readonly semanticOptions?: SemanticEdgeOptions
  /**
   * Skip CHUNKS that are {@link isLowSignalContent} (stat tables, session digests,
   * symbol-dominated telemetry) from the search index — keeps narrative/event chunks
   * while dropping the ~17% telemetry fragments that flood KNN and FTS. The curated
   * narrative tiers (MEMORY/USER/SOUL/lessons/negative/outcomes) are 0% low-signal, so
   * nothing of value is dropped; sessions/ stat dumps are 100% low-signal. Default OFF
   * (byte-identical behavior); flipped ON in prod once evidence shows no recall regression.
   */
  readonly pruneLowSignal?: boolean
  /**
   * MAGMA node-model (Eq.3 / App C.1): when ON (and a non-null {@link factExtractor} is
   * supplied), each content-changing pass of {@link indexVault} offers its fresh chunks to the
   * extractor, which returns self-contained RELATIONAL fact nodes that are stored as derived
   * chunks under their source file (facts-as-chunks) so the whole proven pipeline (FTS,
   * embeddings, entity/semantic edges, traversal) consumes them directly. A relational node
   * encodes its RELATION ("the place Melanie volunteers, Riverdale, is notable for its pipe
   * organ"), so a buried deep-multi-hop answer becomes query-relevant by its own embedding —
   * the only thing proven to win depth-2 entity chains. Default OFF (byte-identical) and inert
   * unless BOTH `extractFacts` is truthy AND `factExtractor` is non-null. Async only — the
   * sync indexer cannot await an extractor and fact nodes need embeddings to be useful.
   */
  readonly extractFacts?: boolean
  /** Injected fact extractor (defaults to the null extractor ⇒ zero facts). LLM transport-agnostic. */
  readonly factExtractor?: LlmFactExtractor
  /** Passages per extractor spawn. Default {@link DEFAULT_FACT_EXTRACT_BATCH_SIZE} / env FACT_EXTRACT_BATCH_SIZE. */
  readonly factBatchSize?: number
  /** Per-pass spawn budget. Default {@link DEFAULT_FACT_EXTRACT_MAX_BATCHES} / env SCNS_EXTRACT_MAX_BATCHES. */
  readonly factMaxBatches?: number
}

/**
 * Recompute the derived entity/temporal edges after an index pass when enabled. Edges are a pure
 * function of chunk content, so a full rebuild is run on any content-changing pass (`hadWork`) and
 * a single bootstrap rebuild is run the first time the option is enabled on an already-indexed
 * vault (entity catalog still empty). No-op passes after bootstrap skip the (redundant) rebuild.
 * Wrapped in its own transaction — must be called OUTSIDE the chunk-mutation transaction.
 */
function maybeRebuildEntityEdges(
  db: Database.Database,
  options: EntityIndexOptions,
  hadWork: boolean,
): void {
  if (!options.extractEntities) return
  if (!hadWork) {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM memory_entities').get() as { n: number }
    if (existing.n > 0) return
  }
  db.transaction(() => rebuildMemoryEdges(db, options.gazetteer))()
}

/**
 * Recompute the deterministic SEMANTIC edges after an index pass when enabled. MUST be called
 * AFTER {@link maybeRebuildEntityEdges} (which unscoped-deletes `memory_edges`) and AFTER
 * {@link pruneOrphanedEmbeddings} (so the KNN never links a stale embedding). Mirrors the entity
 * gating: rebuild on any content-changing pass, plus a one-shot bootstrap the first time the
 * option is enabled on an already-embedded vault (no semantic edges yet). Its own transaction.
 */
function maybeBuildSemanticEdges(
  db: Database.Database,
  options: EntityIndexOptions,
  hadWork: boolean,
): void {
  if (!options.buildSemantic) return
  if (!hadWork) {
    const existing = db
      .prepare("SELECT COUNT(*) AS n FROM memory_edges WHERE edge_type = 'semantic'")
      .get() as { n: number }
    if (existing.n > 0) return
  }
  db.transaction(() => buildSemanticEdges(db, options.semanticOptions))()
}

export interface IndexStats {
  readonly filesScanned: number
  readonly filesIndexed: number
  readonly filesRemoved: number
  readonly chunksCreated: number
  readonly embeddingsGenerated: number
  /** Orphaned vector embeddings removed this pass (chunk_id no longer in `chunks`). */
  readonly embeddingsPruned: number
  /** Low-signal/telemetry chunks skipped from the index when pruneLowSignal is ON. */
  readonly chunksSkippedLowSignal: number
  /** Derived MAGMA relational fact nodes extracted + stored this pass (subset of chunksCreated). */
  readonly factsExtracted: number
  /** Extractor calls (ACP spawns) made this pass — 0 when extraction is OFF; bounded by the budget. */
  readonly factBatchesRun: number
}

/**
 * One source passage offered to the batched fact extractor, tagged with a stable `key` the caller
 * maps a returned fact back to (the chunkMeta index in the content-change flow, or the db chunk id
 * in the backfill flow). `filePath`/`chunkIndex` drive the deterministic batch ordering.
 */
interface BatchSource {
  readonly key: string
  readonly filePath: string
  readonly chunkIndex: number
  readonly content: string
}

interface BatchedExtractionResult {
  /** Facts grounded in an offered source, keyed by {@link BatchSource.key}. */
  readonly facts: ReadonlyArray<{ key: string; content: string }>
  /** Extractor calls actually made this pass = ACP spawns (≤ budget). */
  readonly batchesRun: number
  /** Total batches the sources split into BEFORE the budget cap (for cost projection). */
  readonly totalBatches: number
  /** Keys of every source actually offered (within the budgeted batches). */
  readonly processedKeys: readonly string[]
}

/**
 * Split `sources` into deterministic (file_path, chunk_index)-ordered batches of `batchSize` and
 * call the extractor once per batch, up to `maxBatches` spawns (the per-pass budget). A single batch
 * failure degrades to "no facts for that batch" (do no harm — a failed extraction never corrupts the
 * index, only skips enrichment). Returned facts are validated to a sourceId offered in that batch.
 */
async function runBatchedExtraction(
  extractor: LlmFactExtractor,
  sources: readonly BatchSource[],
  batchSize: number,
  maxBatches: number,
): Promise<BatchedExtractionResult> {
  const ordered = [...sources].sort((a, b) =>
    a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : a.chunkIndex - b.chunkIndex,
  )
  const batches: BatchSource[][] = []
  for (let i = 0; i < ordered.length; i += batchSize) {
    batches.push(ordered.slice(i, i + batchSize))
  }
  const runnable = Math.min(batches.length, maxBatches)
  const facts: Array<{ key: string; content: string }> = []
  const processedKeys: string[] = []
  let batchesRun = 0
  for (let b = 0; b < runnable; b++) {
    const batch = batches[b]!
    const validKeys = new Set(batch.map((s) => s.key))
    for (const s of batch) processedKeys.push(s.key)
    const chunks: FactSourceChunk[] = batch.map((s) => ({
      id: s.key,
      path: s.filePath,
      content: s.content,
    }))
    let out: readonly { sourceId: string; content: string }[] = []
    try {
      out = await extractor.extract({ chunks })
    } catch (err) {
      logger.warn(
        { err: String(err), batch: b },
        'fact extraction batch threw; continuing with no facts for this batch',
      )
      out = []
    }
    batchesRun++
    for (const f of out) {
      if (!f || !f.content || !validKeys.has(f.sourceId)) continue
      facts.push({ key: f.sourceId, content: f.content })
    }
  }
  return { facts, batchesRun, totalBatches: batches.length, processedKeys }
}

interface StoredFile {
  path: string
  mtime_ms: number
  content_hash: string | null
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Drop files whose CURRENT revision was explicitly retired and not restored.
 *
 * Without this, an index pass that started before a deletion (or a scheduled reconciler racing
 * one) re-inserts chunks for a file the operator just removed, and the retired guidance returns
 * through retrieval. The ledger is keyed by (path, content_hash), so only the exact retired
 * revision is refused — a genuinely new memory written at that path indexes normally.
 *
 * The lookup is cheap: the ledger is usually empty, and a content hash is computed only for the
 * handful of paths that appear in it.
 */
function excludeRetiredRevisions<T extends VaultFileLike>(
  db: Database.Database,
  files: readonly T[],
): readonly T[] {
  const retiredPaths = loadActiveRetirementPaths(db)
  if (retiredPaths.size === 0) return files
  return files.filter((f) => {
    if (!retiredPaths.has(f.path)) return true
    if (!isRetiredRevision(db, f.path, hashContent(f.content))) return true
    logger.debug({ path: f.path }, 'skipping retired memory revision during index pass')
    return false
  })
}

interface VaultFileLike {
  readonly path: string
  readonly content: string
}

/**
 * Run an incremental index pass over the vault.
 * Only re-indexes files whose mtime has changed since last index.
 * Removes DB entries for deleted files.
 */
export async function indexVault(
  db: Database.Database,
  vault: Vault,
  chunkConfig?: Partial<ChunkConfig>,
  excludePrefixes: readonly string[] = DEFAULT_INDEX_EXCLUDE_PREFIXES,
  entityOptions: EntityIndexOptions = {},
): Promise<IndexStats> {
  const stats = {
    filesScanned: 0,
    filesIndexed: 0,
    filesRemoved: 0,
    chunksCreated: 0,
    embeddingsGenerated: 0,
    embeddingsPruned: 0,
    chunksSkippedLowSignal: 0,
    factsExtracted: 0,
    factBatchesRun: 0,
  }

  // 1. Get current vault files (excluding index-excluded prefixes, e.g. daily/, and any
  //    explicitly retired revision — see `excludeRetiredRevisions`).
  const currentFiles = excludeRetiredRevisions(
    db,
    vault.listFiles().filter((f) => !isIndexExcluded(f.path, excludePrefixes)),
  )
  stats.filesScanned = currentFiles.length
  const currentPaths = new Set(currentFiles.map((f) => f.path))

  // 2. Get previously indexed files from DB
  const storedFiles = db
    .prepare('SELECT path, mtime_ms, content_hash FROM vault_files')
    .all() as StoredFile[]
  const storedMap = new Map(storedFiles.map((f) => [f.path, f]))

  // 3. Identify deleted files (removal happens inside the transaction below). WS-1 event nodes live
  //    under synthetic EVENT_NODE_PATH_PREFIX paths with NO on-disk file, so they are never in the
  //    scanned set — guard them out here so the fast ingest path can't cascade-wipe slow-path output.
  const deletedPaths: string[] = []
  for (const stored of storedFiles) {
    if (!currentPaths.has(stored.path) && !stored.path.startsWith(EVENT_NODE_PATH_PREFIX)) {
      deletedPaths.push(stored.path)
    }
  }

  // 4. Find mtime-changed candidates, then gate with content-hash.
  const mtimeCandidates = currentFiles.filter((f) => {
    const stored = storedMap.get(f.path)
    return stored === undefined || stored.mtime_ms !== Math.floor(f.mtimeMs)
  })

  const changedFiles: typeof mtimeCandidates = []
  const mtimeOnlyUpdates: Array<{ path: string; mtimeMs: number; sizeBytes: number }> = []
  for (const f of mtimeCandidates) {
    const stored = storedMap.get(f.path)
    if (!stored || stored.content_hash === null) {
      changedFiles.push(f)
      continue
    }
    const hash = hashContent(f.content)
    if (hash === stored.content_hash) {
      mtimeOnlyUpdates.push({ path: f.path, mtimeMs: f.mtimeMs, sizeBytes: f.sizeBytes })
    } else {
      changedFiles.push(f)
    }
  }

  if (changedFiles.length === 0 && deletedPaths.length === 0 && mtimeOnlyUpdates.length === 0) {
    logger.debug('No changed files, skipping indexing')
    maybeRebuildEntityEdges(db, entityOptions, false)
    stats.embeddingsPruned = pruneOrphanedEmbeddings(db)
    maybeBuildSemanticEdges(db, entityOptions, false)
    return stats
  }

  const touchMtime = db.prepare(
    `UPDATE vault_files SET mtime_ms = ?, size_bytes = ? WHERE path = ?`,
  )

  // Handle mtime-only / delete-only case (no embedding work needed).
  if (changedFiles.length === 0) {
    const deleteFile = db.prepare('DELETE FROM vault_files WHERE path = ?')
    const deleteChunksForFile = db.prepare('DELETE FROM chunks WHERE file_path = ?')
    const deleteEmbsForFile = db.prepare(
      'DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)',
    )
    db.transaction(() => {
      for (const path of deletedPaths) {
        deleteEmbsForFile.run(path)
        deleteChunksForFile.run(path)
        deleteFile.run(path)
        stats.filesRemoved++
      }
      for (const touch of mtimeOnlyUpdates) {
        touchMtime.run(Math.floor(touch.mtimeMs), touch.sizeBytes, touch.path)
      }
    })()
    maybeRebuildEntityEdges(db, entityOptions, true)
    stats.embeddingsPruned = pruneOrphanedEmbeddings(db)
    maybeBuildSemanticEdges(db, entityOptions, true)
    return stats
  }

  // 5. Chunk changed files
  const upsertFile = db.prepare(
    `INSERT INTO vault_files (path, mtime_ms, size_bytes, content_hash)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes, content_hash = excluded.content_hash, indexed_at = datetime('now')`,
  )
  const deleteChunks = db.prepare('DELETE FROM chunks WHERE file_path = ?')
  const insertChunk = db.prepare(
    `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const deleteEmbeddings = db.prepare(
    'DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)',
  )
  const insertEmbedding = db.prepare(
    'INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)',
  )

  // Process: collect chunk data first, then do all DB work atomically
  const allChunkTexts: string[] = []
  const chunkMeta: Array<{
    filePath: string
    chunkIndex: number
    startOffset: number
    endOffset: number
    tokenCount: number
  }> = []
  for (const file of changedFiles) {
    // Chunk the file (pure computation, no DB)
    const chunks = chunkText(file.content, chunkConfig)
    for (const chunk of chunks) {
      if (entityOptions.pruneLowSignal && isLowSignalContent(chunk.content)) {
        stats.chunksSkippedLowSignal++
        continue
      }
      allChunkTexts.push(chunk.content)
      chunkMeta.push({
        filePath: file.path,
        chunkIndex: chunk.index,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        tokenCount: chunk.tokenCount,
      })
    }
    stats.filesIndexed++
  }

  // 5b. MAGMA node-model (Eq.3 / App C.1) — DEFAULT-OFF, async-only. Offer this pass's fresh
  // chunks to the injected extractor and store the returned self-contained relational facts as
  // DERIVED chunks under their source file (facts-as-chunks), so FTS/embeddings/entity+semantic
  // edges/traversal consume them with zero extra plumbing. Inert unless extractFacts is truthy
  // AND a non-null extractor is wired in; any extractor failure degrades to "no facts" (the
  // index is never corrupted, only un-enriched). D3: the pass's chunks are split into deterministic
  // (file_path, chunk_index) batches of factBatchSize — one ACP spawn each — bounded by the
  // per-pass factMaxBatches budget, replacing the old single MAX_EXTRACT_PASSAGES=60 batch.
  if (
    entityOptions.extractFacts &&
    entityOptions.factExtractor &&
    !isNullFactExtractor(entityOptions.factExtractor) &&
    allChunkTexts.length > 0
  ) {
    const sourceCount = allChunkTexts.length
    const sources: BatchSource[] = []
    for (let i = 0; i < sourceCount; i++) {
      sources.push({
        key: String(i),
        filePath: chunkMeta[i]!.filePath,
        chunkIndex: chunkMeta[i]!.chunkIndex,
        content: allChunkTexts[i]!,
      })
    }
    const batchSize = resolveFactBatchSize(entityOptions.factBatchSize)
    const maxBatches = resolveFactMaxBatches(entityOptions.factMaxBatches)
    const { facts, batchesRun, totalBatches } = await runBatchedExtraction(
      entityOptions.factExtractor,
      sources,
      batchSize,
      maxBatches,
    )
    stats.factBatchesRun = batchesRun
    const factOrdinalByFile = new Map<string, number>()
    for (const fact of facts) {
      const srcIdx = Number(fact.key)
      const srcMeta = chunkMeta[srcIdx]
      if (!srcMeta || !fact.content) continue
      const ordinal = factOrdinalByFile.get(srcMeta.filePath) ?? 0
      factOrdinalByFile.set(srcMeta.filePath, ordinal + 1)
      const content = fact.content.slice(0, MAX_FACT_CHARS)
      allChunkTexts.push(content)
      chunkMeta.push({
        filePath: srcMeta.filePath,
        chunkIndex: FACT_CHUNK_INDEX_BASE + ordinal,
        startOffset: 0,
        endOffset: content.length,
        tokenCount: content.split(/\s+/).filter(Boolean).length,
      })
      stats.factsExtracted++
    }
    if (stats.factsExtracted > 0 || batchesRun > 0) {
      logger.info(
        { factsExtracted: stats.factsExtracted, batchesRun, totalBatches, batchSize },
        'Extracted MAGMA relational fact nodes (batched)',
      )
    }
  }

  // 6. Generate embeddings in batch (async, before transaction)
  const embeddings = await generateEmbeddingsBatch(allChunkTexts)
  stats.embeddingsGenerated = embeddings.length

  // 7. Delete old + insert new chunks and embeddings atomically
  const deleteFile = db.prepare('DELETE FROM vault_files WHERE path = ?')
  const runInserts = db.transaction(() => {
    // Remove entries for deleted files
    for (const path of deletedPaths) {
      deleteEmbeddings.run(path)
      deleteChunks.run(path)
      deleteFile.run(path)
      stats.filesRemoved++
    }

    for (const touch of mtimeOnlyUpdates) {
      touchMtime.run(Math.floor(touch.mtimeMs), touch.sizeBytes, touch.path)
    }

    for (const file of changedFiles) {
      deleteEmbeddings.run(file.path)
      deleteChunks.run(file.path)
      const hash = hashContent(file.content)
      upsertFile.run(file.path, Math.floor(file.mtimeMs), file.sizeBytes, hash)
    }

    for (let i = 0; i < chunkMeta.length; i++) {
      const meta = chunkMeta[i]!
      const result = insertChunk.run(
        meta.filePath,
        meta.chunkIndex,
        allChunkTexts[i],
        meta.startOffset,
        meta.endOffset,
        meta.tokenCount,
      )
      const chunkId = result.lastInsertRowid
      const emb = embeddings[i]
      if (emb) {
        insertEmbedding.run(BigInt(chunkId as number), serializeEmbedding(emb.embedding))
      }
      stats.chunksCreated++
    }
  })
  runInserts()

  logger.info({ stats }, `Indexed ${stats.filesIndexed} files, ${stats.chunksCreated} chunks`)

  maybeRebuildEntityEdges(db, entityOptions, true)

  stats.embeddingsPruned = pruneOrphanedEmbeddings(db)

  maybeBuildSemanticEdges(db, entityOptions, true)

  return stats
}

/**
 * Backfill embeddings for chunks that exist in FTS5 but have no vector embedding.
 * This handles the case where indexVaultSync was run first (creates chunks) and
 * indexVault runs later (needs to fill in embeddings without re-chunking).
 */
export async function backfillEmbeddings(db: Database.Database): Promise<number> {
  const chunksWithoutEmb = db
    .prepare(
      `SELECT c.id, c.content FROM chunks c
       WHERE c.id NOT IN (SELECT chunk_id FROM chunk_embeddings)
       ORDER BY c.id`,
    )
    .all() as Array<{ id: number; content: string }>

  const filled = await embedChunkRows(db, chunksWithoutEmb)
  if (filled > 0) {
    logger.info({ filled, total: chunksWithoutEmb.length }, 'Backfilled embeddings')
  }
  return filled
}

/**
 * File-scoped variant of {@link backfillEmbeddings}: embed only the missing
 * chunks of ONE vault file. This is the store-path hook (#49) — a memory
 * stored via `indexVaultSync` has chunks + FTS rows but no vector, and the
 * injected briefing ranks by vector similarity, so it stayed invisible to
 * new sessions until the throttled `memory-reindex` task ran (up to ~20 min).
 * Scoping to the stored file keeps an awaited call O(this store) even when
 * the vault carries a large unembedded backlog — the bulk sweep stays on the
 * scheduled task, where the thermal cooldown can pace it.
 */
export async function backfillEmbeddingsForFile(
  db: Database.Database,
  filePath: string,
): Promise<number> {
  const chunksWithoutEmb = db
    .prepare(
      `SELECT c.id, c.content FROM chunks c
       WHERE c.file_path = ?
         AND c.id NOT IN (SELECT chunk_id FROM chunk_embeddings)
       ORDER BY c.id`,
    )
    .all(filePath) as Array<{ id: number; content: string }>

  const filled = await embedChunkRows(db, chunksWithoutEmb)
  if (filled > 0) {
    logger.info(
      { filePath, filled, total: chunksWithoutEmb.length },
      'Backfilled embeddings for stored file',
    )
  }
  return filled
}

async function embedChunkRows(
  db: Database.Database,
  rows: ReadonlyArray<{ id: number; content: string }>,
): Promise<number> {
  if (rows.length === 0) return 0

  const embeddings = await generateEmbeddingsBatch(rows.map((c) => c.content))

  const insertEmb = db.prepare('INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)')
  // Another writer (the scheduled backfill runner vs the store path — both
  // insert outside the indexing lock) may have embedded a chunk during the
  // await above. vec0 throws on a duplicate rowid, which would roll back the
  // whole batch, so re-check inside the transaction — authoritative, since
  // better-sqlite3 transactions are synchronous and cannot interleave.
  const alreadyEmbedded = db.prepare('SELECT 1 FROM chunk_embeddings WHERE chunk_id = ?')

  let filled = 0
  const runInserts = db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const emb = embeddings[i]
      if (emb && !alreadyEmbedded.get(BigInt(rows[i]!.id))) {
        insertEmb.run(BigInt(rows[i]!.id), serializeEmbedding(emb.embedding))
        filled++
      }
    }
  })
  runInserts()
  return filled
}

/**
 * Remove orphaned vector embeddings — rows in `chunk_embeddings` whose `chunk_id` no longer exists
 * in `chunks`. The sqlite-vec `vec0` table has NO foreign key, so embeddings are never cascade-
 * deleted when their chunk is removed (a `vault_files` delete cascades to `chunks` but never reaches
 * `chunk_embeddings`), and the per-file re-index cleanup only targets embeddings whose chunk is STILL
 * present — so any already-orphaned row is unreachable and accumulates indefinitely. Left unchecked
 * the KNN space fills with stale vectors that displace live chunks from the vector top-K, degrading
 * the production hybrid/vector retrieval base (verified 2026-06-27: a live vault held 4322 orphans
 * vs 209 live chunks; up to 7/10 top-10 vector hits for a real query were orphans dropped on join).
 *
 * This is the symmetric opposite of {@link backfillEmbeddings}: idempotent, runs every index pass,
 * and safe (it can only remove embeddings with no live chunk). Returns the number deleted.
 */
export function pruneOrphanedEmbeddings(db: Database.Database): number {
  const res = db
    .prepare('DELETE FROM chunk_embeddings WHERE chunk_id NOT IN (SELECT id FROM chunks)')
    .run()
  if (res.changes > 0) {
    logger.info({ pruned: res.changes }, 'Pruned orphaned embeddings')
  }
  return res.changes
}

/**
 * MISSING-ONLY backfill eligibility (D3) — count the files that have SOURCE chunks
 * (`chunk_index < FACT_CHUNK_INDEX_BASE`) but NO derived fact nodes yet
 * (`chunk_index >= FACT_CHUNK_INDEX_BASE` absent for that file), and the number of such source
 * chunks. Already-enriched files are excluded ⇒ they cost zero work. Pure read; spawns nothing.
 * Used by `scns reindex-facts --dry-run` to project the full-vault cost without touching an LLM.
 */
export function countFactBackfillEligible(db: Database.Database): {
  filesEligible: number
  chunksEligible: number
} {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS chunks, COUNT(DISTINCT file_path) AS files
         FROM chunks
        WHERE chunk_index < ?
          AND file_path NOT IN (
            SELECT DISTINCT file_path FROM chunks WHERE chunk_index >= ?
          )`,
    )
    .get(FACT_CHUNK_INDEX_BASE, FACT_CHUNK_INDEX_BASE) as { chunks: number; files: number }
  return { filesEligible: row.files, chunksEligible: row.chunks }
}

export interface FactBackfillOptions {
  /** The injected extractor (real ACP in prod, mock in tests). Null/absent ⇒ a no-op pass. */
  readonly factExtractor: LlmFactExtractor
  /** Passages per spawn. Default {@link DEFAULT_FACT_EXTRACT_BATCH_SIZE} / env FACT_EXTRACT_BATCH_SIZE. */
  readonly batchSize?: number
  /** Per-pass spawn budget. Default {@link DEFAULT_FACT_EXTRACT_MAX_BATCHES} / env SCNS_EXTRACT_MAX_BATCHES. */
  readonly maxBatches?: number
  /** Rebuild deterministic entity/temporal edges after inserting facts (D6 live backfill). Default OFF. */
  readonly extractEntities?: boolean
  readonly gazetteer?: readonly GazetteerEntry[]
  /** Rebuild the semantic edge tier after inserting facts. Default OFF. */
  readonly buildSemantic?: boolean
  readonly semanticOptions?: SemanticEdgeOptions
}

export interface FactBackfillStats {
  /** Files with source chunks but ZERO fact nodes BEFORE this pass (the missing-only set). */
  readonly filesEligible: number
  /** Source chunks across all eligible files (the work the budget converges over). */
  readonly chunksEligible: number
  /** Distinct eligible files actually included in the budgeted batches this pass. */
  readonly filesOffered: number
  /** Extractor calls (ACP spawns) made this pass — ≤ {@link FactBackfillOptions.maxBatches}. */
  readonly batchesRun: number
  /** Total batches the eligible chunks split into BEFORE the budget cap (for cost projection). */
  readonly totalBatches: number
  /** Derived fact nodes inserted this pass. */
  readonly factsExtracted: number
  readonly batchSize: number
  readonly budget: number
}

/**
 * MISSING-ONLY fact backfill (D3) — the forced re-extraction trigger D6 uses to enrich an ALREADY
 * indexed vault WITHOUT a full re-chunk/re-embed. `indexVault` is incremental, so on the already-
 * indexed live vault flipping `SCNS_EXTRACT_FACTS` extracts NOTHING until files change; this reads
 * EXISTING source chunks straight from the db and adds fact nodes for files that have none yet.
 *
 * Convergence: each pass offers only files with no fact nodes, batched + capped by the spawn budget,
 * so a large vault enriches over several BOUNDED passes and already-enriched files cost 0 spawns. It
 * never re-chunks or re-embeds source chunks — it only INSERTS derived fact chunks (+ their vectors)
 * and, when requested, rebuilds the entity/semantic edges so traversal can consume the new nodes.
 * Do-no-harm: any extractor/batch failure simply yields fewer (or zero) facts; the index is intact.
 */
export async function backfillFactNodes(
  db: Database.Database,
  options: FactBackfillOptions,
): Promise<FactBackfillStats> {
  const batchSize = resolveFactBatchSize(options.batchSize)
  const budget = resolveFactMaxBatches(options.maxBatches)
  const extractor = options.factExtractor
  const { filesEligible, chunksEligible } = countFactBackfillEligible(db)

  const base: FactBackfillStats = {
    filesEligible,
    chunksEligible,
    filesOffered: 0,
    batchesRun: 0,
    totalBatches: 0,
    factsExtracted: 0,
    batchSize,
    budget,
  }
  if (!extractor || isNullFactExtractor(extractor) || chunksEligible === 0) {
    return base
  }

  // Read eligible SOURCE chunks (deterministic order). The db chunk id is the stable mapping key.
  const eligible = db
    .prepare(
      `SELECT id, file_path, chunk_index, content
         FROM chunks
        WHERE chunk_index < ?
          AND file_path NOT IN (
            SELECT DISTINCT file_path FROM chunks WHERE chunk_index >= ?
          )
        ORDER BY file_path, chunk_index`,
    )
    .all(FACT_CHUNK_INDEX_BASE, FACT_CHUNK_INDEX_BASE) as Array<{
    id: number
    file_path: string
    chunk_index: number
    content: string
  }>

  const fileByKey = new Map<string, string>()
  const sources: BatchSource[] = eligible.map((c) => {
    fileByKey.set(String(c.id), c.file_path)
    return {
      key: String(c.id),
      filePath: c.file_path,
      chunkIndex: c.chunk_index,
      content: c.content,
    }
  })

  const { facts, batchesRun, totalBatches, processedKeys } = await runBatchedExtraction(
    extractor,
    sources,
    batchSize,
    budget,
  )

  const offeredFiles = new Set<string>()
  for (const k of processedKeys) {
    const fp = fileByKey.get(k)
    if (fp) offeredFiles.add(fp)
  }

  // Map facts → source file_path, assign per-file ordinals (eligible files have 0 facts ⇒ start 0).
  const factOrdinalByFile = new Map<string, number>()
  const toInsert: Array<{ filePath: string; chunkIndex: number; content: string }> = []
  for (const f of facts) {
    const filePath = fileByKey.get(f.key)
    if (!filePath || !f.content) continue
    const ordinal = factOrdinalByFile.get(filePath) ?? 0
    factOrdinalByFile.set(filePath, ordinal + 1)
    toInsert.push({
      filePath,
      chunkIndex: FACT_CHUNK_INDEX_BASE + ordinal,
      content: f.content.slice(0, MAX_FACT_CHARS),
    })
  }

  let factsExtracted = 0
  if (toInsert.length > 0) {
    const embeddings = await generateEmbeddingsBatch(toInsert.map((t) => t.content))
    const insertChunk = db.prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const insertEmbedding = db.prepare(
      'INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)',
    )
    db.transaction(() => {
      for (let i = 0; i < toInsert.length; i++) {
        const t = toInsert[i]!
        const res = insertChunk.run(
          t.filePath,
          t.chunkIndex,
          t.content,
          0,
          t.content.length,
          t.content.split(/\s+/).filter(Boolean).length,
        )
        const emb = embeddings[i]
        if (emb) {
          insertEmbedding.run(
            BigInt(res.lastInsertRowid as number),
            serializeEmbedding(emb.embedding),
          )
        }
        factsExtracted++
      }
    })()
  }

  // Rebuild edges so traversal can consume the new fact nodes (D6 live backfill). Mirrors indexVault
  // ordering: entity rebuild (unscoped delete) → orphan prune → semantic build.
  const edgeOpts: EntityIndexOptions = {
    extractEntities: options.extractEntities,
    ...(options.gazetteer ? { gazetteer: options.gazetteer } : {}),
    buildSemantic: options.buildSemantic,
    ...(options.semanticOptions ? { semanticOptions: options.semanticOptions } : {}),
  }
  const hadWork = factsExtracted > 0
  maybeRebuildEntityEdges(db, edgeOpts, hadWork)
  pruneOrphanedEmbeddings(db)
  maybeBuildSemanticEdges(db, edgeOpts, hadWork)

  if (factsExtracted > 0 || batchesRun > 0) {
    logger.info(
      {
        factsExtracted,
        batchesRun,
        totalBatches,
        filesOffered: offeredFiles.size,
        batchSize,
        budget,
      },
      'MAGMA missing-only fact backfill pass',
    )
  }

  return {
    filesEligible,
    chunksEligible,
    filesOffered: offeredFiles.size,
    batchesRun,
    totalBatches,
    factsExtracted,
    batchSize,
    budget,
  }
}

/**
 * Index vault without embeddings (for testing without fastembed).
 * Chunks files and inserts into FTS5 only.
 */
export function indexVaultSync(
  db: Database.Database,
  vault: Vault,
  chunkConfig?: Partial<ChunkConfig>,
  excludePrefixes: readonly string[] = DEFAULT_INDEX_EXCLUDE_PREFIXES,
  entityOptions: EntityIndexOptions = {},
): Omit<
  IndexStats,
  'embeddingsGenerated' | 'embeddingsPruned' | 'factsExtracted' | 'factBatchesRun'
> {
  const stats = {
    filesScanned: 0,
    filesIndexed: 0,
    filesRemoved: 0,
    chunksCreated: 0,
    chunksSkippedLowSignal: 0,
  }

  const currentFiles = excludeRetiredRevisions(
    db,
    vault.listFiles().filter((f) => !isIndexExcluded(f.path, excludePrefixes)),
  )
  stats.filesScanned = currentFiles.length
  const currentPaths = new Set(currentFiles.map((f) => f.path))

  const storedFiles = db
    .prepare('SELECT path, mtime_ms, content_hash FROM vault_files')
    .all() as StoredFile[]
  const storedMap = new Map(storedFiles.map((f) => [f.path, f]))

  // WS-1 event nodes (synthetic EVENT_NODE_PATH_PREFIX paths) have no on-disk file — guard them
  // out of the deleted set so the sync indexer never cascade-wipes slow-path event-node chunks.
  const deletedPaths: string[] = []
  for (const stored of storedFiles) {
    if (!currentPaths.has(stored.path) && !stored.path.startsWith(EVENT_NODE_PATH_PREFIX)) {
      deletedPaths.push(stored.path)
    }
  }

  // mtime-change candidates — but content-hash gating below will skip
  // files whose content is actually unchanged (prevents reindex churn
  // when writers touch files without modifying content).
  const mtimeCandidates = currentFiles.filter((f) => {
    const stored = storedMap.get(f.path)
    return stored === undefined || stored.mtime_ms !== Math.floor(f.mtimeMs)
  })

  // Split into: truly-changed (content hash differs) and mtime-only.
  const changedFiles: typeof mtimeCandidates = []
  const mtimeOnlyUpdates: Array<{ path: string; mtimeMs: number; sizeBytes: number }> = []
  for (const f of mtimeCandidates) {
    const stored = storedMap.get(f.path)
    if (!stored || stored.content_hash === null) {
      changedFiles.push(f)
      continue
    }
    const hash = hashContent(f.content)
    if (hash === stored.content_hash) {
      mtimeOnlyUpdates.push({ path: f.path, mtimeMs: f.mtimeMs, sizeBytes: f.sizeBytes })
    } else {
      changedFiles.push(f)
    }
  }

  if (changedFiles.length === 0 && deletedPaths.length === 0 && mtimeOnlyUpdates.length === 0) {
    maybeRebuildEntityEdges(db, entityOptions, false)
    return stats
  }

  const deleteFile = db.prepare('DELETE FROM vault_files WHERE path = ?')
  const upsertFile = db.prepare(
    `INSERT INTO vault_files (path, mtime_ms, size_bytes, content_hash)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes, content_hash = excluded.content_hash, indexed_at = datetime('now')`,
  )
  const touchMtime = db.prepare(
    `UPDATE vault_files SET mtime_ms = ?, size_bytes = ? WHERE path = ?`,
  )
  const deleteChunks = db.prepare('DELETE FROM chunks WHERE file_path = ?')
  const deleteEmbeddings = db.prepare(
    'DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)',
  )
  const insertChunk = db.prepare(
    `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )

  const runMutations = db.transaction(() => {
    for (const path of deletedPaths) {
      deleteEmbeddings.run(path)
      deleteChunks.run(path)
      deleteFile.run(path)
      stats.filesRemoved++
    }

    for (const touch of mtimeOnlyUpdates) {
      touchMtime.run(Math.floor(touch.mtimeMs), touch.sizeBytes, touch.path)
    }

    for (const file of changedFiles) {
      deleteEmbeddings.run(file.path)
      deleteChunks.run(file.path)
      const hash = hashContent(file.content)
      upsertFile.run(file.path, Math.floor(file.mtimeMs), file.sizeBytes, hash)

      const chunks = chunkText(file.content, chunkConfig)
      for (const chunk of chunks) {
        if (entityOptions.pruneLowSignal && isLowSignalContent(chunk.content)) {
          stats.chunksSkippedLowSignal++
          continue
        }
        insertChunk.run(
          file.path,
          chunk.index,
          chunk.content,
          chunk.startOffset,
          chunk.endOffset,
          chunk.tokenCount,
        )
        stats.chunksCreated++
      }
      stats.filesIndexed++
    }
  })
  runMutations()

  if (mtimeOnlyUpdates.length > 0 || changedFiles.length > 0 || deletedPaths.length > 0) {
    logger.debug(
      {
        changed: changedFiles.length,
        mtimeOnly: mtimeOnlyUpdates.length,
        removed: deletedPaths.length,
      },
      'indexVaultSync pass',
    )
  }

  maybeRebuildEntityEdges(db, entityOptions, true)

  return stats
}
