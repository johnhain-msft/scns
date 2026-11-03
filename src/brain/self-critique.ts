/**
 * Phase 13.12.19 — Brain self-critique loop.
 *
 * Before marking a suggestion `implemented`, spawn a fresh ephemeral critic
 * and ask it to rubber-duck the team's output against the stated acceptance.
 * The critic returns a JSON verdict — `pass`, `fail`, or `needs-evidence` —
 * that the agent-loop translates into a final state transition.
 *
 * Design notes:
 * - The critic runs as a detached one-shot (not bound to the broker event
 *   loop) so it can never deadlock the main brain tick.
 * - `spawnCritic` is injected so tests don't need real subprocesses.
 * - Timeouts degrade to `needs-evidence`, never to silent `pass`.
 * - Parsing is defensive: fenced ```json, then last JSON-looking object,
 *   then fall back to `needs-evidence` with a "malformed" reason.
 * - Feature flag: enabled at autonomy L2+ by default; off at L0/L1 because
 *   the human is the critic there. `BRAIN_SELF_CRITIQUE_ENABLED=true/false`
 *   overrides the default.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import {
  mkdirSync as nodeMkdirSync,
  writeFileSync as nodeWriteFileSync,
  readFileSync as nodeReadFileSync,
  existsSync as nodeExistsSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from '../shared/logger.js'
import type { Suggestion } from '../suggest/types.js'

// ── Types ────────────────────────────────────────────────────────────

export type SelfCritiqueVerdictKind = 'pass' | 'fail' | 'needs-evidence'

export interface SelfCritiqueVerdict {
  readonly verdict: SelfCritiqueVerdictKind
  readonly findings: readonly string[]
  readonly requiredFollowups: readonly string[]
  readonly criticalReasons?: readonly string[]
  readonly criticSessionId?: string
  /** Reason captured for timeout/malformed responses. */
  readonly degradedReason?: string
}

export interface CriticSpawnResult {
  readonly stdout: string
  readonly stderr: string
  readonly sessionId: string
  readonly timedOut: boolean
  readonly exitCode: number | null
}

export type SpawnCritic = (
  prompt: string,
  opts: { readonly timeoutMs: number },
) => Promise<CriticSpawnResult>

export interface SelfCritiqueInput {
  readonly suggestion: Suggestion
  readonly teamOutput: string
}

export interface SelfCritiqueOptions {
  /** Final effective flag; if false the runner short-circuits to `pass`. */
  readonly enabled: boolean
  readonly autonomyLevel: number
  readonly timeoutMs?: number
  readonly spawnCritic?: SpawnCritic
}

export interface SelfCritiqueConfig {
  readonly enabled: boolean
  readonly timeoutMs: number
  /**
   * Optional override for the critic spawn binary. When set, replaces the
   * default `copilot` command. Primarily used for live-verification via a
   * stub script that returns a canned JSON verdict.
   */
  readonly criticCommand?: string
  readonly criticArgs?: readonly string[]
}

// ── Config ───────────────────────────────────────────────────────────

/** 120s default aligns with the spec's mandatory timeout ceiling. */
export const DEFAULT_CRITIQUE_TIMEOUT_MS = 120_000
const MIN_CRITIQUE_TIMEOUT_MS = 1_000
const MAX_CRITIQUE_TIMEOUT_MS = 10 * 60_000

/**
 * Resolve the self-critique config for the current autonomy level, honoring
 * `BRAIN_SELF_CRITIQUE_ENABLED` + `BRAIN_SELF_CRITIQUE_TIMEOUT_MS` env.
 *
 * Default: enabled at L2/L3, disabled at L0/L1.
 */
export function loadSelfCritiqueConfig(
  autonomyLevel: number,
  env: NodeJS.ProcessEnv = process.env,
): SelfCritiqueConfig {
  const raw = env.BRAIN_SELF_CRITIQUE_ENABLED?.trim().toLowerCase()
  let enabled: boolean
  if (raw === 'true' || raw === '1' || raw === 'yes') {
    enabled = true
  } else if (raw === 'false' || raw === '0' || raw === 'no') {
    enabled = false
  } else {
    enabled = autonomyLevel >= 2
  }

  const rawTimeout = Number(env.BRAIN_SELF_CRITIQUE_TIMEOUT_MS)
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout >= MIN_CRITIQUE_TIMEOUT_MS
      ? Math.min(rawTimeout, MAX_CRITIQUE_TIMEOUT_MS)
      : DEFAULT_CRITIQUE_TIMEOUT_MS

  const criticCommand = env.BRAIN_SELF_CRITIQUE_CMD?.trim() || undefined
  const criticArgsRaw = env.BRAIN_SELF_CRITIQUE_ARGS
  const criticArgs =
    criticArgsRaw && criticArgsRaw.length > 0
      ? criticArgsRaw.split('|').filter((s) => s.length > 0)
      : undefined

  return { enabled, timeoutMs, criticCommand, criticArgs }
}

// ── Parsing ──────────────────────────────────────────────────────────

/**
 * Phase 13.12.24a: detect whether a teamOutput string contains enough
 * substance for a critic to meaningfully verify. Empty strings, bare
 * `success: true`, and any under ~80 chars without diff markers are
 * treated as insufficient. Exported for unit-testability.
 */
export function hasSubstantiveEvidence(teamOutput: string): boolean {
  if (!teamOutput) return false
  const trimmed = teamOutput.trim()
  if (trimmed.length === 0) return false
  if (/\bdiff --git\b/.test(trimmed)) return true
  if (/^[+-]{3} /m.test(trimmed)) return true
  if (/\bstagedDiff\b/.test(trimmed)) return true
  if (/\bfiles?:\s*\S/.test(trimmed)) return true
  // The executor reports its artifacts as `filesCreated:` followed by a bulleted list, which the
  // `\bfiles?:` probe above never matched — so a genuine one-file artifact change (registering an
  // LSP server writes exactly one config file, ~92 chars of output) was read as "no evidence" and
  // sent to needs-human. An explicit `(none)` is still correctly treated as no evidence.
  if (/\bfilesCreated:\s*(?!\(none\))\S/.test(trimmed)) return true
  // Fall back to a length heuristic — anything over 200 chars is likely
  // real log tail / artifact summary, not a bare executor stub.
  return trimmed.length >= 200
}

const VALID_VERDICTS: ReadonlySet<SelfCritiqueVerdictKind> = new Set([
  'pass',
  'fail',
  'needs-evidence',
])

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    .filter((s) => s.length > 0)
    .slice(0, 50)
}

/**
 * Extract the best-guess JSON object from an LLM response.
 *
 * Priority:
 *   1. First fenced ```json ... ``` block.
 *   2. First fenced ``` ... ``` block that parses as JSON.
 *   3. Last balanced `{...}` region that parses as JSON.
 *
 * Returns `null` when no parseable object is found.
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw || raw.trim().length === 0) return null

  const fencedJsonMatch = raw.match(/```json\s*([\s\S]*?)```/i)
  if (fencedJsonMatch?.[1]) {
    const parsed = tryParse(fencedJsonMatch[1])
    if (parsed) return parsed
  }

  const fencedAnyMatch = raw.match(/```\s*([\s\S]*?)```/)
  if (fencedAnyMatch?.[1]) {
    const parsed = tryParse(fencedAnyMatch[1])
    if (parsed) return parsed
  }

  // Scan for balanced { ... } objects — prefer the LAST one (LLMs often
  // preamble before the final verdict).
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
    const parsed = tryParse(candidates[i]!)
    if (parsed) return parsed
  }
  return null
}

function tryParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s.trim()) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
  } catch {
    /* fall through */
  }
  return null
}

/**
 * Parse a critic response string into a normalized verdict. Malformed input
 * collapses to `needs-evidence` with a degradedReason — never to a silent
 * `pass`.
 */
export function parseSelfCritiqueResponse(raw: string): SelfCritiqueVerdict {
  const obj = extractJsonObject(raw)
  if (!obj) {
    return {
      verdict: 'needs-evidence',
      findings: raw.trim().length > 0 ? [`unparseable critic output: ${raw.slice(0, 200)}`] : [],
      requiredFollowups: [],
      degradedReason: 'malformed-response',
    }
  }

  const rawVerdict = typeof obj.verdict === 'string' ? obj.verdict.trim().toLowerCase() : ''
  const verdict: SelfCritiqueVerdictKind = VALID_VERDICTS.has(rawVerdict as SelfCritiqueVerdictKind)
    ? (rawVerdict as SelfCritiqueVerdictKind)
    : 'needs-evidence'

  const findings = asStringArray(obj.findings ?? obj.issues ?? obj.reasons)
  const requiredFollowups = asStringArray(
    obj.requiredFollowups ?? obj.required_followups ?? obj.followups ?? obj.nextSteps,
  )
  const criticalReasons = asStringArray(obj.criticalReasons ?? obj.critical_reasons ?? obj.critical)

  return {
    verdict,
    findings,
    requiredFollowups,
    criticalReasons: criticalReasons.length > 0 ? criticalReasons : undefined,
    degradedReason:
      verdict === 'needs-evidence' && rawVerdict !== 'needs-evidence'
        ? `unrecognized-verdict:${rawVerdict || 'missing'}`
        : undefined,
  }
}

// ── Prompt ───────────────────────────────────────────────────────────

export function buildCritiquePrompt(input: SelfCritiqueInput): string {
  const { suggestion, teamOutput } = input
  const trimmedOutput =
    teamOutput.length > 12_000 ? `${teamOutput.slice(0, 12_000)}\n… [truncated]` : teamOutput
  return [
    'You are the SCNS self-critique agent. Your job is to independently verify that a',
    'suggestion was GENUINELY satisfied by the executing team, not merely claimed.',
    '',
    '# Suggestion',
    `id: ${suggestion.id}`,
    `type: ${suggestion.type}`,
    `title: ${suggestion.title}`,
    '',
    '## Stated intent',
    suggestion.description,
    '',
    suggestion.implementationPlan ? '## Implementation plan' : '',
    suggestion.implementationPlan ?? '',
    '',
    '# Team output',
    '```',
    trimmedOutput,
    '```',
    '',
    '# Your task',
    'Review the team output versus the stated intent. Decide:',
    '- `pass`: acceptance is genuinely met (files/artifacts exist, behavior matches).',
    '- `fail`: acceptance is NOT met (claimed work missing, side-effects absent, regression).',
    "- `needs-evidence`: ambiguous — can't verify from the output alone.",
    '',
    'Return ONLY a fenced JSON block exactly like:',
    '```json',
    '{',
    '  "verdict": "pass" | "fail" | "needs-evidence",',
    '  "findings": ["short bullet", "..."],',
    '  "requiredFollowups": ["what a human should do next", "..."],',
    '  "criticalReasons": ["optional — only when verdict=fail"]',
    '}',
    '```',
  ].join('\n')
}

// ── Runner ───────────────────────────────────────────────────────────

/**
 * Run a self-critique for the given suggestion + team output.
 *
 * Short-circuit behavior:
 * - `opts.enabled === false` OR `opts.autonomyLevel < 2` → returns a synthetic
 *   `pass` verdict with degradedReason `disabled-by-autonomy`. The caller
 *   should log that we're deferring to the human.
 * - `opts.spawnCritic` missing → returns `needs-evidence` (we can't safely
 *   claim pass without a critic).
 * - Critic times out or exits non-zero → `needs-evidence` with reason.
 */
export async function runSelfCritique(
  input: SelfCritiqueInput,
  opts: SelfCritiqueOptions,
): Promise<SelfCritiqueVerdict> {
  const log = logger.child({ module: 'brain-self-critique', suggestionId: input.suggestion.id })

  if (!opts.enabled || opts.autonomyLevel < 2) {
    log.debug(
      { enabled: opts.enabled, autonomyLevel: opts.autonomyLevel },
      'self-critique disabled; deferring to human',
    )
    return {
      verdict: 'pass',
      findings: [],
      requiredFollowups: [],
      degradedReason: 'disabled-by-autonomy',
    }
  }

  if (!opts.spawnCritic) {
    log.warn('self-critique enabled but no spawnCritic wired; marking needs-evidence')
    return {
      verdict: 'needs-evidence',
      findings: ['no critic spawner configured'],
      requiredFollowups: ['wire a spawnCritic dep or disable BRAIN_SELF_CRITIQUE_ENABLED'],
      degradedReason: 'no-spawner',
    }
  }

  // Phase 13.12.24a: guard against trivial/empty teamOutput. Without concrete
  // evidence (a staged diff, file listing, or substantive text), a critic has
  // nothing to verify and will speculatively fail — producing the infinite
  // scaling-policy + self-critique loop we saw on solo-path suggestions.
  // Short-circuit to `needs-evidence` so the suggestion exits `approved/`
  // instead of retrying forever on backoff.
  if (!hasSubstantiveEvidence(input.teamOutput)) {
    log.info(
      { suggestionId: input.suggestion.id, teamOutputLength: input.teamOutput.length },
      'self-critique: empty/trivial teamOutput — short-circuiting to needs-evidence',
    )
    return {
      verdict: 'needs-evidence',
      findings: [
        'team output lacks substantive evidence (no staged diff / file changes / artifacts)',
      ],
      requiredFollowups: [
        'route this suggestion through an agent that stages a diff, or re-seed with richer output',
      ],
      degradedReason: 'empty-team-output',
    }
  }

  const prompt = buildCritiquePrompt(input)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CRITIQUE_TIMEOUT_MS

  let spawnResult: CriticSpawnResult
  try {
    spawnResult = await opts.spawnCritic(prompt, { timeoutMs })
  } catch (err) {
    log.warn({ err }, 'self-critique: spawnCritic threw')
    return {
      verdict: 'needs-evidence',
      findings: [`critic spawn failed: ${err instanceof Error ? err.message : String(err)}`],
      requiredFollowups: ['retry once environment is healthy'],
      degradedReason: 'spawn-failed',
    }
  }

  if (spawnResult.timedOut) {
    log.warn({ timeoutMs }, 'self-critique: critic timed out')
    return {
      verdict: 'needs-evidence',
      findings: [`critic timed out after ${timeoutMs}ms`],
      requiredFollowups: ['raise timeout or run critique manually'],
      criticSessionId: spawnResult.sessionId,
      degradedReason: 'critique-timeout',
    }
  }

  if (spawnResult.exitCode !== null && spawnResult.exitCode !== 0) {
    log.warn(
      { exitCode: spawnResult.exitCode, stderr: spawnResult.stderr.slice(0, 400) },
      'self-critique: critic exited non-zero',
    )
    return {
      verdict: 'needs-evidence',
      findings: [`critic exited ${spawnResult.exitCode}`, spawnResult.stderr.slice(0, 400)].filter(
        (s) => s.length > 0,
      ),
      requiredFollowups: ['inspect critic logs'],
      criticSessionId: spawnResult.sessionId,
      degradedReason: 'critic-exit-nonzero',
    }
  }

  const parsed = parseSelfCritiqueResponse(spawnResult.stdout)
  return { ...parsed, criticSessionId: spawnResult.sessionId }
}

// ── Default critic spawner (copilot CLI one-shot) ────────────────────

interface DefaultSpawnerDeps {
  readonly spawn?: typeof nodeSpawn
  readonly command?: string
  readonly args?: readonly string[]
}

/**
 * Build a `SpawnCritic` that runs `copilot -p <prompt>` as a detached
 * one-shot, captures stdout+stderr, and enforces a hard timeout via SIGKILL.
 * Exported so the CLI + agent-loop wiring share the same implementation.
 */
export function createDefaultCriticSpawner(deps: DefaultSpawnerDeps = {}): SpawnCritic {
  const spawn = deps.spawn ?? nodeSpawn
  const command = deps.command ?? 'copilot'
  const argsFn = deps.args ?? ['-p']

  return async (prompt, opts) => {
    const sessionId = `sc-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    return new Promise<CriticSpawnResult>((resolve) => {
      let child
      try {
        child = spawn(command, [...argsFn, prompt], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          env: { ...process.env, SCNS_CRITIC_SESSION: sessionId },
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
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })

      const timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, opts.timeoutMs)

      child.on('error', (err: Error) => {
        clearTimeout(timer)
        resolve({
          stdout,
          stderr: `${stderr}\n${err.message}`,
          sessionId,
          timedOut,
          exitCode: -1,
        })
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({
          stdout,
          stderr,
          sessionId,
          timedOut,
          exitCode: typeof code === 'number' ? code : null,
        })
      })
    })
  }
}

// ── Critique file writer ─────────────────────────────────────────────

export type CritiqueTargetStatus = 'implemented' | 'failed' | 'needs-human'

export interface WriteCritiqueDeps {
  readonly mkdirSync?: typeof nodeMkdirSync
  readonly writeFileSync?: typeof nodeWriteFileSync
  readonly readFileSync?: typeof nodeReadFileSync
  readonly existsSync?: typeof nodeExistsSync
}

/**
 * Write a critique sidecar (`<id>.critique.md`) into the same status
 * directory the suggestion lives in, and — when targetStatus is
 * `needs-human` — append a `## Self-Critique` block to the suggestion's own
 * markdown body so the dashboard renders the findings next to the
 * suggestion.
 */
export function writeCritiqueFile(
  params: {
    readonly verdict: SelfCritiqueVerdict
    readonly suggestion: Suggestion
    readonly targetStatus: CritiqueTargetStatus
    readonly suggestionsRoot: string
    readonly now?: () => Date
  },
  deps: WriteCritiqueDeps = {},
): string {
  const mkdir = deps.mkdirSync ?? nodeMkdirSync
  const writeFile = deps.writeFileSync ?? nodeWriteFileSync
  const readFile = deps.readFileSync ?? nodeReadFileSync
  const exists = deps.existsSync ?? nodeExistsSync
  const now = (params.now ?? (() => new Date()))()

  const dir = join(params.suggestionsRoot, params.targetStatus)
  mkdir(dir, { recursive: true })

  const critiquePath = join(dir, `${params.suggestion.id}.critique.md`)
  const content = renderCritiqueMarkdown(
    params.verdict,
    params.suggestion,
    params.targetStatus,
    now,
  )
  writeFile(critiquePath, content, 'utf-8')

  if (params.targetStatus === 'needs-human') {
    const sibling = join(dir, `${params.suggestion.id}.md`)
    if (exists(sibling)) {
      try {
        const body = readFile(sibling, 'utf-8')
        if (typeof body === 'string' && !body.includes('## Self-Critique')) {
          const appended = `${body.trimEnd()}\n\n${renderCritiqueAppendix(params.verdict, now)}\n`
          writeFile(sibling, appended, 'utf-8')
        }
      } catch {
        /* best-effort — critique file already written */
      }
    }
  }

  return critiquePath
}

function renderCritiqueMarkdown(
  v: SelfCritiqueVerdict,
  suggestion: Suggestion,
  targetStatus: CritiqueTargetStatus,
  now: Date,
): string {
  const findings = v.findings.length > 0 ? v.findings : ['(none)']
  const followups = v.requiredFollowups.length > 0 ? v.requiredFollowups : ['(none)']
  const critical = v.criticalReasons ?? []

  const lines = [
    '---',
    `suggestionId: ${suggestion.id}`,
    `verdict: ${v.verdict}`,
    `targetStatus: ${targetStatus}`,
    v.criticSessionId ? `criticSessionId: ${v.criticSessionId}` : 'criticSessionId: (none)',
    `createdAt: ${now.toISOString()}`,
    v.degradedReason ? `degradedReason: ${v.degradedReason}` : null,
    '---',
    '',
    `# Self-Critique: ${suggestion.title}`,
    '',
    `**Verdict:** \`${v.verdict}\``,
    '',
    '## Findings',
    ...findings.map((f) => `- ${f}`),
    '',
    '## Required Followups',
    ...followups.map((f) => `- ${f}`),
  ]

  if (critical.length > 0) {
    lines.push('', '## Critical Reasons', ...critical.map((r) => `- ${r}`))
  }

  return lines.filter((l) => l !== null).join('\n') + '\n'
}

function renderCritiqueAppendix(v: SelfCritiqueVerdict, now: Date): string {
  const findings = v.findings.length > 0 ? v.findings : ['(none)']
  const followups = v.requiredFollowups.length > 0 ? v.requiredFollowups : ['(none)']
  return [
    '## Self-Critique',
    `- verdict: \`${v.verdict}\``,
    `- runAt: ${now.toISOString()}`,
    v.criticSessionId ? `- criticSessionId: ${v.criticSessionId}` : null,
    '',
    '### Findings',
    ...findings.map((f) => `- ${f}`),
    '',
    '### Required Followups',
    ...followups.map((f) => `- ${f}`),
  ]
    .filter((l) => l !== null)
    .join('\n')
}

// Avoid unused imports when all writer deps are injected.
void dirname
