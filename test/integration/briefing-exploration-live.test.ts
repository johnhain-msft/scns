/**
 * Phase B — LIVE proof that ε-exploration reaches the BRIEFING path, with POSITIVE + NEGATIVE controls.
 *
 * ## Why this exists
 * `SCNS_EXPLORE_ROUTING=1` was set on the live broker for days and produced ZERO challenger rows,
 * because `selectExplorationArm` was only reachable from the `search:` handler while `briefing:`
 * (`POST /api/extension/context`) carried 85 of 87 recent live rows. A passing unit test would NOT have
 * caught that — the policy was correct, its CALLER was on the wrong path. So this test drives the REAL
 * built broker over HTTP and reads the resulting row out of the store.
 *
 * Isolation: HOME **and** SCNS_HOME both point at a throwaway sandbox (`resolveScnsHome()` gives
 * SCNS_HOME precedence over `homedir()`, so overriding HOME alone lets an outer SCNS_HOME leak in),
 * so `~/.scns`, the live vault and the production broker on :3456 are never touched. The child is
 * terminated by its exact PID.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import Database from 'better-sqlite3'
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

async function bootBroker(extraEnv: Record<string, string>): Promise<BootedBroker> {
  const home = mkdtempSync(join(tmpdir(), 'scns-explore-live-'))
  mkdirSync(join(home, '.scns', 'memory'), { recursive: true })
  const port = await pickFreePort()
  const child = spawn(
    process.execPath,
    [CLI_PATH, 'start', '--port', String(port), '--autonomy', '0'],
    {
      env: isolatedHomeEnv(home, {
        NODE_ENV: 'test',
        SCNS_EXPERIENCE_STORE: '1',
        SCNS_MAX_CONCURRENT_AGENTS: '1',
        ...extraEnv,
      }),
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  )
  const broker = { child, port, home }
  booted.push(broker)
  if (!(await waitForHealth(port, 90_000))) throw new Error(`broker on :${port} never healthy`)
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
}, 90_000)

interface ExpRow {
  id: number
  retriever: string
  explore_arm: string | null
  propensity: number | null
  flag_state: string | null
  query_text: string
}

function readRows(home: string): ExpRow[] {
  const db = new Database(join(home, '.scns', 'memory', 'experience.db'), { readonly: true })
  try {
    return db
      .prepare(
        `SELECT id, retriever, explore_arm, propensity, flag_state, query_text
           FROM retrieval_experience ORDER BY id`,
      )
      .all() as ExpRow[]
  } finally {
    db.close()
  }
}

async function seed(base: string): Promise<void> {
  const stored = await fetch(`${base}/api/memory/store`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      key: 'notes/broker.md',
      value: 'The broker port decision: SCNS pinned the local broker to port 3456 permanently.',
    }),
  })
  expect(stored.ok).toBe(true)
}

async function briefing(base: string, prompt: string): Promise<Response> {
  return fetch(`${base}/api/extension/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      sessionId: 'sess-explore-control',
      cwd: '/tmp/explore-control',
      clientTimeoutMs: 5000,
    }),
  })
}

const HUMAN_PROMPT = 'what did I decide about the broker port and why does it matter for the loop'
const MACHINE_PROMPT =
  'You are a strict news-desk fact-checker. Verify the broker port claim end to end.'

d('Phase B — exploration reaches the LIVE briefing path (pos + neg controls)', () => {
  it('POSITIVE CONTROL: lever ON + forced ε ⇒ the briefing row carries the CHALLENGER arm and a non-null propensity', async () => {
    // ε=1 forces the explore branch deterministically (no RNG injection needed through HTTP), so the
    // assertion is on the WIRING, not on a coin flip.
    const b = await bootBroker({ SCNS_EXPLORE_ROUTING: '1', SCNS_EXPLORE_EPSILON: '1' })
    const base = `http://127.0.0.1:${b.port}`
    await seed(base)
    const vault = snapshotVault(join(b.home, '.scns', 'memory', 'vault.db'))

    const res = await briefing(base, HUMAN_PROMPT)
    expect(res.ok).toBe(true)

    const rows = readRows(b.home).filter((r) => r.query_text === HUMAN_PROMPT)
    expect(rows.length).toBe(1)
    const row = rows[0]!
    // THE claim: a challenger arm on the briefing path, with a real selection propensity.
    expect(row.explore_arm).toBe('multihop-iter')
    expect(row.propensity).not.toBeNull()
    expect(row.propensity).toBeCloseTo(1, 6) // ε/|challengers| = 1/1
    // The SERVED retrieval really ran the challenger's config (not just a relabelled magma row).
    const flags = JSON.parse(row.flag_state ?? '{}') as {
      multiHop?: boolean
      traverse?: boolean
      exploreArm?: string
    }
    expect(flags.multiHop).toBe(true)
    expect(flags.traverse).toBeFalsy()
    expect(flags.exploreArm).toBe('multihop-iter')
    assertVaultUnchanged(vault)
  }, 180_000)

  it('NEGATIVE CONTROL: lever OFF ⇒ incumbent config, and explore_arm/propensity stay NULL', async () => {
    const b = await bootBroker({ SCNS_EXPLORE_ROUTING: '0', SCNS_EXPLORE_EPSILON: '1' })
    const base = `http://127.0.0.1:${b.port}`
    await seed(base)

    const res = await briefing(base, HUMAN_PROMPT)
    expect(res.ok).toBe(true)

    const rows = readRows(b.home).filter((r) => r.query_text === HUMAN_PROMPT)
    expect(rows.length).toBe(1)
    const row = rows[0]!
    // Inverting the lever must invert the outcome — otherwise the positive control proves nothing.
    expect(row.explore_arm).toBeNull()
    expect(row.propensity).toBeNull()
    expect(row.retriever).toBe('magma')
    const flags = JSON.parse(row.flag_state ?? '{}') as { multiHop?: boolean; traverse?: boolean }
    expect(flags.traverse).toBe(true) // the unchanged magma incumbent config
    expect(flags.multiHop).toBeFalsy()
  }, 180_000)

  it('AUTHORSHIP CONTROL: lever ON but a MACHINE-authored prompt is never explored (budget is not burned)', async () => {
    const b = await bootBroker({ SCNS_EXPLORE_ROUTING: '1', SCNS_EXPLORE_EPSILON: '1' })
    const base = `http://127.0.0.1:${b.port}`
    await seed(base)

    expect((await briefing(base, MACHINE_PROMPT)).ok).toBe(true)
    expect((await briefing(base, HUMAN_PROMPT)).ok).toBe(true)

    const rows = readRows(b.home)
    const machine = rows.find((r) => r.query_text === MACHINE_PROMPT)!
    const human = rows.find((r) => r.query_text === HUMAN_PROMPT)!
    // A machine prompt can never settle, so it must not consume challenger exposure — and it must not
    // be recorded as a policy draw it never was.
    expect(machine.explore_arm).toBeNull()
    expect(machine.propensity).toBeNull()
    // …while the human prompt in the SAME broker process still explores (proves the gate is the
    // authorship signal, not a dead lever).
    expect(human.explore_arm).toBe('multihop-iter')
    expect(human.propensity).not.toBeNull()
  }, 180_000)

  it('ARM DIVERSITY: an exploit draw records the INCUMBENT arm with propensity 1−ε (≥2 arms become visible)', async () => {
    // A vanishingly small ε makes the exploit branch deterministic in practice (P(explore)=1e-9).
    const b = await bootBroker({ SCNS_EXPLORE_ROUTING: '1', SCNS_EXPLORE_EPSILON: '0.000000001' })
    const base = `http://127.0.0.1:${b.port}`
    await seed(base)
    expect((await briefing(base, HUMAN_PROMPT)).ok).toBe(true)

    const row = readRows(b.home).find((r) => r.query_text === HUMAN_PROMPT)!
    expect(row.explore_arm).toBe('magma') // the incumbent, recorded as an explicit policy draw
    expect(row.propensity).not.toBeNull()
    expect(row.propensity!).toBeCloseTo(1 - 1e-9, 6)
    const flags = JSON.parse(row.flag_state ?? '{}') as { traverse?: boolean; multiHop?: boolean }
    expect(flags.traverse).toBe(true)
    expect(flags.multiHop).toBeFalsy()
  }, 180_000)
})
