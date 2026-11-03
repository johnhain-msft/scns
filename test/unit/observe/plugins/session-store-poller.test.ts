import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSessionStorePoller } from '../../../../src/observe/plugins/session-store-poller.js'
import type {
  SessionStoreDbReader,
  SessionStoreRow,
  TurnRow,
} from '../../../../src/observe/plugins/session-store-poller.js'
import type { ObservationEvent } from '../../../../src/observe/plugin-events.js'

function createMockDbReader(overrides: Partial<SessionStoreDbReader> = {}): SessionStoreDbReader {
  return {
    exists: vi.fn().mockReturnValue(true),
    open: vi.fn(),
    close: vi.fn(),
    getNewSessions: vi.fn().mockReturnValue([]),
    getNewTurns: vi.fn().mockReturnValue([]),
    getSessionCount: vi.fn().mockReturnValue(0),
    ...overrides,
  }
}

function createMockSession(overrides: Partial<SessionStoreRow> = {}): SessionStoreRow {
  return {
    id: 'sess-' + Math.random().toString(36).slice(2, 8),
    cwd: '/home/user/project',
    repository: 'user/repo',
    branch: 'main',
    summary: 'Test session',
    created_at: '2024-01-15T10:00:00Z',
    updated_at: '2024-01-15T10:30:00Z',
    ...overrides,
  }
}

function createMockTurn(overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    id: 1,
    session_id: 'sess-1',
    turn_index: 0,
    user_message: 'Fix the login bug',
    assistant_response: 'I will fix the login bug.',
    timestamp: '2024-01-15T10:00:00Z',
    ...overrides,
  }
}

describe('session-store-poller', () => {
  let events: ObservationEvent[]
  let onEvent: (event: ObservationEvent) => void

  beforeEach(() => {
    events = []
    onEvent = (event) => events.push(event)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('lifecycle', () => {
    it('starts in idle state', () => {
      const poller = createSessionStorePoller({ dbReader: createMockDbReader() })
      expect(poller.isRunning()).toBe(false)
      expect(poller.state).toBe('idle')
    })

    it('transitions to running on start', () => {
      const poller = createSessionStorePoller({ dbReader: createMockDbReader(), onEvent })
      poller.start()
      expect(poller.isRunning()).toBe(true)
      expect(poller.state).toBe('running')
      poller.stop()
    })

    it('transitions back to idle on stop', () => {
      const poller = createSessionStorePoller({ dbReader: createMockDbReader(), onEvent })
      poller.start()
      poller.stop()
      expect(poller.isRunning()).toBe(false)
      expect(poller.state).toBe('idle')
    })

    it('is idempotent for start', () => {
      const dbReader = createMockDbReader()
      const poller = createSessionStorePoller({ dbReader, onEvent })
      poller.start()
      poller.start()
      // getNewSessions called only once (one initial poll)
      expect(dbReader.getNewSessions).toHaveBeenCalledTimes(1)
      poller.stop()
    })

    it('closes DB on stop', () => {
      const dbReader = createMockDbReader()
      const poller = createSessionStorePoller({ dbReader, onEvent })
      poller.start()
      poller.stop()
      expect(dbReader.close).toHaveBeenCalled()
    })
  })

  describe('polling', () => {
    it('performs initial poll on start', () => {
      const session = createMockSession()
      const dbReader = createMockDbReader({
        getNewSessions: vi.fn().mockReturnValue([session]),
      })

      const poller = createSessionStorePoller({ dbReader, onEvent })
      poller.start()

      expect(events.length).toBe(1)
      expect(events[0]!.type).toBe('session-discovered')
      expect(events[0]!.payload['sessionId']).toBe(session.id)
      poller.stop()
    })

    it('polls on interval', () => {
      const dbReader = createMockDbReader()
      const poller = createSessionStorePoller({
        dbReader,
        onEvent,
        pollIntervalMs: 10_000,
      })

      poller.start()
      expect(dbReader.getNewSessions).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(10_000)
      expect(dbReader.getNewSessions).toHaveBeenCalledTimes(2)

      vi.advanceTimersByTime(10_000)
      expect(dbReader.getNewSessions).toHaveBeenCalledTimes(3)

      poller.stop()
    })

    it('emits session-discovered events with correct tags', () => {
      const session = createMockSession({
        id: 'sess-abc',
        repository: 'org/myrepo',
        branch: 'feature/auth',
      })
      const dbReader = createMockDbReader({
        getNewSessions: vi.fn().mockReturnValueOnce([session]),
      })

      const poller = createSessionStorePoller({ dbReader, onEvent })
      poller.start()

      expect(events[0]!.tags).toContain('observer:session-store-poller')
      expect(events[0]!.tags).toContain('event:session-discovered')
      expect(events[0]!.tags).toContain('repo:org/myrepo')
      expect(events[0]!.tags).toContain('branch:feature/auth')
      poller.stop()
    })

    it('emits turn-observed events', () => {
      const turn = createMockTurn({
        id: 42,
        session_id: 'sess-1',
        turn_index: 3,
        user_message: 'Fix the authentication module',
      })
      const dbReader = createMockDbReader({
        getNewTurns: vi.fn().mockReturnValueOnce([turn]),
      })

      const poller = createSessionStorePoller({ dbReader, onEvent })
      poller.start()

      expect(events[0]!.type).toBe('turn-observed')
      expect(events[0]!.payload['sessionId']).toBe('sess-1')
      expect(events[0]!.payload['turnIndex']).toBe(3)
      expect(events[0]!.tags).toContain('session:sess-1')
      poller.stop()
    })

    it('advances cursor after processing sessions', () => {
      const session1 = createMockSession({ created_at: '2024-01-15T10:00:00Z' })
      const session2 = createMockSession({ created_at: '2024-01-15T11:00:00Z' })
      const dbReader = createMockDbReader({
        getNewSessions: vi.fn().mockReturnValueOnce([session1, session2]).mockReturnValueOnce([]),
      })

      const poller = createSessionStorePoller({ dbReader, onEvent, pollIntervalMs: 10_000 })
      poller.start()
      vi.advanceTimersByTime(10_000)

      // Second call should use the updated cursor
      expect(dbReader.getNewSessions).toHaveBeenCalledWith('2024-01-15T11:00:00Z')
      poller.stop()
    })

    it('advances turn cursor after processing turns', () => {
      const turn1 = createMockTurn({ id: 10 })
      const turn2 = createMockTurn({ id: 20 })
      const dbReader = createMockDbReader({
        getNewTurns: vi.fn().mockReturnValueOnce([turn1, turn2]).mockReturnValueOnce([]),
      })

      const poller = createSessionStorePoller({ dbReader, onEvent, pollIntervalMs: 10_000 })
      poller.start()
      vi.advanceTimersByTime(10_000)

      expect(dbReader.getNewTurns).toHaveBeenCalledWith(20)
      poller.stop()
    })

    it('respects maxSessionsPerPoll', () => {
      const sessions = Array.from({ length: 100 }, (_, i) =>
        createMockSession({
          id: `sess-${i}`,
          created_at: `2024-01-15T${String(i).padStart(2, '0')}:00:00Z`,
        }),
      )
      const dbReader = createMockDbReader({
        getNewSessions: vi.fn().mockReturnValueOnce(sessions),
      })

      const poller = createSessionStorePoller({
        dbReader,
        onEvent,
        maxSessionsPerPoll: 10,
      })
      poller.start()

      const sessionEvents = events.filter((e) => e.type === 'session-discovered')
      expect(sessionEvents.length).toBe(10)
      poller.stop()
    })
  })

  describe('graceful degradation', () => {
    it('skips poll when DB file does not exist', () => {
      const dbReader = createMockDbReader({
        exists: vi.fn().mockReturnValue(false),
      })

      const poller = createSessionStorePoller({ dbReader, onEvent })
      poller.start()

      expect(dbReader.open).not.toHaveBeenCalled()
      expect(events.length).toBe(0)
      poller.stop()
    })

    it('handles poll errors without crashing', () => {
      const dbReader = createMockDbReader({
        getNewSessions: vi.fn().mockImplementation(() => {
          throw new Error('SQLITE_BUSY')
        }),
      })

      const poller = createSessionStorePoller({ dbReader, onEvent, pollIntervalMs: 10_000 })
      poller.start()

      // Should not throw, still running
      expect(poller.isRunning()).toBe(true)
      expect(events.length).toBe(0)

      // Retry on next poll should work
      ;(dbReader.getNewSessions as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        createMockSession(),
      ])
      vi.advanceTimersByTime(10_000)
      // After SQLITE_BUSY, it closes and reopens
      expect(dbReader.close).toHaveBeenCalled()
      poller.stop()
    })

    it('reopens DB after transient error', () => {
      const dbReader = createMockDbReader({
        getNewSessions: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error('SQLITE_BUSY: database is locked')
          })
          .mockReturnValueOnce([createMockSession()]),
      })

      const poller = createSessionStorePoller({ dbReader, onEvent, pollIntervalMs: 10_000 })
      poller.start()

      // First poll fails
      expect(events.length).toBe(0)
      expect(dbReader.close).toHaveBeenCalled()

      // Second poll should reopen and succeed
      vi.advanceTimersByTime(10_000)
      expect(dbReader.open).toHaveBeenCalledTimes(2) // initial + retry
      poller.stop()
    })
  })

  describe('healthCheck', () => {
    it('reports healthy when running with no errors', async () => {
      const poller = createSessionStorePoller({ dbReader: createMockDbReader(), onEvent })
      poller.start()

      const health = await poller.healthCheck()
      expect(health.healthy).toBe(true)
      expect(health.message).toBe('Running')
      expect(health.details?.['dbPath']).toBeDefined()
      poller.stop()
    })

    it('reports unhealthy after error', async () => {
      const dbReader = createMockDbReader({
        getNewSessions: vi.fn().mockImplementation(() => {
          throw new Error('DB locked')
        }),
      })

      const poller = createSessionStorePoller({ dbReader, onEvent })
      poller.start()

      const health = await poller.healthCheck()
      expect(health.healthy).toBe(false)
      expect(health.message).toContain('DB locked')
      poller.stop()
    })

    it('reports idle when not started', async () => {
      const poller = createSessionStorePoller({ dbReader: createMockDbReader() })
      const health = await poller.healthCheck()
      expect(health.message).toBe('Idle')
    })

    it('includes event count in details', async () => {
      const dbReader = createMockDbReader({
        getNewSessions: vi.fn().mockReturnValueOnce([createMockSession(), createMockSession()]),
      })
      const poller = createSessionStorePoller({ dbReader, onEvent })
      poller.start()

      const health = await poller.healthCheck()
      expect(health.details?.['totalEventsEmitted']).toBe(2)
      poller.stop()
    })
  })

  describe('metadata', () => {
    it('has correct plugin metadata', () => {
      const poller = createSessionStorePoller({ dbReader: createMockDbReader() })
      expect(poller.metadata.name).toBe('session-store-poller')
      expect(poller.metadata.version).toBe('1.0.0')
      expect(poller.metadata.source).toBe('@scns/session-store-poller')
    })

    it('declares sessions capability', () => {
      const poller = createSessionStorePoller({ dbReader: createMockDbReader() })
      expect(poller.capabilities).toContain('sessions')
    })

    it('has session-hook observer type', () => {
      const poller = createSessionStorePoller({ dbReader: createMockDbReader() })
      expect(poller.type).toBe('session-hook')
    })
  })

  describe('configure', () => {
    it('accepts valid config without error', () => {
      const poller = createSessionStorePoller({ dbReader: createMockDbReader() })
      expect(() => poller.configure({ pollIntervalMs: 30_000 })).not.toThrow()
    })

    it('ignores invalid config silently', () => {
      const poller = createSessionStorePoller({ dbReader: createMockDbReader() })
      expect(() => poller.configure({ invalid: 'garbage' })).not.toThrow()
    })
  })

  describe('truncation', () => {
    it('truncates long user messages in turn events', () => {
      const longMessage = 'x'.repeat(500)
      const turn = createMockTurn({ user_message: longMessage })
      const dbReader = createMockDbReader({
        getNewTurns: vi.fn().mockReturnValueOnce([turn]),
      })

      const poller = createSessionStorePoller({ dbReader, onEvent })
      poller.start()

      expect((events[0]!.payload['promptPreview'] as string).length).toBe(200)
      poller.stop()
    })
  })
})
