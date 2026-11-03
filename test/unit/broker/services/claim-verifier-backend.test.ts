/**
 * Track 1 / 1B — the spawned producer≠verifier (execution-grounded re-run check).
 *
 * Unit tests for the mechanism in isolation (NO real subprocess — the spawner is
 * injected). Mirrors test/unit/brain/self-critique.test.ts: the non-negotiable
 * contract is that timeouts / errors / malformed output degrade to
 * `needs-evidence`, NEVER to a silent `pass`.
 */
import { describe, it, expect } from 'vitest'
import {
  runClaimReverification,
  parseReverifyResponse,
  buildReverifyPrompt,
  extractCitedProbe,
  createSpawnVerifierBackend,
  loadClaimVerifierSpawnConfig,
  type SpawnVerifier,
  type VerifierSpawnResult,
} from '../../../../src/broker/services/claim-verifier-backend.js'

function mockSpawn(result: Partial<VerifierSpawnResult> = {}): SpawnVerifier {
  return async () => ({
    stdout: '',
    stderr: '',
    sessionId: 'cv-mock',
    timedOut: false,
    exitCode: 0,
    ...result,
  })
}

// An output an analyst produced with a runtime claim (signal: "runs live") + a
// cited, re-runnable probe (the quoted row the verifier must independently confirm).
const CLAIMY =
  'Heartbeat runs live in production; broker :3456 uptime 30260s [live-confirmed] — ' +
  'checked with `curl http://127.0.0.1:3456/api/health`.'

describe('parseReverifyResponse', () => {
  it('extracts a fenced json block with perClaim', () => {
    const raw = [
      'Here is my independent re-run.',
      '```json',
      '{"verdict":"pass","findings":[],"perClaim":[{"claim":"broker up","probe":"curl /api/health","reran":true,"corroborated":true,"note":"status ready"}]}',
      '```',
    ].join('\n')
    const v = parseReverifyResponse(raw)
    expect(v.verdict).toBe('pass')
    expect(v.perClaim).toHaveLength(1)
    expect(v.perClaim[0]!.reran).toBe(true)
    expect(v.perClaim[0]!.corroborated).toBe(true)
  })

  it('extracts inline (non-fenced) JSON and normalizes a contradiction to fail', () => {
    const raw =
      'Result: {"verdict":"fail","findings":["re-run showed uptime differs"],"perClaim":[{"claim":"x","probe":"curl","reran":true,"corroborated":false}]}'
    const v = parseReverifyResponse(raw)
    expect(v.verdict).toBe('fail')
    expect(v.findings[0]).toMatch(/uptime/)
    expect(v.perClaim[0]!.corroborated).toBe(false)
  })

  it('prefers the LAST balanced object', () => {
    const raw = [
      '{"verdict":"needs-evidence","findings":["draft"]}',
      'On reflection:',
      '{"verdict":"pass","findings":[]}',
    ].join('\n')
    expect(parseReverifyResponse(raw).verdict).toBe('pass')
  })

  it('malformed input ⇒ needs-evidence (never a silent pass)', () => {
    const v = parseReverifyResponse('the broker is fine, trust me')
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toBe('malformed-response')
  })

  it('unrecognized verdict string ⇒ needs-evidence with reason', () => {
    const v = parseReverifyResponse('{"verdict":"looks-good"}')
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toMatch(/unrecognized-verdict:looks-good/)
  })

  it('empty string ⇒ needs-evidence, no findings noise', () => {
    const v = parseReverifyResponse('')
    expect(v.verdict).toBe('needs-evidence')
    expect(v.findings).toEqual([])
  })
})

describe('extractCitedProbe', () => {
  it('pulls a backticked read-only command', () => {
    expect(extractCitedProbe(CLAIMY)).toBe('curl http://127.0.0.1:3456/api/health')
  })
  it('pulls a grep caller-check', () => {
    expect(
      extractCitedProbe('no caller of createWatchdogDaemon [code-only] — `grep -rn createWatchdogDaemon src/`'),
    ).toBe('grep -rn createWatchdogDaemon src/')
  })
  it('returns null when no probe is cited', () => {
    expect(extractCitedProbe('the watchdog is unwired [code-only].')).toBeNull()
  })
  it('ignores a lone backticked symbol (no command verb / no spaces)', () => {
    expect(extractCitedProbe('`createWatchdogDaemon` has no caller [code-only].')).toBeNull()
  })
})

describe('buildReverifyPrompt', () => {
  it('embeds the producer≠verifier persona, the claim, and its cited probe', () => {
    const p = buildReverifyPrompt({ output: CLAIMY })
    expect(p).toMatch(/INDEPENDENT producer≠verifier/)
    expect(p).toMatch(/RE-RUN/)
    expect(p).toMatch(/curl http:\/\/127\.0\.0\.1:3456\/api\/health/)
    // Instructs conservative degradation, not pass-on-faith.
    expect(p).toMatch(/never pass on faith/i)
  })
  it('truncates very large outputs', () => {
    const big = 'runs live '.repeat(4000)
    expect(buildReverifyPrompt({ output: big })).toMatch(/\[truncated\]/)
  })
})

describe('runClaimReverification — degradation contract (mirror self-critique)', () => {
  it('disabled ⇒ pass (defer), never spawns', async () => {
    let spawned = false
    const spy: SpawnVerifier = async () => {
      spawned = true
      return { stdout: '', stderr: '', sessionId: 'x', timedOut: false, exitCode: 0 }
    }
    const v = await runClaimReverification({ output: CLAIMY }, { enabled: false, spawnVerifier: spy })
    expect(v.verdict).toBe('pass')
    expect(v.degradedReason).toBe('disabled')
    expect(spawned).toBe(false)
  })

  it('no runtime claims ⇒ pass without spawning', async () => {
    let spawned = false
    const spy: SpawnVerifier = async () => {
      spawned = true
      return { stdout: '', stderr: '', sessionId: 'x', timedOut: false, exitCode: 0 }
    }
    const v = await runClaimReverification(
      { output: 'The sky is blue and the code compiles.' },
      { enabled: true, spawnVerifier: spy },
    )
    expect(v.verdict).toBe('pass')
    expect(spawned).toBe(false)
  })

  it('no spawner wired ⇒ needs-evidence (cannot safely pass)', async () => {
    const v = await runClaimReverification({ output: CLAIMY }, { enabled: true })
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toBe('no-spawner')
  })

  it('timeout ⇒ needs-evidence (never silent pass)', async () => {
    const v = await runClaimReverification(
      { output: CLAIMY },
      { enabled: true, spawnVerifier: mockSpawn({ timedOut: true, exitCode: null }) },
    )
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toBe('verifier-timeout')
  })

  it('non-zero exit ⇒ needs-evidence', async () => {
    const v = await runClaimReverification(
      { output: CLAIMY },
      { enabled: true, spawnVerifier: mockSpawn({ exitCode: 2, stderr: 'boom' }) },
    )
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toBe('verifier-exit-nonzero')
  })

  it('spawner throws ⇒ needs-evidence', async () => {
    const throwing: SpawnVerifier = async () => {
      throw new Error('spawn ENOENT')
    }
    const v = await runClaimReverification({ output: CLAIMY }, { enabled: true, spawnVerifier: throwing })
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toBe('spawn-failed')
    expect(v.findings[0]).toMatch(/ENOENT/)
  })

  // ── Positive controls: the verifier's real verdicts flow through ──────────

  it('corroborated re-run ⇒ pass (carries session id)', async () => {
    const stdout =
      '```json\n{"verdict":"pass","findings":[],"perClaim":[{"claim":"broker up","probe":"curl","reran":true,"corroborated":true,"note":"status:ready"}]}\n```'
    const v = await runClaimReverification(
      { output: CLAIMY },
      { enabled: true, spawnVerifier: mockSpawn({ stdout }) },
    )
    expect(v.verdict).toBe('pass')
    expect(v.perClaim[0]!.corroborated).toBe(true)
    expect(v.verifierSessionId).toBe('cv-mock')
  })

  it('contradicted re-run ⇒ fail (the deep catch the deterministic core cannot make)', async () => {
    const stdout =
      '```json\n{"verdict":"fail","findings":["re-run of curl showed uptime 5s not 30260s"],"perClaim":[{"claim":"uptime 30260s","probe":"curl /api/health","reran":true,"corroborated":false}]}\n```'
    const v = await runClaimReverification(
      { output: CLAIMY },
      { enabled: true, spawnVerifier: mockSpawn({ stdout }) },
    )
    expect(v.verdict).toBe('fail')
    expect(v.findings[0]).toMatch(/uptime/)
    expect(v.perClaim[0]!.corroborated).toBe(false)
  })
})

describe('createSpawnVerifierBackend', () => {
  it('wraps the runner as a ClaimVerifierBackend and stays enabled', async () => {
    const stdout = '```json\n{"verdict":"pass","findings":[],"perClaim":[]}\n```'
    const backend = createSpawnVerifierBackend({ spawnVerifier: mockSpawn({ stdout }) })
    const v = await backend.reverify({ output: CLAIMY })
    expect(v.verdict).toBe('pass')
  })

  it('dispose is invoked when provided', async () => {
    let disposed = false
    const backend = createSpawnVerifierBackend({
      spawnVerifier: mockSpawn(),
      onDispose: () => {
        disposed = true
      },
    })
    await backend.dispose?.()
    expect(disposed).toBe(true)
  })
})

describe('loadClaimVerifierSpawnConfig', () => {
  it('defaults timeout to 120s and no command override', () => {
    const c = loadClaimVerifierSpawnConfig({} as NodeJS.ProcessEnv)
    expect(c.timeoutMs).toBe(120_000)
    expect(c.command).toBeUndefined()
    expect(c.args).toBeUndefined()
  })
  it('honors CMD/ARGS/TIMEOUT overrides (for the live isolated test)', () => {
    const c = loadClaimVerifierSpawnConfig({
      SCNS_QG_CLAIM_VERIFIER_CMD: 'copilot',
      SCNS_QG_CLAIM_VERIFIER_ARGS: '-p|--allow-tool|shell(curl)',
      SCNS_QG_CLAIM_VERIFIER_TIMEOUT_MS: '90000',
    } as unknown as NodeJS.ProcessEnv)
    expect(c.command).toBe('copilot')
    expect(c.args).toEqual(['-p', '--allow-tool', 'shell(curl)'])
    expect(c.timeoutMs).toBe(90_000)
  })
  it('clamps an absurd timeout to the 10min ceiling', () => {
    const c = loadClaimVerifierSpawnConfig({
      SCNS_QG_CLAIM_VERIFIER_TIMEOUT_MS: '999999999',
    } as unknown as NodeJS.ProcessEnv)
    expect(c.timeoutMs).toBe(600_000)
  })
})
