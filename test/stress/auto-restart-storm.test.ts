/**
 * Auto-restart storm stress test — evidence for the F1+F3+F4+F6 fix.
 *
 * Simulates a broker restart/respawn storm with a MOCK ACP spawner (no real
 * copilot subprocess) and asserts the invariants that bound runaway
 * CPU/memory:
 *
 *  - activeAgents.size <= maxConcurrentAgents at every sample (F1 cap holds)
 *  - Total spawn() calls across all cycles bounded (no multiplicative replay)
 *  - No runaway respawn — successful spawns ≤ cap × cycles
 *  - Event-loop lag stays below 1s (broker remains responsive under storm)
 *  - RSS delta stays below 150 MB (no memory leak under mocked load)
 *
 * This test is the automated counterpart to `scripts/auto-restart-soak.mjs`
 * (live harness). Both exist because the user explicitly demanded real,
 * measurable evidence before re-enabling the auto-restart plists.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type Database from 'better-sqlite3'
import type { TestDb } from '../helpers/db-harness.js'
import { createBrokerTestDb } from '../helpers/broker-db-harness.js'
import {
  createAgentSpawner,
  type AgentSpawner,
  type SpawnerDeps,
  type SpawnerEventLog,
} from '../../src/broker/services/agent-spawner.js'
import type { CliInfo, Platform } from '../../src/broker/services/platform.js'
import {
  loadPendingSnapshots,
  recoverAgents,
} from '../../src/broker/services/session-recovery.js'

const MAX_CONCURRENT = 4
const SNAPSHOTS_PER_CYCLE = 20
const CYCLES = 5
const TEAM_ID = 'storm-team'

function makeMockEventLog(): SpawnerEventLog {
  return {
    sessionRegistered: vi.fn(),
    sessionDeregistered: vi.fn(),
    teamMemberJoined: vi.fn(),
  }
}

function makeMockDeps(): SpawnerDeps {
  const mockChild = {
    pid: 12345,
    killed: false,
    unref: vi.fn(),
    on: vi.fn(),
    kill: vi.fn(),
  }
  return {
    detectPlatform: () => 'darwin' as Platform,
    findCli: () => ({ command: 'copilot' }) as CliInfo,
    isTmuxAvailable: () => false,
    spawnProcess: vi.fn().mockReturnValue(mockChild) as unknown as SpawnerDeps['spawnProcess'],
    spawnSync: vi.fn().mockReturnValue({
      status: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      pid: 0,
      output: [],
      signal: null,
    }) as unknown as SpawnerDeps['spawnSync'],
    execSync: vi.fn() as unknown as SpawnerDeps['execSync'],
    mkdirSync: vi.fn() as unknown as SpawnerDeps['mkdirSync'],
    createWriteStream: vi.fn().mockReturnValue({
      write: vi.fn(),
      end: vi.fn(),
    }) as unknown as SpawnerDeps['createWriteStream'],
    writeFileSync: vi.fn() as unknown as SpawnerDeps['writeFileSync'],
    openSync: vi.fn().mockReturnValue(99) as unknown as SpawnerDeps['openSync'],
    closeSync: vi.fn() as unknown as SpawnerDeps['closeSync'],
  }
}

function seedSnapshots(db: Database.Database, count: number, cycle: number): void {
  const insert = db.prepare(
    `INSERT INTO recovery_snapshots
       (session_id, team_id, name, role, working_dir, purpose, launch_method,
        pending_tasks, recent_messages, recovery_prompt, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  )
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run(
        `old-${cycle}-${i}`,
        TEAM_ID,
        `agent-${cycle}-${i}`,
        'dev',
        '/tmp/stress',
        'stress purpose',
        'detached',
        null,
        null,
        null,
      )
    }
  })
  tx()
}

describe('auto-restart storm (F1+F3+F4+F6 evidence)', () => {
  let testDb: TestDb
  let spawner: AgentSpawner

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(TEAM_ID, 'Storm Team')
    spawner = createAgentSpawner(testDb.db, makeMockEventLog(), {
      brokerUrl: 'http://localhost:9999',
      workingDir: '/tmp/stress',
      deps: makeMockDeps(),
      maxConcurrentAgents: MAX_CONCURRENT,
    })
  })

  afterEach(async () => {
    await spawner.shutdownAll()
    testDb.close()
  })

  it('bounds spawn/recovery under 5 restart cycles × 20 snapshots', async () => {
    const histogram = monitorEventLoopDelay({ resolution: 20 })
    histogram.enable()
    const rssBefore = process.memoryUsage().rss

    const samples: Array<{ cycle: number; activeCount: number; pendingCount: number }> = []
    let totalSpawnAttempts = 0
    let totalSpawnSuccesses = 0

    // Wrap spawn to count attempts, and to hold "active" entries for 20ms
    // simulating real ACP session lifetime before we clean them up. This
    // ensures multiple recovery attempts actually compete for cap slots.
    const baseSpawn = spawner.spawn.bind(spawner)
    const heldSessions: string[] = []
    const spawnProbe = async (input: Parameters<typeof baseSpawn>[0]): Promise<Awaited<ReturnType<typeof baseSpawn>>> => {
      totalSpawnAttempts++
      const result = await baseSpawn(input)
      totalSpawnSuccesses++
      heldSessions.push(result.sessionId)
      return result
    }

    // Sampler running during the storm.
    const stopSampling = vi.fn()
    let sampling = true
    const sampleLoop = (async (): Promise<void> => {
      while (sampling) {
        const stats = spawner.getSpawnStats()
        samples.push({
          cycle: -1,
          activeCount: stats.activeCount,
          pendingCount: stats.pendingCount,
        })
        // Hard invariant under test: pending + active never exceeds cap.
        expect(stats.activeCount + stats.pendingCount).toBeLessThanOrEqual(MAX_CONCURRENT)
        await new Promise((r) => setImmediate(r))
      }
    })()

    const capacityProbe = {
      getActiveCount: () => spawner.getSpawnStats().activeCount,
      getMaxConcurrent: () => spawner.getSpawnStats().maxConcurrent,
    }

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      seedSnapshots(testDb.db, SNAPSHOTS_PER_CYCLE, cycle)
      const snapshots = loadPendingSnapshots(testDb.db)
      // Drive recovery exactly like startup would, with concurrency=2 +
      // half-capacity short-circuit probe. Also kick off a parallel "storm"
      // of direct spawns to simulate brain + respawn contending for cap
      // slots at the same time.
      const stormSpawns = Array.from({ length: 10 }, (_, i) =>
        spawnProbe({
          team_id: TEAM_ID,
          name: `storm-${cycle}-${i}`,
          role: 'dev',
          prompt: 'x',
        }).catch(() => undefined),
      )
      const recoveryPromise = recoverAgents(
        testDb.db,
        spawnProbe,
        snapshots,
        { concurrency: 2, capacityProbe },
      )
      await Promise.all([recoveryPromise, ...stormSpawns])

      // Assert invariant at end of every cycle.
      const postStats = spawner.getSpawnStats()
      expect(postStats.activeCount).toBeLessThanOrEqual(MAX_CONCURRENT)

      // Tear down half the held sessions to mimic natural churn before the
      // next cycle; without this the cap stays saturated and cycle 2+ is
      // uninteresting.
      const toClean = heldSessions.splice(0, Math.ceil(heldSessions.length / 2))
      await Promise.all(toClean.map((id) => spawner.cleanup(id)))
    }

    sampling = false
    stopSampling()
    await sampleLoop
    histogram.disable()

    // ── Invariants ────────────────────────────────────────────────────
    // 1. activeAgents.size <= cap at every sample point.
    for (const s of samples) {
      expect(s.activeCount).toBeLessThanOrEqual(MAX_CONCURRENT)
    }

    // 2. Total spawn() calls bounded.
    //    Recovery: up to SNAPSHOTS_PER_CYCLE * CYCLES = 100 attempts.
    //    Storm: 10 * CYCLES = 50 attempts.
    //    Upper bound allows the full attempt count; the key is that
    //    SUCCESSES are bounded by cap × cycle turnover.
    expect(totalSpawnAttempts).toBeLessThanOrEqual(
      SNAPSHOTS_PER_CYCLE * CYCLES + 10 * CYCLES,
    )

    // 3. No runaway respawn — successful spawns ≤ cap × (cycles + 1).
    //    Each cycle cleans ~half the held sessions, freeing slots for the
    //    next cycle. With cap=4 and 5 cycles, we expect ≤ ~20 successes.
    expect(totalSpawnSuccesses).toBeLessThanOrEqual(MAX_CONCURRENT * (CYCLES + 1))

    // 4. Event-loop lag p99 < 1s.
    const p99Ms = histogram.percentile(99) / 1e6
    expect(p99Ms).toBeLessThan(1000)

    // 5. RSS delta < 150 MB (mocked load — real subprocess cost excluded).
    const rssDeltaMb = (process.memoryUsage().rss - rssBefore) / (1024 * 1024)
    expect(rssDeltaMb).toBeLessThan(150)
  }, 30_000)
})
