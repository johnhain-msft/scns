/**
 * Brain Agent main loop — the daemon that wakes, observes, decides, and acts.
 * All side-effectful dependencies are injected for testability.
 */

import { logger } from '../shared/logger.js'
import {
  BrainAction,
  DecisionPriority,
  type BrainState,
  type Decision,
  type OtelMetricsSummary,
  type PendingTask,
} from './state-types.js'
import type { createTaskClassifier } from './classifier.js'
import type { createDecisionTree } from './decision-tree.js'
import type { createTemplateEngine } from './templates.js'
import type { createHealthMonitor } from '../context/health-monitor.js'
import type { createTaskQueue } from './task-queue.js'
import { selfIssueTeamId } from './self-issue-tracker.js'
import type { DetectedPatterns } from '../observe/pattern-detector.js'
import type { ExtractedPatterns } from '../otel/pattern-extractor.js'
import { isDirectArtifactType, type EscalationKind, type Suggestion } from '../suggest/types.js'
import { promoteSuggestions } from './suggestion-promoter.js'

// ── Types ────────────────────────────────────────────────────────────

export interface BrainAgentOptions {
  readonly intervalMs?: number
  readonly autonomyLevel?: number
  readonly maxConcurrentSessions?: number
  readonly yieldToUser?: boolean
  readonly contextRotationThreshold?: number
  readonly consolidationThresholdHours?: number
  /**
   * Minimum confidence for auto-approving a `pending` suggestion at L2+.
   * Sourced from `SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD` (cli.ts). When omitted,
   * the promoter applies its built-in default (0.85).
   */
  readonly autoApproveThreshold?: number
}

export interface BrainAgentDeps {
  readonly classifier: ReturnType<typeof createTaskClassifier>
  readonly decisionTree: ReturnType<typeof createDecisionTree>
  readonly templateEngine: ReturnType<typeof createTemplateEngine>
  readonly healthMonitor: ReturnType<typeof createHealthMonitor>
  readonly taskQueue: ReturnType<typeof createTaskQueue>

  /**
   * Hot-read the current autonomy level at each brain wake().
   * When provided, this takes precedence over `options.autonomyLevel`,
   * enabling runtime promotion/demotion without broker restart.
   * If omitted, the fixed `options.autonomyLevel` is used.
   */
  readonly getAutonomyLevel?: () => number

  readonly onSpawnAgent?: (prompt: string, role: string, teamId?: string) => Promise<string>
  /**
   * Bug 2 fix: lease a self-issue signal to the unique team the brain just
   * spawned for it, so a `team_completed` event can be correlated back and the
   * lease survives a broker restart (the in-memory queue does not). No-op when
   * unset (unit tests / minimal deps).
   */
  readonly markSelfIssueInProgress?: (signalKey: string, teamId: string) => void
  readonly onConsolidate?: () => Promise<void>
  readonly onRotateContext?: (sessionId: string) => Promise<void>
  readonly getObservationCount?: () => number
  readonly getActiveSessions?: () => number
  readonly isUserActive?: () => boolean
  readonly getLastConsolidationAge?: () => number
  /**
   * R1 (consolidate-livelock fix): the dream executor's OWN gate check
   * (`dreamDaemon.getStatus().gateCheck.canRun`). When false, the decision
   * tree must not decide Consolidate — the run would only gate-skip while
   * pending tasks starve behind it. Unset ⇒ gate assumed open (the executor
   * remains the authority and still gates its own run).
   */
  readonly canConsolidate?: () => boolean

  readonly observationManager?: {
    getStatus(): { observationCount: number }
  }
  readonly onLearn?: () => Promise<{
    readonly sessionsProcessed: number
    readonly digestsStored: number
    readonly errors: ReadonlyArray<string>
  }>
  readonly getOtelMetrics?: () => OtelMetricsSummary
  readonly suggestionGenerator?: {
    generate(patterns: DetectedPatterns): readonly Suggestion[]
    generateFromAllSources?(
      patterns: DetectedPatterns,
      otelPatterns?: ExtractedPatterns,
    ): readonly Suggestion[]
  }
  readonly getDetectedPatterns?: () => DetectedPatterns | null
  /**
   * Behavioral patterns mined from OTel session telemetry (otel_spans). Feeds
   * the OTel-based suggestion extractors (agentic-workflow, prompt, extension,
   * instruction). Without this the brain emits 0 suggestions because the
   * observation-only path rarely yields actionable patterns in a headless
   * deployment.
   */
  readonly getOtelPatterns?: () => ExtractedPatterns | null
  readonly suggestionStore?: {
    list(filter: { status: string }): readonly Suggestion[]
    updateStatus(
      id: string,
      status: string,
      reason?: string,
      blockedMetadata?: { readonly requiredLevel: number; readonly blockedAt: string },
      opts?: { readonly escalation?: EscalationKind },
    ): void
    /** Phase 13.12.9: executor failure → backoff + optional terminal transition. */
    recordFailure?: (id: string, error: string) => void
    /** Phase 13.12.9: clear backoff/failure tracking (manual retry + auto-reset). */
    clearBackoff?: (id: string) => void
    /**
     * Phase 13.12.20: move to in-progress + persist inflightTeamId so the
     * team_completed event handler can map stagedDiff back to the source
     * suggestion.
     */
    markInProgress?: (id: string, teamId: string) => void
    /** Phase 13.12.20: lookup for the team_completed event handler. */
    get?: (id: string) => Suggestion | null
  }
  readonly suggestionExecutor?: {
    execute(suggestion: Suggestion): {
      success: boolean
      error?: string
      /**
       * Evidence passthrough from the executor's ExecutionResult (step counts and the
       * files actually written). Self-critique reads these via describeExecutorResult —
       * without them the critic saw only "success: true", had nothing to verify, and
       * false-failed every artifact write into an infinite retry loop (the regression
       * that motivated Phase 13.12.24a's unified spawn path; see suggestion 76707c3d).
       */
      stepsCompleted?: number
      stepsTotal?: number
      filesCreated?: readonly string[]
      /**
       * Phase 13.12.1+: if set, agent-loop will move the suggestion to this
       * terminal status instead of leaving it in `approved`. Used for
       * `needs-human` (workflow-type, 13.12.1) and `blocked-autonomy`
       * (RunCommand at L<3, 13.12.2).
       */
      nextStatus?: string
      /**
       * Phase 13.12.2: attached when nextStatus is `blocked-autonomy`; the
       * brain persists this so it can auto-reset the suggestion to
       * `approved` once autonomyLevel >= requiredLevel.
       */
      blockedMetadata?: { readonly requiredLevel: number; readonly blockedAt: string }
    }
  }
  /**
   * Phase 13.9.1: route team-complexity suggestions with non-empty suggestedRoles
   * to a real team spawn instead of the file-writing executor. Caller decides
   * how to allocate the team + members (see cli.ts wiring).
   */
  readonly onSpawnTeam?: (input: {
    readonly suggestionId: string
    readonly goal: string
    readonly roles: readonly string[]
    /**
     * Phase 13.12.20: full suggestion description so the team member
     * prompt has enough context to actually do the work.
     */
    readonly description?: string
  }) => Promise<{ readonly teamId: string; readonly memberSessionIds: readonly string[] }>
  /**
   * Phase 13.9.1: emit a traceable record linking suggestion.id → team.id so
   * the dashboard and downstream consumers can follow the bridge.
   */
  readonly onSuggestionSpawnedTeam?: (input: {
    readonly suggestionId: string
    readonly teamId: string
    readonly timestamp: string
  }) => void
  readonly onQualityCheck?: (sessionId: string) => Promise<{
    readonly passed: boolean
    readonly score: number
    readonly findings: readonly string[]
  }>
  readonly onCreateHandoff?: (
    sessionId: string,
    context: string,
  ) => Promise<{ readonly handoffId: string }>
  readonly getUncheckedCompletedSessions?: () => readonly string[]

  /**
   * Phase 13.12.13: brain-side scaling policy. When configured, the
   * ApprovedSuggestions handler consults this BEFORE routing a suggestion
   * to solo-vs-team — the extractor's `estimatedComplexity` becomes a
   * hint the policy may override based on historical outcomes. Decisions
   * are logged (via recordDecision) for audit + dashboard surfacing, and
   * each completion is fed back through recordOutcome so the policy
   * learns over time.
   */
  readonly scalingPolicy?: {
    decide(input: {
      readonly description: string
      readonly hint: 'solo' | 'team' | 'complex'
      readonly suggestedRoles?: readonly string[]
      readonly sourceSuggestionId?: string
    }): {
      readonly shape: 'solo' | 'team'
      readonly roles: readonly string[]
      readonly reasoning: string
      readonly signature: string
      readonly hintShape: 'solo' | 'team'
      readonly historyCount: number
    }
    recordOutcome(input: {
      readonly signature: string
      readonly shape: 'solo' | 'team'
      readonly success: boolean
      readonly sourceSuggestionId?: string
      readonly teamId?: string
      readonly durationMs?: number
      readonly qualityScore?: number
    }): void
  }

  /**
   * Phase 13.12.14: introspection deps for `GET /api/brain/status`.
   * Optional — when missing, getStatusSnapshot() falls back to nulls.
   */
  readonly getPendingSuggestionCount?: () => number
  readonly getMostRecentDecisionId?: () => number | null

  /**
   * Phase 13.12.19: self-critique hook. After a suggestion executes
   * successfully the brain runs this (if configured) BEFORE marking the
   * suggestion `implemented`. The returned verdict decides the final
   * transition:
   *
   *   - `pass` → updateStatus(implemented) + write sidecar critique file.
   *   - `fail` → recordFailure (with backoff, matches 13.12.9) + critique.
   *   - `needs-evidence` → updateStatus(needs-human, reason) + critique
   *     appended to the suggestion body so the dashboard renders it.
   *
   * When unset, behavior is identical to pre-13.12.19 (direct
   * implemented transition).
   */
  readonly selfCritique?: {
    run(input: {
      readonly suggestion: Suggestion
      readonly teamOutput: string
    }): Promise<import('./self-critique.js').SelfCritiqueVerdict>
    writeCritiqueFile(params: {
      readonly verdict: import('./self-critique.js').SelfCritiqueVerdict
      readonly suggestion: Suggestion
      readonly targetStatus: import('./self-critique.js').CritiqueTargetStatus
    }): string
  }
}

export interface BrainStatusSnapshot {
  readonly state: 'idle' | 'running' | 'deciding' | 'acting' | 'starting'
  readonly lastTickAt: string | null
  readonly ticksToday: number
  readonly currentDecisionId: number | null
  /**
   * Pending SUGGESTIONS, not the brain task queue. Legacy alias of
   * {@link pendingSuggestions} kept because the dashboard reads it; prefer
   * the honest names for new consumers.
   */
  readonly queueDepth: number
  /** R3: the REAL brain task queue depth (`taskQueue.size()`). */
  readonly taskQueueDepth: number
  /** Honest name for what {@link queueDepth} has always counted. */
  readonly pendingSuggestions: number
  readonly autonomy: number
  readonly isWoken: boolean
}

export interface BrainAgentStatus {
  readonly state: 'idle' | 'running' | 'deciding' | 'acting'
  readonly wakeCount: number
  readonly lastWakeTime: string | null
  readonly lastDecision: Decision | null
  readonly queueSize: number
  readonly intervalMs: number
}

// ── Defaults for optional deps ───────────────────────────────────────

const noop = () => {}
const noopAsync = async () => {}
const defaultGetObservationCount = () => 0
const defaultGetActiveSessions = () => 0
const defaultIsUserActive = () => false
const defaultGetLastConsolidationAge = () => 0
const defaultOnSpawnAgent = async (_prompt: string, _role: string, _teamId?: string) =>
  'session-unknown'

/**
 * Phase 13.12.20: after a brain-spawned team has been `in-progress` for
 * this long without emitting `team_completed`, we consider it stalled and
 * roll the source suggestion back to `approved` with a recordFailure for
 * backoff. Exported for test determinism.
 */
export const STALLED_TEAM_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Phase 13.12.19: render an executor result for critique consumption.
 * Keeps the shape stable so the critic agent sees consistent context.
 */
function describeExecutorResult(result: {
  readonly success: boolean
  readonly error?: string
  readonly nextStatus?: string
  readonly stepsCompleted?: number
  readonly stepsTotal?: number
  readonly filesCreated?: readonly string[]
}): string {
  const lines = [`success: ${result.success}`]
  // Hard evidence for the critic: without step counts and written-file paths the
  // critique ran against a bare "success: true", could verify nothing, and
  // false-failed every artifact write (the Phase 13.12.24a regression trigger).
  if (result.stepsTotal !== undefined) {
    lines.push(`steps completed: ${result.stepsCompleted ?? 0}/${result.stepsTotal}`)
  }
  if (result.filesCreated && result.filesCreated.length > 0) {
    lines.push('files written:')
    for (const f of result.filesCreated) lines.push(`  - ${f}`)
  }
  if (result.error) lines.push(`error: ${result.error}`)
  if (result.nextStatus) lines.push(`nextStatus: ${result.nextStatus}`)
  return lines.join('\n')
}

/**
 * Phase 13.12.19: compact single-line critique summary suitable for
 * `lastError` / `reviewReason` fields (stored on the suggestion itself).
 */
function summarizeCritique(v: {
  readonly verdict: string
  readonly findings: readonly string[]
  readonly degradedReason?: string
}): string {
  const tag = v.degradedReason ? `${v.verdict}(${v.degradedReason})` : v.verdict
  const findingsTxt = v.findings.slice(0, 3).join('; ')
  return findingsTxt ? `${tag}: ${findingsTxt}` : tag
}

// ── Factory ──────────────────────────────────────────────────────────

export function createBrainAgent(deps: BrainAgentDeps, options?: BrainAgentOptions) {
  const log = logger.child({ module: 'brain-agent' })

  const explicitIntervalMs = options?.intervalMs
  const fallbackAutonomyLevel = options?.autonomyLevel ?? 0
  const readAutonomyLevel = deps.getAutonomyLevel ?? (() => fallbackAutonomyLevel)

  /**
   * Phase 13.12.5: autonomy-scaled tick interval. L2/L3 wake every 60s for
   * responsive automation; L0/L1 stay at 5min. An explicit options.intervalMs
   * always wins (used by tests and env-var overrides).
   */
  function resolveIntervalMs(levelOverride?: number): number {
    if (explicitIntervalMs !== undefined) return explicitIntervalMs
    const level = levelOverride ?? readAutonomyLevel()
    return level >= 2 ? 60_000 : 300_000
  }

  // Initial intervalMs uses fallback level (not the dep); wake() will refresh
  // it to the autonomy-aware value on first tick. Avoids an extra
  // getAutonomyLevel() call at construction time.
  let intervalMs = resolveIntervalMs(fallbackAutonomyLevel)
  const maxConcurrentSessions = options?.maxConcurrentSessions ?? 3
  const yieldToUser = options?.yieldToUser ?? true
  const contextRotationThreshold = options?.contextRotationThreshold ?? 85
  const consolidationThresholdHours = options?.consolidationThresholdHours ?? 24
  const autoApproveThreshold = options?.autoApproveThreshold

  const onSpawnAgent = deps.onSpawnAgent ?? defaultOnSpawnAgent
  const onConsolidate = deps.onConsolidate ?? noopAsync
  const onRotateContext = deps.onRotateContext ?? noopAsync
  const getObservationCount =
    deps.getObservationCount ??
    (deps.observationManager
      ? () => deps.observationManager!.getStatus().observationCount
      : defaultGetObservationCount)
  const getActiveSessions = deps.getActiveSessions ?? defaultGetActiveSessions
  const isUserActive = deps.isUserActive ?? defaultIsUserActive
  const getLastConsolidationAge = deps.getLastConsolidationAge ?? defaultGetLastConsolidationAge

  let timer: ReturnType<typeof setInterval> | null = null
  let scheduleTimer: ReturnType<typeof setTimeout> | null = null
  let scheduleRunning = false
  let wakeCount = 0
  let lastWakeTime: string | null = null
  let ticksToday = 0
  let ticksTodayDate = new Date().toISOString().slice(0, 10)
  let lastDecision: Decision | null = null
  let currentState: 'idle' | 'running' | 'deciding' | 'acting' = 'idle'
  let wakeInProgress = false
  // Phase 13.12.4: coalesced follow-up wake. requestWake() sets this flag
  // when called while a wake is in-flight; wake()'s finally block kicks off
  // one additional wake if it's set. Multiple concurrent requestWake() calls
  // collapse to a single follow-up (no unbounded stacking).
  let pendingWake = false
  // Phase 13.10.3: Flipped true after first successful wake() completes
  // without throwing. Exposed via isReady() so /api/health can flip the
  // brain component from "starting" → "ready". Stays true for the
  // process lifetime once set (including across stop()/start() cycles).
  let ready = false

  // Suppress unused variable warning for noop
  void noop

  function buildBrainState(autonomyLevel: number): BrainState {
    const stats = deps.healthMonitor.getStats()
    void stats // available for future use; ensures monitor is queried
    const urgentSessions = deps.healthMonitor.getUrgentSessions()
    const maxContextUsage =
      urgentSessions.length > 0 ? Math.max(...urgentSessions.map((s) => s.usagePercent)) : 0

    let otelMetrics: OtelMetricsSummary | undefined
    if (deps.getOtelMetrics) {
      try {
        otelMetrics = deps.getOtelMetrics()
      } catch (err) {
        log.warn({ err }, 'Failed to get OTel metrics')
      }
    }

    let brainPatterns: BrainState['patterns'] = null
    const detected = deps.getDetectedPatterns?.() ?? null
    if (detected?.workSchedule) {
      const currentHour = new Date().getUTCHours()
      brainPatterns = {
        workSchedule: {
          peakHour: detected.workSchedule.peakHour,
          activeHours: detected.workSchedule.activeHours,
        },
        isCurrentlyPeakHours: detected.workSchedule.activeHours.includes(currentHour),
      }
    }

    let approvedSuggestionCount = 0
    if (deps.suggestionStore) {
      try {
        approvedSuggestionCount = deps.suggestionStore.list({ status: 'approved' }).length
      } catch (err) {
        log.warn({ err }, 'Failed to count approved suggestions')
      }
    }

    let pendingQualityChecks = 0
    if (deps.getUncheckedCompletedSessions) {
      try {
        pendingQualityChecks = deps.getUncheckedCompletedSessions().length
      } catch (err) {
        log.warn({ err }, 'Failed to count unchecked sessions')
      }
    }

    // Fail-open: on a throwing gate check the executor's own gate still
    // protects the run; assuming closed would silently disable consolidation.
    let consolidationGateOpen = true
    if (deps.canConsolidate) {
      try {
        consolidationGateOpen = deps.canConsolidate()
      } catch (err) {
        log.warn({ err }, 'canConsolidate check failed — assuming gate open')
      }
    }

    return {
      autonomyLevel,
      userActive: isUserActive(),
      yieldToUser,
      pendingTasks: deps.taskQueue.getAll(),
      activeSessions: getActiveSessions(),
      maxConcurrentSessions,
      contextUsagePercent: maxContextUsage,
      contextRotationThreshold,
      recentObservationCount: getObservationCount(),
      lastConsolidationAge: getLastConsolidationAge(),
      consolidationThreshold: consolidationThresholdHours,
      consolidationGateOpen,
      approvedSuggestionCount,
      pendingQualityChecks,
      otelMetrics,
      patterns: brainPatterns,
    }
  }

  /**
   * Generate suggestions from the available pattern sources. Feeds BOTH
   * observation patterns and OTel session patterns into the generator. OTel
   * patterns are the primary signal in headless deployments; when observation
   * patterns are absent we synthesize a minimal shell so the OTel-based
   * extractors still run. No-op when no generator or no pattern source exists.
   */
  function runSuggestionGeneration(context: string): void {
    const generator = deps.suggestionGenerator
    if (!generator) return

    const otelPatterns = deps.getOtelPatterns?.() ?? null
    let patterns = deps.getDetectedPatterns?.() ?? null

    if (!patterns && otelPatterns) {
      const nowIso = new Date().toISOString()
      patterns = {
        workSchedule: null,
        toolFrequency: null,
        projectFocus: null,
        observationCount: 0,
        windowStart: otelPatterns.analyzedFrom || nowIso,
        windowEnd: otelPatterns.analyzedTo || nowIso,
      }
    }

    if (!patterns) return

    const suggestions = generator.generateFromAllSources
      ? generator.generateFromAllSources(patterns, otelPatterns ?? undefined)
      : generator.generate(patterns)

    log.info(
      {
        count: suggestions.length,
        context,
        otelSessions: otelPatterns?.totalSessions ?? 0,
      },
      'Generated suggestions from patterns',
    )
  }

  async function executeDecision(decision: Decision, autonomyLevel: number): Promise<void> {
    switch (decision.action) {
      case BrainAction.Idle:
        log.debug('Idle — nothing to do')
        // Generate suggestions if patterns are available (L1+ only; L0 is observe-only)
        if (autonomyLevel >= 1) {
          try {
            runSuggestionGeneration('idle')
          } catch (err) {
            log.error({ err }, 'Idle: failed to generate suggestions')
          }
        }
        break

      case BrainAction.Observe: {
        const obsCount = deps.observationManager?.getStatus().observationCount ?? 0

        if (obsCount > 0 && deps.onLearn) {
          log.info({ obsCount }, 'Running learning pipeline on observations')
          try {
            const result = await deps.onLearn()
            log.info(
              {
                sessionsProcessed: result.sessionsProcessed,
                digestsStored: result.digestsStored,
                errors: result.errors.length,
              },
              'Learning pipeline complete',
            )
          } catch (err) {
            log.error({ err }, 'Learning pipeline failed')
          }
        } else if (obsCount === 0) {
          log.info('No new observations to learn from')
        } else {
          log.info({ obsCount }, 'Observations available but no learning callback configured')
        }

        // Generate suggestions from detected patterns (L1+ only; L0 is observe-only)
        if (autonomyLevel >= 1) {
          try {
            runSuggestionGeneration('observe')
          } catch (err) {
            log.error({ err }, 'Failed to generate suggestions')
          }
        }
        break
      }

      case BrainAction.Suggest: {
        log.info('Advisory mode: learning and generating suggestions')
        // Run learning pipeline to process recent observations
        if (deps.onLearn && deps.observationManager) {
          const obsCount = deps.observationManager.getStatus().observationCount
          if (obsCount > 0) {
            try {
              const result = await deps.onLearn()
              log.info(
                {
                  sessionsProcessed: result.sessionsProcessed,
                  digestsStored: result.digestsStored,
                },
                'Suggest: learning pipeline complete',
              )
            } catch (err) {
              log.error({ err }, 'Suggest: learning pipeline failed')
            }
          }
        }
        // Generate suggestions from detected patterns
        try {
          runSuggestionGeneration('suggest')
        } catch (err) {
          log.error({ err }, 'Suggest: failed to generate suggestions')
        }
        break
      }

      case BrainAction.YieldToUser:
        log.info('User active, yielding')
        break

      case BrainAction.Consolidate:
        log.info('Running memory consolidation')
        await onConsolidate()
        break

      case BrainAction.RotateContext: {
        const urgent = deps.healthMonitor.getUrgentSessions()
        if (urgent.length > 0) {
          const sessionId = urgent[0]!.sessionId
          log.info({ sessionId }, 'Rotating context for session')
          await onRotateContext(sessionId)
        }
        break
      }

      case BrainAction.HandleSolo:
      case BrainAction.SpawnSolo: {
        const task = deps.taskQueue.dequeue()
        if (!task) break
        const classification = deps.classifier.classify({ description: task.description })
        const template = deps.templateEngine.selectTemplate(
          classification.subtasks[0]?.role ?? 'implementer',
          { taskDescription: task.description },
        )
        const prompt = deps.templateEngine.render(template.id, {
          taskDescription: task.description,
          role: template.role,
        })
        const role = template.role
        // Bug 2 fix: a self-issue task spawns into a UNIQUE team (not the shared
        // `brain-solo` team) and leases the signal to it, so the team_completed
        // event can be correlated back to exactly this issue.
        let soloTeamId: string | undefined
        if (task.signalKey) {
          soloTeamId = selfIssueTeamId(task.id)
          deps.markSelfIssueInProgress?.(task.signalKey, soloTeamId)
        }
        try {
          await onSpawnAgent(prompt, role, soloTeamId)
        } catch (err) {
          // W4: dequeue() precedes the spawn — a throw here would lose the
          // task outright (promoter tasks have no other recovery path; the
          // stale-lease sweep only recovers self-issue tasks after 90 min).
          const requeued = deps.taskQueue.enqueue(task)
          log.error(
            { err, taskId: task.id, requeued },
            'spawn failed after dequeue — task re-enqueued',
          )
        }
        break
      }

      case BrainAction.SpawnTeam: {
        const task = deps.taskQueue.dequeue()
        if (!task) break
        const classification = deps.classifier.classify({ description: task.description })
        const teamId = task.signalKey ? selfIssueTeamId(task.id) : `team-${task.id}`
        if (task.signalKey) {
          deps.markSelfIssueInProgress?.(task.signalKey, teamId)
        }
        let spawnedMembers = 0
        try {
          for (const subtask of classification.subtasks) {
            const template = deps.templateEngine.selectTemplate(subtask.role, {
              taskDescription: subtask.description,
            })
            const prompt = deps.templateEngine.render(template.id, {
              taskDescription: subtask.description,
              role: subtask.role,
              teamId,
            })
            await onSpawnAgent(prompt, subtask.role, teamId)
            spawnedMembers += 1
          }
        } catch (err) {
          // W4: a task lost after dequeue() is gone for good unless something
          // recovers it. Self-issue tasks hold a durable lease, so after a
          // PARTIAL start we leave recovery to the stale-lease sweep rather
          // than re-enqueue (a second full spawn would duplicate the members
          // already started). Every other task (promoter tasks) has no lease
          // and no sweep — re-enqueue it even after a partial start; a
          // duplicated member is wasted work, a lost task is silent loss.
          const leaseRecoverable = spawnedMembers > 0 && !!task.signalKey
          if (leaseRecoverable) {
            log.error(
              { err, taskId: task.id, teamId, spawnedMembers },
              'team spawn failed after partial start — lease retained, stale-lease sweep will retry',
            )
          } else {
            const requeued = deps.taskQueue.enqueue(task)
            log.error(
              { err, taskId: task.id, teamId, spawnedMembers, requeued },
              'team spawn failed — task re-enqueued',
            )
          }
        }
        break
      }

      case BrainAction.ApprovedSuggestions: {
        if (!deps.suggestionStore || !deps.suggestionExecutor) {
          log.warn('ApprovedSuggestions: store or executor not configured')
          break
        }
        const approved = deps.suggestionStore.list({ status: 'approved' })
        log.info({ count: approved.length }, 'Executing approved suggestions')
        const nowMs = Date.now()
        for (const suggestion of approved) {
          try {
            // Phase 13.12.9: honor exponential backoff — skip items whose
            // next_retry_at hasn't arrived. Logged at debug so it's visible
            // but not noisy.
            if (suggestion.nextRetryAt) {
              const retryAtMs = new Date(suggestion.nextRetryAt).getTime()
              if (Number.isFinite(retryAtMs) && nowMs < retryAtMs) {
                log.debug(
                  {
                    id: suggestion.id,
                    nextRetryAt: suggestion.nextRetryAt,
                    attemptCount: suggestion.attemptCount,
                  },
                  'skipped-retry-backoff',
                )
                continue
              }
            }

            // Phase 13.9.1: route team/complex suggestions with non-empty
            // suggestedRoles to a real team spawn; everything else (solo, or
            // pure artifact-writers like skill/mcp/instruction/github-action)
            // keeps the existing file-writing executor path.
            const rolesFromExtractor = suggestion.suggestedRoles ?? []
            const hint = suggestion.estimatedComplexity ?? 'solo'

            // Phase 13.12.13: consult brain-side scaling policy (if wired).
            // Policy decides solo-vs-team using task signature + historical
            // outcomes; extractor's estimatedComplexity is a hint only.
            let decidedShape: 'solo' | 'team' =
              hint === 'team' || hint === 'complex' ? 'team' : 'solo'
            let decidedRoles: readonly string[] = rolesFromExtractor
            let decisionSignature: string | null = null
            if (deps.scalingPolicy) {
              try {
                const d = deps.scalingPolicy.decide({
                  description: suggestion.title,
                  hint,
                  suggestedRoles: rolesFromExtractor,
                  sourceSuggestionId: suggestion.id,
                })
                decidedShape = d.shape
                decidedRoles = d.roles
                decisionSignature = d.signature
                log.info(
                  {
                    suggestionId: suggestion.id,
                    signature: d.signature,
                    hint: d.hintShape,
                    shape: d.shape,
                    historyCount: d.historyCount,
                    reasoning: d.reasoning,
                  },
                  'brain: scaling-policy decision',
                )
              } catch (err) {
                log.warn(
                  { err, suggestionId: suggestion.id },
                  'scaling-policy.decide threw — falling back to extractor hint',
                )
              }
            }

            const wantsTeam = decidedShape === 'team' && decidedRoles.length > 0

            // Solo direct-artifact types (lsp/instruction/tag-proposal/…) never spawn a
            // repo agent: their artifact lives OUTSIDE the repo, so the spawn →
            // staged-repo-diff → npm-gate roundtrip can only fail — the agent has no
            // legitimate repo diff to stage, and the real write (`applyArtifact`) sits
            // behind a PASS it cannot earn. That dead-end is what cycled approved
            // lsp/instruction/tag-proposal items through gate-fail ×N → gate-exhausted →
            // needs-human → weekly re-ask (observed 2026-09-14..10-05). They take the
            // executor path below instead. Team-shaped work is untouched: analysis teams
            // (scns-researcher) legitimately produce no diff and are judged by the claim
            // verifier, not the npm gate.
            //
            // This narrows Phase 13.12.24a, whose motivation was a critique false-fail
            // loop on the executor's thin "success: true" — addressed now by the evidence
            // passthrough on `suggestionExecutor.execute` (steps + filesCreated), so the
            // critic has something real to verify.
            //
            // Phase 13.12.24a (remainder): solo REPO work still goes through onSpawnTeam
            // (as a team-of-one with `scns-dev`) when the callback is wired, so it gets
            // the same in-progress → team_completed → QG roundtrip as team shape. The
            // executor path also remains the fallback when `onSpawnTeam` isn't wired
            // (unit tests, minimal-deps embeddings).
            const directArtifact = isDirectArtifactType(suggestion.type)
            const wantsSoloAgent = decidedShape === 'solo' && !directArtifact && !!deps.onSpawnTeam
            const soloRoles: readonly string[] = ['scns-dev']

            if ((wantsTeam || wantsSoloAgent) && deps.onSpawnTeam) {
              const spawnRoles = wantsTeam ? decidedRoles : soloRoles
              // Phase 13.12.20: do NOT mark `implemented` until the team
              // actually completes. Flow now:
              //   spawn → in-progress (persist teamId) → wait for
              //   team_completed → self-critique over stagedDiff →
              //   implemented / failed / needs-human.
              // An empty memberSessionIds array means every subprocess
              // launch failed; treat that as a non-terminal failure so the
              // brain retries on backoff instead of silently moving on.
              let spawn: {
                readonly teamId: string
                readonly memberSessionIds: readonly string[]
              }
              try {
                spawn = await deps.onSpawnTeam({
                  suggestionId: suggestion.id,
                  goal: suggestion.title,
                  roles: [...spawnRoles],
                  description: suggestion.description,
                })
              } catch (err) {
                log.error(
                  { err, suggestionId: suggestion.id, roles: spawnRoles, shape: decidedShape },
                  'brain: onSpawnTeam threw',
                )
                if (deps.suggestionStore.recordFailure) {
                  try {
                    const msg = err instanceof Error ? err.message : String(err)
                    deps.suggestionStore.recordFailure(
                      suggestion.id,
                      `team-spawn-threw: ${msg.slice(0, 200)}`,
                    )
                  } catch (rfErr) {
                    log.warn(
                      { err: rfErr, suggestionId: suggestion.id },
                      'brain: recordFailure threw after onSpawnTeam error',
                    )
                  }
                }
                continue
              }

              if (spawn.memberSessionIds.length === 0) {
                log.warn(
                  {
                    suggestionId: suggestion.id,
                    teamId: spawn.teamId,
                    roles: spawnRoles,
                    shape: decidedShape,
                  },
                  'brain: team spawn produced zero members — treating as failure',
                )
                if (deps.suggestionStore.recordFailure) {
                  try {
                    deps.suggestionStore.recordFailure(
                      suggestion.id,
                      'team-spawn-empty: no subprocess members launched',
                    )
                  } catch (err) {
                    log.warn(
                      { err, suggestionId: suggestion.id },
                      'brain: recordFailure threw after empty-spawn',
                    )
                  }
                }
                continue
              }

              if (deps.suggestionStore.markInProgress) {
                try {
                  deps.suggestionStore.markInProgress(suggestion.id, spawn.teamId)
                } catch (err) {
                  log.warn(
                    { err, suggestionId: suggestion.id, teamId: spawn.teamId },
                    'brain: markInProgress threw — suggestion stays in approved (will retry)',
                  )
                }
              }
              log.info(
                {
                  suggestionId: suggestion.id,
                  teamId: spawn.teamId,
                  roles: spawnRoles,
                  shape: decidedShape,
                  memberCount: spawn.memberSessionIds.length,
                },
                'brain: suggestion spawned team',
              )
              if (deps.onSuggestionSpawnedTeam) {
                try {
                  deps.onSuggestionSpawnedTeam({
                    suggestionId: suggestion.id,
                    teamId: spawn.teamId,
                    timestamp: new Date().toISOString(),
                  })
                } catch (err) {
                  log.warn(
                    { err, suggestionId: suggestion.id, teamId: spawn.teamId },
                    'brain: failed to emit suggestion-spawned-team message',
                  )
                }
              }
              continue
            }

            const result = deps.suggestionExecutor.execute(suggestion)
            if (result.success) {
              // Phase 13.12.19: run self-critique BEFORE marking implemented.
              // The critique runs as a detached ephemeral agent so it never
              // deadlocks the brain tick. Branches:
              //   - pass → mark implemented (current behavior) + sidecar.
              //   - fail → treat like a non-terminal failure (recordFailure
              //     → backoff, same path as executor failure).
              //   - needs-evidence → terminal `needs-human`, critique
              //     appended to the suggestion body.
              let critiqueVerdict: 'pass' | 'fail' | 'needs-evidence' = 'pass'
              let critiqueSummary = ''
              if (deps.selfCritique) {
                try {
                  const teamOutput = describeExecutorResult(result)
                  const verdict = await deps.selfCritique.run({ suggestion, teamOutput })
                  critiqueVerdict = verdict.verdict
                  critiqueSummary = summarizeCritique(verdict)
                  log.info(
                    {
                      id: suggestion.id,
                      verdict: verdict.verdict,
                      findings: verdict.findings.length,
                      criticSessionId: verdict.criticSessionId,
                      degradedReason: verdict.degradedReason,
                    },
                    'self-critique: verdict',
                  )
                  const targetStatus =
                    verdict.verdict === 'pass'
                      ? 'implemented'
                      : verdict.verdict === 'fail'
                        ? 'failed'
                        : 'needs-human'
                  // Apply status transition FIRST so the file lands in the
                  // right directory (updateStatus / recordFailure move the
                  // suggestion's own .md to the target dir).
                  if (verdict.verdict === 'pass') {
                    deps.suggestionStore.updateStatus(suggestion.id, 'implemented')
                  } else if (verdict.verdict === 'fail') {
                    if (deps.suggestionStore.recordFailure) {
                      deps.suggestionStore.recordFailure(
                        suggestion.id,
                        `self-critique: ${critiqueSummary}`,
                      )
                    } else {
                      deps.suggestionStore.updateStatus(
                        suggestion.id,
                        'failed',
                        `self-critique: ${critiqueSummary}`,
                      )
                    }
                  } else {
                    deps.suggestionStore.updateStatus(
                      suggestion.id,
                      'needs-human',
                      `self-critique: ${critiqueSummary}`,
                      undefined,
                      // The critic refused to pass it; that is a gate refusal, not an exhausted
                      // retry budget. Rebuild is the answer here, not another identical attempt.
                      { escalation: 'gate-refused' },
                    )
                  }
                  try {
                    deps.selfCritique.writeCritiqueFile({
                      verdict,
                      suggestion,
                      targetStatus,
                    })
                  } catch (err) {
                    log.warn(
                      { err, id: suggestion.id },
                      'self-critique: failed to write sidecar critique file',
                    )
                  }
                  if (verdict.verdict !== 'pass') {
                    // Skip the default implemented-path logging and scaling
                    // outcome recording below.
                    continue
                  }
                } catch (err) {
                  log.warn(
                    { err, id: suggestion.id },
                    'self-critique threw — falling through to implemented (fail-open)',
                  )
                  deps.suggestionStore.updateStatus(suggestion.id, 'implemented')
                }
              } else {
                deps.suggestionStore.updateStatus(suggestion.id, 'implemented')
              }
              log.info({ id: suggestion.id, type: suggestion.type }, 'Suggestion executed')
              // Phase 13.12.13: record successful solo outcome for learning.
              if (deps.scalingPolicy && decisionSignature && critiqueVerdict === 'pass') {
                try {
                  deps.scalingPolicy.recordOutcome({
                    signature: decisionSignature,
                    shape: 'solo',
                    success: true,
                    sourceSuggestionId: suggestion.id,
                  })
                } catch (err) {
                  log.warn({ err, id: suggestion.id }, 'Failed to record solo scaling outcome')
                }
              }
            } else if (result.nextStatus) {
              // Phase 13.12.1+: terminal non-success status (e.g. needs-human,
              // blocked-autonomy). Move out of `approved` so it doesn't loop
              // every wake.
              deps.suggestionStore.updateStatus(
                suggestion.id,
                result.nextStatus,
                result.error,
                result.blockedMetadata,
                // Phase 10f: `needs-human` has two meanings and only the tag can tell them apart.
                // This one is a safety gate REFUSING the work (the executor declined the type), not
                // an implementation that ran out of attempts — so `retry` must not offer another go.
                result.nextStatus === 'needs-human' ? { escalation: 'gate-refused' } : undefined,
              )
              log.info(
                {
                  id: suggestion.id,
                  type: suggestion.type,
                  status: result.nextStatus,
                  reason: result.error,
                  requiredLevel: result.blockedMetadata?.requiredLevel,
                },
                'Suggestion moved to non-approved terminal status',
              )
            } else {
              // Phase 13.12.9: non-terminal failure — backoff instead of
              // retrying every tick. recordFailure increments attemptCount,
              // computes next_retry_at, and transitions to `failed` at the
              // retry ceiling. Logged at info (NOT error) to avoid log spam.
              if (deps.suggestionStore.recordFailure) {
                try {
                  deps.suggestionStore.recordFailure(
                    suggestion.id,
                    result.error ?? 'execute() returned success:false',
                  )
                } catch (err) {
                  log.warn(
                    { err, id: suggestion.id },
                    'recordFailure threw — leaving suggestion in approved (will retry)',
                  )
                }
              }
              log.info(
                {
                  id: suggestion.id,
                  error: result.error,
                  attemptCount: (suggestion.attemptCount ?? 0) + 1,
                },
                'Suggestion execution failed — backoff applied',
              )
            }
          } catch (err) {
            log.error({ err, id: suggestion.id }, 'Suggestion execution threw')
          }
        }
        break
      }

      case BrainAction.QualityCheck: {
        if (!deps.getUncheckedCompletedSessions || !deps.onQualityCheck) {
          log.warn('QualityCheck: deps not configured')
          break
        }
        const sessions = deps.getUncheckedCompletedSessions()
        if (sessions.length === 0) break

        const targetSessionId = sessions[0]!
        log.info({ sessionId: targetSessionId }, 'Running quality check on completed session')
        try {
          const result = await deps.onQualityCheck(targetSessionId)
          log.info(
            { sessionId: targetSessionId, passed: result.passed, score: result.score },
            'Quality check complete',
          )

          if (!result.passed && deps.onCreateHandoff) {
            const context = `Quality check failed (score: ${result.score}). Findings: ${result.findings.join('; ')}`
            const { handoffId } = await deps.onCreateHandoff(targetSessionId, context)
            log.info(
              { sessionId: targetSessionId, handoffId },
              'Handoff created for failed session',
            )

            // Spawn replacement agent with handoff context
            const prompt = `Resume work from session ${targetSessionId}. ${context}. Handoff ID: ${handoffId}`
            await onSpawnAgent(prompt, 'implementer')
          }
        } catch (err) {
          log.error({ err, sessionId: targetSessionId }, 'Quality check failed')
        }
        break
      }
    }
  }

  /**
   * Phase 13.12.2: reset `blocked-autonomy` suggestions back to `approved`
   * when the live autonomy level now meets the required level recorded on
   * the suggestion. Runs once per wake, before the promoter.
   */
  function unblockAutonomySuggestions(autonomyLevel: number): void {
    if (!deps.suggestionStore) return

    let blocked: readonly Suggestion[] = []
    try {
      blocked = deps.suggestionStore.list({ status: 'blocked-autonomy' })
    } catch (err) {
      log.warn({ err }, 'unblock: failed to list blocked-autonomy suggestions')
    }

    for (const s of blocked) {
      const required = s.blockedMetadata?.requiredLevel
      if (required === undefined) {
        // Missing metadata — conservative: leave it blocked. A human can
        // re-approve via the dashboard.
        continue
      }
      if (autonomyLevel < required) continue

      try {
        deps.suggestionStore.updateStatus(
          s.id,
          'approved',
          `autonomy raised to L${autonomyLevel} (required L${required})`,
        )
        log.info(
          { id: s.id, autonomyLevel, requiredLevel: required },
          'unblock: blocked-autonomy suggestion reset to approved',
        )
      } catch (err) {
        log.warn({ err, id: s.id }, 'unblock: failed to reset suggestion')
      }
    }

    // Phase 13.12.9: also auto-reset `failed` suggestions whose last_error
    // indicates they were rejected by a RunCommand-at-low-autonomy gate. The
    // default RunCommand gate kicks in at L<3 → we only act when autonomyLevel
    // has reached L3. Other failures (test failures, file conflicts, etc.)
    // stay terminal and require a manual retry.
    if (autonomyLevel < 3) return
    if (!deps.suggestionStore.clearBackoff) return

    let failed: readonly Suggestion[] = []
    try {
      failed = deps.suggestionStore.list({ status: 'failed' })
    } catch (err) {
      log.warn({ err }, 'unblock: failed to list failed suggestions')
      return
    }
    for (const s of failed) {
      if (!s.lastError || !/RunCommand skipped/i.test(s.lastError)) continue
      try {
        deps.suggestionStore.clearBackoff(s.id)
        log.info(
          { id: s.id, autonomyLevel, lastError: s.lastError },
          'unblock: failed(RunCommand-skipped) suggestion reset to approved',
        )
      } catch (err) {
        log.warn({ err, id: s.id }, 'unblock: failed to reset failed suggestion')
      }
    }
  }

  function promoteSuggestionsIntoQueue(autonomyLevel: number): void {
    if (autonomyLevel < 1) return
    if (!deps.suggestionStore) return

    let candidates: readonly Suggestion[] = []
    try {
      const pending = deps.suggestionStore.list({ status: 'pending' })
      const approved = deps.suggestionStore.list({ status: 'approved' })
      candidates = [...pending, ...approved]
    } catch (err) {
      log.warn({ err }, 'promoter: failed to list suggestions')
      return
    }
    if (candidates.length === 0) return

    const result = promoteSuggestions({
      autonomyLevel,
      maxConcurrentSessions,
      activeSessions: getActiveSessions(),
      inflightTasks: deps.taskQueue.getAll(),
      suggestions: candidates,
      autoApproveThreshold,
    })

    if (result.promoted.length === 0 && result.autoApprovedIds.length === 0) return

    for (const id of result.autoApprovedIds) {
      try {
        deps.suggestionStore.updateStatus(id, 'approved')
      } catch (err) {
        log.warn({ err, id }, 'promoter: failed to auto-approve suggestion')
      }
    }

    // Phase 13.12.24a: a suggestion auto-approved on THIS tick is executed by
    // the ApprovedSuggestions action (Path A) — which now spawns solo work as a
    // team-of-one via onSpawnTeam, not just team+roles work. Enqueuing it as a
    // task here too would spawn it a SECOND time via the task-queue path
    // (Path B) on a later tick — the same double-spawn class the promoter's
    // team+roles guard already prevents. ApprovedSuggestions is the
    // authoritative executor for approved items, so skip those enqueues.
    // Human-approved items (status==='approved', not in autoApprovedIds) keep
    // the existing task-queue promotion behavior.
    const autoApprovedSet = new Set(result.autoApprovedIds)

    let enqueued = 0
    for (const p of result.promoted) {
      if (p.sourceSuggestionId && autoApprovedSet.has(p.sourceSuggestionId)) {
        continue
      }
      const ok = deps.taskQueue.enqueue(p.task)
      if (ok) enqueued += 1
      else log.warn({ taskId: p.task.id }, 'promoter: queue full, dropped task')
    }

    if (enqueued > 0 || result.autoApprovedIds.length > 0) {
      log.info(
        {
          promoted: enqueued,
          autoApproved: result.autoApprovedIds.length,
          considered: candidates.length,
        },
        'promoter: suggestions → tasks',
      )
    }
  }

  /**
   * Phase 13.12.20: scan in-progress suggestions and time out any whose
   * team has been running longer than {@link STALLED_TEAM_TIMEOUT_MS}. Stalled
   * suggestions are moved back to `approved` via recordFailure (same
   * backoff path as executor failures) with `lastError='team-stalled-30m'`.
   * This prevents brain-spawned teams from hanging forever when the
   * team_completed event never arrives (e.g. subprocess hang, host reboot).
   */
  function timeOutStalledTeams(): void {
    if (!deps.suggestionStore) return
    let inflight: readonly Suggestion[] = []
    try {
      inflight = deps.suggestionStore.list({ status: 'in-progress' })
    } catch (err) {
      log.warn({ err }, 'stall-timeout: failed to list in-progress suggestions')
      return
    }
    const nowMs = Date.now()
    for (const s of inflight) {
      const updatedMs = new Date(s.updatedAt).getTime()
      if (!Number.isFinite(updatedMs)) continue
      if (nowMs - updatedMs < STALLED_TEAM_TIMEOUT_MS) continue
      log.warn(
        { id: s.id, teamId: s.inflightTeamId, ageMs: nowMs - updatedMs },
        'stall-timeout: in-progress suggestion exceeded timeout — rolling back',
      )
      // Move back to approved first so the backoff recordFailure uses the
      // right source dir. Use updateStatus so `inflightTeamId` gets
      // cleared (see suggestion-store.ts updateStatus).
      try {
        deps.suggestionStore.updateStatus(s.id, 'approved', 'team-stalled')
      } catch (err) {
        log.warn({ err, id: s.id }, 'stall-timeout: updateStatus threw')
        continue
      }
      if (deps.suggestionStore.recordFailure) {
        try {
          deps.suggestionStore.recordFailure(
            s.id,
            `team-stalled-${Math.floor(STALLED_TEAM_TIMEOUT_MS / 60_000)}m`,
          )
        } catch (err) {
          log.warn({ err, id: s.id }, 'stall-timeout: recordFailure threw')
        }
      }
    }
  }

  async function wake(): Promise<Decision> {
    if (wakeInProgress) {
      log.debug('Wake cycle already in progress, skipping')
      return (
        lastDecision ?? {
          action: BrainAction.Idle,
          reason: 'Wake in progress',
          confidence: 1,
          priority: DecisionPriority.Normal,
        }
      )
    }
    wakeInProgress = true
    currentState = 'deciding'

    try {
      // Phase 13.9.2: hot-read autonomy level at the top of each wake so
      // runtime promote/demote takes effect on the next tick without a
      // broker restart. All helpers receive the level explicitly.
      const autonomyLevel = readAutonomyLevel()

      // Phase 13.12.2: auto-reset blocked-autonomy suggestions whose required
      // level is now satisfied. Runs BEFORE promoter so reset items land in
      // `approved` and flow through the normal execution path this same tick.
      unblockAutonomySuggestions(autonomyLevel)

      // Phase 13.12.20: time out brain-spawned teams that have been
      // in-progress longer than STALLED_TEAM_TIMEOUT_MS before the
      // promoter runs, so recovered suggestions re-enter the task queue.
      timeOutStalledTeams()

      // Phase 13.3: promote approved/auto-approvable suggestions into
      // the task queue BEFORE decide(), so the decision tree sees them
      // on the same tick the generator last produced them.
      promoteSuggestionsIntoQueue(autonomyLevel)

      const state = buildBrainState(autonomyLevel)
      const decision = deps.decisionTree.decide(state)

      log.info(
        {
          action: decision.action,
          reason: decision.reason,
          confidence: decision.confidence,
          autonomyLevel,
          observations: state.recentObservationCount,
          consolidationAgeHours: Math.round(state.lastConsolidationAge),
          consolidationGateOpen: state.consolidationGateOpen ?? true,
          pendingTaskCount: state.pendingTasks.length,
          userActive: state.userActive,
          otelSessions: state.otelMetrics?.activeOtelSessions ?? 0,
        },
        'Brain wake cycle decision',
      )
      currentState = 'acting'
      try {
        await executeDecision(decision, autonomyLevel)
      } catch (err) {
        log.error({ err }, 'Error executing decision')
      }

      wakeCount += 1
      lastWakeTime = new Date().toISOString()
      lastDecision = decision
      // Phase 13.12.14: count today's ticks for /api/brain/status. Resets
      // when the UTC date rolls over.
      const today = new Date().toISOString().slice(0, 10)
      if (today !== ticksTodayDate) {
        ticksTodayDate = today
        ticksToday = 0
      }
      ticksToday += 1
      currentState = timer ? 'running' : 'idle'
      // Phase 13.10.3: mark ready only after a full wake completes without
      // throwing. Signals /api/health that taskQueue, autonomy store, and
      // the decision tree are all working end-to-end.
      ready = true

      // Phase 13.12.5: keep BrainAgentStatus.intervalMs in sync with the
      // current autonomy-scaled interval so /api/brain/status and tests
      // observe hot-reloaded values without waiting for the next tick.
      intervalMs = resolveIntervalMs(autonomyLevel)

      return decision
    } finally {
      wakeInProgress = false
      // Phase 13.12.4: if requestWake() was called while this wake was
      // in flight, kick off exactly one coalesced follow-up wake.
      if (pendingWake) {
        pendingWake = false
        setTimeout(() => {
          wake().catch((err) => log.error({ err }, 'Coalesced wake failed'))
        }, 0)
      }
    }
  }

  return {
    start(): void {
      if (scheduleRunning) return
      scheduleRunning = true
      const initialInterval = resolveIntervalMs()
      intervalMs = initialInterval
      log.info({ intervalMs: initialInterval }, 'Brain agent starting')

      const scheduleNext = (): void => {
        if (!scheduleRunning) return
        // Re-read interval each tick so autonomy changes take effect
        // without restarting the agent (Phase 13.12.5 hot-reload).
        const next = resolveIntervalMs()
        if (next !== intervalMs) {
          log.info(
            { previous: intervalMs, next },
            'Brain tick interval changed (autonomy hot-reload)',
          )
          intervalMs = next
        }
        scheduleTimer = setTimeout(() => {
          wake()
            .catch((err) => log.error({ err }, 'Wake cycle failed'))
            .finally(() => scheduleNext())
        }, next)
      }
      scheduleNext()
      // Backcompat: keep `timer` non-null so isRunning() reports true.
      timer = scheduleTimer
      currentState = 'running'
    },

    stop(): void {
      if (!scheduleRunning) return
      scheduleRunning = false
      if (scheduleTimer) {
        clearTimeout(scheduleTimer)
        scheduleTimer = null
      }
      timer = null
      currentState = 'idle'
      log.info('Brain agent stopped')
    },

    wake,

    /**
     * Phase 13.12.4: fire-and-forget wake trigger. Non-blocking; returns
     * void immediately. If a wake is currently in-flight, sets a flag so
     * one coalesced follow-up wake runs after the current one completes.
     * Multiple concurrent calls collapse to at most one follow-up.
     */
    requestWake(): void {
      if (wakeInProgress) {
        pendingWake = true
        return
      }
      setTimeout(() => {
        wake().catch((err) => log.error({ err }, 'Requested wake failed'))
      }, 0)
    },

    addTask(description: string, priority?: DecisionPriority, signalKey?: string): string | null {
      const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const task: PendingTask = {
        id,
        description,
        priority: priority ?? DecisionPriority.Normal,
        createdAt: new Date().toISOString(),
        ...(signalKey ? { signalKey } : {}),
      }
      const enqueued = deps.taskQueue.enqueue(task)
      if (!enqueued) {
        log.warn({ id, description }, 'Task queue full, dropping task')
        return null
      }
      return id
    },

    /**
     * Bug 2 fix: true if a self-issue signal is already sitting in the live
     * in-memory queue (so the ingest run must not re-enqueue it this process).
     * After a restart the queue is empty, so a lost-before-spawn signal is not
     * "queued" and gets re-enqueued.
     */
    hasQueuedSignal(signalKey: string): boolean {
      return deps.taskQueue.getAll().some((t) => t.signalKey === signalKey)
    },

    getStatus(): BrainAgentStatus {
      return {
        state: currentState,
        wakeCount,
        lastWakeTime,
        lastDecision,
        queueSize: deps.taskQueue.size(),
        intervalMs,
      }
    },

    /**
     * Phase 13.12.14: snapshot for `GET /api/brain/status`. Combines
     * in-memory state (currentState, lastWakeTime, ticksToday) with injected
     * deps (queueDepth = pending suggestions, currentDecisionId = latest
     * scaling_decisions row, autonomy = hot-read level).
     */
    getStatusSnapshot(): BrainStatusSnapshot {
      const today = new Date().toISOString().slice(0, 10)
      const ticks = today === ticksTodayDate ? ticksToday : 0
      let queueDepth = 0
      try {
        queueDepth = deps.getPendingSuggestionCount?.() ?? 0
      } catch {
        queueDepth = 0
      }
      // R3: the starved-queue defect was invisible because only the
      // suggestions count was exposed. Surface the real task queue depth too.
      let taskQueueDepth = 0
      try {
        taskQueueDepth = deps.taskQueue.size()
      } catch {
        taskQueueDepth = 0
      }
      let currentDecisionId: number | null = null
      try {
        currentDecisionId = deps.getMostRecentDecisionId?.() ?? null
      } catch {
        currentDecisionId = null
      }
      let autonomy = 0
      try {
        autonomy = readAutonomyLevel()
      } catch {
        autonomy = fallbackAutonomyLevel
      }
      // Surface "starting" only before the first successful wake completes
      // (matches the brain readiness flag exposed via /api/health).
      const externalState: BrainStatusSnapshot['state'] =
        !ready && currentState === 'idle' ? 'starting' : currentState
      return {
        state: externalState,
        lastTickAt: lastWakeTime,
        ticksToday: ticks,
        currentDecisionId,
        queueDepth,
        taskQueueDepth,
        pendingSuggestions: queueDepth,
        autonomy,
        isWoken: wakeInProgress,
      }
    },

    isRunning(): boolean {
      return scheduleRunning
    },

    isReady(): boolean {
      return ready
    },

    isWakeInProgress(): boolean {
      return wakeInProgress
    },
  }
}
