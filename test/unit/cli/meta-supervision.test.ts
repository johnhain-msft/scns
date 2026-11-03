/**
 * Issue #61 — the watchdog as a TWO-service supervision root.
 *
 * macOS supervises three launchd jobs with KeepAlive: the broker, the
 * meta-broker, and the watchdog itself. Windows has one Startup entry, and it
 * starts the watchdog — so anything the watchdog does not supervise has nothing
 * above it at all. The meta-broker was in that category: `scns meta-broker run`
 * dies and nobody notices, and every per-project child dies with it, which
 * silently routes every session in every registered repo to `global:fallback`.
 *
 * The meta-broker cannot be supervised the way the broker is. It has no HTTP
 * listener of its own — it uses `node:net` only to test port availability, and
 * probes its CHILDREN's `/api/health`. So liveness comes from a pidfile, and
 * these tests pin that path plus the decision of when to supervise it at all.
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  metaBrokerPidfilePath,
  decideMetaSupervision,
  resolveSuperviseMetaOverride,
  pidfileLivenessProbe,
  buildMetaBrokerSpawn,
  createMetaBrokerRestart,
  countRegisteredProjects,
} from '../../../src/cli/meta-supervision.js'
import { writeBrokerPidfile } from '../../../src/broker/services/broker-pidfile.js'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'scns-meta-sup-'))
}

describe('metaBrokerPidfilePath', () => {
  it('lives beside every other runtime pidfile, and is NOT per-port', () => {
    // The meta-broker binds no port of its own — one per SCNS_HOME is the
    // correct cardinality, and a port suffix would invent a second one.
    const p = metaBrokerPidfilePath('C:\\Users\\j')
    expect(p).toBe(join('C:\\Users\\j', '.scns', 'run', 'meta-broker.pid'))
  })
})

describe('decideMetaSupervision', () => {
  it('supervises when the registry exists and has projects', () => {
    expect(decideMetaSupervision({ metaDbExists: true, registeredProjects: 2 })).toMatchObject({
      supervise: true,
    })
  })

  it('stays off when the meta-broker was never set up', () => {
    // Supervising here would START a feature the operator never opted into.
    const d = decideMetaSupervision({ metaDbExists: false, registeredProjects: 0 })
    expect(d.supervise).toBe(false)
    expect(d.reason).toContain('no meta registry')
  })

  it('stays off when the registry exists but nothing is registered', () => {
    const d = decideMetaSupervision({ metaDbExists: true, registeredProjects: 0 })
    expect(d.supervise).toBe(false)
    expect(d.reason).toContain('no registered projects')
  })

  it('honours an explicit operator override in both directions', () => {
    expect(
      decideMetaSupervision({ metaDbExists: false, registeredProjects: 0, override: true }),
    ).toMatchObject({ supervise: true, reason: 'operator override' })
    expect(
      decideMetaSupervision({ metaDbExists: true, registeredProjects: 9, override: false }),
    ).toMatchObject({ supervise: false, reason: 'operator override' })
  })

  it('treats an unreadable registry as "not set up" rather than failing the watchdog', () => {
    // The watchdog's primary job is the broker. A broken meta registry must not
    // stop it from supervising anything.
    const d = decideMetaSupervision({ metaDbExists: true, registeredProjects: null })
    expect(d.supervise).toBe(false)
    expect(d.reason).toContain('unreadable')
  })
})

describe('countRegisteredProjects', () => {
  it('returns null for a path that is not a database, instead of throwing', () => {
    const home = tempHome()
    try {
      const p = join(home, 'not-a.db')
      writeFileSync(p, 'definitely not sqlite')
      expect(countRegisteredProjects(p)).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns null for a missing file', () => {
    expect(countRegisteredProjects(join(tmpdir(), 'scns-nope-does-not-exist.db'))).toBeNull()
  })
})

describe('pidfileLivenessProbe', () => {
  it('reports a live process the way an HTTP 200 would, so the core needs no new branch', async () => {
    const home = tempHome()
    try {
      const path = join(home, 'meta.pid')
      writeBrokerPidfile(path, {
        pid: 4242,
        port: 0,
        startedAt: Date.now(),
        execPath: 'node',
      })
      const probe = pidfileLivenessProbe(path, () => {}, 1)
      // `classifyProbe` calls anything with a numeric status "responsive".
      expect(await probe()).toMatchObject({ ok: true, status: 200 })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reports a missing pidfile as unresponsive, with no status at all', async () => {
    const probe = pidfileLivenessProbe(join(tmpdir(), 'scns-absent.pid'))
    const result = await probe()
    expect(result.ok).toBe(false)
    expect(result.status).toBeUndefined()
    expect(result.error).toContain('no live meta-broker')
  })

  it('reports a pidfile whose process is gone as unresponsive', async () => {
    const home = tempHome()
    try {
      const path = join(home, 'meta.pid')
      writeBrokerPidfile(path, { pid: 4242, port: 0, startedAt: 0, execPath: 'node' })
      const dead = (): never => {
        const e = new Error('ESRCH') as NodeJS.ErrnoException
        e.code = 'ESRCH'
        throw e
      }
      const result = await pidfileLivenessProbe(path, dead, 1)()
      expect(result.status).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('never reports the watchdog\u2019s own pid as a live meta-broker', async () => {
    const home = tempHome()
    try {
      const path = join(home, 'meta.pid')
      writeBrokerPidfile(path, { pid: 777, port: 0, startedAt: 0, execPath: 'node' })
      const result = await pidfileLivenessProbe(path, () => {}, 777)()
      expect(result.status).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('buildMetaBrokerSpawn', () => {
  it('runs the real subcommand with the paths the supervisor needs', () => {
    const spec = buildMetaBrokerSpawn({
      execPath: 'C:\\node\\node.exe',
      scriptPath: 'C:\\scns\\dist\\cli.js',
      metaDb: 'C:\\Users\\j\\.scns\\meta-broker.db',
      projectDbDir: 'C:\\Users\\j\\.session-broker\\projects',
    })
    expect(spec.command).toBe('C:\\node\\node.exe')
    expect(spec.args).toEqual([
      'C:\\scns\\dist\\cli.js',
      'meta-broker',
      'run',
      '--meta-db',
      'C:\\Users\\j\\.scns\\meta-broker.db',
      '--broker-entry',
      'C:\\scns\\dist\\cli.js',
      '--project-db-dir',
      'C:\\Users\\j\\.session-broker\\projects',
    ])
  })

  it('announces the supervisor to the meta-broker, as a broker spawn does', () => {
    const spec = buildMetaBrokerSpawn({
      execPath: 'node',
      scriptPath: 'cli.js',
      metaDb: 'm.db',
      projectDbDir: 'p',
    })
    expect(spec.env['SCNS_SUPERVISED']).toBe('1')
  })
})

describe('createMetaBrokerRestart', () => {
  const opts = {
    scnsHome: 'C:\\Users\\j',
    execPath: 'node',
    scriptPath: 'cli.js',
    metaDb: 'm.db',
    projectDbDir: 'p',
  }

  it('stops a recorded meta-broker before spawning a replacement', async () => {
    const order: string[] = []
    const restart = createMetaBrokerRestart(opts, {
      readLivePid: () => 500,
      stopPid: () => order.push('stop'),
      isAlive: () => false,
      spawnProcess: () => {
        order.push('spawn')
        return 501
      },
      sleep: async () => {},
    })
    const out = await restart()
    expect(order).toEqual(['stop', 'spawn'])
    expect(out.spawnedPid).toBe(501)
  })

  it('refuses to spawn a second meta-broker while the first is still alive', async () => {
    // Two supervisors on one registry would each spawn children for the same
    // project and fight over its port.
    const spawnProcess = vi.fn(() => 501)
    const restart = createMetaBrokerRestart(opts, {
      readLivePid: () => 500,
      stopPid: () => {},
      isAlive: () => true,
      spawnProcess,
      sleep: async () => {},
      now: (() => {
        let t = 0
        return () => (t += 1_000)
      })(),
      stopGraceMs: 3_000,
    })
    const out = await restart()
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(out.detail).toContain('refusing to spawn')
  })

  it('spawns straight away when nothing is recorded as running', async () => {
    const restart = createMetaBrokerRestart(opts, {
      readLivePid: () => null,
      stopPid: () => {
        throw new Error('should not be called')
      },
      isAlive: () => false,
      spawnProcess: () => 600,
      sleep: async () => {},
    })
    const out = await restart()
    expect(out.spawnedPid).toBe(600)
    expect(out.stoppedPid).toBeNull()
  })
})

describe('the supervision root, end to end', () => {
  it('decides to supervise a real registry that has a project in it', async () => {
    const home = tempHome()
    try {
      const metaDb = join(home, '.scns', 'meta-broker.db')
      mkdirSync(dirname(metaDb), { recursive: true })
      const { default: Database } = await import('better-sqlite3')
      const { applyMetaSchema, registerProject } =
        await import('../../../src/meta-broker/registry.js')
      const db = new Database(metaDb)
      applyMetaSchema(db)
      registerProject(db, { projectId: 'proj-a', projectRoot: join(home, 'repo') })
      db.close()

      expect(countRegisteredProjects(metaDb)).toBe(1)
      expect(
        decideMetaSupervision({
          metaDbExists: true,
          registeredProjects: countRegisteredProjects(metaDb),
        }).supervise,
      ).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('resolveSuperviseMetaOverride', () => {
  it('defaults to auto-detect when the flag is absent or "auto"', () => {
    expect(resolveSuperviseMetaOverride(undefined)).toBeUndefined()
    expect(resolveSuperviseMetaOverride('auto')).toBeUndefined()
  })

  it('maps on/off to a real override', () => {
    expect(resolveSuperviseMetaOverride('on')).toBe(true)
    expect(resolveSuperviseMetaOverride('OFF')).toBe(false)
  })

  it('accepts the obvious synonyms rather than silently auto-detecting', () => {
    expect(resolveSuperviseMetaOverride('true')).toBe(true)
    expect(resolveSuperviseMetaOverride('yes')).toBe(true)
    expect(resolveSuperviseMetaOverride('false')).toBe(false)
    expect(resolveSuperviseMetaOverride('no')).toBe(false)
  })

  it('falls back to auto-detect for an unrecognised value', () => {
    // A typo must not silently disable supervision.
    expect(resolveSuperviseMetaOverride('maybe')).toBeUndefined()
  })
})
