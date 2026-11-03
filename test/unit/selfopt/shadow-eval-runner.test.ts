/**
 * Phase-1 wedge 5 — the default-OFF opt-in runner.
 *
 * Proves the env opt-ins and isolation WITHOUT ever spawning a real copilot,
 * running real git, or touching the network:
 *   - default-OFF: neither makeBackend nor makeWorktree is constructed;
 *   - real-val opt-in mines a fixture broker DB (readonly) into the report;
 *   - ACP opt-in builds the backend with the isolated worktree cwd, labels the
 *     report 'acp', and ALWAYS tears the worktree down (even on throw);
 *   - the real `AcpReplayBackend` is exercised through the runner with an
 *     INJECTED fake `AcpClient` (no spawn);
 *   - `createDetachedWorktree` honours `SCNS_SELFOPT_ACP_WORKTREE_DIR` via an
 *     injected git-exec spy (no real git).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createVault } from '../../../src/memory/vault.js'
import { BLOCK_START, BLOCK_END } from '../../../src/memory/negative-memory-applicator.js'
import { TARGET_FILE } from '../../../src/memory/gated-negative-memory-applicator.js'
import {
  runShadowEvalWithOptIns,
  createDetachedWorktree,
} from '../../../src/selfopt/shadow-eval-runner.js'
import type { GitExec } from '../../../src/selfopt/shadow-eval-runner.js'
import { AcpReplayBackend } from '../../../src/selfopt/acp-replay-backend.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPromptResult,
} from '../../../src/broker/services/acp-client.js'
import type { ReplayBackend } from '../../../src/selfopt/replay.js'
import { openDatabase } from '../../../src/broker/storage/db.js'
import { appendEvent } from '../../../src/broker/storage/repositories/event-repository.js'

const SAFE_RULE = 'Prefer small, focused commits.'
const SOURCE_CONTENT = `# Copilot instructions\n\nSome preamble.\n\n${BLOCK_START}\n${BLOCK_END}\n\nTrailer.\n`

let tmpRoot: string
let vaultDir: string
let projectDir: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'runner-test-'))
  vaultDir = join(tmpRoot, 'vault')
  projectDir = join(tmpRoot, 'project')
  mkdirSync(vaultDir, { recursive: true })
  mkdirSync(join(projectDir, '.github'), { recursive: true })
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function seedSafeRule(): void {
  const vault = createVault({ rootDir: vaultDir })
  vault.write(
    'negative/mem-safe.md',
    `---
id: mem-safe
dontRule: ${SAFE_RULE}
category: frustration
target: general
confidence: 0.9
source: heuristic
criticStatus: keep
criticSource: heuristic
criticReviewedAt: 2026-01-01T00:00:00.000Z
targetApplied: false
createdAt: 2026-01-01T00:00:00.000Z
---
Original feedback text`,
  )
}

function writeLiveFixture(): void {
  writeFileSync(join(projectDir, TARGET_FILE), SOURCE_CONTENT, 'utf-8')
}

function buildFixtureBrokerDb(): string {
  const dbPath = join(tmpRoot, 'broker-fixture.db')
  const db = openDatabase(dbPath)
  const specs = [
    { team: 'team-a', passed: true, score: 1.0, qcid: 'qc-a' },
    { team: 'team-b', passed: false, score: 0.45, qcid: 'qc-b' },
    { team: 'team-c', passed: true, score: 0.8, qcid: 'qc-c' },
    { team: 'team-d', passed: false, score: 0.2, qcid: 'qc-d' },
  ]
  for (const s of specs) {
    appendEvent(db, {
      event_type: 'team_completed',
      session_id: null,
      payload: JSON.stringify({
        teamId: s.team,
        memberSessionIds: [`${s.team}-s`],
        stagedDiff: `diff --git a/src/${s.team}.ts b/src/${s.team}.ts\n@@ -1 +1 @@\n-old\n+new\n`,
        aggregateOutcome: 'completed',
        completedAt: '2026-06-13T00:00:01Z',
      }),
    })
    appendEvent(db, {
      event_type: 'quality_gate_verdict',
      session_id: null,
      payload: JSON.stringify({
        team_id: s.team,
        passed: s.passed,
        score: s.score,
        reason: 'r',
        branch: `scns/auto/${s.team}`,
        sourceSuggestionId: null,
        qualityCheckId: s.qcid,
      }),
    })
  }
  db.close()
  return dbPath
}

/** A spy ReplayBackend (no spawn) mimicking MockBackend's response shape. */
function spyBackend(): ReplayBackend {
  return {
    attempt(task, skill, memory) {
      return `${skill}\n${memory}\n${task.intent}`.trim()
    },
  }
}

// ── Fake AcpClient (no process spawn, no network) for the T15 integration ────
interface ClientSpy {
  factoryCalls: number
  sessionCwd: string | null
  prompt: string | null
  closed: boolean
}
function freshSpy(): ClientSpy {
  return { factoryCalls: 0, sessionCwd: null, prompt: null, closed: false }
}
function fakeFactory(spy: ClientSpy, output = 'ok'): (opts: AcpClientOptions) => AcpClient {
  return (_opts: AcpClientOptions): AcpClient => {
    spy.factoryCalls++
    return {
      async initialize() {
        return { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0' } }
      },
      async createSession(cwd: string) {
        spy.sessionCwd = cwd
        return 'sess-1'
      },
      async sendPrompt(_sessionId: string, prompt: string): Promise<AcpPromptResult> {
        spy.prompt = prompt
        return { stopReason: 'end_turn', output }
      },
      onUpdate() {},
      getAvailableCommands() {
        return null
      },
      cancelSession() {},
      async close() {
        spy.closed = true
      },
      state: 'ready',
      pid: null,
      timings: {
        processSpawnStartedAt: null,
        initializeResolvedAt: null,
        sessionNewStartedAt: null,
        sessionNewResolvedAt: null,
      },
    }
  }
}

describe('runShadowEvalWithOptIns — default-OFF + opt-ins (no spawn/git/network)', () => {
  it('T11: default-OFF — never builds a backend or worktree; Mock-only, report null', async () => {
    seedSafeRule()
    writeLiveFixture()
    const makeBackend = vi.fn()
    const makeWorktree = vi.fn()

    const res = await runShadowEvalWithOptIns({
      vault: createVault({ rootDir: vaultDir }),
      projectRoot: projectDir,
      brokerDbPath: join(tmpRoot, 'unused.db'),
      env: {},
      makeBackend,
      makeWorktree,
    })

    expect(makeBackend).not.toHaveBeenCalled()
    expect(makeWorktree).not.toHaveBeenCalled()
    expect(res.report).toBeNull()
    expect(res.adopted.map((a) => a.rule)).toEqual([SAFE_RULE])
  })

  it('T12: SHADOW_REAL_VAL only — mines a real val report (mock), no worktree/backend', async () => {
    seedSafeRule()
    writeLiveFixture()
    const dbPath = buildFixtureBrokerDb()
    const makeBackend = vi.fn()
    const makeWorktree = vi.fn()

    const res = await runShadowEvalWithOptIns({
      vault: createVault({ rootDir: vaultDir }),
      projectRoot: projectDir,
      brokerDbPath: dbPath,
      env: { SCNS_SELFOPT_SHADOW_REAL_VAL: '1' },
      makeBackend,
      makeWorktree,
    })

    expect(makeWorktree).not.toHaveBeenCalled()
    expect(makeBackend).not.toHaveBeenCalled()
    expect(res.report).not.toBeNull()
    expect(res.report!.backendLabel).toBe('mock')
    expect(res.report!.nTasks).toBeGreaterThanOrEqual(1)
  })

  it('T13: ACP+REAL_VAL — backend built with the isolated cwd; report labelled acp; cleanup runs', async () => {
    seedSafeRule()
    writeLiveFixture()
    const dbPath = buildFixtureBrokerDb()
    const fakeWt = { cwd: '/tmp/iso-wt', cleanup: vi.fn() }
    const makeWorktree = vi.fn(() => fakeWt)
    let seenCwd: string | null = null
    const makeBackend = vi.fn((cwd: string) => {
      seenCwd = cwd
      return spyBackend()
    })

    const res = await runShadowEvalWithOptIns({
      vault: createVault({ rootDir: vaultDir }),
      projectRoot: projectDir,
      brokerDbPath: dbPath,
      env: { SCNS_SELFOPT_ACP_REPLAY: '1', SCNS_SELFOPT_SHADOW_REAL_VAL: '1' },
      makeWorktree,
      makeBackend,
    })

    expect(makeWorktree).toHaveBeenCalledTimes(1)
    expect(makeBackend).toHaveBeenCalledTimes(1)
    expect(seenCwd).toBe('/tmp/iso-wt')
    expect(res.report).not.toBeNull()
    expect(res.report!.backendLabel).toBe('acp')
    expect(fakeWt.cleanup).toHaveBeenCalledTimes(1)
  })

  it('T14: worktree cleanup runs even when the eval throws', async () => {
    seedSafeRule()
    writeLiveFixture()
    const dbPath = buildFixtureBrokerDb()
    const fakeWt = { cwd: '/tmp/iso-wt', cleanup: vi.fn() }
    const throwingBackend: ReplayBackend = {
      attempt() {
        throw new Error('boom-from-backend')
      },
    }

    await expect(
      runShadowEvalWithOptIns({
        vault: createVault({ rootDir: vaultDir }),
        projectRoot: projectDir,
        brokerDbPath: dbPath,
        env: { SCNS_SELFOPT_ACP_REPLAY: '1', SCNS_SELFOPT_SHADOW_REAL_VAL: '1' },
        makeWorktree: () => fakeWt,
        makeBackend: () => throwingBackend,
      }),
    ).rejects.toThrow(/boom-from-backend/)

    expect(fakeWt.cleanup).toHaveBeenCalledTimes(1)
  })

  it('T15: real AcpReplayBackend via runner uses an INJECTED fake AcpClient (no spawn)', async () => {
    seedSafeRule()
    writeLiveFixture()
    const dbPath = buildFixtureBrokerDb()
    const spy = freshSpy()
    const fakeWt = { cwd: '/tmp/iso', cleanup: vi.fn() }

    const res = await runShadowEvalWithOptIns({
      vault: createVault({ rootDir: vaultDir }),
      projectRoot: projectDir,
      brokerDbPath: dbPath,
      env: { SCNS_SELFOPT_ACP_REPLAY: '1', SCNS_SELFOPT_SHADOW_REAL_VAL: '1' },
      makeWorktree: () => fakeWt,
      makeBackend: (cwd: string) =>
        new AcpReplayBackend({ cwd, createClient: fakeFactory(spy, 'ok verified') }),
    })

    expect(spy.factoryCalls).toBeGreaterThan(0)
    expect(spy.sessionCwd).toBe('/tmp/iso')
    expect(spy.closed).toBe(true)
    expect(res.report!.backendLabel).toBe('acp')
    expect(fakeWt.cleanup).toHaveBeenCalledTimes(1)
  })
})

describe('createDetachedWorktree — env dir + injected git-exec (no real git)', () => {
  it('T16: honours SCNS_SELFOPT_ACP_WORKTREE_DIR and issues the right git args', () => {
    const base = mkdtempSync(join(tmpdir(), 'scns-wt-base-'))
    try {
      const calls: string[][] = []
      const exec: GitExec = (args) => {
        calls.push([...args])
      }

      const wt = createDetachedWorktree(
        '/fake/project',
        { SCNS_SELFOPT_ACP_WORKTREE_DIR: base } as NodeJS.ProcessEnv,
        exec,
      )

      expect(wt.cwd.startsWith(base)).toBe(true)
      expect(existsSync(wt.cwd)).toBe(true)
      expect(calls[0]).toEqual(['-C', '/fake/project', 'worktree', 'add', '--detach', wt.cwd, 'HEAD'])

      wt.cleanup()
      expect(calls[1]).toEqual(['-C', '/fake/project', 'worktree', 'remove', '--force', wt.cwd])
      expect(existsSync(wt.cwd)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
