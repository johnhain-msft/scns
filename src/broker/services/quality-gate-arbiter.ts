/**
 * Phase 13.5 — Quality Gate Arbiter (blue/green).
 *
 * Subscribes to team_completed events. For each completion with a non-empty
 * staged diff, creates a disposable git worktree branched from HEAD, applies
 * the diff, runs `npm test` and `npm run lint` in the worktree (never on
 * main), scores the combined output against the existing rubric, and emits
 * a PASS/FAIL verdict.
 *
 *   PASS → commit the diff on a new `scns/auto/<slug>` branch (the worktree
 *          owns the branch while it exists; removing the worktree leaves the
 *          branch intact in the main repo), and optionally apply any
 *          suggestion artifact (skill/config/etc.) via the executor.
 *   FAIL → force-remove the worktree, delete the branch, record the failure
 *          as a negative memory, and mark the source suggestion
 *          `rejected` with `reviewReason: qg-fail`.
 *
 * Every verdict is persisted to the `quality_checks` table and published as
 * a `quality_gate_verdict` event.
 */

import { exec as nodeExec, execSync as nodeExecSync } from 'node:child_process'
import { promisify } from 'node:util'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync as nodeReadFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { EventLog } from './event-log.js'
import type { EventDispatcher, TypedEvent } from '../event-dispatcher.js'
import type { TeamCompletionData } from './team-lifecycle.js'
import { evaluateRubric } from './quality-checker.js'
import { createQualityCheck } from '../storage/repositories/quality-repository.js'
import type { NegativeMemoryStore } from '../../memory/negative-memory-store.js'
import type { Suggestion, SuggestionStatus } from '../../suggest/types.js'
import type { StatusAuthor } from '../../suggest/suggestion-store.js'
import { logger } from '../../shared/logger.js'
import { isResearcherRole } from '../../shared/role-bridge.js'
import { isSafetyKernelPath } from './safety-kernel/protected-paths.js'
import {
  bridgeNodeModulesIntoWorktree,
  bridgeFallbackAttempted,
  bridgeNeedsDiagnostic,
  verifyBridgedTooling,
  REQUIRED_BINS,
  type BridgeReason,
  type BridgeResult,
  type VerifyToolingResult,
} from './worktree-tooling-bridge.js'
import {
  evaluateBehavioralGate,
  resolveBehavioralGateMode,
  DEFAULT_BEHAVIORAL_VAL_TASKS,
} from '../../selfopt/behavioral-gate.js'
import { verifyClaimEvidence, type VerifierVerdict } from './claim-evidence-verifier.js'
import type { ClaimVerifierBackend, ClaimReverifyVerdict } from './claim-verifier-backend.js'
import { evaluateRedundancy, type RedundancyFlag } from './redundancy-flag-scanner.js'
import type {
  RedundancyVerifierBackend,
  RedundancyVerifyVerdict,
} from './redundancy-verifier-backend.js'
import type { BehavioralGateResult } from '../../selfopt/behavioral-gate.js'
import { MockBackend } from '../../selfopt/replay.js'
import type { ReplayBackend } from '../../selfopt/replay.js'
import type { TaskRecord } from '../../selfopt/types.js'

// ── Task 37 — node_modules bridge ────────────────────────────────────
//
// The bridge implementation lived in this module historically. It was
// extracted into `worktree-tooling-bridge.ts` in the Layer-2 fix so the
// per-team worktree manager can call the same logic; we re-export it
// here so QG arbiter callers (and their tests) keep working unchanged.
//
// See `worktree-tooling-bridge.ts` for the module-level rationale,
// strategy ordering, and rubber-duck-hardened symlink-error fallback.
export {
  bridgeNodeModulesIntoWorktree,
  verifyBridgedTooling,
  REQUIRED_BINS,
  type BridgeReason,
  type BridgeResult,
  type VerifyToolingResult,
}

const log = logger.child({ module: 'quality-gate-arbiter' })

// ── Types ────────────────────────────────────────────────────────────

type RunOk = { ok: true; stdout: string; stderr: string }
type RunErr = { ok: false; stdout: string; stderr: string; code: number }
export type RunResult = RunOk | RunErr

export type RunCommand = (cmd: string, cwd: string, options?: { timeoutMs?: number }) => RunResult

export type RunCommandAsync = (
  cmd: string,
  cwd: string,
  options?: { timeoutMs?: number },
) => Promise<RunResult>

export interface QualityGateSuggestionStore {
  get(id: string): Suggestion | null
  updateStatus(
    id: string,
    status: SuggestionStatus,
    reason?: string,
    blockedMetadata?: { readonly requiredLevel: number; readonly blockedAt: string },
    opts?: { readonly author?: StatusAuthor },
  ): Suggestion | null
  /**
   * FR-057 — the gate's failure seam. Increments `attemptCount`, backs off, holds the proposal
   * non-terminal in `approved` until `MAX_ATTEMPTS_BEFORE_FAILED`, then escalates to
   * `needs-human`. The arbiter MUST route gate failures here rather than through
   * `updateStatus(id, 'rejected', …)`: `rejected` means "the human declined this", and using it
   * for "the machine could not build this" is what taught the learner that John's approval of
   * `65a914f4` was a refusal.
   *
   * Required, not optional. An optional member would let a construction site silently fall back
   * to the mislabelling path, which is exactly the defect.
   */
  recordQualityGateFailure(id: string, reason: string): Suggestion | null
  /**
   * Phase 13.12.20: reverse lookup for brain-spawned teams whose id is
   * `team-sugg-<short>` (not derivable from teamId alone). When the
   * extractor's prefix-based mapping misses, QG falls back to this.
   */
  findByInflightTeamId?: (teamId: string) => Suggestion | null
}

export interface QualityGateExecutor {
  generatePlan(suggestion: Suggestion): unknown
  /**
   * The suggestion is REQUIRED: the executor derives its safety gate from `suggestion.type`, and
   * a call that omits it skips the gate entirely. `applyArtifact` used to call `execute(plan)`,
   * so the one path that writes an approved suggestion's artifact to disk ran ungated.
   */
  execute(
    plan: unknown,
    suggestion: Suggestion,
  ): { readonly success: boolean; readonly errors: readonly string[] }
}

export interface QualityGateArbiterDeps {
  readonly db: Database.Database
  readonly eventLog: EventLog
  readonly dispatcher: EventDispatcher
  readonly projectRoot: string
  readonly suggestionStore?: QualityGateSuggestionStore
  readonly executor?: QualityGateExecutor
  readonly negativeMemoryStore?: NegativeMemoryStore
  readonly runCommand?: RunCommand
  readonly worktreeBase?: string
  /**
   * Cap combined stdout+stderr text that is fed to the rubric/event to
   * avoid oversized SQL rows.
   */
  readonly maxOutputBytes?: number
  /** Skip real test/lint runs — used by some integration scenarios. */
  readonly skipCommands?: boolean
  /**
   * Phase 13.12.24 — baseline-lint-diff gate. When enabled, the arbiter
   * snapshots lint error counts on HEAD (in projectRoot, before the
   * staged diff is applied to the worktree) and only fails the gate
   * when post-diff lint introduces NEW errors. Defaults false here so
   * existing tests opt in explicitly; the CLI wires it to the zod
   * config default (true in production).
   */
  readonly baselineLintEnabled?: boolean
  /** Same as baselineLintEnabled, but diffs vitest FAIL lines. */
  readonly baselineTestsEnabled?: boolean
  /**
   * Task 37 — strategy for bridging `node_modules` from the source
   * repo into the freshly created QG worktree. `git worktree add`
   * does not copy node_modules (gitignored), so `npm test` /
   * `npm run lint` would otherwise exit 127 every run with
   * "vitest: command not found" / "eslint: command not found"
   * (qc=13ab2fb7, qc=394de9bb).
   *
   *   - 'symlink' (default): symlink `<projectRoot>/node_modules` →
   *     `<worktreePath>/node_modules`, verify the runtime binaries
   *     resolve, and fall back to a recursive copy if they don't.
   *   - 'none': skip bridging entirely. Only safe for tests that
   *     inject a mocked runCommand and never spawn real binaries.
   */
  readonly npmStrategy?: 'symlink' | 'none'
  /**
   * Phase 13.12.13: callback invoked on every verdict so the brain's
   * scaling-policy can record the outcome keyed by task signature and
   * learn whether team spawns succeeded. Callback is fire-and-forget —
   * failures are swallowed so QG flow is unaffected.
   */
  readonly onOutcome?: (outcome: {
    readonly teamId: string
    readonly sourceSuggestionId: string | null
    readonly passed: boolean
    readonly score: number
    readonly description: string | null
    /**
     * FR-056/FR-059 — the verdict to bank in the outcome ledger, when the arbiter knows it.
     *
     * `passed` alone is not enough to label an outcome. A consumer that maps `passed:false` to
     * `rejected` records a BUILD failure as the human's refusal — the same defect Phase 10f fixed
     * on the suggestion file, one layer down in `proposal_outcomes` (where it feeds family
     * suppression and the accept-vs-waste gradient). A gate failure is `failed`, which is
     * verdict-neutral by construction: out of `FAILED_VERDICTS`, and `null` on the gradient.
     *
     * Optional so existing consumers keep working; a consumer SHOULD prefer this over `passed`.
     */
    readonly verdict?: 'implemented' | 'failed'
  }) => void
  /**
   * Phase 1 wedge A — behavioral-improvement gate (additive, default-OFF).
   * Injection seam ONLY; the gate is switched on by the env opt-ins
   * `SCNS_QG_BEHAVIORAL_GATE` (measure) / `SCNS_QG_BEHAVIORAL_ENFORCE` (veto),
   * both default-OFF, read from `env` (default `process.env`). Backends default
   * to a deterministic `MockBackend` (NO spawn); the real `AcpReplayBackend` is a
   * separate opt-in wedge and is never constructed here. With the env unset this
   * is fully inert — no backend is built, no replay runs, and the verdict + event
   * are byte-identical to a run without this field. The gate is consulted ONLY on
   * the rubric-PASS branch, so it can only ever DOWNGRADE PASS→FAIL on a measured
   * regression; it can never upgrade FAIL→PASS.
   */
  readonly behavioralGate?: {
    readonly env?: NodeJS.ProcessEnv
    readonly valTasks?: readonly TaskRecord[]
    readonly epsilon?: number
    readonly makeBaselineBackend?: (headCwd: string) => ReplayBackend
    readonly makeCandidateBackend?: (worktreeCwd: string) => ReplayBackend
    /**
     * Preferred production seam: build the asymmetric baseline/candidate pair for
     * ONE completion together with a `dispose` that reaps spawn PIDs and tears
     * down any worktree it created. When present this supersedes the bare
     * `makeBaselineBackend`/`makeCandidateBackend` factories. Called ONLY on the
     * rubric-PASS branch when the env opt-in is set, so it stays inert by default.
     */
    readonly makeBackends?: (input: {
      readonly headCwd: string
      readonly candidateCwd: string
    }) => {
      readonly baseline: ReplayBackend
      readonly candidate: ReplayBackend
      readonly dispose: () => void | Promise<void>
    }
  }
  /**
   * Track 1 / 1B — claim-evidence verifier env source (injectable for tests).
   * Reads `SCNS_QG_CLAIM_VERIFIER` (measure, default-ON) + `SCNS_QG_CLAIM_ENFORCE`
   * (enforce downgrade, default-OFF). Unset ⇒ falls back to `process.env`.
   */
  readonly claimVerifier?: {
    readonly env?: NodeJS.ProcessEnv
    /**
     * Track 1 / 1B producer≠verifier injection seam (default-OFF, no spawn by
     * default). Mirrors `behavioralGate.makeBackends`. When wired AND
     * `SCNS_QG_CLAIM_SPAWN=1`, the arbiter consults this backend AFTER the
     * deterministic pre-filter finds ≥1 runtime claim: the backend spawns an
     * INDEPENDENT verifier (producer≠verifier) that RE-RUNS each cited probe and
     * confirms the quoted row, rather than only checking a label is present. Unset
     * (or the env flag off) ⇒ only the deterministic core runs and the verdict +
     * event are byte-identical to a run without this field. The backend's own
     * runner degrades a timeout/error to `needs-evidence`, never a silent pass.
     */
    readonly makeVerifierBackend?: () => ClaimVerifierBackend
  }
  /**
   * Track 1 — anti-redundant-build hook seam. Reads `SCNS_QG_REDUNDANCY`
   * (scan, default-ON) + `SCNS_QG_REDUNDANCY_SPAWN` (model, default-ON). The
   * deterministic scanner runs on every code-PASS output; ONLY when it trips a
   * redundancy flag with no addressing explanation is `makeVerifierBackend`
   * consulted — a single-shot independent model that judges whether the flagged
   * redundancy is addressed. A tripped-and-unaddressed verdict hard-FAILS the
   * gate (`redundancy-unexplained`). Unset backend ⇒ a tripped deterministic
   * flag alone blocks (never a silent pass).
   */
  readonly redundancyVerifier?: {
    readonly env?: NodeJS.ProcessEnv
    readonly makeVerifierBackend?: () => RedundancyVerifierBackend
  }
}

export interface ArbiterVerdict {
  readonly teamId: string
  readonly passed: boolean
  readonly reason: string
  readonly score: number
  readonly findings: readonly string[]
  readonly branch: string | null
  readonly sourceSuggestionId: string | null
  readonly qualityCheckId: string | null
  /**
   * Phase 1 wedge A — behavioral-improvement signal (additive, default-OFF).
   * `undefined` unless `SCNS_QG_BEHAVIORAL_GATE` is set; never present on the
   * default production path.
   */
  readonly behavioral?: BehavioralGateResult | null
  /**
   * Track 1 / 1B — claim-evidence verifier verdict (additive). Present whenever
   * the verifier ran (measure default-ON): `kind` is pass|fail|needs-evidence,
   * `claimCount` the number of runtime-behavior claims found. On an
   * analysis/research (no-diff) completion this drives the outcome; on a code
   * PASS it is advisory unless `SCNS_QG_CLAIM_ENFORCE=1`.
   */
  readonly claimVerifier?: {
    readonly kind: VerifierVerdict['kind']
    readonly claimCount: number
    readonly findings: readonly string[]
  } | null
  /**
   * Track 1 / 1B — the INDEPENDENT re-run verifier's result (producer≠verifier).
   * Present only when the spawn seam ran (`SCNS_QG_CLAIM_SPAWN=1` + a wired
   * backend + the pre-filter found ≥1 claim). This is the deeper judge that
   * actually re-ran the cited probes; when present it GOVERNS the outcome (the
   * deterministic `claimVerifier` above is the cheap pre-filter). `verdict` is
   * pass|fail|needs-evidence; `degradedReason` is set on a timeout/error degrade.
   */
  readonly claimReverify?: {
    readonly verdict: ClaimReverifyVerdict['verdict']
    readonly findings: readonly string[]
    readonly perClaimCount: number
    readonly degradedReason?: string
  } | null
}

/**
 * Track 1 / 1B — resolve the claim-evidence verifier mode from env.
 *   - measure (default-ON): the verifier runs on completion output, records its
 *     verdict as an event/finding, and governs analysis/research (no-diff)
 *     completions. Disabled only by `SCNS_QG_CLAIM_VERIFIER` = 0/off/false.
 *   - enforce (default-OFF): a fail/needs-evidence verdict may DOWNGRADE a code
 *     PASS→FAIL. Opt-in via `SCNS_QG_CLAIM_ENFORCE=1` (go-live gated).
 *   - spawn (default-OFF): consult the producer≠verifier injection seam (an
 *     independent RE-RUN of cited probes) AFTER the deterministic pre-filter.
 *     Opt-in via `SCNS_QG_CLAIM_SPAWN=1`; inert unless a backend is also wired.
 */
export function resolveClaimVerifierMode(env: NodeJS.ProcessEnv): {
  measure: boolean
  enforce: boolean
  spawn: boolean
} {
  const raw = (env.SCNS_QG_CLAIM_VERIFIER ?? '').trim().toLowerCase()
  const measure = raw !== '0' && raw !== 'off' && raw !== 'false'
  const enforce = (env.SCNS_QG_CLAIM_ENFORCE ?? '').trim() === '1'
  const spawn = (env.SCNS_QG_CLAIM_SPAWN ?? '').trim() === '1'
  return { measure, enforce: measure && enforce, spawn: measure && spawn }
}

/**
 * Track 1 — resolve the anti-redundant-build hook mode from env (Dev-default-ON).
 *   - scan  (default-ON): the deterministic redundancy-flag scanner runs on each
 *     code-PASS output. Disabled only by `SCNS_QG_REDUNDANCY` = 0/off/false.
 *   - spawn (default-ON): when a flag trips with no addressing explanation,
 *     consult the single-shot model backend. Opt-OUT with
 *     `SCNS_QG_REDUNDANCY_SPAWN` = 0/off/false (a resource escape hatch; the
 *     deterministic scan still governs). Inert unless a backend is also wired.
 */
export function resolveRedundancyMode(env: NodeJS.ProcessEnv): {
  scan: boolean
  spawn: boolean
} {
  const raw = (env.SCNS_QG_REDUNDANCY ?? '').trim().toLowerCase()
  const scan = raw !== '0' && raw !== 'off' && raw !== 'false'
  const spawnRaw = (env.SCNS_QG_REDUNDANCY_SPAWN ?? '').trim().toLowerCase()
  const spawn = scan && spawnRaw !== '0' && spawnRaw !== 'off' && spawnRaw !== 'false'
  return { scan, spawn }
}

/** A completion is analysis/research (no code diff expected) when a member has the researcher role. */
export function isAnalysisCompletion(artifacts: ReadonlyArray<{ role: string }>): boolean {
  // Bridge the namespace fracture: a brain-namespace `researcher` denotes the
  // same investigate-only capability as the broker `scns-researcher`, so its
  // no-diff findings are judged by the claim-evidence branch, not auto-failed.
  return artifacts.some((a) => isResearcherRole(a.role))
}

/** Join the per-member log tails into the analysis output the verifier inspects. */
export function analysisOutputFromLogs(logs: ReadonlyArray<{ tail: string }>): string {
  return logs
    .map((l) => l.tail ?? '')
    .filter((t) => t.trim().length > 0)
    .join('\n\n')
}

export interface QualityGateArbiter {
  handleTeamCompletion(data: TeamCompletionData): Promise<ArbiterVerdict>
  stop(): void
}

const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024
const COMMIT_TRAILER = 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Quote a filesystem path for a shell command string. `JSON.stringify` used to
 * do this job, but it escapes backslashes — on win32 the shell (cmd.exe) hands
 * git a path full of doubled `\\` separators. Paths cannot contain `"` on
 * Windows and never do in our temp layouts, so plain double quotes are
 * stripped identically by sh and by the Windows argv parser.
 */
function quotePath(p: string): string {
  return `"${p}"`
}

// Phase 13.12.33 — `defaultRunCommand` used to translate every thrown
// `execSync` exception into `ok: false`, even when the underlying child
// process had already exited cleanly with status 0. That happens in the
// real world for at least three reasons:
//
//   (a) maxBuffer overrun: Node aborts the read stream and throws AFTER
//       the child has exited, so `e.status` is the true exit code.
//   (b) signal-arrival race: SIGTERM (timeout/parent kill) is delivered
//       to a process that already exited; waitpid returns 0 cleanly.
//   (c) stdio close ordering: pipes close in an order Node deems an
//       error even though no process error occurred.
//
// In every case `e.status === 0` is the dispositive signal — the build
// (or test, or lint) actually succeeded. The previous behavior produced
// the misleading verdict `Build failed in worktree (exit 0): no stderr`
// observed in qc=7661336b et al. on team ca3ecfec, which deadlocked the
// self-improve loop because no diff could ever land. Treat status-0
// throws as success and preserve any partial output for diagnostics.
function normalizeRunFailure(err: unknown, cmd: string, cwd: string): RunResult {
  const e = err as {
    stdout?: Buffer | string
    stderr?: Buffer | string
    status?: number | null
    code?: number | string | null
    signal?: NodeJS.Signals | null
    message?: string
  }
  const stdout = e.stdout ? String(e.stdout) : ''
  const stderr = e.stderr ? String(e.stderr) : ''
  // `execSync` reports the child's exit code on `status`; async `exec`
  // reports it on `code` — but `code` is a string ('ENOENT') when the
  // spawn itself failed, in which case there is no exit code at all.
  const exitCode =
    typeof e.status === 'number' ? e.status : typeof e.code === 'number' ? e.code : null
  if (exitCode === 0) {
    // Process exited cleanly; the throw was a Node-side artifact
    // (maxBuffer, signal race, stdio close). Surface as success but
    // log so operators can audit how often this fires.
    logger.warn(
      {
        module: 'quality-gate-arbiter',
        cmd,
        cwd,
        nodeErrorCode: typeof e.code === 'string' ? e.code : null,
        signal: e.signal ?? null,
        message: e.message?.slice(0, 200) ?? null,
      },
      'qg: exec threw on status-0 child; treating as success',
    )
    return { ok: true, stdout, stderr }
  }
  return { ok: false, stdout, stderr, code: exitCode ?? 1 }
}

export function defaultRunCommand(
  cmd: string,
  cwd: string,
  options?: { timeoutMs?: number },
): RunResult {
  try {
    const out = nodeExecSync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout: options?.timeoutMs ?? 180_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      windowsHide: true,
    })
    return { ok: true, stdout: String(out ?? ''), stderr: '' }
  } catch (err) {
    return normalizeRunFailure(err, cmd, cwd)
  }
}

const execAsync = promisify(nodeExec)

/**
 * Non-blocking twin of {@link defaultRunCommand}, for the commands that
 * take minutes rather than milliseconds (`npm run build` / `npm test` /
 * `npm run lint`).
 *
 * `execSync` runs the child's entire lifetime on the calling thread. The
 * arbiter is invoked from the broker's event loop, so a synchronous
 * `npm test` with a 600s budget froze the WHOLE broker — HTTP, the team
 * reaper, brain wake cycles — for as long as the suite ran. Observed in
 * production as a ~15 minute stall where the process sat at 0% CPU with
 * 100% of stack samples inside `node::SyncProcessRunner::Spawn`, reached
 * from a timer callback, while the port stayed open but answered nothing.
 *
 * Success/failure semantics are kept byte-identical to the sync version
 * (including the empty `stderr` on success) so gate verdicts do not move.
 */
export async function defaultRunCommandAsync(
  cmd: string,
  cwd: string,
  options?: { timeoutMs?: number },
): Promise<RunResult> {
  try {
    const { stdout } = await execAsync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout: options?.timeoutMs ?? 180_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      windowsHide: true,
    })
    return { ok: true, stdout: String(stdout ?? ''), stderr: '' }
  } catch (err) {
    return normalizeRunFailure(err, cmd, cwd)
  }
}

function extractSourceSuggestionId(teamId: string): string | null {
  // Brain promoter forms task ids like `task-sugg-<uuid>` and
  // agent-loop builds team ids as `team-<taskId>` → `team-task-sugg-<uuid>`.
  const prefix = 'team-task-sugg-'
  if (teamId.startsWith(prefix)) return teamId.slice(prefix.length)
  return null
}

/**
 * Phase 13.12.34 — Inspect the git index for staged symlink entries
 * (mode 120000) and return their paths. Used as a defense-in-depth
 * post-add check before auto-committing a QG-passing diff: even with
 * `:!node_modules` excluded from `git add`, a symlink committed by an
 * upstream agent (or a future pathspec slip) is fatal to the branch
 * because the symlink target encodes an absolute host filesystem path.
 *
 * Returns an empty array on success or when `git ls-files --stage`
 * fails (defensive: a missing index reads as "nothing to reject"; the
 * git add itself would have failed first if the repo were broken).
 */
export function detectStagedSymlinks(
  run: (cmd: string, cwd: string) => RunResult,
  worktreePath: string,
): string[] {
  const lsFiles = run('git ls-files --stage', worktreePath)
  if (!lsFiles.ok) return []
  const symlinks: string[] = []
  for (const line of (lsFiles.stdout || '').split('\n')) {
    if (!line) continue
    // Format: `<mode> <sha> <stage>\t<path>`
    const mode = line.slice(0, 6)
    if (mode !== '120000') continue
    const tabIdx = line.indexOf('\t')
    if (tabIdx === -1) continue
    const path = line.slice(tabIdx + 1)
    if (path) symlinks.push(path)
  }
  return symlinks
}

/** The npm scripts the gate actually runs (via `--if-present`). */
const GATE_NPM_SCRIPTS = ['build', 'test', 'lint'] as const

/**
 * F2 (blind-review caveat 2, PR #38) — detect gate scripts the diff LOST.
 *
 * The npm steps run with `--if-present`, so a diff that deletes the
 * `build`/`test`/`lint` script from package.json (or package.json itself)
 * makes the corresponding step silently skip — the gate loses teeth with no
 * trace in the verdict. This helper compares HEAD's package.json (the
 * worktree is branched from HEAD, so `git show HEAD:package.json` is the
 * pre-diff baseline) against the post-diff worktree file and returns one
 * finding per lost gate script. Any finding FAILS the verdict
 * (`gate-scripts-removed`) before the npm steps run — an explicit,
 * John-approved hardening (2026-08-14), not a buried one (AGENTS.md rule 12).
 *
 * Deliberately silent when:
 *   - HEAD has no package.json (content repo — the intended G2 weakening);
 *   - HEAD's package.json is unparseable (no baseline to compare);
 *   - the worktree package.json exists but is unparseable (npm itself will
 *     fail the build step, which already FAILs the gate — no double report).
 */
export function detectLostNpmScripts(
  run: (cmd: string, cwd: string) => RunResult,
  worktreePath: string,
): string[] {
  const headRes = run('git show HEAD:package.json', worktreePath)
  if (!headRes.ok) return []
  let headScripts: Record<string, unknown>
  try {
    const parsed = JSON.parse(headRes.stdout || '') as { scripts?: Record<string, unknown> }
    headScripts = parsed.scripts ?? {}
  } catch {
    return []
  }
  const lostGateScripts = GATE_NPM_SCRIPTS.filter((s) => typeof headScripts[s] === 'string')
  if (lostGateScripts.length === 0) return []

  const wtPkgPath = join(worktreePath, 'package.json')
  if (!existsSync(wtPkgPath)) {
    return [
      `Diff removed package.json — HEAD defines npm script(s) ${lostGateScripts
        .map((s) => `"${s}"`)
        .join(', ')}, so the gate's npm build/test/lint steps cannot run against this diff`,
    ]
  }

  let wtScripts: Record<string, unknown>
  try {
    const parsed = JSON.parse(nodeReadFileSync(wtPkgPath, 'utf-8')) as {
      scripts?: Record<string, unknown>
    }
    wtScripts = parsed.scripts ?? {}
  } catch {
    return []
  }

  return lostGateScripts
    .filter((s) => typeof wtScripts[s] !== 'string')
    .map(
      (s) =>
        `Diff removed npm script "${s}" from package.json — the gate's ${s} step would ` +
        `be silently skipped via --if-present (HEAD defines it)`,
    )
}

/**
 * WS-0 Gate 3 (layer 3) — parse `git diff --cached --name-only` in the
 * worktree and return the staged paths that belong to the immutable safety
 * kernel (see {@link isSafetyKernelPath}). Powers the QG arbiter's
 * `kernel-self-edit` pre-commit reject: any non-empty result means the
 * branch is attempting to edit the kernel or its human-owned allowlist and
 * the commit is refused (no override) — defense-in-depth above the
 * auto-merger's absolute `no-safety-kernel-edit` gate.
 *
 * Returns [] when the diff command fails (defensive; consistent with
 * {@link detectStagedSymlinks} — a failed diff reads as "nothing to reject",
 * and the commit path would surface the git error on its own).
 */
export function detectStagedKernelEdits(
  run: (cmd: string, cwd: string) => RunResult,
  worktreePath: string,
): string[] {
  const staged = run('git diff --cached --name-only', worktreePath)
  if (!staged.ok) return []
  return (staged.stdout || '')
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && isSafetyKernelPath(f))
}

/**
 * Phase 13.12.34 — Refuse to commit a worktree that would erase the
 * negative-memories block from `.github/copilot-instructions.md`.
 *
 * Postmortem (team ca3ecfec, 2026-05-15): three verdict-PASS auto-branches
 * stripped all 5 learned guardrail rules from the managed block. The
 * applicator-side fix prevents the next iteration from happening at the
 * source. THIS check is the second line of defense: if any other
 * mechanism (direct agent edit, runaway tool, regex blunder) tries to
 * land a diff that erases the rules, we abort the commit.
 *
 * Semantics: if HEAD has a non-empty managed block AND the worktree
 * version would land with an empty/missing block, fail. Reducing the
 * rule count (legitimate suppress) is allowed; going to zero is not.
 *
 * `fileIO` is injectable for tests; production callers pass defaults.
 */
export function checkNegativeMemoriesPreserved(
  run: (cmd: string, cwd: string) => RunResult,
  worktreePath: string,
  fileIO: {
    existsSync: (p: string) => boolean
    readFileSync: (p: string) => string
  } = {
    existsSync,
    readFileSync: (p: string) => nodeReadFileSync(p, 'utf-8'),
  },
): { ok: true } | { ok: false; finding: string } {
  const TARGET = '.github/copilot-instructions.md'
  const START = '<!-- SCNS:negative-memories:start -->'
  const END = '<!-- SCNS:negative-memories:end -->'

  // 1) HEAD baseline. If file or block is absent in HEAD, there is
  //    nothing to preserve — let any other gates decide.
  const headRes = run(`git show HEAD:${TARGET}`, worktreePath)
  if (!headRes.ok) return { ok: true }
  const headContent = headRes.stdout
  const headStartIdx = headContent.indexOf(START)
  if (headStartIdx === -1) return { ok: true }
  const headEndIdx = headContent.indexOf(END, headStartIdx)
  if (headEndIdx === -1) return { ok: true }
  const headInner = headContent.slice(headStartIdx + START.length, headEndIdx).trim()
  if (headInner.length === 0) return { ok: true }

  // 2) Worktree comparison.
  const wtPath = join(worktreePath, TARGET)
  if (!fileIO.existsSync(wtPath)) {
    return {
      ok: false,
      finding: `${TARGET} deleted in worktree — would erase ${headInner.length} bytes of negative-memories rules`,
    }
  }
  const wtContent = fileIO.readFileSync(wtPath)
  const wtStartIdx = wtContent.indexOf(START)
  const wtEndIdx = wtStartIdx === -1 ? -1 : wtContent.indexOf(END, wtStartIdx)
  if (wtStartIdx === -1 || wtEndIdx === -1) {
    return {
      ok: false,
      finding: `${TARGET} lost negative-memories block markers — would erase ${headInner.length} bytes of rules`,
    }
  }
  const wtInner = wtContent.slice(wtStartIdx + START.length, wtEndIdx).trim()
  if (wtInner.length === 0) {
    return {
      ok: false,
      finding: `${TARGET} negative-memories block emptied (HEAD had ${headInner.length} bytes of rules) — refusing to commit erasure`,
    }
  }

  return { ok: true }
}

/**
 * Phase 13.12.20: resolve the source suggestion for a team_completed event.
 * First tries the deterministic `team-task-sugg-<uuid>` prefix (legacy
 * path-B); on miss, falls back to the suggestion store's reverse lookup
 * by `inflightTeamId` (path-A brain-spawn bridge).
 */
function resolveSourceSuggestionId(
  teamId: string,
  suggestionStore?: QualityGateSuggestionStore,
): string | null {
  const fromPrefix = extractSourceSuggestionId(teamId)
  if (fromPrefix) return fromPrefix
  if (!suggestionStore?.findByInflightTeamId) return null
  try {
    const found = suggestionStore.findByInflightTeamId(teamId)
    return found?.id ?? null
  } catch {
    return null
  }
}

function slugifyTeamId(teamId: string): string {
  const base = teamId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  const suffix = Date.now().toString(36)
  return `${base || 'team'}-${suffix}`
}

function clipOutput(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…[truncated ${s.length - max} bytes]`
}

// ── Phase 13.12.24 — baseline-diff helpers (exported for unit tests) ──

export interface LintStats {
  readonly parsed: boolean
  readonly total: number
  readonly byFile: Readonly<Record<string, number>>
}

const EMPTY_LINT_STATS: LintStats = Object.freeze({
  parsed: false,
  total: 0,
  byFile: Object.freeze({}),
})

export function parseEslintJson(stdout: string): LintStats {
  if (!stdout) return EMPTY_LINT_STATS
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start < 0 || end <= start) return EMPTY_LINT_STATS
  try {
    const arr = JSON.parse(stdout.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) return EMPTY_LINT_STATS
    const byFile: Record<string, number> = {}
    let total = 0
    for (const raw of arr) {
      const entry = raw as { filePath?: unknown; errorCount?: unknown }
      const count = typeof entry.errorCount === 'number' ? entry.errorCount : 0
      const file = typeof entry.filePath === 'string' ? entry.filePath : ''
      if (count > 0 && file) {
        byFile[file] = count
        total += count
      }
    }
    return { parsed: true, total, byFile }
  } catch {
    return EMPTY_LINT_STATS
  }
}

// Phase 13.12.34 — strip ANSI before matching and anchor on a real test-file
// path. Vitest emits SGR color even under FORCE_COLOR=0 when CI=1 (the QG
// runner sets both, see defaultRunCommand), so a real FAIL line arrives as
//   \x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m test/unit/foo.test.ts\x1b[2m > …
// Matching the raw line captured the reset code `\x1b[22m\x1b[49m` as the
// "failing file"; and a failing test's dumped source / error prose like
// `should FAIL with (no even markers)` captured the bare word `with`. Both are
// phantom tokens that vary run-to-run, so `subtractSets(post, baseline)`
// reported false "new failures" and the tests-gate rejected proposals that
// regressed ZERO test files — the loop never reached the rubric-PASS branch.
// Real production evidence (~/.scns/logs/broker.log): team 1fe872c4 failed 6×
// on 2026-06-26 with `newFailingTests:1` whose name was literally
// `\x1b[22m\x1b[49m`; brain-solo 2026-06-10 logged `post 5 / new 4` named
// `with,(no,even,markers`. Reproduced 1:1 with real vitest output 2026-06-28.
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g
// A vitest FAIL badge always names a test FILE (the suite include glob requires
// a .test/.spec extension), so anchoring on that extension admits every genuine
// failing file while rejecting ANSI codes and prose words.
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i

export function parseFailingTests(output: string): Set<string> {
  const set = new Set<string>()
  if (!output) return set
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(ANSI_SGR_RE, '')
    const m = line.match(/(?:^|[\s❯×✗✕])FAIL\s+(\S+)/)
    if (!m || !m[1]) continue
    const token = m[1]
      .replace(/[),:;]+$/, '') // strip trailing punctuation (e.g. "file.test.ts:")
      .replace(/:\d+(?::\d+)?$/, '') // normalize an optional :line:col locator
    if (TEST_FILE_RE.test(token)) set.add(token)
  }
  return set
}

function subtractSets(post: ReadonlySet<string>, base: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const v of post) if (!base.has(v)) out.push(v)
  return out
}

function summarizeFiles(files: readonly string[]): string {
  if (files.length === 0) return ''
  const head = files.slice(0, 5).join(', ')
  return files.length > 5 ? `${head}, +${files.length - 5} more` : head
}

// ── Task 37 — node_modules bridge ────────────────────────────────────
// Extracted to `worktree-tooling-bridge.ts`. See top-of-file import +
// re-export block for the names. This comment preserves the original
// pointer for code archaeologists.

// Phase 13.12.28 — test/lint floor helper. Returns true when a worktree
// command was *not actually run* because the binary could not be located
// (exit 127 / 126 / ENOENT) or the shell explicitly reported
// "command not found". These signals are categorically different from
// "ran but failed", and the baselineClean override (which infers
// regression from diff) MUST NOT mask them — there is no measurement to
// diff against. See the 5ebeadae quality_check row for the production
// shape this guards: `npm test` and `npm run lint` both exit 127 with
// stderr "vitest: command not found" / "eslint: command not found",
// yet QG persisted passed=1 score=1.0.
/**
 * Detect whether a non-zero `RunResult` represents the shell failing to
 * LOCATE the binary (vs. a binary that ran and reported failures).
 *
 * Phase 13.12.30 — narrowed to trust ONLY POSIX shell exit codes
 * 127 ("command not found") and 126 ("found but not executable"). The
 * earlier implementation also scanned stdout+stderr for the substrings
 * "command not found" / ":not found" / "enoent", which produced false
 * positives whenever a normal test failure dumped text containing those
 * strings: our own bridge test fixtures
 * (`test/unit/broker/services/quality-gate-arbiter.bridge.test.ts`)
 * embed `vitest: command not found` as literal test input, and vitest
 * dumps failing test source into its own output. Every `tests-failed`
 * verdict whose test set touched those fixtures was then mislabeled
 * `tooling-missing` (postmortem qc=4f7e7f48).
 *
 * Trusting only the exit code is sufficient because both bash and
 * dash/ash set 126/127 unconditionally for these cases, and npm-script
 * shells propagate the child's exit code unchanged. The trade-off is
 * that a wrapper that swallowed 127 and re-exited 1 with a "command
 * not found" stderr line would now be reported as a regular test/lint
 * failure — which is still actionable (the verdict findings still
 * surface the real first stderr line), and far better than the
 * silent false-positive that this fix removes.
 */
export function isCommandMissing(r: RunResult): boolean {
  if (r.ok) return false
  const err = r as { code?: number }
  const code = typeof err.code === 'number' ? err.code : 0
  return code === 127 || code === 126
}

// ── Factory ──────────────────────────────────────────────────────────

export function createQualityGateArbiter(deps: QualityGateArbiterDeps): QualityGateArbiter {
  const run = deps.runCommand ?? defaultRunCommand
  // Long-running commands go through the non-blocking runner so the broker's
  // event loop stays responsive. When a caller injects `runCommand` (every
  // unit test does), honor that single injection point for both paths so
  // mocks keep intercepting and no test ever spawns a real binary.
  const injectedRun = deps.runCommand
  const runAsync: RunCommandAsync = injectedRun
    ? async (cmd, cwd, options) => injectedRun(cmd, cwd, options)
    : defaultRunCommandAsync
  const maxBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const worktreeBase = deps.worktreeBase ?? tmpdir()
  const baselineLintEnabled = deps.baselineLintEnabled ?? false
  const baselineTestsEnabled = deps.baselineTestsEnabled ?? false
  const npmStrategy: 'symlink' | 'none' = deps.npmStrategy ?? 'symlink'

  // Phase 1 wedge A — behavioral-improvement gate (additive, default-OFF). The
  // env opt-ins are read from here (injectable for tests); backends default to a
  // deterministic MockBackend so nothing spawns. `behavioralEnv()` is the single
  // source of truth for the two switches.
  const behavioralCfg = deps.behavioralGate
  const behavioralEnv = (): NodeJS.ProcessEnv => behavioralCfg?.env ?? process.env

  // Track 1 / 1B — claim-evidence verifier env (measure default-ON; enforce
  // gated). `claimVerifierEnv()` is the single source of truth for the switches.
  const claimVerifierEnv = (): NodeJS.ProcessEnv => deps.claimVerifier?.env ?? process.env
  const claimVerifierMode = (): { measure: boolean; enforce: boolean; spawn: boolean } =>
    resolveClaimVerifierMode(claimVerifierEnv())
  const redundancyVerifierEnv = (): NodeJS.ProcessEnv => deps.redundancyVerifier?.env ?? process.env
  const redundancyVerifierMode = (): { scan: boolean; spawn: boolean } =>
    resolveRedundancyMode(redundancyVerifierEnv())

  // Phase 13.12.24 — tiny per-HEAD-SHA memo so back-to-back verdicts on
  // the same HEAD don't re-run lint/test twice. LRU-8 is plenty.
  // Phase 13.12.25 — include the runtime flag tuple in the cache key so a
  // config toggle (lint-enabled / tests-enabled) can't serve a stale-shape
  // entry across reconfigs.
  const baselineCache = new Map<string, { lint: LintStats; tests: Set<string> }>()
  const baselineCacheKey = (sha: string): string =>
    `${sha}|${baselineLintEnabled ? 'L' : '-'}${baselineTestsEnabled ? 'T' : '-'}`
  function rememberBaseline(sha: string, value: { lint: LintStats; tests: Set<string> }): void {
    baselineCache.set(baselineCacheKey(sha), value)
    while (baselineCache.size > 8) {
      const first = baselineCache.keys().next().value
      if (typeof first !== 'string') break
      baselineCache.delete(first)
    }
  }

  async function computeBaselines(): Promise<{ lint: LintStats; tests: Set<string> }> {
    const shaRes = run('git rev-parse HEAD', deps.projectRoot)
    const sha = shaRes.ok ? (shaRes.stdout || '').trim() : ''
    if (sha) {
      const cached = baselineCache.get(baselineCacheKey(sha))
      if (cached) return cached
    }

    let lint: LintStats = EMPTY_LINT_STATS
    let tests = new Set<string>()
    if (baselineLintEnabled) {
      const r = await runAsync('npm run lint --silent -- --format json', deps.projectRoot, {
        timeoutMs: 180_000,
      })
      lint = parseEslintJson(r.stdout || '')
    }
    if (baselineTestsEnabled) {
      const r = await runAsync('npm test --silent', deps.projectRoot, { timeoutMs: 600_000 })
      tests = parseFailingTests((r.stdout || '') + '\n' + (r.stderr || ''))
    }
    const value = { lint, tests }
    if (sha) rememberBaseline(sha, value)
    return value
  }

  /**
   * Phase 1 wedge A — compute the behavioral non-regression result for one
   * completion. Builds the baseline backend at the live projectRoot (HEAD) and
   * the candidate backend at the post-diff worktree; both default to a
   * deterministic MockBackend (NO spawn). A thrown backend is swallowed and
   * treated as no-signal so an advisory failure can never flip a decision.
   */
  async function computeBehavioralResult(
    teamId: string,
    worktreeCwd: string,
  ): Promise<BehavioralGateResult | null> {
    // Preferred path (production wiring): a per-completion pair WITH lifecycle. The
    // real bounded AcpReplayBackend pair is built here; `dispose` reaps spawn PIDs
    // and removes the baseline worktree in a `finally`. A thrown backend (spawn /
    // timeout / setup) is swallowed as no-signal so an advisory failure can never
    // flip a decision.
    const makeBackends = behavioralCfg?.makeBackends
    if (makeBackends) {
      let pair: {
        baseline: ReplayBackend
        candidate: ReplayBackend
        dispose: () => void | Promise<void>
      } | null = null
      try {
        pair = makeBackends({ headCwd: deps.projectRoot, candidateCwd: worktreeCwd })
        return await evaluateBehavioralGate({
          valTasks: behavioralCfg?.valTasks ?? DEFAULT_BEHAVIORAL_VAL_TASKS,
          baselineBackend: pair.baseline,
          candidateBackend: pair.candidate,
          ...(behavioralCfg?.epsilon !== undefined ? { epsilon: behavioralCfg.epsilon } : {}),
        })
      } catch (err) {
        log.warn({ err, teamId }, 'Behavioral gate threw — treating as no-signal')
        return null
      } finally {
        if (pair) {
          try {
            await pair.dispose()
          } catch (err) {
            log.warn({ err, teamId }, 'Behavioral gate dispose failed (worktree/pid leak risk)')
          }
        }
      }
    }

    // Fallback path (unit tests / no real wiring): bare factories default to a
    // deterministic MockBackend (NO spawn). A thrown backend is swallowed and
    // treated as no-signal.
    const makeBaseline =
      behavioralCfg?.makeBaselineBackend ?? ((): ReplayBackend => new MockBackend())
    const makeCandidate =
      behavioralCfg?.makeCandidateBackend ?? ((): ReplayBackend => new MockBackend())
    try {
      return await evaluateBehavioralGate({
        valTasks: behavioralCfg?.valTasks ?? DEFAULT_BEHAVIORAL_VAL_TASKS,
        baselineBackend: makeBaseline(deps.projectRoot),
        candidateBackend: makeCandidate(worktreeCwd),
        ...(behavioralCfg?.epsilon !== undefined ? { epsilon: behavioralCfg.epsilon } : {}),
      })
    } catch (err) {
      log.warn({ err, teamId }, 'Behavioral gate threw — treating as no-signal')
      return null
    }
  }

  // Track 1 / 1B — the producer≠verifier deep check. Constructs the injected
  // backend, runs the independent probe RE-RUN over the pre-filter's claims, and
  // disposes it. Returns null when no backend is wired (⇒ pre-filter-only, today's
  // behavior). Unlike the behavioral gate, an UNEXPECTED backend throw degrades to
  // `needs-evidence` (never a silent pass) — the anti-overclaim gate must fail safe.
  async function computeClaimReverify(
    teamId: string,
    output: string,
    claims: VerifierVerdict['claims'],
  ): Promise<ClaimReverifyVerdict | null> {
    const make = deps.claimVerifier?.makeVerifierBackend
    if (!make) return null
    let backend: ClaimVerifierBackend | null = null
    try {
      backend = make()
      return await backend.reverify({ output, claims })
    } catch (err) {
      log.warn({ err, teamId }, 'Claim re-verification backend threw — degrading to needs-evidence')
      return {
        verdict: 'needs-evidence',
        findings: [
          `claim re-verification backend error: ${err instanceof Error ? err.message : String(err)}`,
        ],
        perClaim: [],
        degradedReason: 'backend-threw',
      }
    } finally {
      if (backend?.dispose) {
        try {
          await backend.dispose()
        } catch (err) {
          log.warn({ err, teamId }, 'Claim re-verification dispose failed')
        }
      }
    }
  }

  /**
   * Track 1 — run the single-shot redundancy model backend. Called ONLY when the
   * deterministic scanner has already tripped a flag (bounded cost). Mirrors
   * computeClaimReverify: a backend throw degrades to `needs-explanation`, never
   * a silent `pass`.
   */
  async function computeRedundancyVerdict(
    teamId: string,
    output: string,
    flags: readonly RedundancyFlag[],
  ): Promise<RedundancyVerifyVerdict | null> {
    const make = deps.redundancyVerifier?.makeVerifierBackend
    if (!make) return null
    let backend: RedundancyVerifierBackend | null = null
    try {
      backend = make()
      return await backend.judge({ output, flags })
    } catch (err) {
      log.warn(
        { err, teamId },
        'Redundancy verification backend threw — degrading to needs-explanation',
      )
      return {
        verdict: 'needs-explanation',
        findings: [
          `redundancy verification backend error: ${err instanceof Error ? err.message : String(err)}`,
        ],
        degradedReason: 'backend-threw',
      }
    } finally {
      if (backend?.dispose) {
        try {
          await backend.dispose()
        } catch (err) {
          log.warn({ err, teamId }, 'Redundancy verification dispose failed')
        }
      }
    }
  }

  const unsubscribe = deps.dispatcher.subscribe(
    { event_types: ['team_completed'] },
    (event: TypedEvent) => {
      let payload: TeamCompletionData | null = null
      try {
        payload = JSON.parse(event.payload) as TeamCompletionData
      } catch (err) {
        log.warn({ err, eventId: event.id }, 'Failed to parse team_completed payload')
        return
      }
      handleTeamCompletion(payload).catch((err) => {
        log.error({ err, teamId: payload?.teamId }, 'Arbiter handler threw')
      })
    },
  )

  function persistVerdict(
    teamId: string,
    passed: boolean,
    score: number,
    findings: readonly string[],
    output: string,
  ): string | null {
    try {
      const clipped = clipOutput(output, maxBytes)
      const final = createQualityCheck(deps.db, {
        session_id: null,
        task_type: `team:${teamId}`,
        output: clipped,
        passed,
        score,
        findings,
      })
      return final.id
    } catch (err) {
      log.warn({ err, teamId }, 'Failed to persist quality_check row')
      return null
    }
  }

  function recordNegativeMemory(
    teamId: string,
    findings: readonly string[],
    summary: string,
  ): void {
    if (!deps.negativeMemoryStore) return
    try {
      const rule =
        `Quality gate rejected team ${teamId}: ${findings.slice(0, 3).join('; ') || summary}`.slice(
          0,
          300,
        )
      deps.negativeMemoryStore.storeFromHeuristic({
        originalText: summary.slice(0, 2000),
        dontRule: rule,
        category: 'behavior-complaint',
        recommendedTarget: 'general',
        confidence: 0.7,
      })
    } catch (err) {
      log.warn({ err, teamId }, 'Failed to record negative memory')
    }
  }

  function emitOutcome(
    teamId: string,
    sourceSuggestionId: string | null,
    passed: boolean,
    score: number,
  ): void {
    if (!deps.onOutcome) return
    try {
      let description: string | null = null
      if (sourceSuggestionId && deps.suggestionStore) {
        const s = deps.suggestionStore.get(sourceSuggestionId)
        description = s?.title ?? null
      }
      deps.onOutcome({
        teamId,
        sourceSuggestionId,
        passed,
        score,
        description,
        // A gate failure is an implementation failure, never a refusal. See the `verdict` doc on
        // `onOutcome` — without this the ledger re-creates the exact defect this phase removed.
        verdict: passed ? 'implemented' : 'failed',
      })
    } catch (err) {
      log.warn({ err, teamId }, 'onOutcome callback threw')
    }
  }

  /**
   * FR-056 / FR-057 — a gate failure is an IMPLEMENTATION failure, never the human's refusal.
   *
   * Previously this called `updateStatus(id, 'rejected', reason)`, which did three wrong things
   * at once on `65a914f4`: it made the proposal terminal on attempt one, it labelled it with the
   * status that means "John declined this" (and so counted his approval as a refusal via
   * `rejected ∈ FAILED_VERDICTS`), and it cleared the `approve` verdict that proved otherwise.
   *
   * The retry machinery it now calls already existed and was simply never wired to this seam.
   *
   * FR-058b — escalation is the SAFE default. If this write fails the proposal keeps whatever
   * status it currently holds, which is non-terminal; there is deliberately no fall-back to
   * `rejected`, because a storage error is not evidence about John's judgement either.
   */
  function recordGateFailure(sourceSuggestionId: string | null, reason: string): void {
    if (!sourceSuggestionId || !deps.suggestionStore) return
    try {
      const updated = deps.suggestionStore.recordQualityGateFailure(sourceSuggestionId, reason)
      if (updated) {
        log.info(
          {
            sourceSuggestionId,
            status: updated.status,
            attemptCount: updated.attemptCount,
            nextRetryAt: updated.nextRetryAt,
          },
          updated.status === 'needs-human'
            ? 'qg: retry budget exhausted — escalated to needs-human'
            : 'qg: gate failure recorded, retry scheduled',
        )
      }
    } catch (err) {
      log.warn(
        { err, sourceSuggestionId },
        'Failed to record quality-gate failure — suggestion left non-terminal (FR-058b)',
      )
    }
  }

  function approveSuggestion(sourceSuggestionId: string | null, reason: string): void {
    if (!sourceSuggestionId || !deps.suggestionStore) return
    try {
      // The PASS path is not defective and is left alone — but it now declares its author, so
      // marking an approved item `implemented` can never be read as a human re-decision either.
      deps.suggestionStore.updateStatus(sourceSuggestionId, 'implemented', reason, undefined, {
        author: 'machine',
      })
    } catch (err) {
      log.warn({ err, sourceSuggestionId }, 'Failed to mark suggestion implemented')
    }
  }

  function applyArtifact(sourceSuggestionId: string | null): void {
    if (!sourceSuggestionId || !deps.suggestionStore || !deps.executor) return
    try {
      const s = deps.suggestionStore.get(sourceSuggestionId)
      if (!s) return
      const plan = deps.executor.generatePlan(s)
      const res = deps.executor.execute(plan, s)
      if (!res.success) {
        log.warn(
          { sourceSuggestionId, errors: res.errors },
          'Executor reported errors applying artifact',
        )
      }
    } catch (err) {
      log.warn({ err, sourceSuggestionId }, 'Failed to apply artifact')
    }
  }

  async function handleTeamCompletion(data: TeamCompletionData): Promise<ArbiterVerdict> {
    const teamId = data.teamId
    const sourceSuggestionId = resolveSourceSuggestionId(teamId, deps.suggestionStore)
    const slug = slugifyTeamId(teamId)
    const branch = `scns/auto/${slug}`

    deps.eventLog.qualityGateStarted(null, {
      team_id: teamId,
      sourceSuggestionId,
      diffBytes: data.stagedDiff.length,
      memberCount: data.memberSessionIds.length,
    })

    // No diff. Two cases:
    //   (a) Analysis/research team (a scns-researcher member) — a code diff is
    //       NOT expected, so the code-diff gate is the wrong rule. Judge it by
    //       the claim-evidence verifier (Track 1 / 1B): the anti-overclaim check
    //       for descriptive outputs the diff-based gate never covered.
    //   (b) Otherwise a code team produced nothing → a real failure (legacy).
    if (!data.stagedDiff || data.stagedDiff.trim().length === 0) {
      const claimMode = claimVerifierMode()
      const analysisOutput = analysisOutputFromLogs(data.logs)
      if (claimMode.measure && isAnalysisCompletion(data.artifacts) && analysisOutput.length > 0) {
        const coreVerdict = verifyClaimEvidence(analysisOutput)
        // Producer≠verifier deep check (Track 1 / 1B): when SCNS_QG_CLAIM_SPAWN=1
        // AND a backend is wired AND the pre-filter found ≥1 claim, an independent
        // spawn RE-RUNS the cited probes and GOVERNS the outcome (the deterministic
        // core is the cheap pre-filter). Off/unwired ⇒ the core governs (unchanged).
        const reverify =
          claimMode.spawn && coreVerdict.claims.length > 0
            ? await computeClaimReverify(teamId, analysisOutput, coreVerdict.claims)
            : null
        const govKind = reverify ? reverify.verdict : coreVerdict.kind
        const passed = govKind === 'pass'
        const score = passed ? 1 : 0
        const reason = reverify ? `claim-reverify:${govKind}` : `claim-verifier:${govKind}`
        const findings =
          reverify && reverify.findings.length > 0 ? reverify.findings : coreVerdict.findings
        const qualityCheckId = persistVerdict(teamId, passed, score, findings, analysisOutput)
        if (!passed) recordNegativeMemory(teamId, findings, findings.join('; '))
        deps.eventLog.qualityGateVerdict(null, {
          team_id: teamId,
          passed,
          reason,
          score,
          findings,
          branch: null,
          sourceSuggestionId,
          qualityCheckId,
          claimVerifierKind: coreVerdict.kind,
          claimVerifierClaimCount: coreVerdict.claims.length,
          ...(reverify
            ? {
                claimReverifyKind: reverify.verdict,
                ...(reverify.degradedReason
                  ? { claimReverifyDegraded: reverify.degradedReason }
                  : {}),
              }
            : {}),
        })
        if (passed) approveSuggestion(sourceSuggestionId, 'qg-pass:analysis')
        else recordGateFailure(sourceSuggestionId, `qg-fail:${reason}`)
        emitOutcome(teamId, sourceSuggestionId, passed, score)
        log.info(
          {
            teamId,
            reason,
            claimCount: coreVerdict.claims.length,
            reverified: reverify ? reverify.verdict : null,
            passed,
          },
          'Quality gate claim-verifier verdict (analysis/no-diff)',
        )
        return {
          teamId,
          passed,
          reason,
          score,
          findings,
          branch: null,
          sourceSuggestionId,
          qualityCheckId,
          claimVerifier: {
            kind: coreVerdict.kind,
            claimCount: coreVerdict.claims.length,
            findings: coreVerdict.findings,
          },
          ...(reverify
            ? {
                claimReverify: {
                  verdict: reverify.verdict,
                  findings: reverify.findings,
                  perClaimCount: reverify.perClaim.length,
                  ...(reverify.degradedReason ? { degradedReason: reverify.degradedReason } : {}),
                },
              }
            : {}),
        }
      }

      const reason = 'no-diff'
      const findings = ['Team produced no staged diff']
      const qualityCheckId = persistVerdict(teamId, false, 0, findings, '')
      recordNegativeMemory(teamId, findings, findings.join('; '))
      deps.eventLog.qualityGateVerdict(null, {
        team_id: teamId,
        passed: false,
        reason,
        score: 0,
        findings,
        branch: null,
        sourceSuggestionId,
        qualityCheckId,
      })
      // `no-diff` is precisely the 65a914f4 shape: both dev sessions produced `diff_bytes: 0`.
      // An agent that wrote nothing is the strongest possible case for a fresh retry, and the
      // weakest possible evidence about what John thinks of the idea.
      recordGateFailure(sourceSuggestionId, 'qg-fail:no-diff')
      emitOutcome(teamId, sourceSuggestionId, false, 0)
      return {
        teamId,
        passed: false,
        reason,
        score: 0,
        findings,
        branch: null,
        sourceSuggestionId,
        qualityCheckId,
      }
    }

    // 1) Create disposable worktree branched from HEAD.
    let worktreePath: string | null = null
    let wtParent: string | null = null
    let bridgeResult: BridgeResult | null = null
    const cleanupPaths: string[] = []
    try {
      wtParent = mkdtempSync(join(worktreeBase, 'scns-qg-'))
      cleanupPaths.push(wtParent)
      worktreePath = join(wtParent, 'wt')
      const addRes = run(
        `git worktree add -b ${branch} ${quotePath(worktreePath)} HEAD`,
        deps.projectRoot,
      )
      if (!addRes.ok) {
        const findings = [`Worktree creation failed: ${addRes.stderr || addRes.stdout}`]
        return finishFail(teamId, branch, sourceSuggestionId, findings, 'worktree-add-failed', 0)
      }
      // Task 37 — bridge node_modules so vitest/eslint resolve. Result
      // is stashed and surfaced in the verdict findings when the run
      // is also tagged tooling-missing (see emission below).
      bridgeResult = bridgeNodeModulesIntoWorktree(deps.projectRoot, worktreePath, npmStrategy)
      if (!bridgeResult.linked && bridgeResult.reason !== 'strategy-none') {
        log.warn(
          {
            teamId,
            worktreePath,
            reason: bridgeResult.reason,
            missing: bridgeResult.missing,
            binDirRealpath: bridgeResult.binDirRealpath,
            error: bridgeResult.error,
          },
          'qg: worktree node_modules bridge did not link',
        )
      }
      // Phase 13.12.32 — emit a structured worktree_provisioning event
      // so operators and the brain can audit what the bridge actually
      // did. Wrap in try/catch: observability MUST NOT gate-fail. The
      // failure modes we care about (BridgeResult.reason !== 'symlinked'
      // / 'copied') are already captured in the payload itself.
      try {
        const missingArr = bridgeResult.missing ?? []
        const fallbackAttempted = bridgeFallbackAttempted(bridgeResult.reason)
        deps.eventLog.worktreeProvisioning(null, {
          team_id: teamId,
          worktreePath,
          npmStrategy,
          linked: bridgeResult.linked,
          reason: bridgeResult.reason,
          missing: missingArr,
          vitestResolved: bridgeResult.linked && !missingArr.includes('vitest'),
          eslintResolved: bridgeResult.linked && !missingArr.includes('eslint'),
          fallbackAttempted,
          fallbackOk: bridgeResult.reason === 'copied',
          binDirRealpath: bridgeResult.binDirRealpath ?? null,
          error: bridgeResult.error ?? null,
        })
      } catch (eventErr) {
        log.warn(
          {
            teamId,
            worktreePath,
            err: (eventErr as Error).message,
          },
          'qg: failed to emit worktree_provisioning event (non-fatal)',
        )
      }
    } catch (err) {
      const findings = [`Worktree setup threw: ${(err as Error).message}`]
      return finishFail(teamId, branch, sourceSuggestionId, findings, 'worktree-setup-threw', 0)
    }

    try {
      // 2) Apply diff into worktree index. Ensure path exists; in the real
      // git flow `git worktree add` creates it, but injected test runners
      // may mock that step.
      if (!existsSync(worktreePath)) {
        mkdirSync(worktreePath, { recursive: true })
      }
      // Keep the diff file OUTSIDE the worktree so `git add -A` below does
      // not accidentally commit it alongside the real artifact.
      const diffPath = join(wtParent, 'staged.diff')
      writeFileSync(diffPath, data.stagedDiff, 'utf-8')
      const applyRes = run(`git apply --index ${quotePath(diffPath)}`, worktreePath)
      if (!applyRes.ok) {
        const findings = [`git apply failed: ${applyRes.stderr || applyRes.stdout}`]
        return finishFail(
          teamId,
          branch,
          sourceSuggestionId,
          findings,
          'diff-apply-failed',
          0,
          worktreePath,
        )
      }

      // 3) Run build, tests and lint in worktree (optionally skipped).
      // Task 39: `npm run build` MUST precede `npm test` / `npm run lint`
      // because the test suite execs the compiled `dist/cli.js`. Without
      // a build step the worktree has no dist/, and every CLI-spawning
      // test errors with MODULE_NOT_FOUND — see postmortem
      // qc=4f7e7f48-0a9f-465d-b5dc-59984e557d6b.
      //
      // Phase 13.12.31 — split build-failure classification (rubber-duck
      // critique): only the tooling-missing case (exit 126/127 = shell
      // could not locate `tsc`/the build script) is classified as
      // `tooling-missing` with score=1.0. An ordinary compilation failure
      // is the developer's regression, NOT an infrastructure problem, so
      // it is surfaced as `reason='build-failed'` with score=0 — that
      // way operators see a real failure signal instead of a misleading
      // "blame the gate, not the dev" outcome.
      let buildRes: RunResult = { ok: true, stdout: '', stderr: '' }
      let testRes: RunResult = { ok: true, stdout: '', stderr: '' }
      let lintRes: RunResult = { ok: true, stdout: '', stderr: '' }

      // G2 (scns#36 handoff) — a project without a package.json (a content
      // repo like Cosmere_RPG) cannot run npm build/test/lint at all. Running
      // them anyway produced the byte-identical environmental failure that
      // gate-failed 229/230 attempts on the Cosmere child: reproduced 1:1,
      // `npm run build --silent` with no package.json anywhere up the tree
      // exits 254, and `--silent` suppresses npm's own error report, hence
      // `Build failed in worktree (exit 254): no stderr` on every diff (with
      // a package.json higher up the tree npm instead reports a missing
      // script — the stray exit-1 events). The worktree is checked AFTER
      // the staged diff is applied, so a diff that introduces package.json
      // is still built. Non-npm diffs are judged by the remaining gates
      // (rubric / claim-evidence / redundancy / kernel+symlink guards).
      const npmProject = existsSync(join(worktreePath, 'package.json'))
      if (!npmProject && !deps.skipCommands) {
        log.info(
          { teamId, worktreePath },
          'qg: no package.json in worktree — non-npm project, skipping npm build/test/lint',
        )
      }

      // F2 — a diff that removes gate scripts HEAD defined (build/test/lint,
      // or package.json itself) FAILS before the npm steps run: with
      // `--if-present` the lost step would silently skip and the diff would
      // never be compiled or tested. John-approved hardening (2026-08-14).
      // [] on content repos (HEAD had no package.json — the intended G2
      // weakening), so Cosmere-shaped projects are untouched.
      const lostScriptFindings = deps.skipCommands ? [] : detectLostNpmScripts(run, worktreePath)
      if (lostScriptFindings.length > 0) {
        return finishFail(
          teamId,
          branch,
          sourceSuggestionId,
          lostScriptFindings,
          'gate-scripts-removed',
          0,
          worktreePath,
        )
      }

      // Phase 13.12.24 — compute baselines against projectRoot (still at
      // HEAD; the staged diff lives only in the worktree). A non-npm
      // project skips these too: they are the same npm scripts, run at the
      // projectRoot, and would fail with the same ENOENT shape.
      let baselineLint: LintStats = EMPTY_LINT_STATS
      let baselineFailingTests: Set<string> = new Set()
      const baselinesActive =
        !deps.skipCommands && npmProject && (baselineLintEnabled || baselineTestsEnabled)
      if (baselinesActive) {
        const bl = await computeBaselines()
        baselineLint = bl.lint
        baselineFailingTests = bl.tests
      }

      if (!deps.skipCommands && npmProject) {
        // `--if-present` — a package.json without a "build" script is a
        // legitimate project shape, not a dev regression; without the flag
        // npm exits non-zero ("Missing script: build") and the gate would
        // burn the attempt environmentally, same failure family as the
        // exit-254 ENOENT above.
        buildRes = await runAsync('npm run build --silent --if-present', worktreePath, {
          timeoutMs: 300_000,
        })
        if (!buildRes.ok) {
          // Short-circuit: skip test/lint entirely so a build failure
          // does not inflate newLintErrors/regressedFiles or fall
          // through to the generic 'npm test failed' branch.
          let buildOutput = [
            '=== npm run build (exit ' + (buildRes as RunErr).code + ') ===',
            buildRes.stdout,
            buildRes.stderr,
          ].join('\n')
          // tsc writes its diagnostics to STDOUT — a stderr-only quote
          // rendered every real compile failure as "no stderr". Prefer the
          // first non-empty stderr line, fall back to stdout.
          const firstLine = (out: string): string | undefined =>
            out
              .split('\n')
              .find((l) => l.trim().length > 0)
              ?.trim()
              ?.slice(0, 200)
          let diagnostic = firstLine(buildRes.stderr || '') ?? firstLine(buildRes.stdout || '')
          // `--silent` (npm loglevel silent) suppresses npm's OWN error report, so an
          // npm-level failure (EJSONPARSE in a diffed package.json, bad workspace config,
          // …) exits non-zero with ZERO bytes on both streams. Every such verdict read
          // "no output captured" and was undiagnosable — 10+ occurrences 2026-09-12..09-28
          // burned whole retry budgets with no actionable finding. Re-run once WITHOUT
          // --silent purely to harvest npm's report: an npm-level error fails before the
          // build script starts, so the probe is cheap, and a real compile failure never
          // lands here (tsc writes its diagnostics to stdout, so `diagnostic` is set).
          if (diagnostic === undefined) {
            const probe = await runAsync('npm run build --if-present', worktreePath, {
              timeoutMs: 90_000,
            })
            const probeLine = firstLine(probe.stderr || '') ?? firstLine(probe.stdout || '')
            if (probeLine !== undefined) {
              diagnostic = `${probeLine} [from diagnostic re-run without --silent]`
              buildOutput += [
                '',
                '=== diagnostic re-run: npm run build --if-present (exit ' +
                  (probe.ok ? 0 : (probe as RunErr).code) +
                  ') ===',
                probe.stdout,
                probe.stderr,
              ].join('\n')
            }
          }
          diagnostic ??= 'no output captured'
          // tooling-missing iff the shell literally could not run the
          // build script (exit 126/127); otherwise this is a real
          // regression introduced by the dev's diff.
          const buildToolingMissing = isCommandMissing(buildRes)
          const reason = buildToolingMissing ? 'tooling-missing' : 'build-failed'
          const score = buildToolingMissing ? 1.0 : 0
          const findings = [
            `Build failed in worktree (exit ${(buildRes as RunErr).code}): ${diagnostic}`,
          ]
          return finishFail(
            teamId,
            branch,
            sourceSuggestionId,
            findings,
            reason,
            score,
            worktreePath,
            buildOutput,
          )
        }
        testRes = await runAsync('npm test --silent --if-present', worktreePath, {
          timeoutMs: 600_000,
        })
        const lintCmd =
          baselineLintEnabled && baselineLint.parsed
            ? 'npm run lint --silent --if-present -- --format json'
            : 'npm run lint --silent --if-present'
        lintRes = await runAsync(lintCmd, worktreePath, { timeoutMs: 180_000 })
      }

      // The per-command sections are emitted ONLY when the npm steps actually
      // ran — a skipped run must not persist "=== npm … (exit 0) ===" banners
      // that read as build/test/lint having run and succeeded (Copilot review
      // on PR #38). Skips announce themselves explicitly instead.
      const npmStepsRan = !deps.skipCommands && npmProject
      const combinedOutput = (
        npmStepsRan
          ? [
              '=== npm run build (exit ' + (buildRes.ok ? 0 : (buildRes as RunErr).code) + ') ===',
              buildRes.stdout,
              buildRes.stderr,
              '=== npm test (exit ' + (testRes.ok ? 0 : (testRes as RunErr).code) + ') ===',
              testRes.stdout,
              testRes.stderr,
              '=== npm run lint (exit ' + (lintRes.ok ? 0 : (lintRes as RunErr).code) + ') ===',
              lintRes.stdout,
              lintRes.stderr,
            ]
          : [
              deps.skipCommands
                ? '=== build/test/lint skipped (skipCommands) ==='
                : '=== non-npm project (no package.json in worktree): build/test/lint skipped ===',
            ]
      ).join('\n')

      // 4) Rubric evaluation (advisory — only used to collect findings).
      const rubricResult = evaluateRubric(clipOutput(combinedOutput, maxBytes), 'implementation')

      // Phase 13.12.24 — diff lint against baseline. Fall back to the
      // legacy exit-code gate whenever either side fails to parse so we
      // never silently lower the bar.
      let lintFailed = !lintRes.ok
      let postLintStats: LintStats = EMPTY_LINT_STATS
      let newLintErrors = 0
      const regressedLintFiles: string[] = []
      if (baselineLintEnabled && !deps.skipCommands) {
        postLintStats = parseEslintJson(lintRes.stdout || '')
        if (baselineLint.parsed && postLintStats.parsed) {
          newLintErrors = Math.max(0, postLintStats.total - baselineLint.total)
          for (const [file, count] of Object.entries(postLintStats.byFile)) {
            const base = baselineLint.byFile[file] ?? 0
            if (count > base) regressedLintFiles.push(file)
          }
          lintFailed = newLintErrors > 0
        }
      }

      // Phase 13.12.24 — diff failing tests against baseline.
      let testFailed = !testRes.ok
      const postFailingTests =
        baselineTestsEnabled && !deps.skipCommands
          ? parseFailingTests((testRes.stdout || '') + '\n' + (testRes.stderr || ''))
          : new Set<string>()
      const newFailingTests = baselineTestsEnabled
        ? subtractSets(postFailingTests, baselineFailingTests)
        : []
      if (baselineTestsEnabled && !deps.skipCommands) {
        if (postFailingTests.size === 0 && !testRes.ok) {
          // Exit non-zero but no FAIL lines — likely a crash. Keep legacy fail.
          testFailed = true
        } else {
          testFailed = newFailingTests.length > 0
        }
      }

      // Phase 13.12.27 — when both baselines are active and the diffs are
      // authoritatively zero, force testFailed/lintFailed to false
      // regardless of raw exit codes. This prevents the legacy
      // "exit != 0 → FAIL" fallback (crash-shape test runs, non-parsing
      // lint output in the worktree because it has no node_modules) from
      // leaking literal "npm test failed" / "npm run lint failed"
      // findings into a verdict that is, by diff semantics, clean.
      // See HANDOFF-13-12-27 for the 9872e17a repro.
      //
      // Guard: require the BASELINE (not post) to have parsed. Post-side
      // parse failure is expected in the worktree (no node_modules) — in
      // that case newLintErrors stays at its zero init, which we treat as
      // "no regression detected". But if the baseline itself failed to
      // parse we never measured a starting point, so distrust and fall
      // back to the legacy gate.
      const baselineParsed = !baselineLintEnabled || baselineLint.parsed
      // Phase 13.12.28 — test/lint FLOOR. The 13.12.27 override
      // (baselineClean) was too permissive: when the worktree-side
      // command itself could not run (exit 127 / 126 / ENOENT / shell
      // "command not found"), there was no parseable post output, so
      // newLintErrors stayed 0 and newFailingTests stayed empty, which
      // silently flipped a tooling-failure into PASS. See the
      // quality_check rows with task_type='team:...' that recorded
      // passed=1 score=1.0 with output "vitest: command not found /
      // eslint: command not found" — exactly the case this guards.
      //
      // Distinguisher: a missing command is a different signal from
      // "ran but produced no FAIL lines". We never override the
      // exit-code gate when the runner could not be located.
      const postLintMissing = isCommandMissing(lintRes)
      const postTestMissing = isCommandMissing(testRes)
      const postCommandsRan = !postLintMissing && !postTestMissing
      const baselineClean =
        baselinesActive &&
        baselineParsed &&
        postCommandsRan &&
        newLintErrors === 0 &&
        newFailingTests.length === 0
      if (baselineClean) {
        testFailed = false
        lintFailed = false
      }

      if (baselinesActive) {
        log.info(
          {
            teamId,
            baselineLint: baselineLint.total,
            postLint: postLintStats.total,
            newLintErrors,
            baselineFailingTests: baselineFailingTests.size,
            postFailingTests: postFailingTests.size,
            newFailingTests: newFailingTests.length,
          },
          'qg: baseline-diff summary',
        )
      }

      const rubricFailed = !rubricResult.passed
      // Phase 13.12.24 — when the baseline gates swallow lint/test noise,
      // the rubric's mirror findings ("Test failures detected in output",
      // "Lint errors detected in output") are false positives. Filter
      // them out so they don't re-fail a baseline-PASS verdict.
      // Phase 13.12.25 — match the exact finding strings emitted by
      // quality-checker rules (not a loose substring regex) so a future
      // legitimate finding that happens to mention "lint" or "test failure"
      // is not silently swallowed.
      const RUBRIC_TEST_FAILURE = 'Test failures detected in output'
      const RUBRIC_LINT_FAILURE = 'Lint errors detected in output'
      const effectiveRubricFindings = rubricResult.findings.filter((f) => {
        if (baselineTestsEnabled && !testFailed && f === RUBRIC_TEST_FAILURE) return false
        if (baselineLintEnabled && !lintFailed && f === RUBRIC_LINT_FAILURE) return false
        return true
      })
      const effectiveRubricFailed = rubricFailed && effectiveRubricFindings.length > 0

      if (testFailed || lintFailed || effectiveRubricFailed) {
        const findings: string[] = []
        // Task 37 — when the bridge could not resolve required binaries
        // (reason='tooling-unresolved') OR the bridge fell back to copy
        // AND tooling is still reporting missing at runtime, prepend a
        // structured diagnostic that names the missing binaries and the
        // bin dir realpath. Without this line, operators only see the
        // generic "X runner missing in worktree" — they have no signal
        // as to whether the bridge attempted recovery (qc=13ab2fb7,
        // qc=394de9bb).
        if (bridgeResult) {
          const r = bridgeResult.reason
          const toolingFloorTripped = postTestMissing || postLintMissing
          const shouldEmit = bridgeNeedsDiagnostic(r, toolingFloorTripped)
          if (shouldEmit) {
            const missingList =
              bridgeResult.missing && bridgeResult.missing.length > 0
                ? bridgeResult.missing.join(',')
                : 'unknown'
            const realpath = bridgeResult.binDirRealpath ?? 'null'
            const cause = bridgeResult.error ? `, cause=${bridgeResult.error}` : ''
            findings.push(
              `node_modules bridge failed (reason=${r}, missing=${missingList}, realpath=${realpath}${cause})`,
            )
          }
        }
        if (testFailed) {
          if (postTestMissing) {
            // Phase 13.12.28 — surface the tooling-floor diagnosis so
            // operators see the actionable cause (missing binary in
            // worktree) instead of the generic "npm test failed".
            const snippet = ((testRes as { stderr?: string }).stderr ?? '')
              .split('\n')[0]
              ?.trim()
              ?.slice(0, 200)
            findings.push(
              `Test runner missing in worktree (exit ${(testRes as { code?: number }).code ?? '?'}): ${snippet || 'command not found'}`,
            )
          } else if (newFailingTests.length > 0) {
            findings.push(
              `Tests regressed: ${newFailingTests.length} new failure(s) in ${summarizeFiles(newFailingTests)}`,
            )
          } else {
            findings.push('npm test failed')
          }
        }
        if (lintFailed) {
          if (postLintMissing) {
            const snippet = ((lintRes as { stderr?: string }).stderr ?? '')
              .split('\n')[0]
              ?.trim()
              ?.slice(0, 200)
            findings.push(
              `Lint runner missing in worktree (exit ${(lintRes as { code?: number }).code ?? '?'}): ${snippet || 'command not found'}`,
            )
          } else if (newLintErrors > 0) {
            findings.push(
              `Lint regressed: +${newLintErrors} new error(s) in ${summarizeFiles(regressedLintFiles)}`,
            )
          } else {
            findings.push('npm run lint failed')
          }
        }
        if (effectiveRubricFailed) findings.push(...effectiveRubricFindings)
        const reason =
          postTestMissing || postLintMissing
            ? 'tooling-missing'
            : testFailed
              ? 'tests-failed'
              : lintFailed
                ? 'lint-failed'
                : 'rubric-failed'
        return finishFail(
          teamId,
          branch,
          sourceSuggestionId,
          findings,
          reason,
          rubricResult.score,
          worktreePath,
          combinedOutput,
          {
            baselineLint: baselineLint.total,
            postLint: postLintStats.total,
            newLintErrors,
            regressedFiles: regressedLintFiles,
          },
        )
      }

      // 5) PASS — commit on the new branch inside the worktree, then
      // remove the worktree (branch persists).
      const commitMsg = buildCommitMessage(teamId, sourceSuggestionId)
      const msgFile = join(wtParent!, 'commit-msg.txt')
      writeFileSync(msgFile, commitMsg, 'utf-8')

      // Phase 13.12.34 — exclude node_modules and .git/info/exclude from the
      // auto-commit. `bridgeNodeModulesIntoWorktree` (line 414) creates a
      // symlink at <worktree>/node_modules pointing at the host node_modules
      // for tooling resolution. Pre-fix, `git add -A` swept that symlink
      // into the staged diff; the resulting branch shipped a 120000-mode
      // entry pointing at an absolute host path (e.g. `/Users/<dev>/...`),
      // which is poison for any consumer of the branch. The pathspec form
      // `:!pattern` is a magic prefix understood by git to exclude
      // matching paths from the operation.
      // Double quotes, not single: on win32 the shell is cmd.exe, which passes
      // single quotes through to git verbatim and the add fails outright.
      const addAll = run('git add -A . ":!node_modules" ":!.git/info/exclude"', worktreePath)
      if (!addAll.ok) {
        const findings = [`git add -A failed: ${addAll.stderr || addAll.stdout}`]
        return finishFail(
          teamId,
          branch,
          sourceSuggestionId,
          findings,
          'git-add-failed',
          rubricResult.score,
          worktreePath,
          combinedOutput,
        )
      }

      // Phase 13.12.34 — defense-in-depth: even with the pathspec exclusion
      // above, a symlink committed by an upstream agent (or a future
      // pathspec slip) is fatal to the branch. Inspect the staged index
      // and reject the commit if ANY entry has mode 120000 (symlink).
      // `git ls-files --stage` emits one line per staged entry as
      // `<mode> <sha> <stage>\t<path>`.
      const stagedSymlinks = detectStagedSymlinks(run, worktreePath)
      if (stagedSymlinks.length > 0) {
        const findings = [
          `Staged symlinks detected — refusing to commit poison-pill branch: ${stagedSymlinks.slice(0, 5).join(', ')}${stagedSymlinks.length > 5 ? ` (+${stagedSymlinks.length - 5} more)` : ''}`,
        ]
        return finishFail(
          teamId,
          branch,
          sourceSuggestionId,
          findings,
          'staged-symlinks',
          rubricResult.score,
          worktreePath,
          combinedOutput,
        )
      }

      // WS-0 Gate 3 — kernel-self-edit reject (pre-commit, no override).
      // The immutable safety kernel + its human-owned allowlist can never be
      // changed by an autonomous branch. This is defense-in-depth above the
      // auto-merger's absolute `no-safety-kernel-edit` gate: reject here, at
      // QG time, so a kernel-weakening diff never even reaches a verdict-PASS.
      const kernelEdits = detectStagedKernelEdits(run, worktreePath)
      if (kernelEdits.length > 0) {
        const findings = [
          `Branch edits the immutable safety kernel — requires human approval, ` +
            `refusing to commit: ${kernelEdits.slice(0, 5).join(', ')}` +
            (kernelEdits.length > 5 ? ` (+${kernelEdits.length - 5} more)` : ''),
        ]
        return finishFail(
          teamId,
          branch,
          sourceSuggestionId,
          findings,
          'kernel-self-edit',
          rubricResult.score,
          worktreePath,
          combinedOutput,
        )
      }

      // Phase 13.12.34 — guard the negative-memories block in
      // .github/copilot-instructions.md. If HEAD had a non-empty managed
      // block and the staged version would erase it, abort the commit.
      // Postmortem: team ca3ecfec's verdict-PASS branches stripped all
      // five learned guardrail rules; the applicator fix prevents the
      // source, this gate prevents anything else from doing it.
      const negMemCheck = checkNegativeMemoriesPreserved(run, worktreePath)
      if (!negMemCheck.ok) {
        const findings = [negMemCheck.finding]
        return finishFail(
          teamId,
          branch,
          sourceSuggestionId,
          findings,
          'negative-memories-removed',
          rubricResult.score,
          worktreePath,
          combinedOutput,
        )
      }

      // Phase 1 wedge A — behavioral-improvement gate (additive, default-OFF).
      // Evaluated ONLY here on the rubric-PASS branch, so it can only DOWNGRADE
      // PASS→FAIL on a measured regression — never upgrade FAIL→PASS. With the env
      // opt-ins unset this whole block is inert: no backend is constructed, no
      // replay runs, and no behavioral fields are attached to the verdict/event.
      const behavioralMode = resolveBehavioralGateMode(behavioralEnv())
      let behavioralResult: BehavioralGateResult | null = null
      if (behavioralMode.measure) {
        behavioralResult = await computeBehavioralResult(teamId, worktreePath)
        if (behavioralResult?.regressed && behavioralMode.enforce) {
          const findings = [
            `Behavioral regression on held-out set: candidate ` +
              `${behavioralResult.candidateScore.toFixed(4)} < baseline ` +
              `${behavioralResult.baselineScore.toFixed(4)} ` +
              `(delta ${behavioralResult.delta.toFixed(4)}, eps ${behavioralResult.epsilon})`,
          ]
          return finishFail(
            teamId,
            branch,
            sourceSuggestionId,
            findings,
            'behavioral-regression',
            rubricResult.score,
            worktreePath,
            combinedOutput,
          )
        }
      }

      // Track 1 / 1B — claim-evidence verifier on the code-PASS output (measure
      // default-ON). Records the verdict for every PASS; only DOWNGRADES
      // PASS→FAIL when SCNS_QG_CLAIM_ENFORCE=1 (go-live gated), so by default it
      // is advisory and never upgrades a FAIL.
      const claimMode = claimVerifierMode()
      let claimResult: VerifierVerdict | null = null
      let claimReverifyResult: ClaimReverifyVerdict | null = null
      if (claimMode.measure) {
        claimResult = verifyClaimEvidence(combinedOutput)
        // Producer≠verifier deep check: when spawn is enabled + a backend is
        // wired + the pre-filter found ≥1 claim, the independent re-run GOVERNS
        // the enforce decision (the deterministic core is the pre-filter).
        claimReverifyResult =
          claimMode.spawn && claimResult.claims.length > 0
            ? await computeClaimReverify(teamId, combinedOutput, claimResult.claims)
            : null
        const govKind = claimReverifyResult ? claimReverifyResult.verdict : claimResult.kind
        if (govKind !== 'pass' && claimMode.enforce) {
          const findings = claimReverifyResult ? claimReverifyResult.findings : claimResult.findings
          return finishFail(
            teamId,
            branch,
            sourceSuggestionId,
            findings,
            `${claimReverifyResult ? 'claim-reverify' : 'claim-verifier'}:${govKind}`,
            rubricResult.score,
            worktreePath,
            combinedOutput,
          )
        }
      }

      // Track 1 — anti-redundant-build hook (Dev-default-ON). Scan the agent's
      // OWN output explanation for redundancy signals; a tripped flag with no
      // addressing explanation hard-FAILS the gate so the addressing explanation
      // (what existing code was reused / why the new code is distinct) is forced
      // into the final output before this can ship. NON-RECURSIVE: one
      // deterministic pass + at most one single-shot model spawn (only when the
      // scanner trips); the model's output is never re-scanned.
      const redundancyMode = redundancyVerifierMode()
      if (redundancyMode.scan) {
        const agentOutput = analysisOutputFromLogs(data.logs)
        const core = evaluateRedundancy(agentOutput)
        if (core.verdict !== 'pass') {
          // Deterministic scanner tripped. Consult the independent model ONLY
          // now (bounded cost). It GOVERNS: it may clear a false positive (pass)
          // or confirm the duplicate (fail); a degrade stays needs-explanation.
          const model =
            redundancyMode.spawn && deps.redundancyVerifier?.makeVerifierBackend
              ? await computeRedundancyVerdict(teamId, agentOutput, core.flags)
              : null
          const govKind = model ? model.verdict : 'needs-explanation'
          if (govKind !== 'pass') {
            const findings =
              model && model.findings.length > 0 ? model.findings : [...core.findings]
            return finishFail(
              teamId,
              branch,
              sourceSuggestionId,
              findings,
              `redundancy-unexplained:${govKind}`,
              rubricResult.score,
              worktreePath,
              combinedOutput,
            )
          }
        }
      }

      const commitRes = run(
        `git -c user.name=scns-auto -c user.email=scns-auto@localhost commit -F ${JSON.stringify(msgFile)}`,
        worktreePath,
      )
      if (!commitRes.ok) {
        const findings = [`git commit failed: ${commitRes.stderr || commitRes.stdout}`]
        return finishFail(
          teamId,
          branch,
          sourceSuggestionId,
          findings,
          'git-commit-failed',
          rubricResult.score,
          worktreePath,
          combinedOutput,
        )
      }

      // Worktree removal keeps the branch around in the main repo.
      run(`git worktree remove --force ${quotePath(worktreePath)}`, deps.projectRoot)

      applyArtifact(sourceSuggestionId)

      const qualityCheckId = persistVerdict(teamId, true, rubricResult.score, [], combinedOutput)
      approveSuggestion(sourceSuggestionId, 'qg-pass')
      emitOutcome(teamId, sourceSuggestionId, true, rubricResult.score)
      // Phase 13.12.25 — include baseline diagnostics on the PASS path too
      // (the FAIL path already carries them). Consumers like the dashboard
      // drift-analytics card need parity.
      const passBaselinePayload = baselinesActive
        ? {
            baselineLint: baselineLint.total,
            postLint: postLintStats.total,
            newLintErrors,
            regressedFiles: regressedLintFiles,
          }
        : {}
      const behavioralPayload = behavioralResult
        ? {
            behavioralRan: behavioralResult.ran,
            behavioralRegressed: behavioralResult.regressed,
            behavioralDelta: behavioralResult.delta,
            behavioralBaselineScore: behavioralResult.baselineScore,
            behavioralCandidateScore: behavioralResult.candidateScore,
          }
        : {}
      const claimVerifierPayload = claimResult
        ? {
            claimVerifierKind: claimResult.kind,
            claimVerifierClaimCount: claimResult.claims.length,
            ...(claimReverifyResult
              ? {
                  claimReverifyKind: claimReverifyResult.verdict,
                  ...(claimReverifyResult.degradedReason
                    ? { claimReverifyDegraded: claimReverifyResult.degradedReason }
                    : {}),
                }
              : {}),
          }
        : {}
      deps.eventLog.qualityGateVerdict(null, {
        team_id: teamId,
        passed: true,
        reason: baselineClean ? 'baseline-clean' : 'ok',
        score: rubricResult.score,
        findings: [],
        branch,
        sourceSuggestionId,
        qualityCheckId,
        ...passBaselinePayload,
        ...behavioralPayload,
        ...claimVerifierPayload,
      })
      log.info(
        {
          teamId,
          branch,
          score: rubricResult.score,
          reason: baselineClean ? 'baseline-clean' : 'ok',
        },
        'Quality gate PASS — branch committed',
      )

      return {
        teamId,
        passed: true,
        reason: baselineClean ? 'baseline-clean' : 'ok',
        score: rubricResult.score,
        findings: [],
        branch,
        sourceSuggestionId,
        qualityCheckId,
        ...(behavioralResult ? { behavioral: behavioralResult } : {}),
        ...(claimResult
          ? {
              claimVerifier: {
                kind: claimResult.kind,
                claimCount: claimResult.claims.length,
                findings: claimResult.findings,
              },
            }
          : {}),
        ...(claimReverifyResult
          ? {
              claimReverify: {
                verdict: claimReverifyResult.verdict,
                findings: claimReverifyResult.findings,
                perClaimCount: claimReverifyResult.perClaim.length,
                ...(claimReverifyResult.degradedReason
                  ? { degradedReason: claimReverifyResult.degradedReason }
                  : {}),
              },
            }
          : {}),
      }
    } finally {
      for (const p of cleanupPaths) {
        try {
          if (existsSync(p)) rmSync(p, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
    }
  }

  function finishFail(
    teamId: string,
    branch: string,
    sourceSuggestionId: string | null,
    findings: readonly string[],
    reason: string,
    score: number,
    worktreePath?: string,
    output = '',
    baselinePayload?: {
      baselineLint: number
      postLint: number
      newLintErrors: number
      regressedFiles: readonly string[]
    },
  ): ArbiterVerdict {
    if (worktreePath) {
      run(`git worktree remove --force ${quotePath(worktreePath)}`, deps.projectRoot)
    }
    run(`git branch -D ${branch}`, deps.projectRoot)

    const qualityCheckId = persistVerdict(teamId, false, score, findings, output)
    recordNegativeMemory(teamId, findings, output || findings.join('; '))
    recordGateFailure(sourceSuggestionId, `qg-fail:${reason}`)
    emitOutcome(teamId, sourceSuggestionId, false, score)

    deps.eventLog.qualityGateVerdict(null, {
      team_id: teamId,
      passed: false,
      reason,
      score,
      findings,
      branch: null,
      sourceSuggestionId,
      qualityCheckId,
      ...(baselinePayload ?? {}),
    })

    log.info({ teamId, reason, findings }, 'Quality gate FAIL')

    return {
      teamId,
      passed: false,
      reason,
      score,
      findings,
      branch: null,
      sourceSuggestionId,
      qualityCheckId,
    }
  }

  function buildCommitMessage(teamId: string, sourceSuggestionId: string | null): string {
    const summary = sourceSuggestionId
      ? `feat: apply auto-approved suggestion ${sourceSuggestionId}`
      : `feat: apply team ${teamId} artifact`
    return `${summary}\n\nAuto-committed by SCNS quality gate (team=${teamId}).\n\n${COMMIT_TRAILER}\n`
  }

  return {
    handleTeamCompletion,
    stop() {
      unsubscribe()
    },
  }
}
