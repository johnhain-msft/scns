import { describe, it, expect, vi } from 'vitest'
import {
  createEventDispatcher,
  createNullDispatcher,
  extractTeamId,
  type TypedEvent,
  type EventFilter,
} from '../../../src/broker/event-dispatcher.js'

function makeEvent(overrides: Partial<TypedEvent> = {}): TypedEvent {
  return {
    id: 1,
    event_type: 'session_registered',
    session_id: 'sess-1',
    payload: '{}',
    team_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('EventDispatcher', () => {
  it('dispatch sends event to subscribers', () => {
    const dispatcher = createEventDispatcher()
    const handler = vi.fn()
    dispatcher.subscribe({}, handler)

    const event = makeEvent()
    dispatcher.dispatch(event)

    expect(handler).toHaveBeenCalledWith(event)
  })

  it('filter by event_types works', () => {
    const dispatcher = createEventDispatcher()
    const handler = vi.fn()
    dispatcher.subscribe({ event_types: ['message_sent'] }, handler)

    dispatcher.dispatch(makeEvent({ event_type: 'session_registered' }))
    expect(handler).not.toHaveBeenCalled()

    dispatcher.dispatch(makeEvent({ event_type: 'message_sent' }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('filter by team_id works', () => {
    const dispatcher = createEventDispatcher()
    const handler = vi.fn()
    dispatcher.subscribe({ team_id: 'team-a' }, handler)

    dispatcher.dispatch(makeEvent({ team_id: 'team-b' }))
    expect(handler).not.toHaveBeenCalled()

    dispatcher.dispatch(makeEvent({ team_id: 'team-a' }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('filter by session_id works', () => {
    const dispatcher = createEventDispatcher()
    const handler = vi.fn()
    dispatcher.subscribe({ session_id: 'sess-1' }, handler)

    dispatcher.dispatch(makeEvent({ session_id: 'sess-2' }))
    expect(handler).not.toHaveBeenCalled()

    dispatcher.dispatch(makeEvent({ session_id: 'sess-1' }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('combined filters work (AND logic)', () => {
    const dispatcher = createEventDispatcher()
    const handler = vi.fn()
    const filter: EventFilter = {
      event_types: ['message_sent'],
      team_id: 'team-a',
      session_id: 'sess-1',
    }
    dispatcher.subscribe(filter, handler)

    // wrong event type
    dispatcher.dispatch(
      makeEvent({ event_type: 'session_registered', team_id: 'team-a', session_id: 'sess-1' }),
    )
    expect(handler).not.toHaveBeenCalled()

    // wrong team
    dispatcher.dispatch(
      makeEvent({ event_type: 'message_sent', team_id: 'team-b', session_id: 'sess-1' }),
    )
    expect(handler).not.toHaveBeenCalled()

    // wrong session
    dispatcher.dispatch(
      makeEvent({ event_type: 'message_sent', team_id: 'team-a', session_id: 'sess-2' }),
    )
    expect(handler).not.toHaveBeenCalled()

    // all match
    dispatcher.dispatch(
      makeEvent({ event_type: 'message_sent', team_id: 'team-a', session_id: 'sess-1' }),
    )
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('empty filter matches everything', () => {
    const dispatcher = createEventDispatcher()
    const handler = vi.fn()
    dispatcher.subscribe({}, handler)

    dispatcher.dispatch(
      makeEvent({ event_type: 'team_created', team_id: 'team-x', session_id: 'sess-99' }),
    )
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe stops delivery', () => {
    const dispatcher = createEventDispatcher()
    const handler = vi.fn()
    const unsub = dispatcher.subscribe({}, handler)

    dispatcher.dispatch(makeEvent())
    expect(handler).toHaveBeenCalledTimes(1)

    unsub()
    dispatcher.dispatch(makeEvent())
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('handler errors do not crash dispatch', () => {
    const dispatcher = createEventDispatcher()
    const badHandler = vi.fn(() => {
      throw new Error('boom')
    })
    const goodHandler = vi.fn()

    dispatcher.subscribe({}, badHandler)
    dispatcher.subscribe({}, goodHandler)

    expect(() => dispatcher.dispatch(makeEvent())).not.toThrow()
    expect(badHandler).toHaveBeenCalledTimes(1)
    expect(goodHandler).toHaveBeenCalledTimes(1)
  })

  it('subscriberCount tracks correctly', () => {
    const dispatcher = createEventDispatcher()
    expect(dispatcher.subscriberCount()).toBe(0)

    const unsub1 = dispatcher.subscribe({}, vi.fn())
    expect(dispatcher.subscriberCount()).toBe(1)

    const unsub2 = dispatcher.subscribe({}, vi.fn())
    expect(dispatcher.subscriberCount()).toBe(2)

    unsub1()
    expect(dispatcher.subscriberCount()).toBe(1)

    unsub2()
    expect(dispatcher.subscriberCount()).toBe(0)
  })
})

describe('createNullDispatcher', () => {
  it('is a no-op', () => {
    const dispatcher = createNullDispatcher()
    expect(dispatcher.subscriberCount()).toBe(0)

    const handler = vi.fn()
    const unsub = dispatcher.subscribe({}, handler)
    dispatcher.dispatch(makeEvent())

    expect(handler).not.toHaveBeenCalled()
    expect(dispatcher.subscriberCount()).toBe(0)
    unsub() // should not throw
  })
})

describe('extractTeamId', () => {
  it('extracts from object with team_id string', () => {
    expect(extractTeamId({ team_id: 'team-abc' })).toBe('team-abc')
  })

  it('returns null when team_id is not a string', () => {
    expect(extractTeamId({ team_id: 123 })).toBeNull()
    expect(extractTeamId({})).toBeNull()
    expect(extractTeamId({ other: 'val' })).toBeNull()
  })
})
