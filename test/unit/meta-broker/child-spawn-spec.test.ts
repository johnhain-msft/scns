/**
 * Gap 5 — child broker spawn spec.
 *
 * Pins the production-wiring contract for meta-broker child spawns:
 *   - uses the real `start` command (the legacy `broker` subcommand
 *     never existed, so prod child spawns always errored), and
 *   - threads per-project autonomy + auto-approve threshold so each
 *     project runs at its own configured autonomy.
 */
import { describe, it, expect } from 'vitest'
import { buildChildSpawnSpec } from '../../../src/meta-broker/meta-supervisor.js'

const base = {
  brokerEntry: '/abs/dist/cli.js',
  projectRoot: '/abs/proj',
  projectId: 'proj-abc',
  dbPath: '/abs/db/data.db',
  scnsHome: '/abs/projects/proj-abc/home',
  port: 3500,
  instanceId: 'inst-1',
}

describe('buildChildSpawnSpec', () => {
  it('spawns the real `start` command (not the nonexistent `broker`)', () => {
    const spec = buildChildSpawnSpec(base)
    expect(spec.args).toContain('start')
    expect(spec.args).not.toContain('broker')
    expect(spec.args[0]).toBe('/abs/dist/cli.js')
    expect(spec.args).toEqual(expect.arrayContaining(['--port', '3500']))
  })

  it('defaults autonomy to 0 and passes it as --autonomy', () => {
    const spec = buildChildSpawnSpec(base)
    expect(spec.args).toEqual(expect.arrayContaining(['--autonomy', '0']))
  })

  it('threads the per-project autonomy level', () => {
    const spec = buildChildSpawnSpec({ ...base, autonomyLevel: 2 })
    expect(spec.args).toEqual(expect.arrayContaining(['--autonomy', '2']))
  })

  it('sets the per-project broker env (root/id/db/port/instance)', () => {
    const spec = buildChildSpawnSpec(base)
    expect(spec.env.BROKER_PROJECT_ROOT).toBe('/abs/proj')
    expect(spec.env.BROKER_PROJECT_ID).toBe('proj-abc')
    expect(spec.env.BROKER_DB_PATH).toBe('/abs/db/data.db')
    expect(spec.env.BROKER_PORT).toBe('3500')
    expect(spec.env.SCNS_INSTANCE_ID).toBe('inst-1')
  })

  it('isolates the whole ~/.scns memory tree via a per-project SCNS_HOME', () => {
    // Without SCNS_HOME the child's resolveScnsHome() falls back to homedir() and
    // every ~/.scns store (vault/experience/dream/suggestions/secrets/state/…) is
    // SHARED with the singleton. The spec must thread a per-project SCNS_HOME so the
    // child owns its own .scns tree.
    const spec = buildChildSpawnSpec(base)
    expect(spec.env.SCNS_HOME).toBe('/abs/projects/proj-abc/home')
  })

  it('scopes git + file observation to the project root (not the user global scan)', () => {
    // Otherwise the child's projectFocus reflects every repo under ~/Coding_Projects
    // (global auto-detect) rather than its own project.
    const spec = buildChildSpawnSpec(base)
    expect(spec.env.OBSERVE_GIT_REPOS).toBe('/abs/proj')
    expect(spec.env.OBSERVE_FILE_DIRS).toBe('/abs/proj')
  })

  it('disables global/user-level observers so the child is an encapsulated brain', () => {
    // A child must not be affected by anything outside its project: no foreground-app
    // usage, no machine-wide ~/.copilot/session-store.db (every Copilot session).
    const spec = buildChildSpawnSpec(base)
    expect(spec.env.OBSERVE_ACTIVE_APP_ENABLED).toBe('false')
    expect(spec.env.OBSERVE_SESSION_STORE_ENABLED).toBe('false')
  })

  it('includes the auto-approve threshold env only when configured', () => {
    expect(buildChildSpawnSpec(base).env.SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD).toBeUndefined()
    const withThr = buildChildSpawnSpec({ ...base, autoApproveThreshold: 0.8 })
    expect(withThr.env.SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD).toBe('0.8')
  })

  it('threads SCNS_SELF_ISSUE_REPO only when a repo is configured', () => {
    // No repo → the child must NOT inherit the singleton's issue feed.
    expect(buildChildSpawnSpec(base).env.SCNS_SELF_ISSUE_REPO).toBeUndefined()
    expect(
      buildChildSpawnSpec({ ...base, selfIssueRepo: '  ' }).env.SCNS_SELF_ISSUE_REPO,
    ).toBeUndefined()
    const withRepo = buildChildSpawnSpec({ ...base, selfIssueRepo: 'example-org/Cosmere_RPG' })
    expect(withRepo.env.SCNS_SELF_ISSUE_REPO).toBe('example-org/Cosmere_RPG')
  })
})

// ── WI-6: children never killStale — the supervisor owns port assignment ──

describe('buildChildSpawnSpec — killStale opt-out (WI-6)', () => {
  it("threads BROKER_LISTEN_KILL_STALE='false' so an EADDRINUSE child fails instead of killing the port holder", () => {
    const spec = buildChildSpawnSpec({
      brokerEntry: '/opt/scns/dist/cli.js',
      projectRoot: '/repos/app',
      projectId: 'app-123',
      dbPath: '/data/app/data.db',
      scnsHome: '/data/app/home',
      port: 3502,
      instanceId: 'inst-1',
    })
    expect(spec.env['BROKER_LISTEN_KILL_STALE']).toBe('false')
  })
})
