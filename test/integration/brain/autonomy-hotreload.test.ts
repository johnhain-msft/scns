/**
 * Phase 13.9.2 — Autonomy hot-reload integration test.
 *
 * Proves the brain agent picks up autonomy changes written to disk
 * (as `POST /api/autonomy/promote` does) on the next wake() without
 * any restart.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrainAgent, type BrainAgentDeps } from '../../../src/brain/agent-loop.js'
import { createTaskQueue } from '../../../src/brain/task-queue.js'
import { createDecisionTree } from '../../../src/brain/decision-tree.js'
import { createTaskClassifier } from '../../../src/brain/classifier.js'
import { createTemplateEngine } from '../../../src/brain/templates.js'
import { createHealthMonitor } from '../../../src/context/health-monitor.js'
import { loadAutonomy, saveAutonomy, promote } from '../../../src/shared/autonomy.js'

function makeDeps(overrides: Partial<BrainAgentDeps>): BrainAgentDeps {
  return {
    classifier: createTaskClassifier(),
    decisionTree: createDecisionTree(),
    templateEngine: createTemplateEngine(),
    healthMonitor: createHealthMonitor(),
    taskQueue: createTaskQueue(),
    onSpawnAgent: vi.fn().mockResolvedValue('session-1'),
    onConsolidate: vi.fn().mockResolvedValue(undefined),
    onRotateContext: vi.fn().mockResolvedValue(undefined),
    getObservationCount: vi.fn().mockReturnValue(10),
    getActiveSessions: vi.fn().mockReturnValue(0),
    isUserActive: vi.fn().mockReturnValue(false),
    getLastConsolidationAge: vi.fn().mockReturnValue(2),
    ...overrides,
  }
}

describe('Autonomy hot-reload (Phase 13.9.2)', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('promote on disk changes brain behavior on next wake without restart', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scns-autonomy-hotreload-'))

    // Start at L0 — observer-only
    saveAutonomy(tmpDir, {
      level: 0,
      changedAt: new Date().toISOString(),
      changedBy: 'user',
    })

    const generate = vi.fn().mockReturnValue([])
    const patterns = {
      workSchedule: null,
      toolFrequency: null,
      projectFocus: null,
      observationCount: 10,
      windowStart: '2025-01-01T00:00:00Z',
      windowEnd: '2025-01-08T00:00:00Z',
    }

    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(10),
      getDetectedPatterns: vi.fn().mockReturnValue(patterns),
      suggestionGenerator: { generate },
      // Real file-backed autonomy reader — same pattern used in cli.ts wiring
      getAutonomyLevel: () => loadAutonomy(tmpDir).level,
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 0 })

    // Tick 1 at L0 — no suggestions generated
    await agent.wake()
    expect(generate).not.toHaveBeenCalled()
    expect(loadAutonomy(tmpDir).level).toBe(0)

    // Simulate `POST /api/autonomy/promote` — writes to disk
    const newState = promote(tmpDir)
    expect(newState.level).toBe(1)

    // Tick 2 — must see L1 and generate suggestions with no restart
    await agent.wake()
    expect(generate).toHaveBeenCalledWith(patterns)

    // Promote again to L2
    const l2 = promote(tmpDir)
    expect(l2.level).toBe(2)

    generate.mockClear()
    await agent.wake()
    expect(generate).toHaveBeenCalledWith(patterns)
  })

  it('missing autonomy file falls back cleanly', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scns-autonomy-hotreload-'))
    // No autonomy.json written — loader returns default L0

    const deps = makeDeps({
      getAutonomyLevel: () => loadAutonomy(tmpDir).level,
    })
    const agent = createBrainAgent(deps)

    const decision = await agent.wake()
    expect(decision).toBeDefined()
    // Default is L0 observer — decision is made, no crash
    expect(loadAutonomy(tmpDir).level).toBe(0)
  })
})
