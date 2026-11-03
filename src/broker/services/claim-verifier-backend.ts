/**
 * Track 1 / 1B — the spawned producer≠verifier (execution-grounded re-run check).
 *
 * The deterministic `claim-evidence-verifier.ts` only checks that the §3a
 * DISCIPLINE was followed (a label + a quoted row are PRESENT per runtime claim).
 * It cannot tell whether the quoted row is TRUE — it never runs anything. This
 * module is the deeper, independent check that closes that gap: a FRESH spawn
 * (producer ≠ verifier) that, given a runtime claim + its cited probe,
 * INDEPENDENTLY RE-RUNS the probe and confirms the quoted row appears in the
 * actual output — rather than trusting that a label is present.
 *
 * Prior art (the mechanism is grounded, not invented):
 *   - CriticGPT (arXiv:2309.00864) — a separate critic catches errors the author
 *     misses; execution-grounded critique beats a text-only LLM-as-judge.
 *   - Faithful Reasoning w/ Verification (arXiv:2305.14104) — generate claim +
 *     query, RE-RUN the query, keep the claim only if the re-run corroborates it.
 *   - Toolformer (arXiv:2302.04761) — tool-augmented self-verification.
 *   - In-repo realization of generator≠critic: `src/brain/self-critique.ts` —
 *     this module mirrors its SpawnCritic seam, its defensive JSON parse, and its
 *     degrade-to-`needs-evidence`-never-silent-`pass` contract on timeout/error.
 *
 * Design (mirrors self-critique.ts):
 *   - The spawner is INJECTED (`SpawnVerifier`) so tests never fork a subprocess.
 *   - Timeouts / non-zero exits / malformed JSON degrade to `needs-evidence`,
 *     NEVER to a silent `pass` (that would defeat the whole anti-overclaim point).
 *   - The verifier is a bounded one-shot, not a standing judge-brain.
 *   - Default-OFF: nothing here runs until the arbiter's injection seam is wired
 *     AND `SCNS_QG_CLAIM_SPAWN=1` (see quality-gate-arbiter.ts).
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { logger } from '../../shared/logger.js'
import { extractRuntimeClaims, type RuntimeClaim } from './claim-evidence-verifier.js'

// ── Types ────────────────────────────────────────────────────────────

export type ReverifyVerdictKind = 'pass' | 'fail' | 'needs-evidence'

/** The independent re-run result for a single runtime-behavior claim. */
export interface PerClaimResult {
  /** The claim line the verifier assessed. */
  readonly claim: string
  /** The command/probe the verifier re-ran, or null if none could be identified. */
  readonly probe: string | null
  /** Whether the verifier actually re-ran a probe (vs. could not). */
  readonly reran: boolean
  /** Whether the ACTUAL re-run output corroborated the claim's quoted row. */
  readonly corroborated: boolean
  /** Optional short note (e.g. the actual excerpt, or why it could not run). */
  readonly note?: string
}

export interface ClaimReverifyVerdict {
  readonly verdict: ReverifyVerdictKind
  readonly findings: readonly string[]
  readonly perClaim: readonly PerClaimResult[]
  readonly verifierSessionId?: string
  /** Reason captured for timeout/malformed/disabled responses. */
  readonly degradedReason?: string
}

export interface VerifierSpawnResult {
  readonly stdout: string
  readonly stderr: string
  readonly sessionId: string
  readonly timedOut: boolean
  readonly exitCode: number | null
}

export type SpawnVerifier = (
  prompt: string,
  opts: { readonly timeoutMs: number },
) => Promise<VerifierSpawnResult>

export interface ClaimReverifyInput {
  /** The full analysis / completion output to independently re-verify. */
  readonly output: string
  /**
   * Optional pre-extracted runtime claims (the arbiter passes the pre-filter's
   * claims so the spawn agrees on scope). When omitted they are extracted here.
   */
  readonly claims?: readonly RuntimeClaim[]
}

export interface ClaimReverifyOptions {
  /** Final effective flag; when false the runner short-circuits to `pass` (defer). */
  readonly enabled: boolean
  readonly timeoutMs?: number
  readonly spawnVerifier?: SpawnVerifier
}

/**
 * The injection-seam contract the quality-gate arbiter consults (mirrors
 * `behavioralGate.makeBackends`). Default-OFF: the arbiter only builds one when
 * `SCNS_QG_CLAIM_SPAWN=1` AND `makeVerifierBackend` is wired.
 */
export interface ClaimVerifierBackend {
  reverify(input: ClaimReverifyInput): Promise<ClaimReverifyVerdict>
  /** Reap any spawn PID / temp resources. Called in a `finally` by the arbiter. */
  dispose?(): void | Promise<void>
}

// ── Config ───────────────────────────────────────────────────────────

/** 120s default aligns with self-critique's mandatory timeout ceiling. */
export const DEFAULT_REVERIFY_TIMEOUT_MS = 120_000
const MIN_REVERIFY_TIMEOUT_MS = 1_000
const MAX_REVERIFY_TIMEOUT_MS = 10 * 60_000

export interface ClaimVerifierSpawnConfig {
  readonly timeoutMs: number
  /** Override the spawn binary (default `copilot`). Used by the live isolated test. */
  readonly command?: string
  /** Override the spawn args (default `['-p']`). `|`-separated in env. */
  readonly args?: readonly string[]
}

/**
 * Resolve the spawned-verifier config from env, honoring
 * `SCNS_QG_CLAIM_VERIFIER_TIMEOUT_MS` + `SCNS_QG_CLAIM_VERIFIER_CMD` +
 * `SCNS_QG_CLAIM_VERIFIER_ARGS` (mirrors BRAIN_SELF_CRITIQUE_*). The ON/OFF
 * switch itself is `SCNS_QG_CLAIM_SPAWN`, resolved by the arbiter.
 */
export function loadClaimVerifierSpawnConfig(
  env: NodeJS.ProcessEnv = process.env,
): ClaimVerifierSpawnConfig {
  const rawTimeout = Number(env.SCNS_QG_CLAIM_VERIFIER_TIMEOUT_MS)
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout >= MIN_REVERIFY_TIMEOUT_MS
      ? Math.min(rawTimeout, MAX_REVERIFY_TIMEOUT_MS)
      : DEFAULT_REVERIFY_TIMEOUT_MS
  const command = env.SCNS_QG_CLAIM_VERIFIER_CMD?.trim() || undefined
  const rawArgs = env.SCNS_QG_CLAIM_VERIFIER_ARGS
  const args =
    rawArgs && rawArgs.length > 0 ? rawArgs.split('|').filter((s) => s.length > 0) : undefined
  return { timeoutMs, command, args }
}

// ── Cited-probe extraction (deterministic hint; the agent is authoritative) ──

/**
 * Verbs that denote a re-runnable, read-only probe in a §3a claim-evidence line.
 * This is a HINT for the prompt + a signal for "is there anything to re-run"; the
 * spawned agent decides the real probe. Deliberately read-only-leaning.
 */
const PROBE_VERBS =
  /\b(curl|grep|rg|ls|cat|sqlite3|npx|node|psql|git|ps|lsof|find|head|tail|wc|jq|sed|awk|echo|test)\b/i

/**
 * Best-effort extraction of the cited probe/command from a claim line: the first
 * backticked span that looks like a command, else a `via <cmd>` / `run <cmd>`
 * phrase. Returns null when no probe is cited (⇒ the claim is not re-runnable and
 * must rely on its label, which is the deterministic core's job).
 */
export function extractCitedProbe(line: string): string | null {
  const backticks = line.match(/`([^`]+)`/g) ?? []
  for (const span of backticks) {
    const inner = span.replace(/`/g, '').trim()
    if (PROBE_VERBS.test(inner) && /\s/.test(inner)) return inner
  }
  const via = line.match(/\b(?:via|run(?:ning)?|ran|check(?:ed)? with)\s+`?([^`\n]{3,120})`?/i)
  if (via?.[1] && PROBE_VERBS.test(via[1])) return via[1].trim()
  return null
}

// ── Prompt ───────────────────────────────────────────────────────────

export function buildReverifyPrompt(input: ClaimReverifyInput): string {
  const claims = input.claims ?? extractRuntimeClaims(input.output)
  const trimmedOutput =
    input.output.length > 12_000 ? `${input.output.slice(0, 12_000)}\n… [truncated]` : input.output
  const claimLines = claims.map((c, i) => {
    const probe = extractCitedProbe(c.text)
    return `${i + 1}. [label=${c.label ?? 'none'}] ${c.text}` + (probe ? `\n   cited probe: \`${probe}\`` : '')
  })
  return [
    'You are the SCNS claim verifier — an INDEPENDENT producer≠verifier critic.',
    'You did NOT write the report below. Your job is NOT to re-read it and agree;',
    'it is to INDEPENDENTLY RE-RUN each cited probe and confirm the quoted row is',
    'true. A label alone ("[live-confirmed]") is NOT evidence — do not trust it.',
    '',
    '# Runtime-behavior claims to re-verify',
    ...claimLines,
    '',
    '# Full report (context)',
    '```',
    trimmedOutput,
    '```',
    '',
    '# Your task — for EACH claim above',
    '1. Identify the cited probe/command (a read-only check: curl a health',
    '   endpoint, grep/rg for a caller, a sqlite3 count, an `npx tsx` probe, …).',
    '2. RE-RUN it yourself, independently. Only read-only probes — never mutate.',
    '3. Compare the ACTUAL output to the claim\'s quoted row/number.',
    '   - corroborated: the re-run output supports the quoted row.',
    '   - contradicted: the re-run output disproves it (a real overclaim).',
    '   - could-not-run: no probe was cited, or it could not be re-run here.',
    '',
    '# Verdict rules (be conservative — never pass on faith)',
    '- `pass`  — EVERY claim that cites a runnable probe was re-run AND corroborated,',
    '            and every remaining claim is honestly labeled code-only (not asserted live).',
    '- `fail`  — a re-run CONTRADICTS a quoted row, OR a claim asserts live behavior',
    '            with no label and no corroborating re-run (the guard-rca overclaim).',
    '- `needs-evidence` — a live-confirmed claim cites a probe you could not re-run,',
    '            or the evidence is ambiguous. NEVER silently pass these.',
    '',
    'Return ONLY a fenced JSON block exactly like:',
    '```json',
    '{',
    '  "verdict": "pass" | "fail" | "needs-evidence",',
    '  "findings": ["short reason per problem claim"],',
    '  "perClaim": [',
    '    { "claim": "<claim text>", "probe": "<cmd you ran or null>",',
    '      "reran": true, "corroborated": true, "note": "<actual excerpt>" }',
    '  ]',
    '}',
    '```',
  ].join('\n')
}

// ── Parsing (defensive; mirrors self-critique) ────────────────────────

const VALID_VERDICTS: ReadonlySet<ReverifyVerdictKind> = new Set([
  'pass',
  'fail',
  'needs-evidence',
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
  // Scan for balanced { ... } objects — prefer the LAST (LLMs preamble first).
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

function asPerClaim(v: unknown): PerClaimResult[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((o) => ({
      claim: typeof o.claim === 'string' ? o.claim : '',
      probe: typeof o.probe === 'string' && o.probe.length > 0 ? o.probe : null,
      reran: o.reran === true,
      corroborated: o.corroborated === true,
      note: typeof o.note === 'string' && o.note.length > 0 ? o.note.slice(0, 300) : undefined,
    }))
    .slice(0, 50)
}

/**
 * Parse a verifier response into a normalized verdict. Malformed input collapses
 * to `needs-evidence` with a degradedReason — NEVER to a silent `pass`.
 */
export function parseReverifyResponse(raw: string): ClaimReverifyVerdict {
  const obj = extractJsonObject(raw)
  if (!obj) {
    return {
      verdict: 'needs-evidence',
      findings: raw.trim().length > 0 ? [`unparseable verifier output: ${raw.slice(0, 200)}`] : [],
      perClaim: [],
      degradedReason: 'malformed-response',
    }
  }
  const rawVerdict = typeof obj.verdict === 'string' ? obj.verdict.trim().toLowerCase() : ''
  const verdict: ReverifyVerdictKind = VALID_VERDICTS.has(rawVerdict as ReverifyVerdictKind)
    ? (rawVerdict as ReverifyVerdictKind)
    : 'needs-evidence'
  return {
    verdict,
    findings: asStringArray(obj.findings ?? obj.issues ?? obj.reasons),
    perClaim: asPerClaim(obj.perClaim ?? obj.per_claim ?? obj.claims),
    degradedReason:
      verdict === 'needs-evidence' && rawVerdict !== 'needs-evidence'
        ? `unrecognized-verdict:${rawVerdict || 'missing'}`
        : undefined,
  }
}

// ── Runner ───────────────────────────────────────────────────────────

/**
 * Run an independent re-verification of the runtime claims in `input.output`.
 *
 * Short-circuit / degrade behavior (mirrors runSelfCritique):
 *   - `!opts.enabled` → `pass` (defer; degradedReason `disabled`).
 *   - no runtime claims → `pass` (nothing to re-verify).
 *   - `opts.spawnVerifier` missing → `needs-evidence` (cannot safely pass).
 *   - spawn throws / times out / exits non-zero → `needs-evidence` with reason.
 *   - malformed JSON → `needs-evidence` (via parseReverifyResponse).
 */
export async function runClaimReverification(
  input: ClaimReverifyInput,
  opts: ClaimReverifyOptions,
): Promise<ClaimReverifyVerdict> {
  const log = logger.child({ module: 'claim-verifier-backend' })

  if (!opts.enabled) {
    return { verdict: 'pass', findings: [], perClaim: [], degradedReason: 'disabled' }
  }

  const claims = input.claims ?? extractRuntimeClaims(input.output)
  if (claims.length === 0) {
    return { verdict: 'pass', findings: [], perClaim: [] }
  }

  if (!opts.spawnVerifier) {
    log.warn('claim re-verification enabled but no spawnVerifier wired; marking needs-evidence')
    return {
      verdict: 'needs-evidence',
      findings: ['no verifier spawner configured'],
      perClaim: [],
      degradedReason: 'no-spawner',
    }
  }

  const prompt = buildReverifyPrompt({ output: input.output, claims })
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REVERIFY_TIMEOUT_MS

  let spawnResult: VerifierSpawnResult
  try {
    spawnResult = await opts.spawnVerifier(prompt, { timeoutMs })
  } catch (err) {
    log.warn({ err }, 'claim re-verification: spawnVerifier threw')
    return {
      verdict: 'needs-evidence',
      findings: [`verifier spawn failed: ${err instanceof Error ? err.message : String(err)}`],
      perClaim: [],
      degradedReason: 'spawn-failed',
    }
  }

  if (spawnResult.timedOut) {
    log.warn({ timeoutMs }, 'claim re-verification: verifier timed out')
    return {
      verdict: 'needs-evidence',
      findings: [`verifier timed out after ${timeoutMs}ms`],
      perClaim: [],
      verifierSessionId: spawnResult.sessionId,
      degradedReason: 'verifier-timeout',
    }
  }

  if (spawnResult.exitCode !== null && spawnResult.exitCode !== 0) {
    log.warn(
      { exitCode: spawnResult.exitCode, stderr: spawnResult.stderr.slice(0, 400) },
      'claim re-verification: verifier exited non-zero',
    )
    return {
      verdict: 'needs-evidence',
      findings: [`verifier exited ${spawnResult.exitCode}`, spawnResult.stderr.slice(0, 400)].filter(
        (s) => s.length > 0,
      ),
      perClaim: [],
      verifierSessionId: spawnResult.sessionId,
      degradedReason: 'verifier-exit-nonzero',
    }
  }

  const parsed = parseReverifyResponse(spawnResult.stdout)
  return { ...parsed, verifierSessionId: spawnResult.sessionId }
}

// ── Default spawner (copilot CLI one-shot) ────────────────────────────

interface DefaultSpawnerDeps {
  readonly spawn?: typeof nodeSpawn
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Build a `SpawnVerifier` that runs `copilot -p <prompt>` as a bounded one-shot,
 * captures stdout+stderr, and enforces a hard timeout via SIGKILL (mirrors
 * self-critique's createDefaultCriticSpawner). Unlike the deny-all self-critique
 * spawner, the verifier is expected to RE-RUN read-only probes, so the caller
 * points `SCNS_QG_CLAIM_VERIFIER_ARGS` at a copilot invocation with read-only
 * tool access — bounded by an isolated cwd + SCNS_HOME, not by broad privilege.
 */
export function createDefaultVerifierSpawner(deps: DefaultSpawnerDeps = {}): SpawnVerifier {
  const spawn = deps.spawn ?? nodeSpawn
  const command = deps.command ?? 'copilot'
  const baseArgs = deps.args ?? ['-p']

  return async (prompt, opts) => {
    const sessionId = `cv-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    return new Promise<VerifierSpawnResult>((resolve) => {
      let child
      try {
        child = spawn(command, [...baseArgs, prompt], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          env: { ...(deps.env ?? process.env), SCNS_CLAIM_VERIFIER_SESSION: sessionId },
        })
      } catch (err) {
        resolve({
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          sessionId,
          timedOut: false,
          exitCode: -1,
        })
        return
      }

      let stdout = ''
      let stderr = ''
      let timedOut = false
      child.stdout?.on('data', (c: Buffer) => {
        stdout += c.toString('utf-8')
      })
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString('utf-8')
      })

      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid) process.kill(child.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }, opts.timeoutMs)

      child.on('error', (err: Error) => {
        clearTimeout(timer)
        resolve({ stdout, stderr: stderr || err.message, sessionId, timedOut, exitCode: -1 })
      })
      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        resolve({ stdout, stderr, sessionId, timedOut, exitCode: timedOut ? null : code })
      })
    })
  }
}

/**
 * Build a {@link ClaimVerifierBackend} around {@link runClaimReverification} for
 * the arbiter's `claimVerifier.makeVerifierBackend` seam. `spawnVerifier` defaults
 * to the bounded copilot one-shot; tests inject a fake. `enabled` is always true
 * here — the arbiter is the ON/OFF gate (SCNS_QG_CLAIM_SPAWN), so once it decides
 * to build a backend, the backend runs.
 */
export function createSpawnVerifierBackend(opts: {
  readonly spawnVerifier?: SpawnVerifier
  readonly timeoutMs?: number
  readonly onDispose?: () => void | Promise<void>
} = {}): ClaimVerifierBackend {
  const spawnVerifier = opts.spawnVerifier ?? createDefaultVerifierSpawner()
  return {
    reverify: (input) =>
      runClaimReverification(input, {
        enabled: true,
        spawnVerifier,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      }),
    ...(opts.onDispose ? { dispose: opts.onDispose } : {}),
  }
}
