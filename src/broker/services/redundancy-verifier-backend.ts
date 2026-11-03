/**
 * Redundancy verifier backend — the single-shot, producer≠verifier MODEL check
 * of the anti-redundant-build hook (Track 1). Sibling of
 * `claim-verifier-backend.ts`; it REUSES that module's generic one-shot spawn
 * primitives (`SpawnVerifier`, `VerifierSpawnResult`, `createDefaultVerifierSpawner`)
 * rather than forking a second spawner — building a parallel spawner here would
 * be exactly the redundancy this hook exists to catch.
 *
 * When the deterministic scanner (`redundancy-flag-scanner.ts`) trips a flag with
 * no addressing explanation, this backend asks an INDEPENDENT fresh model — which
 * did NOT write the build — to judge whether the flagged redundancy is actually
 * addressed (existing code reused / genuinely distinct) or a real duplicate.
 *
 * Contract (mirrors claim-verifier):
 *   - The spawner is INJECTED so tests never fork a subprocess.
 *   - Timeout / non-zero exit / malformed JSON degrade to `needs-explanation`,
 *     NEVER a silent `pass` (that would defeat the anti-overclaim point).
 *   - The verifier is a bounded ONE-SHOT — a single spawn per flagged build.
 *
 * NON-RECURSION (load-bearing): exactly one spawn, its stdout is parsed into a
 * verdict and NEVER re-fed to the scanner. The spawn carries a
 * `SCNS_REDUNDANCY_VERIFIER_SESSION` marker so a verifier process can be told
 * apart from a real build if it ever surfaced in the pipeline.
 */

import { randomUUID } from 'node:crypto'
import { logger } from '../../shared/logger.js'
import {
  createDefaultVerifierSpawner,
  type SpawnVerifier,
  type VerifierSpawnResult,
} from './claim-verifier-backend.js'
import type { RedundancyFlag } from './redundancy-flag-scanner.js'

export type RedundancyVerifyVerdictKind = 'pass' | 'fail' | 'needs-explanation'

export interface RedundancyVerifyVerdict {
  readonly verdict: RedundancyVerifyVerdictKind
  readonly findings: readonly string[]
  readonly verifierSessionId?: string
  readonly degradedReason?: string
}

export interface RedundancyVerifyInput {
  /** The agent's output explanation to independently judge. */
  readonly output: string
  /** The deterministic flags that tripped (scope hint for the model). */
  readonly flags: readonly RedundancyFlag[]
}

export interface RedundancyVerifyOptions {
  readonly enabled: boolean
  readonly timeoutMs?: number
  readonly spawnVerifier?: SpawnVerifier
}

/**
 * The injection-seam contract the arbiter consults (mirrors
 * `ClaimVerifierBackend`). The arbiter builds one only when the deterministic
 * scanner has already tripped — so most builds never reach here.
 */
export interface RedundancyVerifierBackend {
  judge(input: RedundancyVerifyInput): Promise<RedundancyVerifyVerdict>
  dispose?(): void | Promise<void>
}

export const DEFAULT_REDUNDANCY_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 10 * 60_000

export interface RedundancyVerifierSpawnConfig {
  readonly timeoutMs: number
  readonly command?: string
  readonly args?: readonly string[]
}

/** Resolve the spawn config from env (mirrors loadClaimVerifierSpawnConfig). */
export function loadRedundancyVerifierSpawnConfig(
  env: NodeJS.ProcessEnv = process.env,
): RedundancyVerifierSpawnConfig {
  const rawTimeout = Number(env.SCNS_QG_REDUNDANCY_VERIFIER_TIMEOUT_MS)
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout >= MIN_TIMEOUT_MS
      ? Math.min(rawTimeout, MAX_TIMEOUT_MS)
      : DEFAULT_REDUNDANCY_TIMEOUT_MS
  const command = env.SCNS_QG_REDUNDANCY_VERIFIER_CMD?.trim() || undefined
  const rawArgs = env.SCNS_QG_REDUNDANCY_VERIFIER_ARGS
  const args =
    rawArgs && rawArgs.length > 0 ? rawArgs.split('|').filter((s) => s.length > 0) : undefined
  return { timeoutMs, command, args }
}

export function buildRedundancyPrompt(input: RedundancyVerifyInput): string {
  const trimmed =
    input.output.length > 12_000 ? `${input.output.slice(0, 12_000)}\n… [truncated]` : input.output
  const flagLines = input.flags.map((f, i) => `${i + 1}. "${f.phrase}" — …${f.excerpt}…`)
  return [
    'You are the SCNS redundancy verifier — an INDEPENDENT critic. You did NOT',
    'write the work below. A deterministic scanner flagged redundancy signals in',
    "the author's own output but found NO explanation that the redundancy was",
    'addressed. Your job: decide whether the work adequately AVOIDS redundancy.',
    '',
    '# Redundancy signals the scanner found',
    ...flagLines,
    '',
    '# Full author output (context)',
    '```',
    trimmed,
    '```',
    '',
    '# Judge (be conservative — the failure mode is shipping a duplicate)',
    '- `pass`  — the author REUSED existing code, or the new code is genuinely',
    '            DISTINCT and the output makes that clear (name the reuse/distinction).',
    '- `fail`  — the output describes building something that duplicates or',
    '            re-implements existing capability WITHOUT reusing it or justifying',
    '            a real distinction (the anti-pattern this hook exists to catch).',
    '- `needs-explanation` — you cannot tell from the output whether the redundancy',
    '            was addressed. NEVER guess `pass`.',
    '',
    'Return ONLY a fenced JSON block exactly like:',
    '```json',
    '{ "verdict": "pass" | "fail" | "needs-explanation",',
    '  "findings": ["short reason if not pass"] }',
    '```',
  ].join('\n')
}

const VALID: ReadonlySet<RedundancyVerifyVerdictKind> = new Set([
  'pass',
  'fail',
  'needs-explanation',
])

function tryParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s.trim()) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    /* fall through */
  }
  return null
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw || raw.trim().length === 0) return null
  const fencedJson = raw.match(/```json\s*([\s\S]*?)```/i)
  if (fencedJson?.[1]) {
    const p = tryParse(fencedJson[1])
    if (p) return p
  }
  const fencedAny = raw.match(/```\s*([\s\S]*?)```/)
  if (fencedAny?.[1]) {
    const p = tryParse(fencedAny[1])
    if (p) return p
  }
  const candidates: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        candidates.push(raw.slice(start, i + 1))
        start = -1
      }
      if (depth < 0) {
        depth = 0
        start = -1
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const p = tryParse(candidates[i]!)
    if (p) return p
  }
  return null
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    .filter((s) => s.length > 0)
    .slice(0, 50)
}

/**
 * Parse a verifier response. Malformed input collapses to `needs-explanation`
 * with a degradedReason — NEVER a silent `pass`.
 */
export function parseRedundancyResponse(raw: string): RedundancyVerifyVerdict {
  const obj = extractJsonObject(raw)
  if (!obj) {
    return {
      verdict: 'needs-explanation',
      findings:
        raw.trim().length > 0 ? [`unparseable verifier output: ${raw.slice(0, 200)}`] : [],
      degradedReason: 'malformed-response',
    }
  }
  const rawVerdict = typeof obj.verdict === 'string' ? obj.verdict.trim().toLowerCase() : ''
  const verdict: RedundancyVerifyVerdictKind = VALID.has(rawVerdict as RedundancyVerifyVerdictKind)
    ? (rawVerdict as RedundancyVerifyVerdictKind)
    : 'needs-explanation'
  return {
    verdict,
    findings: asStringArray(obj.findings ?? obj.issues ?? obj.reasons),
    degradedReason:
      verdict === 'needs-explanation' && rawVerdict !== 'needs-explanation'
        ? `unrecognized-verdict:${rawVerdict || 'missing'}`
        : undefined,
  }
}

/**
 * Run a single-shot independent redundancy judgement. Short-circuit / degrade
 * (mirrors runClaimReverification):
 *   - `!enabled`            → `pass` (defer; degradedReason `disabled`).
 *   - no flags              → `pass` (nothing to judge).
 *   - no spawnVerifier      → `needs-explanation` (cannot safely pass).
 *   - spawn throws/timeout/nonzero/malformed → `needs-explanation` with reason.
 */
export async function runRedundancyVerification(
  input: RedundancyVerifyInput,
  opts: RedundancyVerifyOptions,
): Promise<RedundancyVerifyVerdict> {
  const log = logger.child({ module: 'redundancy-verifier-backend' })

  if (!opts.enabled) {
    return { verdict: 'pass', findings: [], degradedReason: 'disabled' }
  }
  if (input.flags.length === 0) {
    return { verdict: 'pass', findings: [] }
  }
  if (!opts.spawnVerifier) {
    log.warn('redundancy verification enabled but no spawnVerifier wired; needs-explanation')
    return {
      verdict: 'needs-explanation',
      findings: ['no verifier spawner configured'],
      degradedReason: 'no-spawner',
    }
  }

  const prompt = buildRedundancyPrompt(input)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REDUNDANCY_TIMEOUT_MS

  let spawnResult: VerifierSpawnResult
  try {
    spawnResult = await opts.spawnVerifier(prompt, { timeoutMs })
  } catch (err) {
    log.warn({ err }, 'redundancy verification: spawnVerifier threw')
    return {
      verdict: 'needs-explanation',
      findings: [`verifier spawn failed: ${err instanceof Error ? err.message : String(err)}`],
      degradedReason: 'spawn-failed',
    }
  }

  if (spawnResult.timedOut) {
    log.warn({ timeoutMs }, 'redundancy verification: verifier timed out')
    return {
      verdict: 'needs-explanation',
      findings: [`verifier timed out after ${timeoutMs}ms`],
      verifierSessionId: spawnResult.sessionId,
      degradedReason: 'verifier-timeout',
    }
  }

  if (spawnResult.exitCode !== null && spawnResult.exitCode !== 0) {
    log.warn(
      { exitCode: spawnResult.exitCode, stderr: spawnResult.stderr.slice(0, 400) },
      'redundancy verification: verifier exited non-zero',
    )
    return {
      verdict: 'needs-explanation',
      findings: [`verifier exited ${spawnResult.exitCode}`, spawnResult.stderr.slice(0, 400)].filter(
        (s) => s.length > 0,
      ),
      verifierSessionId: spawnResult.sessionId,
      degradedReason: 'verifier-exit-nonzero',
    }
  }

  const parsed = parseRedundancyResponse(spawnResult.stdout)
  return { ...parsed, verifierSessionId: spawnResult.sessionId }
}

/**
 * Build a {@link RedundancyVerifierBackend} around the one-shot spawner. Reuses
 * the claim-verifier's `createDefaultVerifierSpawner` (a generic bounded copilot
 * one-shot) so there is a single spawner implementation, not two. `enabled` is
 * always true here — the arbiter is the ON/OFF gate.
 */
export function createRedundancyVerifierBackend(opts: {
  readonly spawnVerifier?: SpawnVerifier
  readonly timeoutMs?: number
  readonly command?: string
  readonly args?: readonly string[]
  readonly onDispose?: () => void | Promise<void>
} = {}): RedundancyVerifierBackend {
  const spawnVerifier =
    opts.spawnVerifier ??
    createDefaultVerifierSpawner({
      ...(opts.command ? { command: opts.command } : {}),
      ...(opts.args ? { args: opts.args } : {}),
      env: { ...process.env, SCNS_REDUNDANCY_VERIFIER_SESSION: `rv-${randomUUID().slice(0, 8)}` },
    })
  return {
    judge: (input) =>
      runRedundancyVerification(input, {
        enabled: true,
        spawnVerifier,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      }),
    ...(opts.onDispose ? { dispose: opts.onDispose } : {}),
  }
}
