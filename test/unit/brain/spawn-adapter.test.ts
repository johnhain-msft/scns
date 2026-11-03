/**
 * Tests for BrainSpawnAdapter — bridges brain callback → agent spawner.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import {
  createBrainSpawnAdapter,
  type BrainSpawnAdapterDeps,
} from '../../../src/brain/spawn-adapter.js'

function createMockDeps(overrides: Partial<BrainSpawnAdapterDeps> = {}): BrainSpawnAdapterDeps {
  return {
    db: {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(null),
        run: vi.fn(),
      }),
    } as unknown as Database.Database,
    spawner: {
      spawn: vi.fn().mockResolvedValue({
        sessionId: 'session-123',
        teamId: 'team-1',
        name: 'brain-implementer-abc',
        role: 'implementer',
        platform: { os: 'darwin', shell: '/bin/zsh' },
        launchMethod: 'acp',
        pid: 1234,
        tmuxSession: null,
        tmuxWindow: null,
        acpSessionId: 'acp-sess-1',
      }),
      sendMessage: vi.fn().mockResolvedValue({ accepted: true }),
      getActiveAgents: vi.fn().mockReturnValue(new Map()),
      cleanup: vi.fn().mockResolvedValue(undefined),
      shutdownAll: vi.fn().mockResolvedValue(undefined),
    },
    preferredLaunchMethod: 'acp',
    workingDir: '/test/dir',
    ...overrides,
  }
}

describe('BrainSpawnAdapter', () => {
  let deps: BrainSpawnAdapterDeps

  beforeEach(() => {
    deps = createMockDeps()
  })

  it('spawns an agent with correct params from brain callback', async () => {
    const adapter = createBrainSpawnAdapter(deps)
    const sessionId = await adapter.spawnAgent('Write tests for auth', 'implementer')

    expect(sessionId).toBe('session-123')
    expect(deps.spawner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^brain-implementer-/),
        role: 'implementer',
        prompt: 'Write tests for auth',
        launch_method: 'acp',
      }),
    )
  })

  it('auto-creates team when teamId provided and team does not exist', async () => {
    const dbGet = vi.fn().mockReturnValue(null) // team not found
    const dbRun = vi.fn()
    deps = createMockDeps({
      db: {
        prepare: vi.fn().mockReturnValue({
          get: dbGet,
          run: dbRun,
        }),
      } as unknown as Database.Database,
    })

    const adapter = createBrainSpawnAdapter(deps)
    await adapter.spawnAgent('Do work', 'reviewer', 'team-brain-42')

    // Should have tried to look up team, then create it
    expect(deps.db.prepare).toHaveBeenCalled()
    expect(deps.spawner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        team_id: 'team-brain-42',
      }),
    )
  })

  it('uses existing team when it already exists', async () => {
    const dbGet = vi.fn().mockReturnValue({ id: 'existing-team', name: 'test' })
    deps = createMockDeps({
      db: {
        prepare: vi.fn().mockReturnValue({
          get: dbGet,
          run: vi.fn(),
        }),
      } as unknown as Database.Database,
    })

    const adapter = createBrainSpawnAdapter(deps)
    await adapter.spawnAgent('Do work', 'implementer', 'existing-team')

    expect(deps.spawner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        team_id: 'existing-team',
      }),
    )
  })

  it('creates default solo team when no teamId provided', async () => {
    const adapter = createBrainSpawnAdapter(deps)
    await adapter.spawnAgent('Solo task', 'implementer')

    expect(deps.spawner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        team_id: 'brain-solo',
      }),
    )
  })

  it('generates deterministic agent names from role', async () => {
    const adapter = createBrainSpawnAdapter(deps)
    await adapter.spawnAgent('Task 1', 'implementer')
    await adapter.spawnAgent('Task 2', 'reviewer')

    const calls = vi.mocked(deps.spawner.spawn).mock.calls
    expect(calls[0]![0].name).toMatch(/^brain-implementer-/)
    expect(calls[1]![0].name).toMatch(/^brain-reviewer-/)
  })

  it('falls back to detached when preferred launch method fails', async () => {
    const spawner = {
      ...deps.spawner,
      spawn: vi
        .fn()
        .mockRejectedValueOnce(new Error('ACP not available'))
        .mockResolvedValueOnce({
          sessionId: 'session-fallback',
          teamId: 'brain-solo',
          name: 'brain-implementer-abc',
          role: 'implementer',
          platform: { os: 'darwin', shell: '/bin/zsh' },
          launchMethod: 'detached',
          pid: 5678,
          tmuxSession: null,
          tmuxWindow: null,
          acpSessionId: null,
        }),
    }

    const adapter = createBrainSpawnAdapter({ ...deps, spawner })
    const sessionId = await adapter.spawnAgent('Task', 'implementer')

    expect(sessionId).toBe('session-fallback')
    expect(spawner.spawn).toHaveBeenCalledTimes(2)
    // Second call should use 'detached'
    expect(spawner.spawn.mock.calls[1]![0].launch_method).toBe('detached')
  })

  it('passes working directory to spawner', async () => {
    const adapter = createBrainSpawnAdapter(deps)
    await adapter.spawnAgent('Task', 'implementer')

    expect(deps.spawner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        working_dir: '/test/dir',
      }),
    )
  })

  it('returns session ID from spawn result', async () => {
    const adapter = createBrainSpawnAdapter(deps)
    const id = await adapter.spawnAgent('Task', 'implementer')
    expect(id).toBe('session-123')
  })

  it('normalizes the brain researcher role to the canonical broker spawn-role (bridge)', async () => {
    const adapter = createBrainSpawnAdapter(deps)
    await adapter.spawnAgent('Investigate the stall', 'researcher', 'team-x')

    // The recorded team_members.role must be scns-researcher so the broker
    // (buildResearcherPrompt, QG isAnalysisCompletion) recognizes it.
    expect(deps.spawner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'scns-researcher',
        name: expect.stringMatching(/^brain-scns-researcher-/),
      }),
    )
  })

  it('leaves non-researcher roles unchanged (researcher-only bridge scope)', async () => {
    const adapter = createBrainSpawnAdapter(deps)
    await adapter.spawnAgent('Build it', 'implementer', 'team-y')

    expect(deps.spawner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'implementer' }),
    )
  })
})
