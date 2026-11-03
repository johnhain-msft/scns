/**
 * End-to-end acceptance for manual, session-aware memory pruning (#73).
 *
 * Everything here runs against an ISOLATED vault, memory DB and broker DB — never the live tree.
 * The cases are the acceptance table from the design: coordination that ended versus coordination
 * that is still live, work superseded inside a still-open session, durable and pinned lessons with
 * no active sessions, mixed records, incomplete evidence, and directory boundaries.
 *
 * The check that matters is the OUTCOME, not the report: after apply, the retired guidance must be
 * absent from the source file, from the search index, from the managed instruction block and from a
 * fresh retrieval — while the positive controls remain retrievable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { createVault, type Vault } from '../../../src/memory/vault.js'
import { indexVaultSync } from '../../../src/memory/indexer.js'
import { keywordOnlySearch } from '../../../src/memory/search.js'
import {
  BLOCK_START,
  BLOCK_END,
} from '../../../src/memory/negative-memory-applicator.js'
import {
  createMemoryPruningService,
  resolveProjectMemory,
  withVaultLease,
  formatPruningPlan,
  inventoryRecords,
} from '../../../src/memory/pruning-runner.js'
import type { ProjectMemoryIdentity } from '../../../src/memory/memory-deletion.js'
import type {
  ProviderProposal,
  PruningProvider,
} from '../../../src/memory/pruning-evaluator.js'

describe('manual session-aware pruning (end to end)', () => {
  let tmpDir: string
  let vaultRoot: string
  let projectRoot: string
  let brokerDbPath: string
  let vault: Vault
  let db: Database.Database
  let brokerDb: Database.Database

  function identity(): ProjectMemoryIdentity {
    return {
      projectId: 'proj-alpha',
      projectRoot,
      instanceId: 'inst-1',
      vaultRoot,
      dbPath: ':memory:',
    }
  }

  function seedMemory(
    id: string,
    rule: string,
    body: string,
    over: { sessionId?: string; pinned?: boolean } = {},
  ): string {
    vault.write(
      `negative/${id}.md`,
      `---
id: ${id}
dontRule: ${rule}
category: correction
target: general
confidence: 0.9
source: copilot-tool
targetApplied: true
createdAt: 2026-09-01T00:00:00.000Z
promptOrigin: human
sessionId: ${over.sessionId ?? 's-old'}
${over.pinned ? 'pinned: true\n' : ''}---
${body}
`,
    )
    return `negative/${id}.md`
  }

  function writeInstructions(rules: readonly string[]) {
    const block = `${BLOCK_START}\n## Things to AVOID (learned from experience)\n\n${rules
      .map((r) => `- ${r}`)
      .join('\n')}\n${BLOCK_END}`
    mkdirSync(join(projectRoot, '.github'), { recursive: true })
    writeFileSync(
      join(projectRoot, '.github', 'copilot-instructions.md'),
      `# House rules\n\nHuman-authored preamble.\n\n${block}\n\nHuman-authored trailer.\n`,
      'utf-8',
    )
  }

  function instructions(): string {
    return readFileSync(join(projectRoot, '.github', 'copilot-instructions.md'), 'utf-8')
  }

  function createBrokerDb(): Database.Database {
    const conn = new Database(brokerDbPath)
    // Mirrors src/broker/storage/schema.sql: `tasks` has NO `project_id` (it is scoped through
    // its team), `teams` does. Keeping the fixture honest is what makes this suite able to
    // catch a query that cannot run against a deployed broker DB.
    conn.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, purpose TEXT, working_dir TEXT, worktree TEXT,
        repo_context TEXT, parent_session_id TEXT, branch_point_message_id TEXT,
        status TEXT DEFAULT 'active', project_id TEXT,
        last_heartbeat DATETIME, created_at DATETIME, archived_at DATETIME
      );
      CREATE TABLE teams (
        id TEXT PRIMARY KEY, name TEXT, description TEXT, parent_team_id TEXT,
        status TEXT, project_id TEXT, working_dir TEXT,
        created_at DATETIME, archived_at DATETIME
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL, seq INTEGER, subject TEXT,
        description TEXT, status TEXT DEFAULT 'pending', owner TEXT, active_form TEXT,
        created_at DATETIME, updated_at DATETIME
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, sender_id TEXT, receiver_id TEXT, content TEXT,
        story_id TEXT, reply_to TEXT, team_id TEXT, seq INTEGER, to_role TEXT, to_team TEXT,
        client_message_id TEXT,
        created_at DATETIME,
        -- Issue #70 delivery ladder: delivered_at -> read_at -> disposition.
        delivered_at DATETIME, read_at DATETIME,
        disposition TEXT CHECK (disposition IS NULL OR disposition IN ('accepted', 'rejected', 'deferred')),
        disposition_at DATETIME, disposition_note TEXT
      );
      CREATE TABLE file_intents (
        file_path TEXT, session_id TEXT, intent TEXT, declared_at DATETIME,
        PRIMARY KEY (file_path, session_id)
      );
    `)
    conn
      .prepare("INSERT INTO teams (id, name, project_id) VALUES ('t1', 'team-one', 'proj-alpha')")
      .run()
    return conn
  }

  function seedSession(id: string, status = 'active') {
    brokerDb
      .prepare(
        `INSERT INTO sessions (id, purpose, working_dir, status, project_id, last_heartbeat, created_at)
         VALUES (?, 'work', ?, ?, 'proj-alpha', datetime('now'), datetime('now'))`,
      )
      .run(id, projectRoot, status)
  }

  function seedClosedTask(subject: string): number {
    const info = brokerDb
      .prepare(
        `INSERT INTO tasks (team_id, subject, status, created_at, updated_at)
         VALUES ('t1', ?, 'completed', datetime('now'), datetime('now'))`,
      )
      .run(subject)
    return Number(info.lastInsertRowid)
  }

  function provider(proposals: readonly ProviderProposal[]): PruningProvider {
    return { assess: async () => proposals }
  }

  function service(p?: PruningProvider) {
    return createMemoryPruningService({
      vault,
      db,
      identity: identity(),
      brokerDbPath,
      brokerStatus: 'stopped',
      transcriptPath: join(tmpDir, 'no-transcript.db'),
      ...(p ? { provider: p } : {}),
    })
  }

  function retrieves(term: string): boolean {
    return keywordOnlySearch(db, term, 10).length > 0
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scns-prune-e2e-'))
    vaultRoot = join(tmpDir, 'home', '.scns', 'memory')
    projectRoot = join(tmpDir, 'project')
    brokerDbPath = join(tmpDir, 'data.db')
    mkdirSync(vaultRoot, { recursive: true })
    mkdirSync(projectRoot, { recursive: true })
    vault = createVault({ rootDir: vaultRoot })
    db = openMemoryDb(':memory:')
    brokerDb = createBrokerDb()
  })

  afterEach(() => {
    closeMemoryDb(db)
    try {
      brokerDb.close()
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('retires an ended coordination rule from source, index, instructions and fresh retrieval', async () => {
    const gone = seedMemory(
      'm-coord',
      'Wait for the handoff session before implementing',
      'Wait for the handoff session before implementing. Coordination note, distinctiveunicorn.',
    )
    seedMemory(
      'm-durable',
      'Never claim tests pass without quoting the row',
      'Never claim tests pass without quoting the row. Durable lesson, distinctivepegasus.',
    )
    indexVaultSync(db, vault)
    writeInstructions([
      'Wait for the handoff session before implementing',
      'Never claim tests pass without quoting the row',
    ])
    seedSession('s-now')
    const taskId = seedClosedTask('handoff coordination')

    expect(retrieves('distinctiveunicorn')).toBe(true)

    const plan = await service(
      provider([
        {
          memoryId: 'm-coord',
          verdict: 'retire',
          applicability: 'coordination-bound',
          rationale: 'the handoff coordination task completed',
          evidenceRefs: [`task:${taskId}`],
        },
        {
          memoryId: 'm-durable',
          verdict: 'keep',
          applicability: 'durable',
          rationale: 'a standing verification rule',
          evidenceRefs: [],
        },
      ]),
    ).preview()

    expect(plan.counts.retire).toBe(1)
    expect(plan.counts.keep).toBe(1)
    expect(plan.deletion).not.toBeNull()

    const result = service().apply(plan)
    expect(result.refused).toBeNull()
    expect(result.applied).toBe(true)

    // Source, index and fresh retrieval
    expect(vault.read(gone)).toBeNull()
    expect(retrieves('distinctiveunicorn')).toBe(false)
    expect(retrieves('distinctivepegasus')).toBe(true)

    // Managed instructions: exactly one bullet gone, human prose intact
    const text = instructions()
    expect(text).not.toContain('Wait for the handoff session before implementing')
    expect(text).toContain('Never claim tests pass without quoting the row')
    expect(text).toContain('Human-authored preamble.')
    expect(text).toContain('Human-authored trailer.')

    // A later reconciliation pass must not bring it back.
    indexVaultSync(db, vault)
    expect(retrieves('distinctiveunicorn')).toBe(false)
    expect(retrieves('distinctivepegasus')).toBe(true)
  })

  it('preserves a rule whose coordination is still unresolved', async () => {
    const kept = seedMemory(
      'm-coord',
      'Do not merge until the peer session confirms',
      'Do not merge until the peer session confirms. distinctiveunicorn.',
      { sessionId: 's-peer' },
    )
    indexVaultSync(db, vault)
    writeInstructions(['Do not merge until the peer session confirms'])
    seedSession('s-peer')
    const taskId = seedClosedTask('an unrelated task')
    brokerDb
      .prepare(
        `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
         VALUES ('msg-open', 's-peer', 's-peer', 'still blocked on the branch', datetime('now'), NULL)`,
      )
      .run()

    const plan = await service(
      provider([
        {
          memoryId: 'm-coord',
          verdict: 'retire',
          applicability: 'coordination-bound',
          rationale: 'looks finished',
          evidenceRefs: [`task:${taskId}`],
        },
      ]),
    ).preview()

    expect(plan.counts.retire).toBe(0)
    expect(plan.counts.uncertain).toBe(1)
    expect(plan.deletion).toBeNull()

    const result = service().apply(plan)
    expect(result.refused).toMatch(/no retire or revise/i)
    expect(vault.read(kept)).not.toBeNull()
    expect(retrieves('distinctiveunicorn')).toBe(true)
    expect(instructions()).toContain('Do not merge until the peer session confirms')
  })

  it('keeps durable and pinned lessons when no session is active at all', async () => {
    seedMemory('m-durable', 'Verify output content, not just status codes', 'body distinctivepegasus')
    seedMemory('m-pinned', 'Never fabricate evidence', 'body distinctivephoenix', { pinned: true })
    indexVaultSync(db, vault)
    writeInstructions(['Verify output content, not just status codes', 'Never fabricate evidence'])

    // No sessions, no tasks, no turns — the "silence" case.
    const plan = await service(
      provider([
        {
          memoryId: 'm-durable',
          verdict: 'retire',
          applicability: 'task-bound',
          rationale: 'nothing references it any more',
          evidenceRefs: [],
        },
        {
          memoryId: 'm-pinned',
          verdict: 'retire',
          applicability: 'task-bound',
          rationale: 'old',
          evidenceRefs: [],
        },
      ]),
    ).preview()

    expect(plan.counts.retire).toBe(0)
    expect(plan.counts.keep).toBe(1) // the pinned guard
    expect(plan.counts.uncertain).toBe(1)
    expect(plan.deletion).toBeNull()
    expect(retrieves('distinctivepegasus')).toBe(true)
    expect(retrieves('distinctivephoenix')).toBe(true)
  })

  it('revises a mixed record so only the expired clause disappears', async () => {
    const mixed = seedMemory(
      'm-mixed',
      'Use hub-and-spoke networking and do not implement in this handoff session',
      'Use hub-and-spoke networking and do not implement in this handoff session. durableclause stays, obsoleteclause goes.',
    )
    indexVaultSync(db, vault)
    writeInstructions([
      'Use hub-and-spoke networking and do not implement in this handoff session',
    ])
    seedSession('s-now')
    const taskId = seedClosedTask('handoff planning phase')

    const plan = await service(
      provider([
        {
          memoryId: 'm-mixed',
          verdict: 'revise',
          applicability: 'project-requirement',
          rationale: 'the network requirement is durable; the planning restriction expired',
          evidenceRefs: [`task:${taskId}`],
          revisedRule: 'Use hub-and-spoke networking',
          revisedBody: 'Use hub-and-spoke networking. durableclause stays.',
        },
      ]),
    ).preview()

    expect(plan.counts.revise).toBe(1)
    const result = service().apply(plan)
    expect(result.applied).toBe(true)

    const after = vault.read(mixed)!
    expect(after.content).toContain('dontRule: Use hub-and-spoke networking\n')
    expect(after.content).toContain('durableclause')
    expect(after.content).not.toContain('obsoleteclause')

    expect(retrieves('durableclause')).toBe(true)
    expect(retrieves('obsoleteclause')).toBe(false)

    const text = instructions()
    expect(text).toContain('- Use hub-and-spoke networking\n')
    expect(text).not.toContain('do not implement in this handoff session')
  })

  it('refuses to retire anything when the broker evidence could not be read', async () => {
    seedMemory('m-1', 'Some temporary rule', 'body distinctiveunicorn')
    indexVaultSync(db, vault)

    const svc = createMemoryPruningService({
      vault,
      db,
      identity: identity(),
      brokerDbPath: join(tmpDir, 'missing-broker.db'),
      brokerStatus: 'stopped',
      transcriptPath: join(tmpDir, 'no-transcript.db'),
      provider: provider([
        {
          memoryId: 'm-1',
          verdict: 'retire',
          applicability: 'task-bound',
          rationale: 'no work references it',
          evidenceRefs: ['task:1'],
        },
      ]),
    })
    const plan = await svc.preview()

    expect(plan.evidence.completeness.level).toBe('unavailable')
    expect(plan.counts.retire).toBe(0)
    expect(plan.counts.uncertain).toBe(1)
    expect(plan.warnings.join(' ')).toMatch(/unavailable|could not/i)
    expect(retrieves('distinctiveunicorn')).toBe(true)
  })

  it('reports every memory as uncertain — never kept — when no evaluator is configured', async () => {
    seedMemory('m-1', 'A rule', 'body')
    seedMemory('m-2', 'Another rule', 'body')
    indexVaultSync(db, vault)
    seedSession('s-now')

    const plan = await service().preview()

    expect(plan.counts.uncertain).toBe(2)
    expect(plan.counts.keep).toBe(0)
    expect(plan.counts.retire).toBe(0)
    expect(plan.evaluator.configured).toBe(false)
    expect(plan.warnings.join(' ')).toMatch(/no pruning evaluator/i)
    expect(formatPruningPlan(plan)).toMatch(/not configured/i)
  })

  it('refuses a retirement whose contrary evidence appeared between preview and apply', async () => {
    const kept = seedMemory(
      'm-coord',
      'Do not merge until the peer session confirms',
      'Do not merge until the peer session confirms. distinctiveunicorn.',
      { sessionId: 's-peer' },
    )
    indexVaultSync(db, vault)
    writeInstructions(['Do not merge until the peer session confirms'])
    seedSession('s-peer')
    const taskId = seedClosedTask('peer coordination')

    // At preview time there is no unresolved coordination, so the retirement stands.
    const plan = await service(
      provider([
        {
          memoryId: 'm-coord',
          verdict: 'retire',
          applicability: 'coordination-bound',
          rationale: 'the peer coordination task closed',
          evidenceRefs: [`task:${taskId}`],
        },
      ]),
    ).preview()
    expect(plan.counts.retire).toBe(1)

    // Between review and apply the peer sends a message: the premise no longer holds.
    brokerDb
      .prepare(
        `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
         VALUES ('msg-late', 's-peer', 's-peer', 'actually still blocked', datetime('now'), NULL)`,
      )
      .run()

    const result = service().apply(plan)
    expect(result.applied).toBe(false)
    expect(result.errors.join(' ')).toMatch(/evidence|contradict|changed/i)
    // The memory and every one of its representations survive.
    expect(vault.read(kept)).not.toBeNull()
    expect(retrieves('distinctiveunicorn')).toBe(true)
    expect(instructions()).toContain('Do not merge until the peer session confirms')
  })

  it('applies normally when the premises still hold at apply time', async () => {
    seedMemory('m-coord', 'Temporary rule', 'Temporary rule. distinctiveunicorn.')
    indexVaultSync(db, vault)
    writeInstructions(['Temporary rule'])
    seedSession('s-now')
    const taskId = seedClosedTask('closed work')

    const plan = await service(
      provider([
        {
          memoryId: 'm-coord',
          verdict: 'retire',
          applicability: 'task-bound',
          rationale: 'the bound task closed',
          evidenceRefs: [`task:${taskId}`],
        },
      ]),
    ).preview()

    const result = service().apply(plan)
    expect(result.applied).toBe(true)
    expect(retrieves('distinctiveunicorn')).toBe(false)
  })

  it('refuses to apply a plan built for a different project', async () => {
    seedMemory('m-1', 'A rule', 'body distinctiveunicorn')
    indexVaultSync(db, vault)
    seedSession('s-now')
    const taskId = seedClosedTask('closed')

    const plan = await service(
      provider([
        {
          memoryId: 'm-1',
          verdict: 'retire',
          applicability: 'task-bound',
          rationale: 'task closed',
          evidenceRefs: [`task:${taskId}`],
        },
      ]),
    ).preview()

    const foreign = {
      ...plan,
      deletion: {
        ...plan.deletion!,
        project: { ...plan.deletion!.project, projectId: 'proj-beta' },
      },
    }
    const result = service().apply(foreign)
    expect(result.refused).toMatch(/proj-beta/)
    expect(vault.read('negative/m-1.md')).not.toBeNull()
    expect(retrieves('distinctiveunicorn')).toBe(true)
  })

  it('serializes mutations across processes with an exclusive vault lease', () => {
    let inner: unknown = null
    withVaultLease(vaultRoot, () => {
      inner = (() => {
        try {
          withVaultLease(vaultRoot, () => 'should not run')
          return 'no-refusal'
        } catch (err) {
          return (err as Error).message
        }
      })()
    })
    expect(String(inner)).toMatch(/lease/i)
    // The lease is released afterwards, so the next caller succeeds.
    expect(withVaultLease(vaultRoot, () => 'ok')).toBe('ok')
  })

  describe('orphaned coordination (round-2 N1)', () => {
    // The reviewer's probe, made permanent: a real vault, memory DB, broker DB and a WORKING
    // transcript oracle. Only session-row presence varies between the two arms, so anything
    // that differs is caused by it.

    function writeTranscript(sessionId: string, text: string): string {
      const path = join(tmpDir, `transcript-${sessionId}.db`)
      const t = new Database(path)
      t.exec(
        'CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, timestamp TEXT)',
      )
      t.prepare(
        "INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?, 0, ?, '2026-09-17T10:00:00.000Z')",
      ).run(sessionId, text)
      t.close()
      return path
    }

    function retireProposal(turnRef = 'turn:s-live#0'): PruningProvider {
      return provider([
        {
          memoryId: 'm-coord',
          verdict: 'retire',
          applicability: 'coordination-bound',
          rationale: 'the coordination this instruction waited on has ended',
          evidenceRefs: [turnRef],
        },
      ])
    }

    it('refuses to retire while an unread message from the memory’s own session is unattributable', async () => {
      seedMemory('m-coord', 'Wait for the peer session', 'Wait for the peer session.', {
        sessionId: 's-gone',
      })
      indexVaultSync(db, vault)
      writeInstructions(['Wait for the peer session'])
      seedSession('s-live')
      // `s-gone` deliberately has NO row in `sessions` — the #70 state.
      brokerDb
        .prepare(
          `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
           VALUES ('m-unread', 's-gone', NULL, 'still blocked on you', datetime('now'), NULL)`,
        )
        .run()
      brokerDb
        .prepare(
          `INSERT INTO file_intents (file_path, session_id, intent, declared_at)
           VALUES ('src/held.ts', 's-gone', 'edit', datetime('now'))`,
        )
        .run()

      const plan = await createMemoryPruningService({
        vault,
        db,
        identity: identity(),
        brokerDbPath,
        brokerStatus: 'stopped',
        transcriptPath: writeTranscript('s-live', 'that coordination is finished'),
        provider: retireProposal(),
      }).preview()

      // The row is in the DB, so it must be in the evidence — not silently absent.
      expect(plan.evidence.orphanedMessageIds).toEqual(['m-unread'])
      expect(plan.evidence.orphanedIntentPaths).toEqual(['src/held.ts'])
      expect(plan.evidence.completeness.coordinationAttributable).toBe(false)
      expect(plan.evidence.completeness.level).not.toBe('complete')
      // …and every source was individually readable, so this is NOT the old blind-source case.
      expect(plan.evidence.completeness.sessionsAvailable).toBe(true)
      expect(plan.evidence.completeness.messagesAvailable).toBe(true)
      expect(plan.evidence.completeness.intentsAvailable).toBe(true)

      // The outcome that matters: nothing is deleted on the strength of the dropped row.
      const d = plan.decisions.find((x) => x.memoryId === 'm-coord')!
      expect(d.verdict).toBe('uncertain')
      expect(d.source).toBe('guard')
      expect(plan.counts.retire).toBe(0)
      expect(plan.deletion).toBeNull()
      expect(instructions()).toContain('Wait for the peer session')
    })

    it('still retires on complete evidence when nothing is unattributable (arm C control)', async () => {
      seedMemory('m-coord', 'Wait for the peer session', 'Wait for the peer session.', {
        sessionId: 's-gone',
      })
      indexVaultSync(db, vault)
      writeInstructions(['Wait for the peer session'])
      seedSession('s-live')
      // Identical to the arm above except that the coordination row is absent entirely, so
      // there is nothing the broker cannot attribute.

      const plan = await createMemoryPruningService({
        vault,
        db,
        identity: identity(),
        brokerDbPath,
        brokerStatus: 'stopped',
        transcriptPath: writeTranscript('s-live', 'that coordination is finished'),
        provider: retireProposal(),
      }).preview()

      expect(plan.evidence.completeness.coordinationAttributable).toBe(true)
      expect(plan.evidence.completeness.level).toBe('complete')

      const d = plan.decisions.find((x) => x.memoryId === 'm-coord')!
      expect(d.verdict).toBe('retire')
      expect(d.source).toBe('provider')
      expect(plan.evaluator.downgraded).toBe(0)
    })
    it('refuses to retire when the row cap hid live coordination on the memory’s own session', async () => {
      // Round-3 N2: nothing is gone and nothing is unreadable — the blocker is simply past the
      // cap. The 500 VISIBLE messages are between two other live sessions, so they raise no
      // objection for this memory; the only row that would is the oldest, which `created_at
      // DESC LIMIT 500` drops. Row count is therefore the sole varied input.
      seedMemory('m-coord', 'Wait for the peer session', 'Wait for the peer session.', {
        sessionId: 's-owner',
      })
      indexVaultSync(db, vault)
      writeInstructions(['Wait for the peer session'])
      seedSession('s-owner')
      seedSession('s-peer')
      seedSession('s-other')
      const insert = brokerDb.prepare(
        `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      brokerDb.transaction(() => {
        // Oldest: the only row touching s-owner, and the first one the cap discards.
        insert.run('mm-blocker', 's-peer', 's-owner', 'still blocked on you', '2026-09-17T00:00:00.000Z')
        for (let i = 1; i <= 500; i += 1) {
          const ts = new Date(Date.UTC(2026, 8, 17, 0, 0, i)).toISOString()
          insert.run(`mm${i}`, 's-peer', 's-other', `unrelated chatter ${i}`, ts)
        }
      })()

      const plan = await createMemoryPruningService({
        vault,
        db,
        identity: identity(),
        brokerDbPath,
        brokerStatus: 'stopped',
        transcriptPath: writeTranscript('s-owner', 'that coordination is finished'),
        provider: retireProposal('turn:s-owner#0'),
      }).preview()

      // The blocker really is invisible — this is not a case the coordination guard can see.
      expect(plan.evidence.unreadMessageIds).toHaveLength(500)
      expect(plan.evidence.unreadMessageIds).not.toContain('mm-blocker')
      expect(plan.evidence.completeness.messagesAvailable).toBe(true)
      expect(plan.evidence.completeness.coordinationAttributable).toBe(true)
      expect(plan.evidence.completeness.inventoryComplete).toBe(false)
      expect(plan.evidence.completeness.level).not.toBe('complete')
      // The citation is real, so guard 2 cannot be what stops this.
      expect(plan.decisions.find((x) => x.memoryId === 'm-coord')!.evidenceRefs).toEqual([
        'turn:s-owner#0',
      ])

      const d = plan.decisions.find((x) => x.memoryId === 'm-coord')!
      expect(d.verdict).toBe('uncertain')
      expect(d.source).toBe('guard')
      expect(plan.counts.retire).toBe(0)
      expect(plan.deletion).toBeNull()
    })
  })

  describe('record inventory and orphan types', () => {
    // Plan §2: "Inventory the union of canonical vault files, indexed paths, and managed
    // Markdown. Classify file-only, index-only, projection-only and fully matched records.
    // Synthetic `event-nodes` are not orphan files." Acceptance row 7 requires each orphan
    // type be EXPLAINED — a store-by-store disagreement is not visible from the negative tier
    // alone, because a record can be missing from the very store you enumerated.

    it('classifies all four record types and keeps synthetic event nodes out of the orphans', async () => {
      seedMemory('m-matched', 'Always quote the failing row', 'Always quote the failing row.')
      seedMemory('m-ghost', 'Ghost rule that lost its file', 'Ghost rule that lost its file.')
      indexVaultSync(db, vault)

      // index-only: the index still carries the record after its file disappeared.
      vault.remove('negative/m-ghost.md')
      // file-only: written after the index pass, so no index rows exist for it yet.
      seedMemory('m-fresh', 'Fresh rule not yet indexed', 'Fresh rule not yet indexed.')
      // projection-only: a managed rule with no backing record at all.
      writeInstructions(['Always quote the failing row', 'Orphaned projection with no record'])
      // Synthetic event-node rows are written by the dream slow-path, not by a real file.
      db.prepare(
        `INSERT INTO vault_files (path, mtime_ms, size_bytes, content_hash)
         VALUES ('event-nodes/ev-1.md', 0, 10, 'h')`,
      ).run()

      const inv = inventoryRecords(vault, db, identity())

      const classOf = (path: string) => inv.records.find((r) => r.path === path)?.recordClass
      expect(classOf('negative/m-matched.md')).toBe('fully-matched')
      expect(classOf('negative/m-ghost.md')).toBe('index-only')
      expect(classOf('negative/m-fresh.md')).toBe('file-only')
      expect(
        inv.records.find((r) => r.rule === 'Orphaned projection with no record')?.recordClass,
      ).toBe('projection-only')

      // Every disagreement is an orphan; the fully matched record is not.
      const orphanPaths = inv.orphans.map((r) => r.path ?? r.rule).sort()
      expect(orphanPaths).toEqual([
        'Orphaned projection with no record',
        'negative/m-fresh.md',
        'negative/m-ghost.md',
      ])
      expect(inv.counts['fully-matched']).toBe(1)

      // Synthetic event nodes are reported as such, never as an orphan file.
      expect(inv.syntheticEventNodePaths).toEqual(['event-nodes/ev-1.md'])
      expect(inv.records.some((r) => r.path?.startsWith('event-nodes/'))).toBe(false)
      expect(inv.orphans.some((r) => r.path?.startsWith('event-nodes/'))).toBe(false)
    })

    it('carries the orphan explanation into the pruning plan and its rendered form', async () => {
      seedMemory('m-keep', 'Always quote the failing row', 'Always quote the failing row.')
      seedMemory('ghost', 'Ghost rule that lost its file', 'Ghost rule that lost its file.')
      indexVaultSync(db, vault)
      vault.remove('negative/ghost.md')
      writeInstructions(['Always quote the failing row'])
      seedSession('s-live')

      const plan = await service().preview()

      // The reviewer's probe: the serialized plan must actually mention the record, its class
      // and the fact that it is an orphan — an inventory read from one tier cannot.
      const serialized = JSON.stringify(plan)
      expect(serialized).toContain('ghost')
      expect(serialized).toContain('index-only')
      expect(serialized.toLowerCase()).toContain('orphan')
      expect(plan.inventory.orphans.map((r) => r.path)).toContain('negative/ghost.md')

      const rendered = formatPruningPlan(plan)
      expect(rendered.toLowerCase()).toContain('orphan')
      expect(rendered).toContain('negative/ghost.md')
      expect(rendered).toContain('index-only')
    })

    it('reports an absent managed instruction file without creating it', () => {
      seedMemory('m-one', 'Some rule', 'Some rule.')
      indexVaultSync(db, vault)

      const inv = inventoryRecords(vault, db, identity())

      expect(inv.instructionsFileMissing).toBe(true)
      expect(existsSync(join(projectRoot, '.github', 'copilot-instructions.md'))).toBe(false)
    })
  })

  describe('directory boundaries', () => {
    let metaDbPath: string
    let projectsDir: string
    let outerRoot: string
    let innerRoot: string

    beforeEach(() => {
      metaDbPath = join(tmpDir, 'meta-broker.db')
      projectsDir = join(tmpDir, 'projects')
      outerRoot = join(tmpDir, 'outer')
      innerRoot = join(outerRoot, 'nested')
      mkdirSync(innerRoot, { recursive: true })

      const meta = new Database(metaDbPath)
      meta.exec(`
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY, project_root TEXT NOT NULL, desired_port INTEGER,
          bound_port INTEGER, status TEXT NOT NULL DEFAULT 'registered', instance_id TEXT,
          child_pid INTEGER, last_seen_at TEXT, last_error TEXT,
          health_failures INTEGER NOT NULL DEFAULT 0, autonomy_level INTEGER,
          auto_approve_threshold REAL, self_issue_repo TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)
      meta
        .prepare(
          "INSERT INTO projects (project_id, project_root, status, bound_port) VALUES (?, ?, 'stopped', NULL)",
        )
        .run('outer-proj', outerRoot)
      meta
        .prepare(
          "INSERT INTO projects (project_id, project_root, status, bound_port) VALUES (?, ?, 'failed', NULL)",
        )
        .run('inner-proj', innerRoot)
      meta.close()
    })

    it('selects the DEEPEST registered project, never the parent', () => {
      const resolved = resolveProjectMemory({
        directory: join(innerRoot, 'src'),
        metaDbPath,
        projectDbDir: projectsDir,
      })
      expect(resolved.identity.projectId).toBe('inner-proj')
      expect(resolved.identity.vaultRoot).toBe(
        join(projectsDir, 'inner-proj', 'home', '.scns', 'memory'),
      )
      // A failed registration still resolves to its OWN store — never the parent's.
      expect(resolved.status).toBe('failed')
      expect(resolved.brokerLive).toBe(false)
    })

    it('resolves the parent for a path outside the nested root', () => {
      const resolved = resolveProjectMemory({
        directory: join(outerRoot, 'docs'),
        metaDbPath,
        projectDbDir: projectsDir,
      })
      expect(resolved.identity.projectId).toBe('outer-proj')
    })

    it('refuses an unregistered directory rather than using the global vault', () => {
      expect(() =>
        resolveProjectMemory({
          directory: join(tmpDir, 'somewhere-else'),
          metaDbPath,
          projectDbDir: projectsDir,
        }),
      ).toThrow(/not inside any registered SCNS project/i)
    })

    it('reports a running broker so a second writer can be refused', () => {
      const meta = new Database(metaDbPath)
      meta
        .prepare("UPDATE projects SET status = 'running', bound_port = 3505 WHERE project_id = ?")
        .run('outer-proj')
      meta.close()

      const resolved = resolveProjectMemory({
        directory: outerRoot,
        metaDbPath,
        projectDbDir: projectsDir,
      })
      expect(resolved.brokerLive).toBe(true)
      expect(resolved.boundPort).toBe(3505)
    })
  })
})
