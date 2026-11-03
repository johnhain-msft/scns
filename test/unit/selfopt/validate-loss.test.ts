/**
 * Phase 1 wedge B — validate-loss pure helper. CI-safe: the candidate "real"
 * backend is an `AcpReplayBackend` driven by an INJECTED fake `AcpClient`, so the
 * suite NEVER spawns a real copilot process. Proves the headline `min_chars`
 * reading is a genuine FUNCTION of the candidate response (it MOVES when the real
 * output changes) while it is a CONSTANT under the deterministic Mock baseline.
 */
import { describe, it, expect } from 'vitest'
import {
  validateLoss,
  scoreLossReadings,
  resolveValidateLossMode,
  VALIDATE_LOSS_ACP_ENV,
  HEADLINE_TASK,
  HEADLINE_MIN_CHARS,
} from '../../../src/selfopt/validate-loss.js'
import { AcpReplayBackend } from '../../../src/selfopt/acp-replay-backend.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPromptResult,
} from '../../../src/broker/services/acp-client.js'

const ISOLATED_CWD = '/tmp/scns-validate-loss-isolated-wt'

interface ClientSpy {
  factoryCalls: number
  closed: boolean
}

function freshSpy(): ClientSpy {
  return { factoryCalls: 0, closed: false }
}

/** A fake AcpClient factory — canned output, NO process spawn, NO network. */
function fakeFactory(spy: ClientSpy, output: string): (opts: AcpClientOptions) => AcpClient {
  return (_opts: AcpClientOptions): AcpClient => {
    spy.factoryCalls++
    return {
      async initialize() {
        return { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0' } }
      },
      async createSession() {
        return 'sess-1'
      },
      async sendPrompt(_sessionId: string, _prompt: string): Promise<AcpPromptResult> {
        return { stopReason: 'end_turn', output }
      },
      onUpdate() {},
      getAvailableCommands() {
        return null
      },
      cancelSession() {},
      async close() {
        spy.closed = true
      },
      state: 'ready',
      pid: null,
      timings: {
        processSpawnStartedAt: null,
        initializeResolvedAt: null,
        sessionNewStartedAt: null,
        sessionNewResolvedAt: null,
      },
    }
  }
}

/** Real `AcpReplayBackend` whose only non-determinism (the spawn) is faked. */
function fakeAcpBackend(spy: ClientSpy, output: string): AcpReplayBackend {
  return new AcpReplayBackend({ cwd: ISOLATED_CWD, createClient: fakeFactory(spy, output) })
}

const LONG_WITH_VERIFY =
  'To verify a code change works before claiming success, run the full test suite, ' +
  'reproduce the original failure, confirm it no longer occurs, and inspect the diff ' +
  'for unintended side effects across the affected modules and their callers.'
const LONG_NO_VERIFY =
  'Run the complete automated suite, reproduce the original defect, confirm it no longer ' +
  'occurs, and inspect the change for unintended side effects across the affected modules ' +
  'and their dependents before announcing that the work is genuinely complete and shippable.'

function reading(readings: ReturnType<typeof scoreLossReadings>, id: 'min_chars' | 'contains_verify') {
  const r = readings.find((x) => x.id === id)
  if (!r) throw new Error(`no reading ${id}`)
  return r
}

describe('wedge B — validateLoss responsiveness (real backend, fake client)', () => {
  it('VL-1: a long real answer flips the headline min_chars to pass — delta +1, ONE spawn', async () => {
    expect(LONG_WITH_VERIFY.length).toBeGreaterThan(HEADLINE_MIN_CHARS)
    const spy = freshSpy()
    const res = await validateLoss({
      candidateBackend: fakeAcpBackend(spy, LONG_WITH_VERIFY),
      backendLabel: 'acp',
    })

    const headline = reading(res.readings, 'min_chars')
    expect(headline.headline).toBe(true)
    expect(headline.baselineHard).toBe(0)
    expect(headline.candidateHard).toBe(1)
    expect(headline.delta).toBe(1)
    expect(res.headlineDelta).toBe(1)
    expect(res.candidateResponse).toBe(LONG_WITH_VERIFY)
    expect(res.baselineResponse).toBe(HEADLINE_TASK.intent)
    expect(res.backendLabel).toBe('acp')
    expect(res.nSpawns).toBe(1)
    expect(spy.factoryCalls).toBe(1) // exactly ONE spawn
    expect(spy.closed).toBe(true)
  })

  it('VL-2: the SAME task with a SHORT real answer keeps the headline at 0 — delta 0 (responsiveness)', async () => {
    const spy = freshSpy()
    const res = await validateLoss({
      candidateBackend: fakeAcpBackend(spy, 'ok'),
      backendLabel: 'acp',
    })

    const headline = reading(res.readings, 'min_chars')
    expect(headline.baselineHard).toBe(0)
    expect(headline.candidateHard).toBe(0) // moved vs VL-1 purely because the response changed
    expect(headline.delta).toBe(0)
    expect(res.headlineDelta).toBe(0)
    expect(spy.factoryCalls).toBe(1)
  })

  it('VL-3: the two readings move independently over the one response', async () => {
    expect(LONG_NO_VERIFY.length).toBeGreaterThan(HEADLINE_MIN_CHARS)
    expect(LONG_NO_VERIFY.toLowerCase()).not.toContain('verify')
    const spy = freshSpy()
    const res = await validateLoss({
      candidateBackend: fakeAcpBackend(spy, LONG_NO_VERIFY),
      backendLabel: 'acp',
    })

    expect(reading(res.readings, 'min_chars').delta).toBe(1) // long ⇒ passes
    const secondary = reading(res.readings, 'contains_verify')
    expect(secondary.headline).toBe(false)
    expect(secondary.baselineHard).toBe(1) // the intent contains "verify"
    expect(secondary.candidateHard).toBe(0) // this answer does not
    expect(secondary.delta).toBe(-1)
  })
})

describe('wedge B — validateLoss default-OFF (symmetric Mock, no spawn)', () => {
  it('VL-4: with no backends both readings are inert — delta 0, nSpawns 0', async () => {
    const res = await validateLoss()
    expect(res.backendLabel).toBe('mock')
    expect(res.nSpawns).toBe(0)
    expect(res.baselineResponse).toBe(res.candidateResponse)
    for (const r of res.readings) expect(r.delta).toBe(0)
    expect(res.headlineDelta).toBe(0)
  })
})

describe('wedge B — scoreLossReadings (pure, no backend)', () => {
  it('VL-5: scores a baseline/candidate response pair against both judges', () => {
    const short = 'too short'
    const long = 'x'.repeat(HEADLINE_MIN_CHARS) + ' verify'
    const readings = scoreLossReadings(short, long)
    expect(reading(readings, 'min_chars')).toMatchObject({ baselineHard: 0, candidateHard: 1, delta: 1 })
    expect(reading(readings, 'contains_verify')).toMatchObject({ baselineHard: 0, candidateHard: 1, delta: 1 })

    // symmetric input ⇒ every delta 0
    for (const r of scoreLossReadings(long, long)) expect(r.delta).toBe(0)
  })
})

describe('wedge B — resolveValidateLossMode (default-OFF)', () => {
  it('VL-6: parses truthy/falsy forms of the ACP opt-in', () => {
    const mk = (v?: string): NodeJS.ProcessEnv =>
      (v === undefined ? {} : { [VALIDATE_LOSS_ACP_ENV]: v }) as NodeJS.ProcessEnv
    expect(resolveValidateLossMode(mk()).useAcp).toBe(false)
    for (const v of ['1', 'true', 'yes', 'on', 'ON', ' True ']) {
      expect(resolveValidateLossMode(mk(v)).useAcp).toBe(true)
    }
    for (const v of ['0', 'false', '', 'nope', 'off']) {
      expect(resolveValidateLossMode(mk(v)).useAcp).toBe(false)
    }
  })
})
