/**
 * Stub AgentSpawner for unit tests.
 *
 * Records all spawn() / sendMessage() / cleanup() calls and returns a
 * deterministic SpawnResult so endpoint tests can assert on the inputs and
 * verify side effects without actually starting any child process.
 */

import type {
  AgentSpawner,
  SpawnInput,
  SpawnResult,
  SpawnedAgentInfo,
  SpawnStats,
} from '../../src/broker/services/agent-spawner.js'

export interface StubSpawnerOptions {
  /** Override the default SpawnResult. teamId/name/role default to the input. */
  readonly defaultResult?: Partial<SpawnResult>
  /** If set, spawn() throws this error instead of returning a result. */
  readonly throwOnSpawn?: Error
  /** If set, sendMessage returns this. Defaults to { accepted: true }. */
  readonly sendMessageResult?: { accepted: boolean; error?: string }
}

export interface StubAgentSpawner extends AgentSpawner {
  readonly spawnCalls: ReadonlyArray<SpawnInput>
  readonly sendMessageCalls: ReadonlyArray<{ sessionId: string; message: string }>
  readonly cleanupCalls: ReadonlyArray<string>
  readonly shutdownCalled: () => boolean
  reset(): void
}

let stubCounter = 0

export function createStubSpawner(opts: StubSpawnerOptions = {}): StubAgentSpawner {
  const spawnCalls: SpawnInput[] = []
  const sendMessageCalls: { sessionId: string; message: string }[] = []
  const cleanupCalls: string[] = []
  let shutdown = false
  const active = new Map<string, SpawnedAgentInfo>()

  const stub: StubAgentSpawner = {
    spawnCalls,
    sendMessageCalls,
    cleanupCalls,
    shutdownCalled: () => shutdown,
    reset() {
      spawnCalls.length = 0
      sendMessageCalls.length = 0
      cleanupCalls.length = 0
      shutdown = false
      active.clear()
    },

    async spawn(input: SpawnInput): Promise<SpawnResult> {
      spawnCalls.push(input)
      if (opts.throwOnSpawn) throw opts.throwOnSpawn
      stubCounter += 1
      const sessionId = opts.defaultResult?.sessionId ?? `stub-session-${stubCounter}`
      const launchMethod = input.launch_method ?? opts.defaultResult?.launchMethod ?? 'detached'
      const result: SpawnResult = {
        sessionId,
        teamId: input.team_id,
        name: input.name,
        role: input.role ?? 'scns-dev',
        platform: opts.defaultResult?.platform ?? 'darwin',
        launchMethod,
        pid: opts.defaultResult?.pid ?? 12345,
        tmuxSession: opts.defaultResult?.tmuxSession ?? null,
        tmuxWindow: opts.defaultResult?.tmuxWindow ?? null,
        acpSessionId:
          opts.defaultResult?.acpSessionId ??
          (launchMethod === 'acp' ? `acp-${sessionId}` : null),
      }
      active.set(sessionId, {
        sessionId,
        teamId: result.teamId,
        name: result.name,
        role: result.role,
        pid: result.pid,
        launchMethod: result.launchMethod,
        startedAt: new Date().toISOString(),
        acpSessionId: result.acpSessionId,
      })
      return result
    },

    async sendMessage(sessionId: string, message: string) {
      sendMessageCalls.push({ sessionId, message })
      return opts.sendMessageResult ?? { accepted: true }
    },

    getActiveAgents() {
      return active
    },

    getSpawnStats(): SpawnStats {
      return {
        activeCount: active.size,
        maxConcurrent: 10,
        spawnsLast60s: spawnCalls.length,
        pendingCount: 0,
      }
    },

    async cleanup(sessionId: string) {
      cleanupCalls.push(sessionId)
      active.delete(sessionId)
    },

    async shutdownAll() {
      shutdown = true
      active.clear()
    },
  }

  return stub
}
