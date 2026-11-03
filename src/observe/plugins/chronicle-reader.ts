import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ObserverPlugin, ObserverHealth, PluginMetadata } from '../plugin.js'
import type { ObserverCapability } from '../plugin.js'
import type { ObservationEvent } from '../plugin-events.js'
import type { ObserverState } from '../observer.js'
import type { ObservationType } from '../types.js'
import { logger } from '../../shared/logger.js'

const ChronicleConfigSchema = z.object({
  chroniclePath: z.string().default('~/.copilot/chronicle'),
  pollIntervalMs: z.number().min(1000).default(30000),
  maxEntriesPerPoll: z.number().min(1).default(100),
})

export type ChronicleConfig = z.infer<typeof ChronicleConfigSchema>

export interface ChronicleEntry {
  readonly sessionId: string
  readonly timestamp: string
  readonly type: 'session-start' | 'session-end' | 'summary' | 'instruction-suggestion'
  readonly content: string
  readonly metadata?: Record<string, unknown>
}

const ChronicleEntrySchema = z.object({
  sessionId: z.string(),
  timestamp: z.string(),
  type: z.enum(['session-start', 'session-end', 'summary', 'instruction-suggestion']),
  content: z.string(),
  metadata: z.record(z.unknown()).optional(),
})

/** Cursor tracks last-read position per file */
interface CursorState {
  readonly files: Record<string, number> // file → line offset
}

/** Abstraction for filesystem operations (testable) */
export interface ChronicleFileReader {
  exists(path: string): Promise<boolean>
  readDir(path: string): Promise<readonly string[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  mkdir(path: string): Promise<void>
}

export interface ChroniclePluginOptions {
  readonly fileReader?: ChronicleFileReader
  readonly onEvent?: (event: ObservationEvent) => void
  readonly chroniclePath?: string
  readonly cursorPath?: string
  readonly pollIntervalMs?: number
  readonly maxEntriesPerPoll?: number
}

/** Create a Chronicle observer plugin */
export function createChroniclePlugin(options?: ChroniclePluginOptions): ObserverPlugin {
  const log = logger.child({ module: 'chronicle-reader' })

  let state: ObserverState = 'idle'
  let pollTimeout: ReturnType<typeof setTimeout> | null = null
  let polling = false

  let config: ChronicleConfig = ChronicleConfigSchema.parse({
    chroniclePath: options?.chroniclePath ?? '~/.copilot/chronicle',
    pollIntervalMs: options?.pollIntervalMs ?? 30000,
    maxEntriesPerPoll: options?.maxEntriesPerPoll ?? 100,
  })

  const fileReader = options?.fileReader ?? createDefaultFileReader()
  const onEvent = options?.onEvent
  const cursorPath = options?.cursorPath ?? '~/.scns/chronicle-cursor.json'
  let cursor: CursorState = { files: {} }

  const metadata: PluginMetadata = Object.freeze({
    name: 'chronicle-reader',
    version: '0.1.0',
    source: 'chronicle',
    description: 'Reads Copilot CLI Chronicle session data as observations',
  })

  async function loadCursor(): Promise<void> {
    try {
      if (await fileReader.exists(cursorPath)) {
        const raw = await fileReader.readFile(cursorPath)
        const parsed = JSON.parse(raw) as CursorState
        if (parsed && typeof parsed.files === 'object') {
          cursor = parsed
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to load chronicle cursor, starting fresh')
      cursor = { files: {} }
    }
  }

  async function saveCursor(): Promise<void> {
    try {
      const dir = cursorPath.substring(0, cursorPath.lastIndexOf('/'))
      if (dir) {
        await fileReader.mkdir(dir)
      }
      await fileReader.writeFile(cursorPath, JSON.stringify(cursor, null, 2))
    } catch (err) {
      log.warn({ err }, 'Failed to save chronicle cursor')
    }
  }

  function parseEntry(line: string): ChronicleEntry | null {
    try {
      const parsed = JSON.parse(line) as unknown
      const result = ChronicleEntrySchema.safeParse(parsed)
      if (result.success) return result.data as ChronicleEntry
      return null
    } catch {
      return null
    }
  }

  function toObservationEvent(entry: ChronicleEntry): ObservationEvent {
    return {
      id: randomUUID(),
      source: 'chronicle',
      type: entry.type,
      timestamp: entry.timestamp,
      payload: {
        sessionId: entry.sessionId,
        type: entry.type,
        content: entry.content,
        ...(entry.metadata ?? {}),
      },
      tags: Object.freeze(['chronicle', entry.type]),
    }
  }

  async function poll(): Promise<void> {
    if (state !== 'running' || polling) return
    polling = true

    try {
      const dirExists = await fileReader.exists(config.chroniclePath)
      if (!dirExists) {
        log.debug({ path: config.chroniclePath }, 'Chronicle directory not found')
        return
      }

      const files = await fileReader.readDir(config.chroniclePath)
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'))

      let totalEmitted = 0

      for (const file of jsonlFiles) {
        if (totalEmitted >= config.maxEntriesPerPoll) break
        if (state !== 'running') break

        const filePath = `${config.chroniclePath}/${file}`
        const lineOffset = cursor.files[filePath] ?? 0

        try {
          const content = await fileReader.readFile(filePath)
          const lines = content.split('\n').filter((l) => l.trim().length > 0)

          const newLines = lines.slice(lineOffset)
          for (const line of newLines) {
            if (totalEmitted >= config.maxEntriesPerPoll) break
            if (state !== 'running') break

            const entry = parseEntry(line)
            if (entry) {
              const event = toObservationEvent(entry)
              onEvent?.(event)
              totalEmitted++
            }
          }

          // Advance cursor to how many lines we actually processed
          const processedUpTo = Math.min(lineOffset + newLines.length, lines.length)
          cursor = {
            files: { ...cursor.files, [filePath]: processedUpTo },
          }
        } catch (err) {
          log.warn({ err, file: filePath }, 'Failed to read chronicle file')
        }
      }

      if (totalEmitted > 0) {
        await saveCursor()
        log.debug({ count: totalEmitted }, 'Emitted chronicle entries')
      }
    } catch (err) {
      log.warn({ err }, 'Error during chronicle poll')
    } finally {
      polling = false
    }
  }

  function schedulePoll(): void {
    if (state !== 'running') return
    pollTimeout = setTimeout(async () => {
      await poll()
      schedulePoll()
    }, config.pollIntervalMs)
  }

  const plugin: ObserverPlugin = {
    type: 'chronicle' as ObservationType,
    name: 'chronicle-reader',
    metadata,
    capabilities: Object.freeze(['sessions'] as readonly ObserverCapability[]),

    get state(): ObserverState {
      return state
    },

    start(): void {
      if (state === 'running') return
      state = 'running'
      log.info({ path: config.chroniclePath }, 'Chronicle plugin started')

      // Initial poll immediately, then schedule recurring
      void loadCursor()
        .then(() => poll())
        .then(() => schedulePoll())
        .catch((err) => log.error({ err }, 'Chronicle initial poll failed'))
    },

    stop(): void {
      if (state === 'idle') return
      state = 'idle'
      if (pollTimeout !== null) {
        clearTimeout(pollTimeout)
        pollTimeout = null
      }
      log.info('Chronicle plugin stopped')
    },

    isRunning(): boolean {
      return state === 'running'
    },

    configure(rawConfig: Record<string, unknown>): void {
      const parsed = ChronicleConfigSchema.parse(rawConfig)
      config = parsed
      log.info({ config: parsed }, 'Chronicle plugin reconfigured')
    },

    getConfigSchema(): z.ZodType {
      return ChronicleConfigSchema
    },

    async healthCheck(): Promise<ObserverHealth> {
      const exists = await fileReader.exists(config.chroniclePath)
      return {
        healthy: exists,
        message: exists
          ? `Chronicle path accessible: ${config.chroniclePath}`
          : `Chronicle path not found: ${config.chroniclePath}`,
        lastCheck: new Date().toISOString(),
        details: { chroniclePath: config.chroniclePath, state },
      }
    },
  }

  return plugin
}

/** Default filesystem reader using node:fs/promises */
function createDefaultFileReader(): ChronicleFileReader {
  // Lazy import to avoid issues during testing
  let fsPromises: typeof import('node:fs/promises') | null = null
  let pathModule: typeof import('node:path') | null = null
  let osModule: typeof import('node:os') | null = null

  async function getFs() {
    if (!fsPromises) {
      fsPromises = await import('node:fs/promises')
    }
    return fsPromises
  }

  async function getPath() {
    if (!pathModule) {
      pathModule = await import('node:path')
    }
    return pathModule
  }

  async function getOs() {
    if (!osModule) {
      osModule = await import('node:os')
    }
    return osModule
  }

  async function resolvePath(p: string): Promise<string> {
    const os = await getOs()
    const path = await getPath()
    if (p.startsWith('~')) {
      return path.join(os.homedir(), p.slice(1))
    }
    return path.resolve(p)
  }

  return {
    async exists(p: string): Promise<boolean> {
      const fs = await getFs()
      const resolved = await resolvePath(p)
      try {
        await fs.access(resolved)
        return true
      } catch {
        return false
      }
    },

    async readDir(p: string): Promise<readonly string[]> {
      const fs = await getFs()
      const resolved = await resolvePath(p)
      return fs.readdir(resolved)
    },

    async readFile(p: string): Promise<string> {
      const fs = await getFs()
      const resolved = await resolvePath(p)
      return fs.readFile(resolved, 'utf-8')
    },

    async writeFile(p: string, content: string): Promise<void> {
      const fs = await getFs()
      const resolved = await resolvePath(p)
      await fs.writeFile(resolved, content, 'utf-8')
    },

    async mkdir(p: string): Promise<void> {
      const fs = await getFs()
      const resolved = await resolvePath(p)
      await fs.mkdir(resolved, { recursive: true })
    },
  }
}
