/**
 * Shared memory-deletion primitive (#71) — the ONE operation that removes or revises a
 * canonical vault record and reconciles every active representation of it: the source
 * Markdown, the searchable index (vault_files / chunks / chunks_fts / memory_edges /
 * chunk_embeddings), and the managed `.github/copilot-instructions.md` block.
 *
 * Deleting one representation is not deletion — these tests pin all of them, plus the
 * refusals (path escape, identity mismatch, stale plan) and the recovery/partial-failure
 * contract that separates a recoverable RETIRE from an unrecoverable HARD-DELETE.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { openMemoryDb, closeMemoryDb, EVENT_CHUNK_INDEX_BASE } from '../../../src/memory/db.js'
import { createVault, type Vault } from '../../../src/memory/vault.js'
import { indexVaultSync } from '../../../src/memory/indexer.js'
import { BLOCK_START, BLOCK_END } from '../../../src/memory/negative-memory-applicator.js'
import {
  previewMemoryDeletion,
  applyMemoryDeletion,
  restoreRetiredMemory,
  listRetirements,
  type MemoryDeletionPlan,
  type ProjectMemoryIdentity,
} from '../../../src/memory/memory-deletion.js'

describe('memory-deletion (shared #71 primitive)', () => {
  let tmpDir: string
  let vaultRoot: string
  let projectRoot: string
  let vault: Vault
  let db: Database.Database

  const IDENTITY: ProjectMemoryIdentity = {
    projectId: 'proj-alpha',
    projectRoot: '',
    instanceId: 'inst-1',
    vaultRoot: '',
    dbPath: ':memory:',
  }

  function identity(): ProjectMemoryIdentity {
    return { ...IDENTITY, projectRoot, vaultRoot }
  }

  function seedNegative(id: string, rule: string, body?: string, extra = ''): string {
    const content = `---
id: ${id}
dontRule: ${rule}
category: correction
target: general
confidence: 0.9
source: copilot-tool
targetApplied: true
createdAt: 2026-09-01T00:00:00.000Z
promptOrigin: human
${extra}---
${body ?? rule}
`
    vault.write(`negative/${id}.md`, content)
    return `negative/${id}.md`
  }

  function instructionsPath(): string {
    return join(projectRoot, '.github', 'copilot-instructions.md')
  }

  function writeInstructions(
    rules: readonly string[],
    preamble = '# Project rules\n\nKeep me.\n\n',
  ) {
    const block =
      rules.length === 0
        ? `${BLOCK_START}\n${BLOCK_END}`
        : `${BLOCK_START}\n## Things to AVOID (learned from experience)\n\n${rules
            .map((r) => `- ${r}`)
            .join('\n')}\n${BLOCK_END}`
    mkdirSync(join(projectRoot, '.github'), { recursive: true })
    writeFileSync(instructionsPath(), `${preamble}${block}\n\nTrailing user prose.\n`, 'utf-8')
  }

  function indexFootprint(path: string) {
    const file = db.prepare('SELECT COUNT(*) n FROM vault_files WHERE path = ?').get(path) as {
      n: number
    }
    const chunks = db.prepare('SELECT COUNT(*) n FROM chunks WHERE file_path = ?').get(path) as {
      n: number
    }
    const fts = db
      .prepare(
        'SELECT COUNT(*) n FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)',
      )
      .get(path) as { n: number }
    const edges = db
      .prepare(
        'SELECT COUNT(*) n FROM memory_edges WHERE src_chunk IN (SELECT id FROM chunks WHERE file_path = ?)',
      )
      .get(path) as { n: number }
    const embeddings = db
      .prepare(
        'SELECT COUNT(*) n FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)',
      )
      .get(path) as { n: number }
    return { file: file.n, chunks: chunks.n, fts: fts.n, edges: edges.n, embeddings: embeddings.n }
  }

  /** Give every chunk of a path a fake embedding + edge so cleanup has something to remove. */
  function decorateIndex(path: string): void {
    const ids = db.prepare('SELECT id FROM chunks WHERE file_path = ?').all(path) as Array<{
      id: number
    }>
    const entity = db
      .prepare(
        "INSERT INTO memory_entities (name, kind) VALUES (?, 'concept') ON CONFLICT(name) DO UPDATE SET kind=excluded.kind RETURNING id",
      )
      .get(`ent-${path}`) as { id: number }
    const vec = new Float32Array(384).fill(0.01)
    for (const { id } of ids) {
      db.prepare('INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)').run(
        BigInt(id),
        Buffer.from(vec.buffer),
      )
      db.prepare(
        "INSERT INTO memory_edges (src_chunk, edge_type, dst_entity, source) VALUES (?, 'entity', ?, 'gazetteer')",
      ).run(id, entity.id)
    }
  }

  function ftsHits(term: string): number {
    const row = db
      .prepare('SELECT COUNT(*) n FROM chunks_fts WHERE chunks_fts MATCH ?')
      .get(term) as { n: number }
    return row.n
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scns-mem-del-'))
    vaultRoot = join(tmpDir, 'vault')
    projectRoot = join(tmpDir, 'project')
    mkdirSync(vaultRoot, { recursive: true })
    mkdirSync(projectRoot, { recursive: true })
    vault = createVault({ rootDir: vaultRoot })
    db = openMemoryDb(':memory:')
  })

  afterEach(() => {
    closeMemoryDb(db)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Preview ────────────────────────────────────────────────────────────────

  it('previews the full footprint of a record: source, index rows and managed rule', () => {
    const path = seedNegative(
      'm1',
      'Never claim tests pass without the row',
      'Never claim tests pass without the row. Extra context about the incident.',
    )
    seedNegative('m2', 'Verify output content, not just HTTP status codes')
    indexVaultSync(db, vault)
    decorateIndex(path)
    writeInstructions([
      'Never claim tests pass without the row',
      'Verify output content, not just HTTP status codes',
    ])

    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path }],
      mode: 'retire',
    })

    expect(plan.kind).toBe('scns-memory-deletion-plan')
    expect(plan.items).toHaveLength(1)
    const item = plan.items[0]!
    expect(item.path).toBe(path)
    expect(item.memoryId).toBe('m1')
    expect(item.sourceExists).toBe(true)
    expect(item.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(item.index.fileRow).toBe(true)
    expect(item.index.chunkCount).toBeGreaterThan(0)
    expect(item.index.embeddingCount).toBe(item.index.chunkCount)
    expect(item.index.edgeCount).toBe(item.index.chunkCount)
    expect(item.managedRules.map((r) => r.text)).toContain('Never claim tests pass without the row')
    // The OTHER memory's rule must not be swept into this plan.
    expect(plan.managedBlock.removedRules).toEqual(['Never claim tests pass without the row'])
    expect(plan.managedBlock.removedRules).not.toContain(
      'Verify output content, not just HTTP status codes',
    )
  })

  it('reports an absent instruction file without creating it', () => {
    const path = seedNegative('m1', 'Some rule')
    indexVaultSync(db, vault)

    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path }],
      mode: 'retire',
    })

    expect(plan.managedBlock.exists).toBe(false)
    expect(plan.managedBlock.blockPresent).toBe(false)
    expect(existsSync(instructionsPath())).toBe(false)
  })

  it('refuses a path that escapes the vault root', () => {
    expect(() =>
      previewMemoryDeletion({
        vault,
        db,
        identity: identity(),
        targets: [{ path: '../../etc/passwd' }],
        mode: 'hard-delete',
      }),
    ).toThrow(/traversal|outside/i)
  })

  it('marks an absent path as a no-op rather than failing', () => {
    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path: 'negative/does-not-exist.md' }],
      mode: 'hard-delete',
    })
    expect(plan.items[0]!.sourceExists).toBe(false)
    expect(plan.warnings.join(' ')).toMatch(/does-not-exist/)
  })

  // ── Apply: coherent removal ───────────────────────────────────────────────

  it('removes source, every index representation and the managed bullet — leaving controls intact', () => {
    const gone = seedNegative(
      'm1',
      'Wait for the other session before merging',
      'Wait for the other session before merging. Coordination note with distinctiveunicorn token.',
    )
    const kept = seedNegative(
      'm2',
      'Verify output content, not just HTTP status codes',
      'Verify output content, not just HTTP status codes. Control memory with distinctivepegasus token.',
    )
    indexVaultSync(db, vault)
    decorateIndex(gone)
    decorateIndex(kept)
    writeInstructions([
      'Wait for the other session before merging',
      'Verify output content, not just HTTP status codes',
    ])

    expect(ftsHits('distinctiveunicorn')).toBeGreaterThan(0)
    expect(ftsHits('distinctivepegasus')).toBeGreaterThan(0)

    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path: gone }],
      mode: 'retire',
    })
    const result = applyMemoryDeletion({ vault, db, identity: identity(), plan })

    expect(result.refused).toBeNull()
    expect(result.applied).toBe(true)
    expect(result.partial).toBe(false)

    // Source gone
    expect(vault.read(gone)).toBeNull()
    // Index fully reconciled — zero residual rows
    expect(indexFootprint(gone)).toEqual({ file: 0, chunks: 0, fts: 0, edges: 0, embeddings: 0 })
    expect(ftsHits('distinctiveunicorn')).toBe(0)

    // Positive controls survive untouched
    expect(vault.read(kept)).not.toBeNull()
    const keptFootprint = indexFootprint(kept)
    expect(keptFootprint.chunks).toBeGreaterThan(0)
    expect(keptFootprint.embeddings).toBe(keptFootprint.chunks)
    expect(keptFootprint.edges).toBe(keptFootprint.chunks)
    expect(ftsHits('distinctivepegasus')).toBeGreaterThan(0)

    // Managed block: only the approved bullet disappears; user prose preserved byte-for-byte
    const instructions = readFileSync(instructionsPath(), 'utf-8')
    expect(instructions).not.toContain('Wait for the other session before merging')
    expect(instructions).toContain('Verify output content, not just HTTP status codes')
    expect(instructions).toContain('# Project rules')
    expect(instructions).toContain('Trailing user prose.')
    expect(result.managedBlock.status).toBe('ok')
    expect(result.managedBlock.rulesRemoved).toBe(1)
  })

  it('does not resurrect a removed memory on the next index pass', () => {
    const gone = seedNegative(
      'm1',
      'Ephemeral coordination rule',
      'Ephemeral coordination rule with distinctiveunicorn token.',
    )
    seedNegative('m2', 'Durable lesson')
    indexVaultSync(db, vault)

    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path: gone }],
      mode: 'retire',
    })
    applyMemoryDeletion({ vault, db, identity: identity(), plan })

    // A later reconciliation pass (the scheduled memory-reindex) must not bring it back.
    indexVaultSync(db, vault)
    expect(indexFootprint(gone)).toEqual({ file: 0, chunks: 0, fts: 0, edges: 0, embeddings: 0 })
    expect(ftsHits('distinctiveunicorn')).toBe(0)
    expect(indexFootprint('negative/m2.md').chunks).toBeGreaterThan(0)
  })

  it('preserves synthetic event-node rows that have no on-disk file', () => {
    const gone = seedNegative('m1', 'Rule to remove')
    indexVaultSync(db, vault)
    db.prepare(
      'INSERT INTO vault_files (path, mtime_ms, size_bytes, content_hash) VALUES (?, 0, 0, ?)',
    ).run('event-nodes/synthetic', 'hash')
    db.prepare(
      'INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count) VALUES (?, ?, ?, 0, 1, 1)',
    ).run('event-nodes/synthetic', EVENT_CHUNK_INDEX_BASE, 'synthetic event node')

    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path: gone }],
      mode: 'hard-delete',
    })
    applyMemoryDeletion({ vault, db, identity: identity(), plan })

    expect(indexFootprint('event-nodes/synthetic').chunks).toBe(1)
  })

  // ── Refusals ──────────────────────────────────────────────────────────────

  it('refuses a plan built for a different project', () => {
    const path = seedNegative('m1', 'Rule')
    indexVaultSync(db, vault)
    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path }],
      mode: 'retire',
    })
    const foreign: MemoryDeletionPlan = {
      ...plan,
      project: { ...plan.project, projectId: 'some-other-project' },
    }

    const result = applyMemoryDeletion({ vault, db, identity: identity(), plan: foreign })
    expect(result.refused).toMatch(/project/i)
    expect(result.applied).toBe(false)
    expect(vault.read(path)).not.toBeNull()
  })

  it('refuses a stale item whose source changed after the preview', () => {
    const path = seedNegative('m1', 'Original rule')
    indexVaultSync(db, vault)
    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path }],
      mode: 'retire',
    })

    // Someone edits the memory between review and apply.
    seedNegative('m1', 'Original rule', 'Body was edited after the plan was reviewed.')

    const result = applyMemoryDeletion({ vault, db, identity: identity(), plan })
    expect(result.applied).toBe(false)
    expect(result.items[0]!.source).toBe('failed')
    expect(result.errors.join(' ')).toMatch(/changed|stale/i)
    expect(vault.read(path)).not.toBeNull()
  })

  it('refuses when the instruction file changed after the preview', () => {
    const path = seedNegative('m1', 'Rule one')
    indexVaultSync(db, vault)
    writeInstructions(['Rule one', 'Rule two'])
    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path }],
      mode: 'retire',
    })

    writeFileSync(instructionsPath(), `${readFileSync(instructionsPath(), 'utf-8')}\nuser edit\n`)

    const result = applyMemoryDeletion({ vault, db, identity: identity(), plan })
    expect(result.managedBlock.status).toBe('failed')
    expect(result.partial || result.refused !== null).toBe(true)
    // The user's edit is never clobbered.
    expect(readFileSync(instructionsPath(), 'utf-8')).toContain('user edit')
  })

  it('refuses to delete a pinned memory unless the plan explicitly overrides', () => {
    const path = seedNegative('m1', 'Pinned durable lesson', undefined, 'pinned: true\n')
    indexVaultSync(db, vault)

    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path }],
      mode: 'retire',
    })
    expect(plan.items[0]!.pinned).toBe(true)
    expect(plan.warnings.join(' ')).toMatch(/pinned/i)

    const result = applyMemoryDeletion({ vault, db, identity: identity(), plan })
    expect(result.items[0]!.source).toBe('skipped')
    expect(result.items[0]!.satisfied).toBe(false)
    // Protecting a pinned memory is not success — the reviewed work did not happen.
    expect(result.applied).toBe(false)
    expect(vault.read(path)).not.toBeNull()

    const forced = applyMemoryDeletion({
      vault,
      db,
      identity: identity(),
      plan,
      allowPinned: true,
    })
    expect(forced.items[0]!.source).toBe('ok')
    expect(forced.applied).toBe(true)
    expect(vault.read(path)).toBeNull()
  })

  // ── Revise (mixed records) ────────────────────────────────────────────────

  it('revises a mixed record so the obsolete clause leaves source, index and managed block', () => {
    const path = seedNegative(
      'm1',
      'Use the hub-and-spoke network and do not implement in this handoff session',
      'Use the hub-and-spoke network and do not implement in this handoff session. The obsoleteclause token is temporary; the durableclause token is a lasting requirement.',
    )
    indexVaultSync(db, vault)
    writeInstructions([
      'Use the hub-and-spoke network and do not implement in this handoff session',
    ])

    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [
        {
          path,
          action: 'revise',
          revisedRule: 'Use the hub-and-spoke network',
          revisedBody:
            'Use the hub-and-spoke network. The durableclause token is a lasting requirement.',
        },
      ],
      mode: 'retire',
    })
    expect(plan.items[0]!.action).toBe('revise')
    expect(plan.managedBlock.revisedRules[0]).toEqual({
      from: 'Use the hub-and-spoke network and do not implement in this handoff session',
      to: 'Use the hub-and-spoke network',
    })

    const result = applyMemoryDeletion({ vault, db, identity: identity(), plan })
    expect(result.applied).toBe(true)

    const after = vault.read(path)
    expect(after).not.toBeNull()
    expect(after!.content).toContain('dontRule: Use the hub-and-spoke network\n')
    expect(after!.content).toContain('durableclause')
    expect(after!.content).not.toContain('obsoleteclause')

    // The index must stop presenting the obsolete clause as current guidance.
    expect(ftsHits('obsoleteclause')).toBe(0)
    expect(ftsHits('durableclause')).toBeGreaterThan(0)

    const instructions = readFileSync(instructionsPath(), 'utf-8')
    expect(instructions).toContain('- Use the hub-and-spoke network\n')
    expect(instructions).not.toContain('do not implement in this handoff session')
  })

  // ── Managed-block edge cases ──────────────────────────────────────────────

  it('keeps a bullet that is still backed by another surviving record (duplicate text)', () => {
    const gone = seedNegative('m1', 'Always verify before claiming done')
    seedNegative('m2', 'Always verify before claiming done')
    indexVaultSync(db, vault)
    writeInstructions(['Always verify before claiming done'])

    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path: gone }],
      mode: 'retire',
    })
    expect(plan.managedBlock.removedRules).toEqual([])

    applyMemoryDeletion({ vault, db, identity: identity(), plan })
    expect(readFileSync(instructionsPath(), 'utf-8')).toContain(
      '- Always verify before claiming done',
    )
  })

  it('leaves unmatched legacy bullets alone and reports them', () => {
    const gone = seedNegative('m1', 'Backed rule')
    indexVaultSync(db, vault)
    writeInstructions(['Backed rule', 'Legacy bullet with no backing record'])

    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path: gone }],
      mode: 'retire',
    })
    expect(plan.managedBlock.unmatchedRules).toContain('Legacy bullet with no backing record')

    applyMemoryDeletion({ vault, db, identity: identity(), plan })
    const instructions = readFileSync(instructionsPath(), 'utf-8')
    expect(instructions).toContain('- Legacy bullet with no backing record')
    expect(instructions).not.toContain('- Backed rule')
  })

  it('can remove the last rule, leaving an empty managed block and the file intact', () => {
    const gone = seedNegative('m1', 'The only rule')
    indexVaultSync(db, vault)
    writeInstructions(['The only rule'])

    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path: gone }],
      mode: 'retire',
    })
    const result = applyMemoryDeletion({ vault, db, identity: identity(), plan })
    expect(result.managedBlock.status).toBe('ok')

    const instructions = readFileSync(instructionsPath(), 'utf-8')
    expect(instructions).toContain(BLOCK_START)
    expect(instructions).toContain(BLOCK_END)
    expect(instructions).not.toContain('- The only rule')
    expect(instructions).toContain('# Project rules')
    expect(instructions).toContain('Trailing user prose.')
  })

  // ── Recovery / idempotence ────────────────────────────────────────────────

  it('writes a recoverable archive record for retire and restores it exactly', () => {
    const path = seedNegative('m1', 'Retire me', 'Retire me. Body with distinctiveunicorn token.')
    indexVaultSync(db, vault)
    const before = vault.read(path)!.content

    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path }],
      mode: 'retire',
    })
    const result = applyMemoryDeletion({ vault, db, identity: identity(), plan })
    expect(result.recoveryRef).toBeTruthy()
    expect(result.items[0]!.recoverable).toBe(true)

    // The recovery copy is NOT an active memory: excluded from listing and index.
    expect(vault.listFiles().some((f) => f.path === path)).toBe(false)
    indexVaultSync(db, vault)
    expect(ftsHits('distinctiveunicorn')).toBe(0)

    const restored = restoreRetiredMemory({ vault, db, identity: identity(), path })
    expect(restored.restored).toBe(true)
    expect(vault.read(path)!.content).toBe(before)
    // A restore revives the RECORD; the managed bullet is re-projected by the applicator.
    expect(restored.managedBlockNote).toMatch(/application pass/i)

    // Restoring twice is not a second recovery — it says so rather than reporting success.
    const again = restoreRetiredMemory({ vault, db, identity: identity(), path })
    expect(again.restored).toBe(false)
    expect(again.reason).toMatch(/already restored/i)
  })

  it('reports restored chunks as pending embedding backfill while FTS is already current', () => {
    const path = seedNegative('m1', 'Retire me', 'Retire me. Body with vectorlessgriffin token.')
    indexVaultSync(db, vault)
    // The record HAD vectors before retirement, so the post-restore zero is meaningful.
    decorateIndex(path)
    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path }],
      mode: 'retire',
    })
    applyMemoryDeletion({ vault, db, identity: identity(), plan })

    const restored = restoreRetiredMemory({ vault, db, identity: identity(), path })
    expect(restored.restored).toBe(true)

    // The reindex is keyword-current but vectorless — and the result must say so.
    const footprint = indexFootprint(path)
    expect(footprint.fts).toBeGreaterThan(0)
    expect(footprint.embeddings).toBe(0)
    expect(restored.embeddingsPendingBackfill).toBeGreaterThan(0)
    expect(restored.embeddingsPendingBackfill).toBe(footprint.chunks)
  })

  it('reports hard-delete truthfully as unrecoverable', () => {
    const path = seedNegative('m1', 'Delete me for real')
    indexVaultSync(db, vault)

    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path }],
      mode: 'hard-delete',
    })
    const result = applyMemoryDeletion({ vault, db, identity: identity(), plan })
    expect(result.items[0]!.recoverable).toBe(false)
    expect(result.recoveryRef).toBeNull()

    const restored = restoreRetiredMemory({ vault, db, identity: identity(), path })
    expect(restored.restored).toBe(false)
    expect(restored.reason).toMatch(/no recovery record|hard/i)
  })

  it('restoration refuses to overwrite a newer file at the same path', () => {
    const path = seedNegative('m1', 'Retire me')
    indexVaultSync(db, vault)
    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path }],
      mode: 'retire',
    })
    applyMemoryDeletion({ vault, db, identity: identity(), plan })

    seedNegative('m1', 'A newer memory reused this id')
    const restored = restoreRetiredMemory({ vault, db, identity: identity(), path })
    expect(restored.restored).toBe(false)
    expect(restored.reason).toMatch(/newer|exists/i)
    expect(vault.read(path)!.content).toContain('A newer memory reused this id')
  })

  it('is idempotent: re-applying the same plan neither duplicates archives nor errors', () => {
    const path = seedNegative('m1', 'Retire me twice')
    indexVaultSync(db, vault)
    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path }],
      mode: 'retire',
    })

    const first = applyMemoryDeletion({ vault, db, identity: identity(), plan })
    expect(first.applied).toBe(true)
    const afterFirst = listRetirements(db).length

    const second = applyMemoryDeletion({ vault, db, identity: identity(), plan })
    expect(second.items[0]!.source).toBe('skipped')
    expect(second.errors).toEqual([])
    expect(listRetirements(db)).toHaveLength(afterFirst)
  })

  it('reports partial failure per step instead of claiming success', () => {
    const okPath = seedNegative('m1', 'Removable rule')
    const stalePath = seedNegative('m2', 'Edited between review and apply')
    indexVaultSync(db, vault)
    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path: okPath }, { path: stalePath }],
      mode: 'retire',
    })

    // A concurrent writer edits one target between review and apply.
    seedNegative('m2', 'Edited between review and apply', 'Body rewritten by another session.')

    const result = applyMemoryDeletion({ vault, db, identity: identity(), plan })
    expect(result.applied).toBe(false)
    expect(result.partial).toBe(true)
    const byPath = new Map(result.items.map((i) => [i.path, i]))
    expect(byPath.get(okPath)!.source).toBe('ok')
    expect(byPath.get(okPath)!.satisfied).toBe(true)
    expect(byPath.get(stalePath)!.source).toBe('failed')
    expect(byPath.get(stalePath)!.satisfied).toBe(false)
    // The refused item keeps both its source and its index rows — nothing half-done.
    expect(vault.read(stalePath)).not.toBeNull()
    expect(indexFootprint(stalePath).chunks).toBeGreaterThan(0)
    expect(result.errors.join(' ')).toMatch(/stale|changed/i)
  })

  it('treats an already-absent source as satisfied while still reconciling its index', () => {
    const okPath = seedNegative('m1', 'Removable rule')
    const gonePath = seedNegative('m2', 'Already removed elsewhere')
    indexVaultSync(db, vault)
    const plan = previewMemoryDeletion({
      vault,
      db,
      identity: identity(),
      targets: [{ path: okPath }, { path: gonePath }],
      mode: 'retire',
    })

    // A concurrent writer removes one target's source between review and apply.
    vault.remove(gonePath)

    const result = applyMemoryDeletion({ vault, db, identity: identity(), plan })
    const byPath = new Map(result.items.map((i) => [i.path, i]))
    expect(byPath.get(gonePath)!.source).toBe('skipped')
    expect(byPath.get(gonePath)!.satisfied).toBe(true)
    // No orphan index rows survive the vanished source.
    expect(indexFootprint(gonePath)).toEqual({
      file: 0,
      chunks: 0,
      fts: 0,
      edges: 0,
      embeddings: 0,
    })
    expect(result.applied).toBe(true)
    expect(result.partial).toBe(false)
    expect(result.errors).toEqual([])
  })
})
