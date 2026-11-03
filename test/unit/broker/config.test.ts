import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { spawnSync } from 'node:child_process'
import { loadConfig, resolveProjectRoot } from '../../../src/broker/config.js'

function mkGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scns-cfg-'))
  const res = spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { encoding: 'utf-8' })
  if (res.status !== 0) {
    throw new Error(`git init failed: ${res.stderr}`)
  }
  // Real `git rev-parse --is-inside-work-tree` needs at least the init.
  return dir
}

function mkTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'scns-cfg-nogit-'))
}

describe('Broker config', () => {
  const savedEnv: Record<string, string | undefined> = {}

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    // Clear saved env for next test
    for (const key of Object.keys(savedEnv)) {
      delete savedEnv[key]
    }
  })

  it('returns frozen defaults when no env vars set', () => {
    const config = loadConfig()
    expect(config.port).toBe(3456)
    expect(config.heartbeatIntervalMs).toBe(10_000)
    expect(config.heartbeatTimeoutMs).toBe(20_000)
    expect(config.zombieGraceMs).toBe(300_000)
    expect(config.brokerToken).toBeNull()
    expect(config.autoRespawn).toBe(true)
    expect(config.maxRespawnRetries).toBe(3)
    expect(config.respawnBackoffBaseMs).toBe(5000)
    expect(config.autoScaleIntervalMs).toBe(30_000)
    expect(config.autoScaleEnabled).toBe(false)
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('reads BROKER_PORT from env', () => {
    setEnv('BROKER_PORT', '9999')
    const config = loadConfig()
    expect(config.port).toBe(9999)
  })

  it('reads BROKER_DB_PATH from env', () => {
    setEnv('BROKER_DB_PATH', '/custom/path.db')
    const config = loadConfig()
    expect(config.dbPath).toBe('/custom/path.db')
  })

  it('reads BROKER_TOKEN from env', () => {
    setEnv('BROKER_TOKEN', 'secret123')
    const config = loadConfig()
    expect(config.brokerToken).toBe('secret123')
  })

  it('reads BROKER_AUTO_RESPAWN=false', () => {
    setEnv('BROKER_AUTO_RESPAWN', 'false')
    const config = loadConfig()
    expect(config.autoRespawn).toBe(false)
  })

  it('reads BROKER_AUTO_SCALE=true', () => {
    setEnv('BROKER_AUTO_SCALE', 'true')
    const config = loadConfig()
    expect(config.autoScaleEnabled).toBe(true)
  })

  it('falls back to default for invalid port', () => {
    setEnv('BROKER_PORT', 'not-a-number')
    const config = loadConfig()
    expect(config.port).toBe(3456)
  })

  it('falls back to default for negative port', () => {
    setEnv('BROKER_PORT', '-1')
    const config = loadConfig()
    expect(config.port).toBe(3456)
  })

  it('reads BROKER_HEARTBEAT_INTERVAL_MS', () => {
    setEnv('BROKER_HEARTBEAT_INTERVAL_MS', '5000')
    const config = loadConfig()
    expect(config.heartbeatIntervalMs).toBe(5000)
  })

  // Phase 13.12.24 — baseline-lint-diff config flags
  it('defaults qualityGate.baselineLintEnabled/baselineTestsEnabled to true', () => {
    // Ensure any ambient env doesn't leak — save & clear.
    setEnv('SCNS_QG_BASELINE_LINT', '')
    setEnv('SCNS_QG_BASELINE_TESTS', '')
    delete process.env.SCNS_QG_BASELINE_LINT
    delete process.env.SCNS_QG_BASELINE_TESTS
    const config = loadConfig()
    expect(config.qualityGate.baselineLintEnabled).toBe(true)
    expect(config.qualityGate.baselineTestsEnabled).toBe(true)
    expect(Object.isFrozen(config.qualityGate)).toBe(true)
  })

  it('SCNS_QG_BASELINE_LINT=false disables baseline lint gate', () => {
    setEnv('SCNS_QG_BASELINE_LINT', 'false')
    const config = loadConfig()
    expect(config.qualityGate.baselineLintEnabled).toBe(false)
  })

  it('SCNS_QG_BASELINE_LINT=0 also disables baseline lint gate', () => {
    setEnv('SCNS_QG_BASELINE_LINT', '0')
    const config = loadConfig()
    expect(config.qualityGate.baselineLintEnabled).toBe(false)
  })

  it('SCNS_QG_BASELINE_TESTS=false disables baseline test gate', () => {
    setEnv('SCNS_QG_BASELINE_TESTS', 'false')
    const config = loadConfig()
    expect(config.qualityGate.baselineTestsEnabled).toBe(false)
  })

  // Multi-project unblock — BROKER_PROJECT_ROOT wedge
  describe('BROKER_PROJECT_ROOT (projectRoot)', () => {
    const tmpDirs: string[] = []

    afterEach(() => {
      while (tmpDirs.length > 0) {
        const dir = tmpDirs.pop()!
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // best-effort
        }
      }
    })

    it('honors BROKER_PROJECT_ROOT when set to a valid git repo', () => {
      const repo = mkGitRepo()
      tmpDirs.push(repo)
      setEnv('BROKER_PROJECT_ROOT', repo)
      const config = loadConfig()
      expect(config.projectRoot).toBe(resolvePath(repo))
    })

    it('resolves relative paths to absolute', () => {
      const repo = mkGitRepo()
      tmpDirs.push(repo)
      // Relative-looking path that resolvePath() will absolutize against cwd.
      // We can't easily craft a relative path that points at our tmp repo
      // without cd, but resolvePath() of an absolute is still absolute and
      // path normalization runs.
      const trailing = repo + '/'
      setEnv('BROKER_PROJECT_ROOT', trailing)
      const config = loadConfig()
      expect(config.projectRoot).toBe(resolvePath(trailing))
    })

    it('throws when BROKER_PROJECT_ROOT points to a non-existent path', () => {
      const missing = join(tmpdir(), `scns-cfg-missing-${Date.now()}-${Math.random()}`)
      setEnv('BROKER_PROJECT_ROOT', missing)
      expect(() => loadConfig()).toThrow(/does not exist/)
    })

    it('throws when BROKER_PROJECT_ROOT points to a non-directory', () => {
      const dir = mkTmpDir()
      tmpDirs.push(dir)
      const filePath = join(dir, 'not-a-dir.txt')
      writeFileSync(filePath, 'hello')
      setEnv('BROKER_PROJECT_ROOT', filePath)
      expect(() => loadConfig()).toThrow(/not a directory/)
    })

    it('throws when BROKER_PROJECT_ROOT is not inside a git work tree', () => {
      const dir = mkTmpDir()
      tmpDirs.push(dir)
      setEnv('BROKER_PROJECT_ROOT', dir)
      expect(() => loadConfig()).toThrow(/not inside a git work tree/)
    })

    it('treats empty BROKER_PROJECT_ROOT as unset and defaults to process.cwd()', () => {
      setEnv('BROKER_PROJECT_ROOT', '')
      const config = loadConfig()
      // process.cwd() of test runner is the SCNS repo which IS a git tree.
      expect(config.projectRoot).toBe(resolvePath(process.cwd()))
    })

    it('does NOT throw when default cwd is not a git work tree (soft validation)', () => {
      // Use resolveProjectRoot directly with a mocked runGit so we can
      // simulate cwd-not-in-git without changing the runner's cwd.
      const dir = mkTmpDir()
      tmpDirs.push(dir)
      const result = resolveProjectRoot(undefined, dir, () => ({ status: 128, stdout: '' }))
      expect(result).toBe(resolvePath(dir))
    })

    it('default projectRoot is process.cwd() resolved absolute', () => {
      const config = loadConfig()
      expect(config.projectRoot).toBe(resolvePath(process.cwd()))
    })
  })
})

// ── WI-2(a): loopback-by-default bind address ─────────────────────────────
// The broker used to listen on all interfaces. v1 hardens the default to
// 127.0.0.1 (every known client — extension, dashboard, meta-resolve — is
// loopback), overridable via BROKER_BIND for deliberate LAN exposure.

describe('Broker config — BROKER_BIND (WI-2a)', () => {
  const savedBind = { value: undefined as string | undefined }

  beforeEach(() => {
    savedBind.value = process.env.BROKER_BIND
    delete process.env.BROKER_BIND
  })

  afterEach(() => {
    if (savedBind.value === undefined) delete process.env.BROKER_BIND
    else process.env.BROKER_BIND = savedBind.value
  })

  it('defaults bind to 127.0.0.1 (loopback)', () => {
    const config = loadConfig()
    expect(config.bind).toBe('127.0.0.1')
  })

  it('reads BROKER_BIND from env', () => {
    process.env.BROKER_BIND = '0.0.0.0'
    const config = loadConfig()
    expect(config.bind).toBe('0.0.0.0')
  })

  it('falls back to loopback for an empty BROKER_BIND', () => {
    process.env.BROKER_BIND = ''
    const config = loadConfig()
    expect(config.bind).toBe('127.0.0.1')
  })
})
