/**
 * WI-3 — Repo-isolation integration proof (the v1 work-machine guarantee).
 *
 * Spawns REAL broker processes (the actual `scns start` daemon path, run from
 * source via tsx) exactly the way the meta-supervisor would: two child brokers
 * built from `buildChildSpawnSpec` with distinct per-project SCNS_HOMEs, plus
 * a global broker owning the meta registry. Then proves:
 *
 *   1. a fact stored into project A's child is INVISIBLE to project B's child
 *      (memory search AND context injection),
 *   2. /api/meta/resolve routes each project root (and subdirectories) to the
 *      RIGHT child broker,
 *   3. an unregistered path resolves `resolved:false` — the global-fallback
 *      hazard the extension logs as `global:fallback`.
 *
 * The win32 branch of the resolve/normalization helpers feeding this flow is
 * unit-tested in test/unit/shared/paths.test.ts and the registry win32
 * describe blocks — that is the from-Mac stand-in for running this suite on
 * native Windows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

import {
  applyMetaSchema,
  registerProject,
  updateChildState,
} from '../../../src/meta-broker/registry.js'
import { buildChildSpawnSpec } from '../../../src/meta-broker/meta-supervisor.js'
import { deriveProjectId } from '../../../src/broker/project-identity.js'
import { nodeBinArgv } from '../../helpers/node-bin.js'

const REPO_ROOT = resolve(__dirname, '../../..')
// Run tsx's real entry point under the CURRENT interpreter rather than the
// extensionless `node_modules/.bin/tsx` shim, which is unspawnable on Windows.
// See test/helpers/node-bin.ts for why the `.cmd` sibling is not the fix.
const [NODE_BIN, TSX_CLI] = nodeBinArgv(REPO_ROOT, 'tsx')
const CLI = join(REPO_ROOT, 'src', 'cli.ts')

const MARKER = 'zebra-quantum-isolation-marker-wi3'

interface BrokerProc {
  readonly proc: ChildProcess
  readonly port: number
}

async function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => res(port))
    })
    srv.on('error', rej)
  })
}

/**
 * `/health` goes green before the memory subsystem finishes wiring: until
 * `deps.memoryStore` / `deps.memorySearch` are set, `POST /api/memory/store`
 * answers 503 `Memory store not initialized` and `GET /api/memory/search`
 * answers `available:false`. In isolation that gap is invisible; under
 * full-suite load it was wide enough for the first store POST to lose the race.
 *
 * Poll the READ-ONLY search route — polling the store route would write probe
 * rows into the very corpus the isolation assertions then read.
 */
async function waitForMemoryReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const out = await getJson(port, '/api/memory/search?q=readiness-probe')
      if (out?.available !== false) return
    } catch {
      // broker still wiring
    }
    if (Date.now() > deadline) {
      throw new Error(`memory store on :${port} not ready in ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const r = spawnSync('git', ['init', '-q'], { cwd: dir })
  if (r.status !== 0) throw new Error(`git init failed in ${dir}`)
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`broker on :${port} not healthy in ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

function spawnBroker(env: Record<string, string>, port: number): BrokerProc {
  const proc = spawn(NODE_BIN, [TSX_CLI, CLI, 'start', '--port', String(port), '--autonomy', '0'], {
    env: {
      ...process.env,
      ...env,
      // Keep test children quiet + fully self-contained: no machine-wide
      // observation, no experience store, no live traffic.
      OBSERVE_ACTIVE_APP_ENABLED: 'false',
      OBSERVE_SESSION_STORE_ENABLED: 'false',
    },
    stdio: 'ignore',
  })
  return { proc, port }
}

async function getJson(port: number, path: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(8000),
  })
  return res.json()
}

async function postJson(port: number, path: string, body: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  return res.json()
}

describe('WI-3 — per-repo isolation across child brokers (real processes)', () => {
  let root: string
  let repoA: string
  let repoB: string
  let idA: string
  let idB: string
  let global_: BrokerProc | undefined
  let childA: BrokerProc | undefined
  let childB: BrokerProc | undefined

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'scns-wi3-'))
    repoA = join(root, 'projects', 'repoA')
    repoB = join(root, 'projects', 'repoB')
    const repoG = join(root, 'projects', 'repoG')
    gitInit(repoA)
    gitInit(repoB)
    gitInit(repoG)
    idA = deriveProjectId(repoA)
    idB = deriveProjectId(repoB)

    // Global broker home owns the meta registry (exactly where the live
    // global broker reads it: <SCNS_HOME>/.scns/meta-broker.db).
    const homeG = join(root, 'homeG')
    mkdirSync(join(homeG, '.scns'), { recursive: true })
    const registryDb = new Database(join(homeG, '.scns', 'meta-broker.db'))
    applyMetaSchema(registryDb)
    registerProject(registryDb, { projectId: idA, projectRoot: repoA })
    registerProject(registryDb, { projectId: idB, projectRoot: repoB })

    const [portG, portA, portB] = [await getFreePort(), await getFreePort(), await getFreePort()]

    // Child spawn specs — the same contract the meta-supervisor uses, with
    // per-project SCNS_HOME/db under <projectDbDir>/<id>/ (supervisor layout).
    const projectDbDir = join(root, 'children')
    const specs = [
      { id: idA, repo: repoA, port: portA },
      { id: idB, repo: repoB, port: portB },
    ].map(({ id, repo, port }) => {
      const spec = buildChildSpawnSpec({
        brokerEntry: CLI,
        projectRoot: repo,
        projectId: id,
        dbPath: join(projectDbDir, id, 'data.db'),
        scnsHome: join(projectDbDir, id, 'home'),
        port,
        instanceId: `wi3-${id}`,
      })
      mkdirSync(join(projectDbDir, id, 'home'), { recursive: true })
      return { id, port, spec }
    })

    // The supervisor records each child's bound state; meta-resolve refuses to
    // route to a child that isn't running, so mirror that bookkeeping here.
    for (const { id, port } of specs) {
      updateChildState(registryDb, id, {
        status: 'running',
        boundPort: port,
        childPid: 0,
        instanceId: `wi3-${id}`,
        lastSeenAt: new Date().toISOString(),
      })
    }
    registryDb.close()

    global_ = spawnBroker(
      {
        SCNS_HOME: homeG,
        BROKER_DB_PATH: join(homeG, 'broker.db'),
        BROKER_PROJECT_ROOT: repoG,
      },
      portG,
    )
    childA = spawnBroker({ ...specs[0]!.spec.env }, portA)
    childB = spawnBroker({ ...specs[1]!.spec.env }, portB)

    await Promise.all([
      waitForHealth(portG, 90_000),
      waitForHealth(portA, 90_000),
      waitForHealth(portB, 90_000),
    ])
    // Health is not readiness — see waitForMemoryReady.
    await Promise.all([waitForMemoryReady(portA, 60_000), waitForMemoryReady(portB, 60_000)])
  }, 120_000)

  afterAll(async () => {
    for (const b of [childA, childB, global_]) {
      if (b) b.proc.kill('SIGTERM')
    }
    // Give the daemons a moment to shut down before removing their homes.
    await new Promise((r) => setTimeout(r, 1500))
    for (const b of [childA, childB, global_]) {
      if (b && !b.proc.killed) b.proc.kill('SIGKILL')
    }
    rmSync(root, { recursive: true, force: true })
  }, 30_000)

  it('routes each project root and its subdirectories to the right child', async () => {
    const a = await getJson(global_!.port, `/api/meta/resolve?path=${encodeURIComponent(repoA)}`)
    expect(a.resolved).toBe(true)
    expect(a.projectId).toBe(idA)
    expect(a.boundPort).toBe(childA!.port)
    expect(a.brokerUrl).toBe(`http://127.0.0.1:${childA!.port}`)

    const bSub = await getJson(
      global_!.port,
      `/api/meta/resolve?path=${encodeURIComponent(join(repoB, 'src', 'deep'))}`,
    )
    expect(bSub.resolved).toBe(true)
    expect(bSub.projectId).toBe(idB)
    expect(bSub.boundPort).toBe(childB!.port)
  }, 30_000)

  it('resolves an unregistered path to resolved:false (the global-fallback hazard)', async () => {
    const out = await getJson(
      global_!.port,
      `/api/meta/resolve?path=${encodeURIComponent(join(root, 'projects', 'unregistered'))}`,
    )
    expect(out.resolved).toBe(false)
    expect(out.reason).toBe('no-project-for-path')
  }, 30_000)

  it('a fact stored in child A is searchable in A and INVISIBLE in child B', async () => {
    const stored = await postJson(childA!.port, '/api/memory/store', {
      key: 'wi3-isolation-marker',
      value: `The secret launch codename is ${MARKER}.`,
    })
    expect(stored.error ?? null).toBeNull()

    // Child A sees its own fact (poll briefly — indexing may lag the write).
    let hitA = false
    for (let i = 0; i < 20 && !hitA; i++) {
      const res = await getJson(childA!.port, `/api/memory/search?q=${MARKER}`)
      const results = (res.results ?? []) as Array<{ content?: string }>
      hitA = results.some((r) => (r.content ?? '').includes(MARKER))
      if (!hitA) await new Promise((r) => setTimeout(r, 500))
    }
    expect(hitA).toBe(true)

    // Child B must see NOTHING — distinct SCNS_HOME ⇒ distinct vault.
    const resB = await getJson(childB!.port, `/api/memory/search?q=${MARKER}`)
    const resultsB = (resB.results ?? []) as Array<{ content?: string }>
    expect(resultsB.some((r) => (r.content ?? '').includes(MARKER))).toBe(false)
  }, 60_000)

  it("child B's context injection never leaks A's fact", async () => {
    const ctx = await postJson(childB!.port, '/api/extension/context', {
      prompt: `What is the secret launch codename ${MARKER}?`,
    })
    const injected = String(ctx.context ?? ctx.additionalContext ?? '')
    expect(injected).not.toContain(MARKER)
  }, 30_000)
})
