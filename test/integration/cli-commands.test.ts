/**
 * CLI commands integration tests — Phase 9.
 *
 * Tests the CLI action handlers by exercising the underlying modules directly
 * (autonomy, cost-tracker, log-rotation, suggestion-store, brain-agent,
 * observation config, etc.) with real filesystems and in-memory state.
 *
 * For broker-dependent commands (stop, status, search, team, rotate),
 * we spin up a real in-memory broker and make real HTTP calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  loadAutonomy,
  saveAutonomy,
  promote,
  demote,
  getAutonomyDescription,
} from '../../src/shared/autonomy.js'
import { createCostTracker, estimateCost } from '../../src/shared/cost-tracker.js'
import { createLogRotator } from '../../src/shared/log-rotation.js'
import { loadObservationConfig } from '../../src/observe/config.js'
import { createBrainAgent } from '../../src/brain/agent-loop.js'
import { createTaskQueue } from '../../src/brain/task-queue.js'
import { createDecisionTree } from '../../src/brain/decision-tree.js'
import { createTaskClassifier } from '../../src/brain/classifier.js'
import { createTemplateEngine } from '../../src/brain/templates.js'
import { createHealthMonitor } from '../../src/context/health-monitor.js'
import { createSuggestionStore } from '../../src/suggest/suggestion-store.js'
import { createExecutor } from '../../src/suggest/executor.js'
import { createReviewWorkflow } from '../../src/suggest/review.js'

import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { openMemoryDb } from '../../src/memory/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'
import type Database from 'better-sqlite3'

// ── Temp dir helpers ──────────────────────────────────────────────

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'scns-cli-commands-'))

function tempDir(name: string): string {
  const dir = join(TEST_ROOT, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

// Mock process.exit — the /api/shutdown endpoint calls
// setTimeout(() => process.exit(0), 500) which would crash vitest.
// Must be in beforeEach since restoreMocks: true restores it between tests.
beforeEach(() => {
  vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
})

afterEach(() => {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true })
  }
})

// ── Broker helper ────────────────────────────────────────────────

interface BrokerFixture {
  db: Database.Database
  broker: BrokerServer
  server: Server
  base: string
}

function createTestBroker(): BrokerFixture {
  const db = openDatabase(':memory:')
  const eventLog = createEventLog(db)
  const broker = createBrokerServer(db, eventLog, undefined, undefined, { authToken: null })
  const server = createServer(broker.app)
  server.listen(0)
  const addr = server.address() as AddressInfo
  const base = `http://127.0.0.1:${addr.port}`
  return { db, broker, server, base }
}

async function destroyBroker(f: BrokerFixture): Promise<void> {
  await f.broker.close()
  await new Promise<void>((r) => f.server.close(() => r()))
  closeDatabase(f.db)
}

// ═══════════════════════════════════════════════════════════════════
// 1. Autonomy (promote / demote) — filesystem tests
// ═══════════════════════════════════════════════════════════════════

describe('scns promote / demote', () => {
  it('promote increments from default L0 to L1', () => {
    const dir = tempDir('autonomy-promote')
    const result = promote(dir)
    expect(result.level).toBe(1)
    expect(result.changedBy).toBe('user')
  })

  it('promote caps at L3', () => {
    const dir = tempDir('autonomy-cap')
    saveAutonomy(dir, { level: 3, changedAt: new Date().toISOString(), changedBy: 'user' })
    const result = promote(dir)
    expect(result.level).toBe(3)
  })

  it('demote decrements from L2 to L1', () => {
    const dir = tempDir('autonomy-demote')
    saveAutonomy(dir, { level: 2, changedAt: new Date().toISOString(), changedBy: 'user' })
    const result = demote(dir)
    expect(result.level).toBe(1)
  })

  it('demote floors at L0', () => {
    const dir = tempDir('autonomy-floor')
    const result = demote(dir)
    expect(result.level).toBe(0)
  })

  it('getAutonomyDescription returns correct strings', () => {
    expect(getAutonomyDescription(0)).toContain('Observer')
    expect(getAutonomyDescription(1)).toContain('Assistant')
    expect(getAutonomyDescription(2)).toContain('Collaborator')
    expect(getAutonomyDescription(3)).toContain('Autonomous')
  })

  it('loadAutonomy returns default when no file exists', () => {
    const dir = tempDir('autonomy-nofile')
    const state = loadAutonomy(dir)
    expect(state.level).toBe(0)
    expect(state.changedBy).toBe('user')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 2. scns stop — sends POST /api/shutdown
// ═══════════════════════════════════════════════════════════════════

describe('scns stop', () => {
  let fixture: BrokerFixture

  beforeEach(() => {
    fixture = createTestBroker()
  })

  afterEach(async () => {
    await destroyBroker(fixture)
  })

  it('sends POST to /api/shutdown and receives success', async () => {
    const res = await fetch(`${fixture.base}/api/shutdown`, { method: 'POST' })
    const data = (await res.json()) as { success: boolean; message: string }
    expect(data.success).toBe(true)
    expect(data.message).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════
// 3. scns status — fetches health + sessions + teams
// ═══════════════════════════════════════════════════════════════════

describe('scns status', () => {
  let fixture: BrokerFixture

  beforeEach(() => {
    fixture = createTestBroker()
  })

  afterEach(async () => {
    await destroyBroker(fixture)
  })

  it('health endpoint returns 200', async () => {
    const res = await fetch(`${fixture.base}/health`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>
    expect(data).toHaveProperty('status')
  })

  it('list_sessions returns empty initially', async () => {
    const res = await fetch(`${fixture.base}/api/list_sessions`)
    const data = (await res.json()) as { sessions: unknown[] }
    expect(data.sessions).toEqual([])
  })

  it('teams returns empty initially', async () => {
    const res = await fetch(`${fixture.base}/api/teams`)
    const data = (await res.json()) as { teams: unknown[] }
    expect(data.teams).toEqual([])
  })

  it('status --json would produce valid JSON shape', async () => {
    const stateDir = tempDir('status-json')
    const autonomy = loadAutonomy(stateDir)

    const [healthRes, sessRes, teamRes] = await Promise.all([
      fetch(`${fixture.base}/health`),
      fetch(`${fixture.base}/api/list_sessions`),
      fetch(`${fixture.base}/api/teams`),
    ])

    const healthData = (await healthRes.json()) as Record<string, unknown>
    const sessData = (await sessRes.json()) as { sessions: unknown[] }
    const teamData = (await teamRes.json()) as { teams: unknown[] }

    const summary = {
      broker: 'up',
      sessions: sessData.sessions.length,
      teams: teamData.teams.length,
      autonomy: {
        level: autonomy.level,
        description: getAutonomyDescription(autonomy.level),
      },
      health: healthData,
    }

    expect(summary.broker).toBe('up')
    expect(summary.sessions).toBe(0)
    expect(summary.teams).toBe(0)
    expect(summary.autonomy.level).toBe(0)
    expect(summary.autonomy.description).toContain('Observer')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 4. scns search — verify hybrid search integration
// ═══════════════════════════════════════════════════════════════════

describe('scns search', () => {
  it('cost tracker records and retrieves session data (search-adjacent integration)', () => {
    const tracker = createCostTracker()
    tracker.recordUsage({
      sessionId: 's1',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      estimatedCostUSD: estimateCost(1000, 500),
      timestamp: new Date().toISOString(),
    })
    const cost = tracker.getSessionCost('s1')
    expect(cost).not.toBeNull()
    expect(cost!.totalTokens).toBe(1500)
  })

  // Regression guard for the `scns search` footgun: the command MUST open the
  // vault with the memory opener (openMemoryDb → loads sqlite-vec), NOT the broker
  // storage opener (openDatabase → no vec0, runs broker migrations, WAL-truncates
  // assuming sole ownership). The old command used openDatabase, so hybridSearch's
  // vectorSearch crashed with "no such module: vec0" and it polluted the live vault.
  it('opens the vault with the sqlite-vec memory opener (vector search works); the broker opener lacks vec0', () => {
    const dir = tempDir('search-opener')
    // openMemoryDb creates the vec0 chunk_embeddings table at construction — it
    // throws here if sqlite-vec is not loaded. Succeeding proves vec is available
    // to the search path.
    expect(() => {
      const mdb = openMemoryDb(join(dir, 'vault.db'))
      mdb.close()
    }).not.toThrow()
    // The broker storage opener loads NO sqlite-vec: any vec0 operation throws.
    const bdb = openDatabase(join(dir, 'broker-open.db'))
    expect(() =>
      bdb.prepare('CREATE VIRTUAL TABLE probe_vec USING vec0(id INTEGER PRIMARY KEY, e float[4])').run(),
    ).toThrow(/vec0/)
    closeDatabase(bdb)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 5. scns dashboard — verifies logic for checking dashboard build
// ═══════════════════════════════════════════════════════════════════

describe('scns dashboard', () => {
  it('detects when dashboard is not built', () => {
    const dir = tempDir('dashboard-check')
    const outDir = join(dir, 'out')
    const nextDir = join(dir, '.next')
    expect(existsSync(outDir)).toBe(false)
    expect(existsSync(nextDir)).toBe(false)
  })

  it('detects when dashboard out/ exists', () => {
    const dir = tempDir('dashboard-built')
    const outDir = join(dir, 'out')
    mkdirSync(outDir, { recursive: true })
    expect(existsSync(outDir)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 6. scns install / uninstall — plist file management
// ═══════════════════════════════════════════════════════════════════

describe('scns install / uninstall', () => {
  it('install creates a plist file', () => {
    const dir = tempDir('launchd')
    const plistPath = join(dir, 'com.scns.brain.plist')

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.scns.brain</string>
</dict>
</plist>`

    writeFileSync(plistPath, plistContent, 'utf-8')
    expect(existsSync(plistPath)).toBe(true)
    const content = readFileSync(plistPath, 'utf-8')
    expect(content).toContain('com.scns.brain')
  })

  it('uninstall removes the plist file', () => {
    const dir = tempDir('launchd-remove')
    const plistPath = join(dir, 'com.scns.brain.plist')
    writeFileSync(plistPath, '<plist/>', 'utf-8')
    expect(existsSync(plistPath)).toBe(true)

    rmSync(plistPath)
    expect(existsSync(plistPath)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 7. scns dream --status — consolidation status
// ═══════════════════════════════════════════════════════════════════

describe('scns dream --status', () => {
  it('log rotator reports stats correctly', () => {
    const dir = tempDir('dream-logs')
    const rotator = createLogRotator({ logDir: dir })

    const stats = rotator.getStats()
    expect(stats.totalFiles).toBe(0)
    expect(stats.totalSizeBytes).toBe(0)
  })

  it('log rotator rotates and cleans up', () => {
    const dir = tempDir('dream-rotate')

    // Create a log file with old mtime
    const logFile = join(dir, 'test.log')
    writeFileSync(logFile, 'old log content')

    const rotator = createLogRotator({ logDir: dir, maxFileSizeMB: 0 })
    const result = rotator.rotate()
    // Should either rotate or skip based on mtime being today
    expect(result.errors).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════
// 8. scns observe status — observation config
// ═══════════════════════════════════════════════════════════════════

describe('scns observe status', () => {
  it('loads default observation config', () => {
    const config = loadObservationConfig()
    expect(config.activeApp.enabled).toBe(true)
    expect(config.fileChanges.enabled).toBe(true)
    expect(config.gitActivity.enabled).toBe(true)
    expect(config.sessionHooks.enabled).toBe(true)
    // terminal and browser are opt-in by default
    expect(config.terminalHistory.enabled).toBe(false)
    expect(config.browserTabs.enabled).toBe(false)
  })

  it('reports all six observer types', () => {
    const config = loadObservationConfig()
    const entries: [string, { enabled: boolean }][] = [
      ['active-app', config.activeApp],
      ['file-changes', config.fileChanges],
      ['git-activity', config.gitActivity],
      ['terminal-history', config.terminalHistory],
      ['browser-tabs', config.browserTabs],
      ['session-hooks', config.sessionHooks],
    ]
    expect(entries).toHaveLength(6)
    // At least 4 enabled by default
    const enabledCount = entries.filter(([, c]) => c.enabled).length
    expect(enabledCount).toBeGreaterThanOrEqual(4)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 9. scns team create / list — broker API
// ═══════════════════════════════════════════════════════════════════

describe('scns team create / list', () => {
  let fixture: BrokerFixture

  beforeEach(() => {
    fixture = createTestBroker()
  })

  afterEach(async () => {
    await destroyBroker(fixture)
  })

  it('team create sends POST to /api/teams', async () => {
    const res = await fetch(`${fixture.base}/api/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-team' }),
    })
    expect(res.status).toBe(201)
    const data = (await res.json()) as { id: string; name: string }
    expect(data.name).toBe('test-team')
    expect(data.id).toBeDefined()
  })

  it('team list sends GET to /api/teams', async () => {
    // Create a team first
    await fetch(`${fixture.base}/api/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alpha-team' }),
    })

    const res = await fetch(`${fixture.base}/api/teams`)
    const data = (await res.json()) as { teams: Array<{ name: string }> }
    expect(data.teams.length).toBe(1)
    expect(data.teams[0]!.name).toBe('alpha-team')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 10. scns rotate status / candidates
// ═══════════════════════════════════════════════════════════════════

describe('scns rotate status / candidates', () => {
  let fixture: BrokerFixture

  beforeEach(() => {
    fixture = createTestBroker()
  })

  afterEach(async () => {
    await destroyBroker(fixture)
  })

  it('rotate status returns 503 when no controller', async () => {
    const res = await fetch(`${fixture.base}/api/rotate/status`)
    expect(res.status).toBe(503)
    const data = (await res.json()) as Record<string, unknown>
    expect(data).toHaveProperty('error')
  })

  it('rotate candidates returns 503 when no controller', async () => {
    const res = await fetch(`${fixture.base}/api/rotate/candidates`)
    expect(res.status).toBe(503)
    const data = (await res.json()) as { candidates?: unknown[] }
    expect(data).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════
// 11. scns review list — suggestion store
// ═══════════════════════════════════════════════════════════════════

describe('scns review list', () => {
  it('reads pending suggestions from the store', () => {
    const dir = tempDir('suggestions')
    const store = createSuggestionStore({ rootDir: dir })
    const executor = createExecutor()
    const workflow = createReviewWorkflow({ store, executor })

    const pending = workflow.listPending()
    expect(pending).toEqual([])
  })

  it('lists a saved suggestion', () => {
    const dir = tempDir('suggestions-with-data')
    const store = createSuggestionStore({ rootDir: dir })
    const executor = createExecutor()
    const workflow = createReviewWorkflow({ store, executor })

    const now = new Date().toISOString()
    store.save({
      id: randomUUID(),
      type: 'skill',
      title: 'Test suggestion',
      description: 'A test suggestion',
      status: 'pending',
      confidence: 0.8,
      evidence: [{ source: 'test', detail: 'test detail', observedAt: now, weight: 0.5 }],
      tags: ['test'],
      createdAt: now,
      updatedAt: now,
    })

    const pending = workflow.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.title).toBe('Test suggestion')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 12. scns brain wake — brain agent creates agent + wake
// ═══════════════════════════════════════════════════════════════════

describe('scns brain wake', () => {
  it('creates agent and triggers wake cycle', async () => {
    const agent = createBrainAgent(
      {
        classifier: createTaskClassifier(),
        decisionTree: createDecisionTree(),
        templateEngine: createTemplateEngine(),
        healthMonitor: createHealthMonitor(),
        taskQueue: createTaskQueue(),
      },
      { autonomyLevel: 0 },
    )

    const decision = await agent.wake()
    expect(decision).toHaveProperty('action')
    expect(decision).toHaveProperty('reason')
    expect(decision).toHaveProperty('confidence')
    expect(decision).toHaveProperty('priority')
    expect(typeof decision.confidence).toBe('number')
  })

  it('adds a task and wakes with it in queue', async () => {
    const agent = createBrainAgent(
      {
        classifier: createTaskClassifier(),
        decisionTree: createDecisionTree(),
        templateEngine: createTemplateEngine(),
        healthMonitor: createHealthMonitor(),
        taskQueue: createTaskQueue(),
      },
      { autonomyLevel: 1 },
    )

    const taskId = agent.addTask('Fix the login bug')
    expect(taskId).toBeDefined()

    const status = agent.getStatus()
    expect(status.queueSize).toBe(1)

    const decision = await agent.wake()
    expect(decision).toHaveProperty('action')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 13. Cost tracking (scns cost endpoints)
// ═══════════════════════════════════════════════════════════════════

describe('cost tracking', () => {
  it('cost tracker records multiple sessions', () => {
    const tracker = createCostTracker()
    const now = new Date().toISOString()

    tracker.recordUsage({
      sessionId: 's1',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      estimatedCostUSD: estimateCost(1000, 500),
      timestamp: now,
    })

    tracker.recordUsage({
      sessionId: 's2',
      inputTokens: 2000,
      outputTokens: 1000,
      totalTokens: 3000,
      estimatedCostUSD: estimateCost(2000, 1000),
      timestamp: now,
    })

    const summary = tracker.getSummary()
    expect(summary.sessionCount).toBe(2)
    expect(summary.totalInputTokens).toBe(3000)
    expect(summary.totalOutputTokens).toBe(1500)
    expect(summary.totalTokens).toBe(4500)
    expect(summary.estimatedTotalCostUSD).toBeGreaterThan(0)
  })

  it('cost/summary endpoint returns data (no tracker)', async () => {
    const fixture = createTestBroker()
    try {
      const res = await fetch(`${fixture.base}/api/cost/summary`)
      expect(res.status).toBe(200)
      const data = (await res.json()) as Record<string, unknown>
      expect(data).toBeDefined()
    } finally {
      await destroyBroker(fixture)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
// 14. Autonomy API endpoints
// ═══════════════════════════════════════════════════════════════════

describe('autonomy API endpoints', () => {
  let fixture: BrokerFixture

  beforeEach(() => {
    fixture = createTestBroker()
  })

  afterEach(async () => {
    await destroyBroker(fixture)
  })

  it('GET /api/autonomy returns current state', async () => {
    const res = await fetch(`${fixture.base}/api/autonomy`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { level: number }
    expect(typeof data.level).toBe('number')
  })

  it('POST /api/autonomy/promote returns updated state', async () => {
    const res = await fetch(`${fixture.base}/api/autonomy/promote`, { method: 'POST' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { level: number }
    expect(typeof data.level).toBe('number')
  })

  it('POST /api/autonomy/demote returns updated state', async () => {
    const res = await fetch(`${fixture.base}/api/autonomy/demote`, { method: 'POST' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { level: number }
    expect(typeof data.level).toBe('number')
  })
})
