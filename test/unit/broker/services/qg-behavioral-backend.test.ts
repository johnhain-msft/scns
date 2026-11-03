/**
 * Phase 1 wedge A (go-live) — the REAL bounded backend pair for the quality-gate
 * behavioral gate. Every collaborator is injected: NO copilot spawn, NO real git,
 * NO kill. Asserts the bounded controls (deny-all policy + 150s cap + injected
 * guidance), the asymmetry channel (HEAD vs post-diff guidance), and the
 * per-completion lifecycle (PID reap + baseline-worktree-only teardown).
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultMakeBoundedBackend,
  makeQgBehavioralGateConfig,
  makeQgRetrievalGateConfig,
  resolveQgRetrievalCandidateConfig,
  readGuidanceFile,
  QG_BEHAVIORAL_ATTEMPT_TIMEOUT_MS,
  QG_GUIDANCE_FILE,
  QG_GUIDANCE_MAX_CHARS,
  type BackendWithPid,
  type IsolatedDir,
} from '../../../../src/broker/services/qg-behavioral-backend.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpRequestPermissionParams,
} from '../../../../src/broker/services/acp-client.js'
import type { ReplayBackend } from '../../../../src/selfopt/replay.js'
import type { InjectedMemoryProvider, IsolatedWorktree } from '../../../../src/selfopt/index.js'
import type { TaskRecord } from '../../../../src/selfopt/types.js'
import type { BaseSearch } from '../../../../src/memory/intent-search.js'
import type { SearchResult } from '../../../../src/memory/search.js'
import { openMemoryDb, closeMemoryDb } from '../../../../src/memory/db.js'
import { rebuildMemoryEdges } from '../../../../src/memory/entities/edges.js'
import type DatabaseT from 'better-sqlite3'

function fakeBackend(label: string): ReplayBackend {
  return { attempt: () => label }
}

const REJECT_PARAMS: AcpRequestPermissionParams = {
  sessionId: 's',
  toolCall: { kind: 'execute', title: 'npm install' },
  options: [
    { optionId: 'allow', kind: 'allow_always', name: 'Allow' },
    { optionId: 'no', kind: 'reject_once', name: 'Reject' },
  ] as unknown as AcpRequestPermissionParams['options'],
}

describe('readGuidanceFile', () => {
  it('reads .github/copilot-instructions.md from the cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'qgb-read-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, QG_GUIDANCE_FILE), 'RULE: always verify.', 'utf-8')
    expect(readGuidanceFile(root)).toBe('RULE: always verify.')
    rmSync(root, { recursive: true, force: true })
  })

  it('returns empty string when the file is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'qgb-read-none-'))
    expect(readGuidanceFile(root)).toBe('')
    rmSync(root, { recursive: true, force: true })
  })

  it('caps the guidance at QG_GUIDANCE_MAX_CHARS', () => {
    const root = mkdtempSync(join(tmpdir(), 'qgb-read-cap-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, QG_GUIDANCE_FILE), 'x'.repeat(QG_GUIDANCE_MAX_CHARS + 500), 'utf-8')
    expect(readGuidanceFile(root).length).toBe(QG_GUIDANCE_MAX_CHARS)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('defaultMakeBoundedBackend — bounded controls (no spawn)', () => {
  it('builds a deny-all client, caps the attempt, and injects guidance', () => {
    let seenOpts: AcpClientOptions | null = null
    let madeWith: {
      cwd: string
      allowAllTools: boolean
      attemptTimeoutMs: number
      injectedMemory: string
    } | null = null

    const pair: BackendWithPid = defaultMakeBoundedBackend('/iso/wt', 'HEAD-GUIDANCE', {
      createClientFn: (opts: AcpClientOptions): AcpClient => {
        seenOpts = opts
        // minimal fake; never used past option capture
        return {} as unknown as AcpClient
      },
      makeReplayBackend: (opts) => {
        madeWith = {
          cwd: opts.cwd,
          allowAllTools: opts.allowAllTools,
          attemptTimeoutMs: opts.attemptTimeoutMs,
          injectedMemory: opts.injectedMemory,
        }
        // exercise the wrapped client factory so we can inspect what it forwards
        opts.createClient({ cwd: opts.cwd })
        return fakeBackend('b')
      },
    })

    expect(madeWith).toEqual({
      cwd: '/iso/wt',
      allowAllTools: false,
      attemptTimeoutMs: QG_BEHAVIORAL_ATTEMPT_TIMEOUT_MS,
      injectedMemory: 'HEAD-GUIDANCE',
    })
    // deny-all: the wrapped client got a permissionPolicy that selects reject_once
    const opts = seenOpts as unknown as AcpClientOptions
    expect(opts.permissionPolicy).toBeDefined()
    expect(opts.permissionPolicy!.decide(REJECT_PARAMS)).toEqual({
      outcome: 'selected',
      optionId: 'no',
    })
    // a spawnFn is threaded so the PID can be captured at spawn time
    expect(typeof opts.spawnFn).toBe('function')
    // PID starts null until a real spawn occurs (never in this CI-safe test)
    expect(pair.getPid()).toBeNull()
  })
})

interface WtSpy {
  created: string[]
  cleaned: string[]
}

function fakeWorktree(spy: WtSpy, cwd: string): IsolatedWorktree {
  spy.created.push(cwd)
  return {
    cwd,
    cleanup: () => {
      spy.cleaned.push(cwd)
    },
  }
}

describe('makeQgBehavioralGateConfig.makeBackends — asymmetry + lifecycle', () => {
  it('injects HEAD guidance into baseline and post-diff guidance into candidate', () => {
    const wtSpy: WtSpy = { created: [], cleaned: [] }
    const guidanceByCwd: Record<string, string> = {
      '/baseline/wt': 'HEAD: always verify before claiming success.',
      '/team/wt': 'POST-DIFF: just confirm it.',
    }
    const madeBackends: Array<{ cwd: string; mem: string }> = []

    const cfg = makeQgBehavioralGateConfig({
      projectRoot: '/live/root',
      makeWorktree: (root) => {
        expect(root).toBe('/live/root')
        return fakeWorktree(wtSpy, '/baseline/wt')
      },
      readGuidance: (cwd) => guidanceByCwd[cwd] ?? '',
      makeBackend: (cwd, mem) => {
        madeBackends.push({ cwd, mem })
        return { backend: fakeBackend(cwd), getPid: () => null }
      },
    })

    const pair = cfg.makeBackends({ headCwd: '/live/root', candidateCwd: '/team/wt' })

    // baseline runs in the ISOLATED detached worktree, candidate in the team worktree
    expect(madeBackends).toEqual([
      { cwd: '/baseline/wt', mem: 'HEAD: always verify before claiming success.' },
      { cwd: '/team/wt', mem: 'POST-DIFF: just confirm it.' },
    ])
    expect(wtSpy.created).toEqual(['/baseline/wt'])
    pair.dispose()
  })

  it('dispose reaps BOTH spawn PIDs and removes ONLY the baseline worktree', () => {
    const wtSpy: WtSpy = { created: [], cleaned: [] }
    const killed: Array<{ pid: number; sig: NodeJS.Signals }> = []

    const cfg = makeQgBehavioralGateConfig({
      projectRoot: '/live/root',
      makeWorktree: () => fakeWorktree(wtSpy, '/baseline/wt'),
      readGuidance: () => 'g',
      makeBackend: (cwd) => ({
        backend: fakeBackend(cwd),
        getPid: () => (cwd === '/baseline/wt' ? 1001 : 2002),
      }),
      isAlive: () => true,
      killByPid: (pid, sig) => killed.push({ pid, sig }),
    })

    const pair = cfg.makeBackends({ headCwd: '/live/root', candidateCwd: '/team/wt' })
    pair.dispose()

    expect(killed).toEqual([
      { pid: 1001, sig: 'SIGKILL' },
      { pid: 2002, sig: 'SIGKILL' },
    ])
    // ONLY the baseline worktree is torn down; the team worktree (/team/wt) is the
    // arbiter's and must never appear here.
    expect(wtSpy.cleaned).toEqual(['/baseline/wt'])
  })

  it('does not kill a PID that has already exited', () => {
    const wtSpy: WtSpy = { created: [], cleaned: [] }
    const killed: number[] = []
    const cfg = makeQgBehavioralGateConfig({
      projectRoot: '/live/root',
      makeWorktree: () => fakeWorktree(wtSpy, '/baseline/wt'),
      readGuidance: () => 'g',
      makeBackend: (cwd) => ({ backend: fakeBackend(cwd), getPid: () => 1234 }),
      isAlive: () => false,
      killByPid: (pid) => killed.push(pid),
    })
    cfg.makeBackends({ headCwd: '/live/root', candidateCwd: '/team/wt' }).dispose()
    expect(killed).toEqual([])
    expect(wtSpy.cleaned).toEqual(['/baseline/wt'])
  })

  it('cleans up the partial baseline worktree and rethrows if backend setup throws', () => {
    const wtSpy: WtSpy = { created: [], cleaned: [] }
    const cfg = makeQgBehavioralGateConfig({
      projectRoot: '/live/root',
      makeWorktree: () => fakeWorktree(wtSpy, '/baseline/wt'),
      readGuidance: () => 'g',
      makeBackend: () => {
        throw new Error('boom in makeBackend')
      },
    })
    expect(() => cfg.makeBackends({ headCwd: '/live/root', candidateCwd: '/team/wt' })).toThrow(
      /boom in makeBackend/,
    )
    // the worktree it created was cleaned up despite the throw
    expect(wtSpy.cleaned).toEqual(['/baseline/wt'])
  })
})

// Sanity: the val-task type import is exercised so the test file matches the
// production TaskRecord shape used by the gate (compile-time guard).
const _typeGuard: TaskRecord | null = null
void _typeGuard

// ── THE BRIDGE — retrieval-mode gate config ──────────────────────────────────

function addChunk(db: DatabaseT.Database, path: string, mtimeMs: number, content: string): void {
  db.prepare('INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)').run(
    path,
    mtimeMs,
    content.length,
  )
  db.prepare(
    `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
     VALUES (?, 0, ?, 0, ?, 1)`,
  ).run(path, content, content.length)
}

/** A base search returning ONE sentinel result (proves base-vs-routed asymmetry). */
const sentinelBase: BaseSearch = async (): Promise<readonly SearchResult[]> => [
  {
    chunkId: 999,
    filePath: 'sentinel.md',
    content: 'SENTINEL-BASE-RESULT',
    score: 1,
    vectorScore: 0,
    keywordScore: 1,
    chunkIndex: 0,
  },
]

function brokerVault(): DatabaseT.Database {
  const db = openMemoryDb(':memory:')
  addChunk(db, 'b1.md', 1000, 'the broker first booted')
  addChunk(db, 'b2.md', 2000, 'the broker config reads BROKER_DB_PATH from env at startup')
  rebuildMemoryEdges(db)
  return db
}

function fakeDir(spy: { cleaned: string[] }, cwd: string): IsolatedDir {
  return { cwd, cleanup: () => spy.cleaned.push(cwd) }
}

describe('makeQgRetrievalGateConfig — retrieved-memory asymmetry (THE BRIDGE)', () => {
  it('baseline resolver uses the base (routing OFF); candidate injects the neighborhood (routing ON)', async () => {
    const db = brokerVault()
    try {
      const resolvers: Array<{ cwd: string; mem: InjectedMemoryProvider }> = []
      const cfg = makeQgRetrievalGateConfig({
        db,
        baseSearch: sentinelBase,
        makeIsolatedDir: () => fakeDir({ cleaned: [] }, `/iso/${resolvers.length}`),
        makeBackend: (cwd, mem) => {
          resolvers.push({ cwd, mem })
          return { backend: fakeBackend(cwd), getPid: () => null }
        },
      })

      cfg.makeBackends({ headCwd: '/live/root', candidateCwd: '/team/wt' })

      // first backend = baseline (routing OFF), second = candidate (routing ON)
      const task: TaskRecord = {
        ...ruleTaskRecord('rt', 'Which env var does the broker read?'),
        retrievalQuery: 'Tell me about the broker',
      }
      const baselineText = await callResolver(resolvers[0]!.mem, task)
      const candidateText = await callResolver(resolvers[1]!.mem, task)

      expect(baselineText).toContain('SENTINEL-BASE-RESULT')
      expect(baselineText).not.toContain('BROKER_DB_PATH')
      expect(candidateText).toContain('BROKER_DB_PATH')
      expect(candidateText).not.toContain('SENTINEL-BASE-RESULT')
    } finally {
      closeMemoryDb(db)
    }
  })

  it('uses task.retrievalQuery decoupled from the agent-facing intent', async () => {
    const db = brokerVault()
    try {
      let candidateResolver: InjectedMemoryProvider | null = null
      const cfg = makeQgRetrievalGateConfig({
        db,
        baseSearch: sentinelBase,
        makeIsolatedDir: () => fakeDir({ cleaned: [] }, '/iso'),
        makeBackend: (_cwd, mem) => {
          candidateResolver = mem // last assignment = candidate
          return { backend: fakeBackend('c'), getPid: () => null }
        },
      })
      cfg.makeBackends({ headCwd: '/h', candidateCwd: '/c' })

      // intent names NO entity; retrievalQuery names the broker ⇒ routing fires on the query.
      const task: TaskRecord = {
        ...ruleTaskRecord('rt', 'Name one configuration variable. Quote it exactly.'),
        retrievalQuery: 'Tell me about the broker',
      }
      const text = await callResolver(candidateResolver!, task)
      expect(text).toContain('BROKER_DB_PATH')
    } finally {
      closeMemoryDb(db)
    }
  })

  it('dispose reaps BOTH spawn PIDs and cleans BOTH isolated dirs', () => {
    const db = brokerVault()
    try {
      const cleaned: string[] = []
      const killed: Array<{ pid: number; sig: NodeJS.Signals }> = []
      let n = 0
      const cfg = makeQgRetrievalGateConfig({
        db,
        baseSearch: sentinelBase,
        makeIsolatedDir: () => {
          const cwd = `/iso/${n++}`
          return { cwd, cleanup: () => cleaned.push(cwd) }
        },
        makeBackend: (cwd) => ({ backend: fakeBackend(cwd), getPid: () => (cwd === '/iso/0' ? 1001 : 2002) }),
        isAlive: () => true,
        killByPid: (pid, sig) => killed.push({ pid, sig }),
      })
      const pair = cfg.makeBackends({ headCwd: '/h', candidateCwd: '/c' })
      pair.dispose()

      expect(killed).toEqual([
        { pid: 1001, sig: 'SIGKILL' },
        { pid: 2002, sig: 'SIGKILL' },
      ])
      expect(cleaned.sort()).toEqual(['/iso/0', '/iso/1'])
    } finally {
      closeMemoryDb(db)
    }
  })

  it('throws (no-signal) when the lazy db provider yields null', () => {
    const cfg = makeQgRetrievalGateConfig({ db: () => null })
    expect(() => cfg.makeBackends({ headCwd: '/h', candidateCwd: '/c' })).toThrow(
      /memory vault DB unavailable/,
    )
  })

  it('resolves the db provider lazily at makeBackends time', async () => {
    const db = brokerVault()
    try {
      let live: DatabaseT.Database | null = null // not yet open at config time
      const resolvers: InjectedMemoryProvider[] = []
      const cfg = makeQgRetrievalGateConfig({
        db: () => live,
        baseSearch: sentinelBase,
        makeIsolatedDir: () => fakeDir({ cleaned: [] }, `/iso/${resolvers.length}`),
        makeBackend: (_cwd, mem) => {
          resolvers.push(mem)
          return { backend: fakeBackend('x'), getPid: () => null }
        },
      })
      live = db // vault "opens" only now
      cfg.makeBackends({ headCwd: '/h', candidateCwd: '/c' })
      const text = await callResolver(resolvers[1]!, {
        ...ruleTaskRecord('rt', 'q'),
        retrievalQuery: 'Tell me about the broker',
      })
      expect(text).toContain('BROKER_DB_PATH')
    } finally {
      closeMemoryDb(db)
    }
  })

  it('the FUSION candidate consults the injected semantic-relevance scorer; the baseline does not', async () => {
    const db = brokerVault()
    try {
      const scorerCalls: Array<{ query: string }> = []
      const resolvers: InjectedMemoryProvider[] = []
      const cfg = makeQgRetrievalGateConfig({
        db,
        baseSearch: sentinelBase,
        // candidate measures MAGMA Alg.1 fusion (with its cosine-ranked semantic source)
        candidateConfig: { intentRouting: true, fusion: true },
        makeSemanticRelevanceScorer: (_db, query) => {
          scorerCalls.push({ query })
          return () => new Map<number, number>()
        },
        makeIsolatedDir: () => fakeDir({ cleaned: [] }, `/iso/${resolvers.length}`),
        makeBackend: (_cwd, mem) => {
          resolvers.push(mem)
          return { backend: fakeBackend('x'), getPid: () => null }
        },
      })
      cfg.makeBackends({ headCwd: '/h', candidateCwd: '/c' })

      const task: TaskRecord = {
        ...ruleTaskRecord('rt', 'Which env var does the broker read?'),
        retrievalQuery: 'Tell me about the broker',
      }
      await callResolver(resolvers[0]!, task) // baseline (routing OFF, no fusion)
      await callResolver(resolvers[1]!, task) // candidate (fusion ON)

      // Only the fusion candidate builds the relevance scorer — the baseline (routing off) never does.
      expect(scorerCalls).toEqual([{ query: 'Tell me about the broker' }])
    } finally {
      closeMemoryDb(db)
    }
  })
})

describe('resolveQgRetrievalCandidateConfig — env-driven candidate retrieval levers (default-OFF)', () => {
  it('no flags ⇒ { intentRouting: true } (byte-identical to today)', () => {
    expect(resolveQgRetrievalCandidateConfig({})).toEqual({ intentRouting: true })
  })

  it('SCNS_QG_RETRIEVAL_FUSION=1 ⇒ adds fusion: true', () => {
    expect(resolveQgRetrievalCandidateConfig({ SCNS_QG_RETRIEVAL_FUSION: '1' })).toEqual({
      intentRouting: true,
      fusion: true,
    })
  })

  it('semantic + timeline flags each add their lever; all three compose', () => {
    expect(
      resolveQgRetrievalCandidateConfig({
        SCNS_QG_RETRIEVAL_FUSION: '1',
        SCNS_QG_RETRIEVAL_SEMANTIC: '1',
        SCNS_QG_RETRIEVAL_TIMELINE: '1',
      }),
    ).toEqual({ intentRouting: true, fusion: true, semantic: true, timeline: true })
  })

  it('a non-"1" value does NOT enable a lever (strict opt-in)', () => {
    expect(resolveQgRetrievalCandidateConfig({ SCNS_QG_RETRIEVAL_FUSION: 'true' })).toEqual({
      intentRouting: true,
    })
  })
})

/** Invoke an injected-memory resolver (the retrieval-mode function form) for a task. */
async function callResolver(mem: InjectedMemoryProvider, task: TaskRecord): Promise<string> {
  if (typeof mem !== 'function') throw new Error('expected a per-task resolver function')
  return mem(task)
}

/** Minimal rule TaskRecord for resolver tests. */
function ruleTaskRecord(id: string, intent: string): TaskRecord {
  return {
    id,
    project: 'scns',
    intent,
    contextExcerpt: '',
    attemptedSolution: '',
    outcome: 'mixed',
    referenceKind: 'rule',
    reference: '',
    recordedScore: null,
    judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'x' }] },
    tags: ['behavioral', 'retrieval'],
    sourceSessions: [],
    split: 'val',
    origin: 'real',
    derivedFrom: '',
  }
}
