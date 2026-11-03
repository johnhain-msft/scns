import { describe, expect, it } from 'vitest'
import {
  decideStartupNotice,
  startupNoticeRuntimeJs,
  type StartupNoticeState,
} from '../../../src/copilot-extension/startup-notice.js'

describe('startup notice state transitions', () => {
  it('announces once across replacement hosts sharing the same activation', () => {
    let state: StartupNoticeState | null = null
    const shown: boolean[] = []
    for (let fork = 0; fork < 6; fork++) {
      const decision = decideStartupNotice(state, 'session-a', 'start-a', 'ready')
      shown.push(decision.announce)
      state = decision.next
    }
    expect(shown).toEqual([true, false, false, false, false, false])
  })

  it('announces a new activation of the same conversation without a time threshold', () => {
    const previous = decideStartupNotice(null, 'session-a', 'start-a', 'ready').next
    expect(decideStartupNotice(previous, 'session-a', 'resume-a', 'ready').announce).toBe(true)
    expect(decideStartupNotice(previous, 'session-b', 'start-a', 'ready').announce).toBe(true)
  })

  it('announces recurring failure and recovery instead of remembering all prior text', () => {
    let state: StartupNoticeState | null = null
    const shown: string[] = []
    for (const message of ['ready', 'failed', 'failed', 'ready', 'ready', 'failed', 'ready']) {
      const decision = decideStartupNotice(state, 'session-a', 'start-a', message)
      if (decision.announce) shown.push(message)
      state = decision.next
    }
    expect(shown).toEqual(['ready', 'failed', 'ready', 'failed', 'ready'])
  })

  it('preserves severity changes and route changes', () => {
    const state = decideStartupNotice(null, 'session-a', 'start-a', 'route-a', 'info').next
    expect(decideStartupNotice(state, 'session-a', 'start-a', 'route-a', 'warning').announce).toBe(
      true,
    )
    expect(decideStartupNotice(state, 'session-a', 'start-a', 'route-b').announce).toBe(true)
  })

  it.each([null, {}, 7, { sessionId: 'session-a', entries: [] }, { version: 1 }])(
    'does not suppress notices using invalid or obsolete state: %j',
    (previous) => {
      expect(decideStartupNotice(previous, 'session-a', 'start-a', 'ready').announce).toBe(true)
    },
  )

  it('does not infer a persistent identity when the session or activation is unknown', () => {
    for (const [session, activation] of [
      ['', 'start-a'],
      ['session-a', ''],
    ]) {
      const previous = decideStartupNotice(null, session!, activation!, 'ready').next
      expect(decideStartupNotice(previous, session!, activation!, 'ready').announce).toBe(true)
    }
  })

  it('stores only the last delivered state', () => {
    let state: StartupNoticeState | null = null
    for (let n = 0; n < 100; n++) {
      state = decideStartupNotice(state, 'session-a', 'start-a', `route-${n}`).next
    }
    expect(state).toEqual({
      version: 1,
      sessionId: 'session-a',
      activationId: 'start-a',
      message: 'route-99',
      level: 'info',
    })
  })
})

describe('emitted startup-notice decision', () => {
  it('matches the core across valid, invalid, changed and unknown identities', () => {
    const emitted = new Function(
      `${startupNoticeRuntimeJs()}; return decideStartupNotice;`,
    )() as typeof decideStartupNotice
    const state = decideStartupNotice(null, 'session-a', 'start-a', 'ready').next
    for (const previous of [null, {}, state, 0, { ...state, version: 0 }]) {
      for (const session of ['', 'session-a', 'session-b']) {
        for (const activation of ['', 'start-a', 'resume-a']) {
          for (const message of ['ready', 'failed']) {
            for (const level of ['info', 'warning', 'error']) {
              expect(emitted(previous, session, activation, message, level)).toEqual(
                decideStartupNotice(previous, session, activation, message, level),
              )
            }
          }
        }
      }
    }
  })
})
