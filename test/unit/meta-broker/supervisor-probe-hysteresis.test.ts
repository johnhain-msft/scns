/**
 * Regression for #48 — a single transient probe failure latches a whole
 * session to the global brain.
 *
 * Observed live on the native-Windows work machine (2026-09-11): 3 of 60
 * polls of /api/meta/resolve returned `child-failing` while the child was
 * demonstrably healthy. Any Copilot session starting inside such a window
 * binds `global:fallback` for its entire life — memory writes refused,
 * injected briefing empty, nothing tells the user.
 *
 * Cause: `probeChild` flipped registry `status` to 'failing' on the FIRST
 * failed probe, while the restart policy explicitly documents 1–2 consecutive
 * failures as a transient blip (restart-policy.ts, `minFailures: 3`). Routing
 * (`/api/meta/resolve` requires status === 'running') must tolerate exactly
 * what the restart policy tolerates: the child stays routable until
 * `minFailures` consecutive failures, and restart/suspend bookkeeping is
 * unchanged because every failure is still recorded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import {
  createMetaSupervisor,
  type MetaSupervisor,
} from '../../../src/meta-broker/meta-supervisor.js'
import {
  applyMetaSchema,
  registerProject,
  updateChildState,
  getProject,
} from '../../../src/meta-broker/registry.js'

const PROJECT_ID = 'proj-hysteresis'
const POLICY = {
  minFailures: 3,
  cooldownMs: 30_000,
  maxRestartsPerWindow: 3,
  windowMs: 600_000,
}

describe('meta-supervisor probe hysteresis (#48)', () => {
  let db: Database.Database
  let tempDir: string
  let probeResults: boolean[]
  let supervisor: MetaSupervisor

  beforeEach(() => {
    db = new Database(':memory:')
    applyMetaSchema(db)
    tempDir = mkdtempSync(join(tmpdir(), 'scns-hysteresis-'))
    registerProject(db, { projectId: PROJECT_ID, projectRoot: '/abs/proj-hysteresis' })
    updateChildState(db, PROJECT_ID, {
      status: 'running',
      boundPort: 3999,
      childPid: 111,
      instanceId: 'iid-a',
      lastSeenAt: new Date().toISOString(),
    })
    probeResults = []
    supervisor = createMetaSupervisor({
      db,
      brokerEntry: 'dist/cli.js',
      projectDbDir: tempDir,
      policy: POLICY,
      httpProbe: async () => {
        const next = probeResults.shift()
        return next ?? false
      },
    })
  })

  afterEach(async () => {
    await supervisor.stop()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('one failed probe records the failure but leaves the child routable (status stays running)', async () => {
    probeResults.push(false)
    await supervisor.tickOnce()

    const proj = getProject(db, PROJECT_ID)!
    expect(proj.healthFailures).toBe(1)
    expect(proj.status).toBe('running')
  })

  it('stays running below the threshold, flips to failing exactly at minFailures', async () => {
    probeResults.push(false, false, false)

    await supervisor.tickOnce()
    await supervisor.tickOnce()
    let proj = getProject(db, PROJECT_ID)!
    expect(proj.healthFailures).toBe(2)
    expect(proj.status).toBe('running')

    await supervisor.tickOnce()
    proj = getProject(db, PROJECT_ID)!
    expect(proj.healthFailures).toBe(3)
    expect(proj.status).toBe('failing')
  })

  it('a success below the threshold resets the counter and the child never left running', async () => {
    probeResults.push(false, true)

    await supervisor.tickOnce()
    expect(getProject(db, PROJECT_ID)!.status).toBe('running')
    await supervisor.tickOnce()

    const proj = getProject(db, PROJECT_ID)!
    expect(proj.healthFailures).toBe(0)
    expect(proj.status).toBe('running')
  })

  it('a starting child is not promoted to running by a failed probe', async () => {
    updateChildState(db, PROJECT_ID, {
      status: 'starting',
      boundPort: 3999,
      childPid: 111,
      instanceId: 'iid-a',
      lastSeenAt: new Date().toISOString(),
    })
    probeResults.push(false)
    await supervisor.tickOnce()

    const proj = getProject(db, PROJECT_ID)!
    expect(proj.healthFailures).toBe(1)
    expect(proj.status).toBe('starting')
  })
})
