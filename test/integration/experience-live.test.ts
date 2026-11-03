/**
 * T026 [US2] (specs/001-learning-memory-loop) — LIVE experience capture, end-to-end.
 *
 * Boots the REAL built broker (`dist/cli.js start`) on an ephemeral port with HOME **and** SCNS_HOME
 * isolated to a throwaway sandbox (SCNS_HOME outranks `homedir()`, so pinning HOME alone would let an
 * outer SCNS_HOME leak in and defeat the sandbox — so `~/.scns` and the production broker on :3456 are
 * never touched), drives live prompts through the real `/api/memory/search` route → the cli memorySearch
 * adapter → `intentAwareSearch` → `logRetrievalExperience`, and asserts:
 *   - one row per attempt with all seven spec fields under one returned `experienceId` (FR-007),
 *   - the human verdict settles that EXACT id (per-attempt, 0% topic-only — SC-005),
 *   - the sandbox vault mtime/size are unchanged by searching (read-only),
 *   - FAIL-SAFE negative: with the experience store unopenable, the answer path still serves
 *     (byte-identical shape, no experienceId) and nothing crashes.
 *
 * The child is terminated by its exact PID (child.kill) — never by name.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import Database from 'better-sqlite3'
import { openExperienceStore, settleHumanOutcome } from '../../src/memory/experience-store.js'
import { snapshotVault, assertVaultUnchanged, isolatedHomeEnv } from '../helpers/isolation.js'

const REPO_ROOT = resolve(__dirname, '..', '..')
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js')
const d = existsSync(CLI_PATH) ? describe : describe.skip

function pickFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const p = addr.port
        srv.close(() => res(p))
      } else {
        srv.close()
        rej(new Error('failed to pick free port'))
      }
    })
  })
}

async function waitForHealth(port: number, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) return true
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

interface BootedBroker {
  readonly child: ChildProcess
  readonly port: number
  readonly home: string
}

const booted: BootedBroker[] = []

async function bootBroker(prepareHome?: (home: string) => void): Promise<BootedBroker> {
  const home = mkdtempSync(join(tmpdir(), 'scns-exp-live-'))
  mkdirSync(join(home, '.scns', 'memory'), { recursive: true })
  prepareHome?.(home)
  const port = await pickFreePort()
  const child = spawn(
    process.execPath,
    [CLI_PATH, 'start', '--port', String(port), '--autonomy', '0'],
    {
      env: isolatedHomeEnv(home, {
        NODE_ENV: 'test',
        SCNS_EXPERIENCE_STORE: '1',
        SCNS_MAX_CONCURRENT_AGENTS: '1',
      }),
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  )
  const broker = { child, port, home }
  booted.push(broker)
  const healthy = await waitForHealth(port, 90_000)
  if (!healthy) throw new Error(`broker on :${port} never became healthy`)
  return broker
}

async function stopBroker(b: BootedBroker): Promise<void> {
  b.child.kill('SIGTERM') // exact child PID only — never by name
  await new Promise<void>((res) => {
    const t = setTimeout(() => {
      try {
        b.child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      res()
    }, 10_000)
    b.child.once('exit', () => {
      clearTimeout(t)
      res()
    })
  })
  rmSync(b.home, { recursive: true, force: true })
}

afterAll(async () => {
  for (const b of booted) await stopBroker(b)
}, 60_000)

d('T026 — live experience capture through the real broker', () => {
  it('records one seven-field row per live attempt; the verdict binds the exact returned id; the vault is untouched', async () => {
    const b = await bootBroker()
    const base = `http://127.0.0.1:${b.port}`

    // Seed real memory content through the live store route (indexes synchronously).
    const stored = await fetch(`${base}/api/memory/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'notes/broker.md',
        value: 'The broker port decision: SCNS pinned the local broker to port 3456 permanently.',
      }),
    })
    expect(stored.ok).toBe(true)

    const vaultPath = join(b.home, '.scns', 'memory', 'vault.db')
    const before = snapshotVault(vaultPath)
    expect(before.exists).toBe(true)

    // Drive two live prompts — SAME topic, so only per-attempt ids can separate them.
    const q = 'what did I decide about the broker port'
    const r1 = (await (
      await fetch(`${base}/api/memory/search?q=${encodeURIComponent(q)}`)
    ).json()) as {
      results: readonly { chunkId: number; content: string }[]
      experienceId?: number
    }
    const r2 = (await (
      await fetch(`${base}/api/memory/search?q=${encodeURIComponent(q)}`)
    ).json()) as {
      results: readonly { chunkId: number; content: string }[]
      experienceId?: number
    }

    expect(Array.isArray(r1.results)).toBe(true)
    expect(r1.results.length).toBeGreaterThan(0) // the seeded note is retrievable live
    expect(r1.experienceId).toBeGreaterThan(0)
    expect(r2.experienceId).toBeGreaterThan(r1.experienceId!) // one NEW id per attempt

    // Searching is read-only on the vault (mtime+size unchanged).
    assertVaultUnchanged(before)

    // The row carries the seven spec fields under the RETURNED id.
    const expDb = new Database(join(b.home, '.scns', 'memory', 'experience.db'), {
      readonly: true,
    })
    const row = expDb
      .prepare('SELECT * FROM retrieval_experience WHERE id = ?')
      .get(r1.experienceId) as {
      query_text: string
      retriever: string
      flag_state: string
      explore_arm: string | null
      propensity: number | null
      retrieved_chunk_ids: string
      gen_answer: string | null
      judge_score: number | null
      tokens: number | null
      human_outcome: number | null
    }
    expDb.close()
    expect(row.query_text).toBe(q)
    expect(row.retriever).toBe('hybrid') // exploit-only live default
    expect(row.explore_arm).toBe('hybrid')
    expect(row.propensity).toBe(1) // deterministic exploit policy μ=1
    expect(JSON.parse(row.flag_state)).toMatchObject({ exploreArm: 'hybrid', propensity: 1 })
    expect(JSON.parse(row.retrieved_chunk_ids).length).toBeGreaterThan(0)
    // Live: no judge, no verdict yet — NULL, never fabricated.
    expect(row.gen_answer).toBeNull()
    expect(row.judge_score).toBeNull()
    expect(row.human_outcome).toBeNull()

    // Per-attempt human binding: settle the EXACT first id; the same-topic sibling stays NULL.
    const store = openExperienceStore(join(b.home, '.scns', 'memory', 'experience.db'))
    expect(settleHumanOutcome(store, r1.experienceId!, 1.0)).toBe(true)
    const settled = store.db
      .prepare('SELECT id, human_outcome FROM retrieval_experience WHERE id IN (?, ?) ORDER BY id')
      .all(r1.experienceId, r2.experienceId) as { id: number; human_outcome: number | null }[]
    expect(settled[0]!.human_outcome).toBe(1.0)
    expect(settled[1]!.human_outcome).toBeNull() // 0% topic-only attribution
    store.close()

    await stopBroker(b)
    booted.splice(booted.indexOf(b), 1)
  }, 240_000)

  it('FAIL-SAFE negative: an unopenable experience store never breaks the live answer path', async () => {
    const b = await bootBroker((home) => {
      // Pre-create experience.db as a DIRECTORY so openExperienceStore fails at boot.
      mkdirSync(join(home, '.scns', 'memory', 'experience.db'), { recursive: true })
    })
    const base = `http://127.0.0.1:${b.port}`
    const r = (await (
      await fetch(`${base}/api/memory/search?q=${encodeURIComponent('broker port')}`)
    ).json()) as { results?: unknown; experienceId?: number }
    expect(Array.isArray(r.results)).toBe(true) // the production answer path still serves
    expect(r.experienceId).toBeUndefined() // no fabricated id when logging is dead

    await stopBroker(b)
    booted.splice(booted.indexOf(b), 1)
  }, 240_000)
})

// ── T038 [US3] — live SHADOWED exploration: logged, never returned (go-live-to-measure) ─────────
d('T038 — bounded shadowed exploration on the live path', () => {
  it(
    'with SCNS_EXPLORE_ROUTING=1 an explore draw logs a variant-arm row with its propensity while the served answer stays hybrid',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'scns-exp-live-'))
      mkdirSync(join(home, '.scns', 'memory'), { recursive: true })
      const port = await pickFreePort()
      const child = spawn(
        process.execPath,
        [CLI_PATH, 'start', '--port', String(port), '--autonomy', '0'],
        {
          env: isolatedHomeEnv(home, {
            NODE_ENV: 'test',
            SCNS_EXPERIENCE_STORE: '1',
            SCNS_EXPLORE_ROUTING: '1',
            SCNS_EXPLORE_EPSILON: '0.95', // P(no explore in 6 draws) < 1e-7 — deterministic enough
            SCNS_MAX_CONCURRENT_AGENTS: '1',
          }),
          stdio: ['ignore', 'ignore', 'ignore'],
        },
      )
      const b = { child, port, home }
      booted.push(b)
      expect(await waitForHealth(port, 90_000)).toBe(true)
      const base = `http://127.0.0.1:${port}`

      await fetch(`${base}/api/memory/store`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: 'notes/explore.md',
          value: 'The exploration bound decision: shadow arms are logged and never served.',
        }),
      })

      for (let i = 0; i < 6; i++) {
        const r = (await (
          await fetch(`${base}/api/memory/search?q=${encodeURIComponent('exploration bound decision')}`)
        ).json()) as { results: readonly unknown[] }
        expect(Array.isArray(r.results)).toBe(true) // the served answer always exists (hybrid)
      }

      const expDb = new Database(join(home, '.scns', 'memory', 'experience.db'), { readonly: true })
      const shadow = expDb
        .prepare(
          `SELECT explore_arm, propensity, retriever FROM retrieval_experience
            WHERE explore_arm IN ('magma','multihop-iter') AND propensity IS NOT NULL`,
        )
        .all() as { explore_arm: string; propensity: number; retriever: string }[]
      const served = expDb
        .prepare(`SELECT COUNT(*) n FROM retrieval_experience WHERE explore_arm = 'hybrid'`)
        .get() as { n: number }
      expDb.close()

      // At ε=0.95 across 6 draws at least one shadow row exists (P(fail) < 1e-7), each carrying the
      // uniform-arm propensity ε/|arms| = 0.475 ∈ (0,1] — the off-policy tuple IPS/DR needs.
      expect(shadow.length).toBeGreaterThan(0)
      for (const s of shadow) {
        expect(s.propensity).toBeCloseTo(0.475, 5)
        expect(['magma', 'multihop-iter']).toContain(s.explore_arm)
      }
      // Every SERVED row is hybrid — the production answer never followed the explored arm.
      expect(served.n).toBe(6)

      await stopBroker(b)
      booted.splice(booted.indexOf(b), 1)
    },
    240_000,
  )
})
