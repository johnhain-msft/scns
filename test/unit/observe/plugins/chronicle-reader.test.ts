import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createChroniclePlugin } from '../../../../src/observe/plugins/chronicle-reader.js'
import type { ChronicleFileReader } from '../../../../src/observe/plugins/chronicle-reader.js'
import type { ObservationEvent } from '../../../../src/observe/plugin-events.js'

/** Create a mock file reader for testing */
function createMockFileReader(files: Record<string, string> = {}): ChronicleFileReader {
  return {
    async exists(path: string): Promise<boolean> {
      return path in files || Object.keys(files).some((f) => f.startsWith(path + '/'))
    },
    async readDir(path: string): Promise<readonly string[]> {
      const prefix = path.endsWith('/') ? path : path + '/'
      return Object.keys(files)
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length))
        .filter((f) => !f.includes('/'))
    },
    async readFile(path: string): Promise<string> {
      const content = files[path]
      if (content === undefined) throw new Error(`ENOENT: no such file: ${path}`)
      return content
    },
    async writeFile(path: string, content: string): Promise<void> {
      files[path] = content
    },
    async mkdir(_path: string): Promise<void> {
      // no-op for mock
    },
  }
}

function makeEntryJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sessionId: 'sess-1',
    timestamp: '2024-01-15T10:00:00.000Z',
    type: 'session-start',
    content: 'Session started',
    ...overrides,
  })
}

describe('createChroniclePlugin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('metadata', () => {
    it('has correct plugin metadata', () => {
      const plugin = createChroniclePlugin()
      expect(plugin.metadata.name).toBe('chronicle-reader')
      expect(plugin.metadata.source).toBe('chronicle')
      expect(plugin.metadata.version).toBeDefined()
      expect(plugin.metadata.description).toBeDefined()
    })

    it('has sessions capability', () => {
      const plugin = createChroniclePlugin()
      expect(plugin.capabilities).toContain('sessions')
    })
  })

  describe('state lifecycle', () => {
    it('starts in idle state', () => {
      const plugin = createChroniclePlugin()
      expect(plugin.state).toBe('idle')
      expect(plugin.isRunning()).toBe(false)
    })

    it('transitions to running on start()', () => {
      const reader = createMockFileReader()
      const plugin = createChroniclePlugin({ fileReader: reader })
      plugin.start()
      expect(plugin.state).toBe('running')
      expect(plugin.isRunning()).toBe(true)
      plugin.stop()
    })

    it('transitions to idle on stop()', () => {
      const reader = createMockFileReader()
      const plugin = createChroniclePlugin({ fileReader: reader })
      plugin.start()
      plugin.stop()
      expect(plugin.state).toBe('idle')
      expect(plugin.isRunning()).toBe(false)
    })

    it('stop() is safe to call when idle', () => {
      const plugin = createChroniclePlugin()
      expect(() => plugin.stop()).not.toThrow()
    })

    it('start() is idempotent when running', () => {
      const reader = createMockFileReader()
      const plugin = createChroniclePlugin({ fileReader: reader })
      plugin.start()
      expect(() => plugin.start()).not.toThrow()
      plugin.stop()
    })
  })

  describe('configure', () => {
    it('accepts valid config', () => {
      const plugin = createChroniclePlugin()
      expect(() =>
        plugin.configure({
          chroniclePath: '/custom/path',
          pollIntervalMs: 5000,
          maxEntriesPerPoll: 50,
        }),
      ).not.toThrow()
    })

    it('rejects invalid pollIntervalMs', () => {
      const plugin = createChroniclePlugin()
      expect(() => plugin.configure({ pollIntervalMs: 100 })).toThrow()
    })

    it('rejects invalid maxEntriesPerPoll', () => {
      const plugin = createChroniclePlugin()
      expect(() => plugin.configure({ maxEntriesPerPoll: 0 })).toThrow()
    })

    it('applies defaults for missing fields', () => {
      const plugin = createChroniclePlugin()
      expect(() => plugin.configure({})).not.toThrow()
    })
  })

  describe('getConfigSchema', () => {
    it('returns a Zod schema', () => {
      const plugin = createChroniclePlugin()
      const schema = plugin.getConfigSchema()
      expect(schema).toBeDefined()
      const result = schema.safeParse({ chroniclePath: '/test', pollIntervalMs: 5000 })
      expect(result.success).toBe(true)
    })
  })

  describe('healthCheck', () => {
    it('reports healthy when chronicle path exists', async () => {
      const reader = createMockFileReader({ '/home/user/.copilot/chronicle/data.json': '{}' })
      const plugin = createChroniclePlugin({
        fileReader: reader,
        chroniclePath: '/home/user/.copilot/chronicle',
      })
      const health = await plugin.healthCheck()
      expect(health.healthy).toBe(true)
      expect(health.message).toContain('accessible')
    })

    it('reports unhealthy when chronicle path does not exist', async () => {
      const reader = createMockFileReader({})
      const plugin = createChroniclePlugin({
        fileReader: reader,
        chroniclePath: '/nonexistent/path',
      })
      const health = await plugin.healthCheck()
      expect(health.healthy).toBe(false)
      expect(health.message).toContain('not found')
    })
  })

  describe('polling and events', () => {
    it('reads entries from chronicle directory', async () => {
      const events: ObservationEvent[] = []
      const onEvent = (e: ObservationEvent) => {
        events.push(e)
      }

      const entry1 = makeEntryJson({
        sessionId: 'sess-1',
        type: 'session-start',
        timestamp: '2024-01-15T10:00:00.000Z',
      })
      const entry2 = makeEntryJson({
        sessionId: 'sess-1',
        type: 'session-end',
        timestamp: '2024-01-15T10:05:00.000Z',
      })

      const reader = createMockFileReader({
        '/chronicle/session-1.jsonl': entry1 + '\n' + entry2 + '\n',
      })

      const plugin = createChroniclePlugin({
        fileReader: reader,
        onEvent,
        chroniclePath: '/chronicle',
        cursorPath: '/state/cursor.json',
      })

      plugin.start()
      await vi.advanceTimersByTimeAsync(100)

      expect(events.length).toBe(2)
      expect(events[0]!.source).toBe('chronicle')
      expect(events[0]!.payload['sessionId']).toBe('sess-1')
      expect(events[1]!.payload['type']).toBe('session-end')

      plugin.stop()
    })

    it('emits events with correct ObservationEvent shape', async () => {
      const events: ObservationEvent[] = []
      const entry = makeEntryJson({
        sessionId: 'sess-X',
        type: 'summary',
        content: 'Did some work',
      })

      const reader = createMockFileReader({
        '/chronicle/data.jsonl': entry + '\n',
      })

      const plugin = createChroniclePlugin({
        fileReader: reader,
        onEvent: (e) => events.push(e),
        chroniclePath: '/chronicle',
        cursorPath: '/state/cursor.json',
      })

      plugin.start()
      await vi.advanceTimersByTimeAsync(100)

      expect(events.length).toBe(1)
      const ev = events[0]!
      expect(ev.id).toBeDefined()
      expect(ev.source).toBe('chronicle')
      expect(ev.type).toBe('summary')
      expect(ev.timestamp).toBe('2024-01-15T10:00:00.000Z')
      expect(ev.payload['content']).toBe('Did some work')
      expect(ev.tags).toContain('chronicle')

      plugin.stop()
    })

    it('skips already-read entries on subsequent polls (cursor tracking)', async () => {
      const events: ObservationEvent[] = []
      const files: Record<string, string> = {
        '/chronicle/data.jsonl':
          makeEntryJson({ sessionId: 'a', timestamp: '2024-01-15T10:00:00.000Z' }) + '\n',
      }

      const reader = createMockFileReader(files)
      const plugin = createChroniclePlugin({
        fileReader: reader,
        onEvent: (e) => events.push(e),
        chroniclePath: '/chronicle',
        cursorPath: '/state/cursor.json',
        pollIntervalMs: 1000,
      })

      plugin.start()
      await vi.advanceTimersByTimeAsync(100)
      expect(events.length).toBe(1)

      // Add new entry
      files['/chronicle/data.jsonl'] +=
        makeEntryJson({ sessionId: 'b', timestamp: '2024-01-15T11:00:00.000Z' }) + '\n'

      await vi.advanceTimersByTimeAsync(1000)
      expect(events.length).toBe(2)
      expect(events[1]!.payload['sessionId']).toBe('b')

      plugin.stop()
    })

    it('handles empty chronicle directory gracefully', async () => {
      const events: ObservationEvent[] = []
      const reader = createMockFileReader({})

      const plugin = createChroniclePlugin({
        fileReader: reader,
        onEvent: (e) => events.push(e),
        chroniclePath: '/chronicle',
        cursorPath: '/state/cursor.json',
      })

      plugin.start()
      await vi.advanceTimersByTimeAsync(100)
      expect(events.length).toBe(0)
      plugin.stop()
    })

    it('handles missing chronicle directory gracefully', async () => {
      const events: ObservationEvent[] = []
      const reader = createMockFileReader({})

      const plugin = createChroniclePlugin({
        fileReader: reader,
        onEvent: (e) => events.push(e),
        chroniclePath: '/nonexistent',
        cursorPath: '/state/cursor.json',
      })

      plugin.start()
      await vi.advanceTimersByTimeAsync(100)
      expect(events.length).toBe(0)
      plugin.stop()
    })

    it('handles malformed JSON lines gracefully', async () => {
      const events: ObservationEvent[] = []
      const reader = createMockFileReader({
        '/chronicle/data.jsonl': 'not-json\n' + makeEntryJson({ sessionId: 'valid' }) + '\n',
      })

      const plugin = createChroniclePlugin({
        fileReader: reader,
        onEvent: (e) => events.push(e),
        chroniclePath: '/chronicle',
        cursorPath: '/state/cursor.json',
      })

      plugin.start()
      await vi.advanceTimersByTimeAsync(100)
      // Should only emit the valid entry, skip malformed
      expect(events.length).toBe(1)
      expect(events[0]!.payload['sessionId']).toBe('valid')
      plugin.stop()
    })

    it('respects maxEntriesPerPoll limit', async () => {
      const events: ObservationEvent[] = []
      const lines =
        Array.from({ length: 10 }, (_, i) =>
          makeEntryJson({
            sessionId: `s-${i}`,
            timestamp: `2024-01-15T${String(i).padStart(2, '0')}:00:00.000Z`,
          }),
        ).join('\n') + '\n'

      const reader = createMockFileReader({
        '/chronicle/data.jsonl': lines,
      })

      const plugin = createChroniclePlugin({
        fileReader: reader,
        onEvent: (e) => events.push(e),
        chroniclePath: '/chronicle',
        cursorPath: '/state/cursor.json',
        maxEntriesPerPoll: 3,
      })

      plugin.start()
      await vi.advanceTimersByTimeAsync(100)
      // First poll: only 3 entries
      expect(events.length).toBe(3)

      plugin.stop()
    })

    it('does not emit events after stop()', async () => {
      const events: ObservationEvent[] = []
      const reader = createMockFileReader({
        '/chronicle/data.jsonl': makeEntryJson() + '\n',
      })

      const plugin = createChroniclePlugin({
        fileReader: reader,
        onEvent: (e) => events.push(e),
        chroniclePath: '/chronicle',
        cursorPath: '/state/cursor.json',
        pollIntervalMs: 1000,
      })

      plugin.start()
      await vi.advanceTimersByTimeAsync(100)
      const countAfterFirstPoll = events.length
      plugin.stop()

      await vi.advanceTimersByTimeAsync(5000)
      expect(events.length).toBe(countAfterFirstPoll)
    })
  })

  describe('observer type', () => {
    it('has chronicle type', () => {
      const plugin = createChroniclePlugin()
      expect(plugin.type).toBe('chronicle')
    })

    it('has chronicle-reader name', () => {
      const plugin = createChroniclePlugin()
      expect(plugin.name).toBe('chronicle-reader')
    })
  })
})
