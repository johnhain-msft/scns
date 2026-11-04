#!/usr/bin/env node

// Cap ONNX runtime threads to prevent FastEmbed inference from saturating all
// CPU cores during memory indexing / embedding backfill. Set BEFORE any import
// of fastembed / onnxruntime-node. Users can override via env.
if (!process.env['OMP_NUM_THREADS']) process.env['OMP_NUM_THREADS'] = '2'
if (!process.env['ORT_INTRA_OP_NUM_THREADS']) process.env['ORT_INTRA_OP_NUM_THREADS'] = '2'
if (!process.env['ORT_INTER_OP_NUM_THREADS']) process.env['ORT_INTER_OP_NUM_THREADS'] = '1'

import { Command } from 'commander'
import { basename, join, resolve, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import {
  existsSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
} from 'node:fs'
import {
  generateLaunchAgentPlist,
  generateSystemdUnit,
  getServicePaths,
  detectPlatform,
  findPlistDrift,
  generateBrokerPlist,
  generateWindowsStartupCmd,
} from './cli/service-generators.js'
import type {
  ServiceConfig,
  PlistDriftFinding,
  BrokerPlistConfig,
} from './cli/service-generators.js'
import { buildTeamMemberPrompt } from './cli/team-member-prompts.js'
import { dispatchResearch } from './cli/research-command.js'
import type { OtelFileWatcher } from './otel/file-watcher.js'
import { createDreamDaemon } from './dream/dream-daemon.js'
import { DEFAULT_MAINTENANCE_GUARD } from './dream/memory-maintenance.js'
import { loadObservationConfig } from './observe/config.js'
import { createObservationManager } from './observe/observation-manager.js'
import { createSessionHookHandler } from './observe/observers/session-hooks.js'
import { createDailyLogWriter } from './observe/daily-log-writer.js'
import {
  loadAutonomy,
  seedAutonomyIfAbsent,
  promote as promoteAutonomy,
  demote as demoteAutonomy,
  getAutonomyDescription,
} from './shared/autonomy.js'
import { logger } from './shared/logger.js'
import { withTemporaryDirectory } from './shared/temporary-directory.js'
import { resolveScnsHome } from './shared/scns-home.js'
import { ScnsError } from './shared/errors.js'
import { isUnattendedEnabled, unattendedStatusDetail } from './shared/unattended.js'
import { computeTaskSignature, decideShape } from './brain/scaling-policy.js'
import {
  findOutcomesBySignature,
  recordScalingOutcome,
  recordScalingDecision,
} from './broker/storage/repositories/scaling-outcomes-repository.js'
import { createNegativeMemoryStore } from './memory/negative-memory-store.js'
import { analyzeSentiment } from './memory/sentiment-analyzer.js'
import { buildCausalDreamConfig } from './memory/causal-wiring.js'

const program = new Command()

program
  .name('scns')
  .description('Second Central Nervous System — autonomous second brain + nervous system')
  .version('0.1.0')

program
  .command('start')
  .description('Start the SCNS brain agent and session broker')
  .option('-p, --port <port>', 'broker port', '3456')
  .option('--autonomy <level>', 'autonomy level (0–3)', '0')
  .option('--otel-path <path>', 'explicit OTel telemetry file path override')
  .action(async (opts: { port: string; autonomy: string; otelPath?: string }) => {
    const port = parseInt(opts.port, 10)
    const autonomyLevel = parseInt(opts.autonomy, 10)

    // Register global error handlers FIRST so any error during startBroker
    // (e.g. startup-cleanup failure) is logged to broker_error.log and exits
    // gracefully with exitCode=1 instead of triggering the Node runtime's
    // C++ mutex-abort path (observed in prod 2026-04-22).
    const { registerGlobalErrorHandlers: _registerFatalHandlersFirst } =
      await import('./shared/global-error-handlers.js')
    _registerFatalHandlersFirst()

    // Hoist broker config load so `cfg.projectRoot` is available to every
    // downstream wiring point in this action. Eliminates the previously
    // late-loaded `loadBrokerConfigForQG` import and centralizes the
    // single source of truth for the broker's project root, used by the
    // QG arbiter, auto-merger, dream daemon, brain spawn adapter, and the
    // brain team-spawn prompt builder. `BROKER_PROJECT_ROOT` (when set)
    // is validated here — invalid values throw with operator-actionable
    // messages caught by the global error handlers registered above.
    const { loadConfig: loadBrokerCfg } = await import('./broker/config.js')
    const brokerCfg = loadBrokerCfg()

    console.log('Starting SCNS system...')

    // 1. Start observation manager (must start before broker so hook handler is ready)
    const config = loadObservationConfig()
    const scnsDir = join(resolveScnsHome(), '.scns')
    const vaultRootDir = join(scnsDir, 'memory')

    // Seed the autonomy store from --autonomy on first boot. loadAutonomy()
    // defaults to level 0 when no state file exists, which would otherwise make
    // --autonomy a no-op for a fresh broker (e.g. a meta-broker child with its own
    // isolated, empty SCNS_HOME → stuck in Observer mode). Idempotent: an existing
    // store (singleton, or a prior promote) is left untouched.
    seedAutonomyIfAbsent(join(scnsDir, 'state'), autonomyLevel)

    // Create vault + negative memory store early so they're available for broker startup
    const { createVault } = await import('./memory/vault.js')
    const vault = createVault({ rootDir: vaultRootDir })
    const negMemStore = createNegativeMemoryStore(vault)

    const manager = createObservationManager({
      config,
      vaultRootDir,
      // Poll the broker's own project repo first so its commit history seeds the
      // observation buffer before slower repos during the post-restart window.
      gitPriorityRepos: [process.env['BROKER_PROJECT_ROOT'] ?? process.cwd()],
    })
    manager.start()
    console.log('  Observation manager started')

    // 2. Start broker with hook handler wired
    const { startBroker } = await import('./broker/startup.js')
    const handleSessionEvent = (event: {
      readonly event: string
      readonly sessionId?: string
      readonly tool?: string
      readonly timestamp: string
      readonly metadata?: Record<string, unknown>
      readonly model?: string
      readonly toolArgs?: string
      readonly toolResult?: string
      readonly mcpServer?: string
      readonly skillName?: string
      readonly exitCode?: number
      readonly errorMessage?: string
      readonly traceId?: string
      readonly tokenUsage?: { readonly input?: number; readonly output?: number }
    }): { readonly id: string } | null => {
      const obs = manager.handleSessionEvent(
        event as import('./observe/observers/session-hooks.js').SessionEventData,
      )
      return obs ? { id: obs.id } : null
    }
    // 2b. Create rotation controller, compaction detector, and cost tracker
    const { createHealthMonitor } = await import('./context/health-monitor.js')
    const { createCompactionDetector } = await import('./context/compaction-detector.js')
    const { createRotationController } = await import('./context/rotation-controller.js')
    const { createHandoffGenerator } = await import('./context/handoff-generator.js')
    const { createHandoffStore } = await import('./context/handoff-store.js')
    const { createCostTracker } = await import('./shared/cost-tracker.js')

    const healthMonitor = createHealthMonitor()
    const compactionDetector = createCompactionDetector({ healthMonitor })
    const handoffStore = createHandoffStore({ rootDir: join(scnsDir, 'handoffs') })
    const rotationController = createRotationController({
      detector: compactionDetector,
      handoffGenerator: createHandoffGenerator(),
      handoffStore,
      healthMonitor,
    })
    const costTracker = createCostTracker()

    // Late-bound callback — dream daemon created after broker, so we use a ref
    let onSessionCompletedFn: (() => void) | undefined = undefined

    // Build OTel env vars to inject into spawned agents
    const { ensureTelemetryDir: ensureOtelDir } = await import('./otel/auto-config.js')
    const otelEnv: Record<string, string> = {}
    const otelFilePath =
      process.env['OTEL_SCNS_FILE_PATH'] ?? process.env['COPILOT_OTEL_FILE_EXPORTER_PATH'] ?? null
    if (otelFilePath) {
      const resolvedOtelPath = resolve(otelFilePath.replace(/^~(?=\/|$)/, homedir()))
      otelEnv['COPILOT_OTEL_FILE_EXPORTER_PATH'] = resolvedOtelPath
      otelEnv['COPILOT_OTEL_ENABLED'] = 'true'
      otelEnv['OTEL_SCNS_FILE_PATH'] = resolvedOtelPath
      otelEnv['OTEL_SCNS_ENABLED'] = 'true'
      try {
        ensureOtelDir(resolvedOtelPath)
      } catch {
        /* dir may already exist */
      }
    }

    // Startup-time telemetry rotation. If the broker has been off for a
    // while and the JSONL has grown past threshold, rotate immediately
    // BEFORE any copilot CLI children are spawned — that way every
    // session opens a fresh primary instead of inheriting a near-cap
    // file. Catches the case where the periodic 6h scheduler tick has
    // not had a chance to run (e.g. after a long crash or a multi-day
    // outage). Runs even when no OTel env vars are set on the launchd
    // env — the rotator resolves the default ~/.scns/telemetry path
    // itself. Failures are logged and ignored; rotation is best-effort.
    try {
      const {
        rotateTelemetryIfNeeded,
        resolveTelemetryRotationConfig,
        sweepParkedTelemetry,
        pruneTelemetryArchives,
      } = await import('./retention/telemetry-rotator.js')
      const cfg = resolveTelemetryRotationConfig(
        otelFilePath
          ? { filePath: resolve(otelFilePath.replace(/^~(?=\/|$)/, homedir())) }
          : undefined,
      )
      const result = await rotateTelemetryIfNeeded(cfg)
      if (result.rotated) {
        console.log(
          `  Rotated telemetry log (${result.beforeBytes} bytes → archive ${result.archivePath})`,
        )
      }
      const swept = sweepParkedTelemetry(cfg.filePath)
      if (swept.removed.length > 0) {
        console.log(
          `  Swept ${swept.removed.length} orphaned parked telemetry file(s) (${swept.freedBytes} bytes freed)`,
        )
      }
      // P5a: startup-time archive prune — a long-stopped broker can have
      // accumulated hostile pre-policy archives. Reclaim them before any
      // copilot CLI children spawn so we never start a session already at
      // the memory-pressure threshold.
      const pruned = pruneTelemetryArchives(cfg)
      if (pruned.removed.length > 0) {
        console.log(
          `  Pruned ${pruned.removed.length} oversized telemetry archive(s) (${pruned.freedBytes} bytes freed${pruned.capExceeded ? '; cap still exceeded — .1 is protected' : ''})`,
        )
      } else if (pruned.capExceeded) {
        console.log(
          '  Telemetry archive total over cap but only .1 remains — not pruning live inode',
        )
      }
    } catch (err) {
      console.warn('  Startup telemetry rotation failed (non-fatal):', err)
    }

    let broker: Awaited<ReturnType<typeof startBroker>>
    // Phase 13.12.17 — credential vault + internal token. Created before
    // broker starts so they can be injected into agent spawner env.
    const { createSecretStore } = await import('./secrets/secret-store.js')
    const { ensureInternalToken } = await import('./secrets/internal-token.js')
    const secretStore = createSecretStore({ rootDir: join(scnsDir, 'secrets') })
    const internalToken = ensureInternalToken({
      path: join(scnsDir, '.internal-token'),
    })
    try {
      broker = await startBroker({
        port,
        handleSessionEvent,
        rotationController,
        compactionDetector,
        costTracker,
        sentimentAnalyzer: analyzeSentiment,
        negativeMemoryStore: negMemStore,
        onSessionCompleted: () => onSessionCompletedFn?.(),
        otelEnv,
        secretStore,
        internalToken,
      })
    } catch (err) {
      // WI-6: a broker that cannot bind must DIE, not linger. Rethrowing left
      // a half-started zombie (observers running, no listener) that the
      // supervisor could never health-probe or reap.
      manager.stop()
      console.error('  Broker failed to start:', err instanceof Error ? err.message : err)
      process.exit(1)
    }
    console.log(`  Broker listening on port ${port}`)

    // 2. Start brain agent
    const { createBrainAgent } = await import('./brain/agent-loop.js')
    const { createTaskQueue } = await import('./brain/task-queue.js')
    const { createDecisionTree } = await import('./brain/decision-tree.js')
    const { createTaskClassifier } = await import('./brain/classifier.js')
    const { createTemplateEngine } = await import('./brain/templates.js')
    const { getSpanCount } = await import('./otel/otel-repository.js')
    const { ensureLearningStateTable, loadLearningState } = await import('./otel/learning-state.js')

    // 3. Set up suggestion system
    const { createSuggestionStore } = await import('./suggest/suggestion-store.js')
    const { createConfidenceScorer } = await import('./suggest/confidence.js')
    const { createEvidenceGatherer } = await import('./suggest/evidence.js')
    const { createSuggestionGenerator } = await import('./suggest/generator.js')
    const { collectRepoFileTypes } = await import('./suggest/repo-file-types.js')
    const { createPatternDetector } = await import('./observe/pattern-detector.js')
    const { createCrossSourceCorrelator } = await import('./observe/cross-source/correlator.js')
    const { createExecutor } = await import('./suggest/executor.js')
    const selfCritiqueModule = await import('./brain/self-critique.js')
    const { extractSessionSummaries } = await import('./otel/session-extractor.js')
    const { extractPatterns } = await import('./otel/pattern-extractor.js')

    const patternDetector = createPatternDetector()
    const crossSourceCorrelator = createCrossSourceCorrelator()

    // Cache OTel pattern extraction so the per-tick brain suggestion pass does
    // not re-run a full session/span scan every 60s. Recomputed at most once
    // per SCNS_OTEL_PATTERNS_TTL_MS (default 5 min).
    const otelPatternsTtlMs = parseInt(process.env['SCNS_OTEL_PATTERNS_TTL_MS'] ?? '300000', 10)
    let otelPatternsCache: {
      at: number
      value: import('./otel/pattern-extractor.js').ExtractedPatterns | null
    } | null = null

    const suggestionsDir = join(scnsDir, 'suggestions')
    const suggestionStore = createSuggestionStore({ rootDir: suggestionsDir })

    // Phase 13.12.12: eagerly create lesson/taxonomy/rejection stores so the
    // suggestion generator can emit tag-proposals on its first wake.
    const { createLessonStore: createLessonStoreEarly } = await import('./memory/lessons.js')
    const { createTaxonomyStore } = await import('./memory/taxonomy.js')
    const { createTagRejectionStore } = await import('./memory/tag-rejections.js')
    const lessonsRootEarly = join(vaultRootDir, 'lessons')
    const earlyLessonStore = createLessonStoreEarly({ rootDir: lessonsRootEarly })
    const taxonomyStoreInstance = createTaxonomyStore({
      path: join(vaultRootDir, '.taxonomy.yml'),
    })
    const tagRejectionStoreInstance = createTagRejectionStore({
      path: join(vaultRootDir, '.tag-rejections.jsonl'),
    })

    const dedupWindowDaysEnv = process.env['SCNS_SUGGEST_DEDUP_WINDOW_DAYS']
    const parsedDedupWindow = dedupWindowDaysEnv ? Number.parseInt(dedupWindowDaysEnv, 10) : NaN
    const dedupWindowDays =
      Number.isFinite(parsedDedupWindow) && parsedDedupWindow > 0 ? parsedDedupWindow : undefined

    // Phase 13.x — auto-approve confidence threshold for the suggestion
    // promoter, overridable via SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD. Accepts a
    // float in (0, 1]; anything missing/invalid/out-of-range falls back to the
    // promoter's built-in default (0.85), preserving prior behavior. Uses
    // Number() (not parseFloat) so malformed values like "0.8x" reject to the
    // default rather than silently parsing to 0.8.
    const autoApproveThresholdEnv = process.env['SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD']
    const parsedAutoApprove =
      autoApproveThresholdEnv && autoApproveThresholdEnv.trim() !== ''
        ? Number(autoApproveThresholdEnv)
        : NaN
    const autoApproveThreshold =
      Number.isFinite(parsedAutoApprove) && parsedAutoApprove > 0 && parsedAutoApprove <= 1
        ? parsedAutoApprove
        : undefined

    // D2a (design-m1.md §6): memory-derived self-improvement ideation. Default-OFF
    // via SCNS_IDEATE_MEMORY=1. The readers lazily resolve `memoryDb` (assigned later
    // in startup) through a holder, so before the graph is ready — or when the flag is
    // off — ideation safely uses the static seed menu (cold-graph fallback).
    const ideateMemoryHolder: { db: import('better-sqlite3').Database | null } = { db: null }
    const ideateMemoryEnabled = process.env['SCNS_IDEATE_MEMORY'] === '1'
    let selfImprovementMemory:
      | import('./suggest/generator.js').GeneratorDeps['selfImprovementMemory']
      | undefined
    let recordSuggestionOutcomeFn:
      | typeof import('./suggest/outcome-writer.js').recordSuggestionOutcome
      | undefined
    if (ideateMemoryEnabled) {
      const { entityNeighborhood: ideateNeighborhood } =
        await import('./memory/entities/neighborhood.js')
      const { aggregateOutcomesByEntity: ideateOutcomes } =
        await import('./memory/proposal-outcomes.js')
      const { recordSuggestionOutcome: ideateRecordOutcome } =
        await import('./suggest/outcome-writer.js')
      recordSuggestionOutcomeFn = ideateRecordOutcome
      // D2 outcome-gate (default-OFF): only active when SCNS_IDEATE_GATE_ENFORCE=1.
      // familyStats is read fresh per cycle (outcomes accumulate over time).
      const { resolveIdeationGateMode, familyLandingStats } =
        await import('./selfopt/ideation-gate.js')
      const { recordEntityAccess: ideateRecordAccess } = await import('./memory/memory-access.js')
      const ideateGateMode = resolveIdeationGateMode(process.env)
      selfImprovementMemory = {
        enabled: true,
        readers: {
          neighborhood: (entity: string) =>
            ideateMemoryHolder.db ? ideateNeighborhood(ideateMemoryHolder.db, entity) : [],
          outcomes: (entity: string) =>
            ideateMemoryHolder.db
              ? ideateOutcomes(ideateMemoryHolder.db, entity)
              : { entity, total: 0, landed: 0, failed: 0, families: new Map() },
        },
        // D2 retrieval signal ("use it or lose it") — feeds the dream maintenance phase.
        onAccess: (entity: string) => {
          if (ideateMemoryHolder.db) {
            try {
              ideateRecordAccess(ideateMemoryHolder.db, entity, Math.floor(Date.now() / 86_400_000))
            } catch {
              /* best-effort signal */
            }
          }
        },
        ...(ideateGateMode.enforce
          ? {
              gate: {
                enforce: true,
                familyStats: () =>
                  ideateMemoryHolder.db ? familyLandingStats(ideateMemoryHolder.db) : new Map(),
              },
            }
          : {}),
      }
    }

    const suggestionGen = createSuggestionGenerator(
      {
        scorer: createConfidenceScorer(),
        evidenceGatherer: createEvidenceGatherer(),
        store: suggestionStore,
        lessonStore: { listAll: () => earlyLessonStore.listAll() },
        tagRejectionStore: { signatures: () => tagRejectionStoreInstance.signatures() },
        taxonomyStore: { load: () => taxonomyStoreInstance.load() },
        ...(selfImprovementMemory ? { selfImprovementMemory } : {}),
      },
      {
        ...(dedupWindowDays !== undefined ? { dedupWindowDays } : {}),
        // Scope the global file-type histogram to what this repo actually contains, so a
        // language dominant in another watched project cannot produce a lint suggestion here.
        // Indexed once at startup; a repo that gains a new language picks it up on restart.
        repoFileTypes: collectRepoFileTypes(),
      },
    )

    // 3c. Phase 13.5 — Quality Gate Arbiter.
    // Subscribes to team_completed events, runs tests/lint on a disposable
    // worktree, commits on scns/auto/<slug> branch on PASS, records negative
    // memory + rejects suggestion on FAIL.
    const { createQualityGateArbiter } = await import('./broker/services/quality-gate-arbiter.js')
    const {
      makeQgBehavioralGateConfig,
      makeQgRetrievalGateConfig,
      resolveQgRetrievalCandidateConfig,
    } = await import('./broker/services/qg-behavioral-backend.js')
    const { ALL_RETRIEVAL_VAL_TASKS } = await import('./selfopt/index.js')
    const {
      createSpawnVerifierBackend,
      createDefaultVerifierSpawner,
      loadClaimVerifierSpawnConfig,
    } = await import('./broker/services/claim-verifier-backend.js')
    const { createRedundancyVerifierBackend, loadRedundancyVerifierSpawnConfig } =
      await import('./broker/services/redundancy-verifier-backend.js')
    const qgExecutor = createExecutor({ autonomyLevel })
    const qualityGateArbiter = createQualityGateArbiter({
      db: broker.db,
      eventLog: broker.eventLog,
      dispatcher: broker.dispatcher,
      projectRoot: brokerCfg.projectRoot,
      baselineLintEnabled: brokerCfg.qualityGate.baselineLintEnabled,
      baselineTestsEnabled: brokerCfg.qualityGate.baselineTestsEnabled,
      suggestionStore: {
        get: (id: string) => suggestionStore.get(id),
        updateStatus: (id, status, reason, blockedMetadata, opts) =>
          suggestionStore.updateStatus(id, status, reason, blockedMetadata, opts),
        // FR-057: the gate's failure seam. Routing a gate failure through here instead of
        // `updateStatus(id, 'rejected', …)` is what stops an implementation failure from being
        // recorded as John's refusal.
        recordQualityGateFailure: (id: string, reason: string) =>
          suggestionStore.recordQualityGateFailure(id, reason),
        // Phase 13.12.20: allow QG to route brain-spawned `team-sugg-<short>`
        // completions back to their source suggestion.
        findByInflightTeamId: (teamId: string) => suggestionStore.findByInflightTeamId(teamId),
      },
      executor: {
        generatePlan: (s) => qgExecutor.generatePlan(s),
        execute: (plan, s) =>
          qgExecutor.execute(plan as import('./suggest/executor.js').ImplementationPlan, s),
      },
      negativeMemoryStore: negMemStore,
      // Phase 1 wedge A (go-live): wire the REAL asymmetric behavioral-improvement
      // gate. Inert by default — the bounded deny-all AcpReplayBackend pair is
      // constructed ONLY on the rubric-PASS branch when SCNS_QG_BEHAVIORAL_GATE=1,
      // and a measured regression only vetoes (PASS→FAIL) when
      // SCNS_QG_BEHAVIORAL_ENFORCE=1.
      //
      // THE BRIDGE: with SCNS_QG_BEHAVIORAL_RETRIEVAL=1 the asymmetry channel is
      // RETRIEVED MEMORY (baseline = HEAD retrieval config, candidate = the
      // candidate's) over the live vault via the REAL retrieval path, so the gate
      // MEASURES MAGMA memory quality instead of a static guidance diff. The vault
      // handle is resolved lazily (the arbiter is built before the vault is opened).
      // The retrieval-sensitive val set (ENTITY + WHY/causal) MUST be wired here too,
      // else the arbiter defaults to DEFAULT_BEHAVIORAL_VAL_TASKS (guidance tasks),
      // whose DEFAULT-intent queries fall back to base search ⇒ delta 0 ⇒ the
      // retrieval gate is inert. Each retrieval task is itself inert until its
      // grounding exists, so this can never produce a false veto.
      // Default-OFF: guidance-mode is used unless this flag is explicitly set.
      behavioralGate:
        process.env.SCNS_QG_BEHAVIORAL_RETRIEVAL === '1'
          ? {
              ...makeQgRetrievalGateConfig({
                db: () => ideateMemoryHolder.db,
                // Candidate retrieval levers (fusion/semantic/timeline) are opt-in via
                // SCNS_QG_RETRIEVAL_* and default-OFF ⇒ candidate stays { intentRouting: true }
                // (today's behavior) unless a lever is explicitly flagged for measurement.
                candidateConfig: resolveQgRetrievalCandidateConfig(process.env),
              }),
              valTasks: ALL_RETRIEVAL_VAL_TASKS,
            }
          : makeQgBehavioralGateConfig({ projectRoot: brokerCfg.projectRoot }),
      // Track 1 / 1B — the producer≠verifier spawn seam. ALWAYS wired but INERT by
      // default: the arbiter only invokes this backend when SCNS_QG_CLAIM_SPAWN=1
      // AND the deterministic pre-filter finds ≥1 runtime claim. It then spawns a
      // bounded copilot one-shot that INDEPENDENTLY re-runs each cited probe
      // (read-only) and confirms the quoted row — the deep check the deterministic
      // core cannot do. A timeout/error degrades to needs-evidence, never a silent
      // pass. CMD/ARGS/TIMEOUT are env-overridable (SCNS_QG_CLAIM_VERIFIER_*) so an
      // isolated live test can point the spawn at a read-only-tool copilot.
      claimVerifier: {
        makeVerifierBackend: () => {
          const spawnCfg = loadClaimVerifierSpawnConfig(process.env)
          return createSpawnVerifierBackend({
            spawnVerifier: createDefaultVerifierSpawner({
              ...(spawnCfg.command ? { command: spawnCfg.command } : {}),
              ...(spawnCfg.args ? { args: spawnCfg.args } : {}),
            }),
            timeoutMs: spawnCfg.timeoutMs,
          })
        },
      },
      // Track 1 — anti-redundant-build hook (Dev-default-ON). The deterministic
      // scanner runs on every code-PASS output; ONLY when it trips a redundancy
      // flag with no addressing explanation is this single-shot model backend
      // consulted (bounded copilot one-shot, one spawn per flagged build). A
      // tripped-and-unaddressed verdict hard-FAILS (redundancy-unexplained).
      // Opt out of the scan with SCNS_QG_REDUNDANCY=0 or the model spawn with
      // SCNS_QG_REDUNDANCY_SPAWN=0; CMD/ARGS/TIMEOUT via SCNS_QG_REDUNDANCY_VERIFIER_*.
      redundancyVerifier: {
        makeVerifierBackend: () => {
          const spawnCfg = loadRedundancyVerifierSpawnConfig(process.env)
          return createRedundancyVerifierBackend({
            ...(spawnCfg.command ? { command: spawnCfg.command } : {}),
            ...(spawnCfg.args ? { args: spawnCfg.args } : {}),
            timeoutMs: spawnCfg.timeoutMs,
          })
        },
      },
      // Phase 13.12.13: feed team outcomes back into the brain's scaling
      // policy so it learns which shape (solo vs team) works for similar
      // tasks. Signature is computed from the source suggestion's title
      // (same input the policy used at decide-time, so the keys match).
      onOutcome: ({ teamId, sourceSuggestionId, passed, score, description, verdict }) => {
        // D2b (design-m1.md §6): close the self-improvement loop — record the
        // proposal's per-entity outcome so the next memory-derived ideation read
        // learns what landed / keeps failing. Default-OFF (SCNS_IDEATE_MEMORY=1);
        // only entity-anchored (memory-path) proposals are tracked, others are skipped.
        if (recordSuggestionOutcomeFn && ideateMemoryHolder.db && sourceSuggestionId) {
          try {
            const s = suggestionStore.get(sourceSuggestionId)
            if (s) {
              recordSuggestionOutcomeFn(
                // Phase D: pass the live experience store (assigned later in startup; this callback
                // runs long after) so the terminal verdict settles the human accept-vs-waste gradient
                // onto the retrievals that informed this entity (bounded + auditable + fail-safe).
                { db: ideateMemoryHolder.db, vault, experienceStore },
                s,
                // FR-056: prefer the arbiter's explicit verdict. The old `passed ? … : 'rejected'`
                // banked every gate failure as the human's refusal, which fed family suppression
                // and scored 0.2 waste on the north-star gradient for a failure John never saw.
                // The fallback keeps the shape total for any caller that omits `verdict`.
                verdict ?? (passed ? 'implemented' : 'failed'),
                score,
              )
            }
          } catch (err) {
            logger.warn({ err, sourceSuggestionId }, 'Failed to record D2b proposal outcome')
          }
        }
        if (!description) return
        try {
          const signature = computeTaskSignature(description)
          recordScalingOutcome(broker.db, {
            task_signature: signature,
            spawned_as: 'team',
            success: passed,
            quality_score: score,
            source_suggestion_id: sourceSuggestionId,
            team_id: teamId,
          })
        } catch (err) {
          logger.warn({ err, teamId }, 'Failed to record team scaling outcome')
        }
      },
    })
    void qualityGateArbiter

    // Phase 13.12.34 — Auto-Merger Service.
    // Subscribes to quality_gate_verdict events, runs structural safety
    // gates, and (when BROKER_AUTO_MERGE=1) fast-forwards verdict-PASS
    // scns/auto/* branches into main. Default OFF; opt-in only.
    // BROKER_AUTO_MERGE_ALLOW_QG_INFRA=1 also allows auto-merging
    // changes to the QG infrastructure itself (chicken-and-egg
    // override; intended for operator-vetted rollouts only).
    const autoMergeEnabled = process.env['BROKER_AUTO_MERGE'] === '1'
    const autoMergeAllowQgInfra = process.env['BROKER_AUTO_MERGE_ALLOW_QG_INFRA'] === '1'
    const { createAutoMerger } = await import('./broker/services/auto-merger.js')
    const { completeTaskByMerge } = await import('./broker/services/task-completion-gate.js')
    const autoMerger = createAutoMerger({
      db: broker.db,
      eventLog: broker.eventLog,
      dispatcher: broker.dispatcher,
      projectRoot: brokerCfg.projectRoot,
      enabled: autoMergeEnabled,
      allowQgInfraMerge: autoMergeAllowQgInfra,
      // P0.3: close the auto-merge → task_completed gap. The auto-merger
      // calls this after a successful merge; the gate's status-guarded
      // UPDATE is idempotent against the verdict subscriber.
      completeTaskOnMerge: (input) => completeTaskByMerge(broker.db, input),
    })
    void autoMerger

    // 3b. Late-bind dashboard deps so dashboard routes are fully functional

    // Memory search — use hybrid search (FTS5 + vector) with keyword-only fallback
    const { hybridSearch, keywordOnlySearch } = await import('./memory/search.js')
    const { intentAwareSearch, parseFusionWeights } = await import('./memory/intent-search.js')
    const { makeSemanticRelevanceScorer } = await import('./memory/semantic-relevance.js')
    // MAGMA live briefing (Stage-4) — the injected memory context IS the measured retrieveContext seam.
    const { retrieveContext } = await import('./memory/retrieval-context.js')
    const { classifyIntent } = await import('./memory/intent.js')
    const { isLearnedEntityQueryEnabled } = await import('./memory/entities/learned-vocab.js')
    const { openExperienceStore, logRetrievalExperience, countExplorations24h, countSettledByArm } =
      await import('./memory/experience-store.js')
    // N1 — the REAL human accept/waste emitting surface: a verbatim same-session re-ask settles the
    // prior briefing's EXACT experienceId as `re-asked` (0.2 waste). Additive + fail-safe + no prod flip.
    const { findReaskPriorId } = await import('./memory/reask-detector.js')
    const { settleHumanOutcomeForAttempt } = await import('./memory/human-outcome.js')
    // GATE (arXiv:2310.11589) — ask-don't-guess intent elicitation. On an under-determined/novel prompt,
    // generate ONE informative clarifying question (deny-all ACP, off the hot path), deliver it into a
    // later briefing, and settle the exact experienceId ACCEPT when the human answers (served) — the
    // clean intent+outcome label the learner needs. Additive + fail-safe; ON (John's go-live decision).
    const { shouldElicit } = await import('./memory/gate-trigger.js')
    const {
      findGateAnswer,
      settleGateAnswered,
      findDeliverableGateQuestion,
      markGateDelivered,
      setGateQuestion,
      computeMaxPriorSimilarity,
      countSessionGateAsks,
      recordGateDecision,
    } = await import('./memory/gate-elicitation.js')
    // GATE 3(b) label validity: the Copilot CLI's own transcript is the ground truth for "did the human
    // actually type this?". Without it the settle guessed authorship and manufactured ACCEPTs from
    // sub-agent briefs (live rows 382/678). Read-only, fail-safe, override with SCNS_COPILOT_SESSION_STORE.
    const { createSessionTranscript } = await import('./memory/session-transcript.js')
    const { describeAuthorshipFallback, classifyPromptAuthorship } =
      await import('./memory/prompt-authorship.js')
    // QUERY CHAINS (Radlinski & Joachims, KDD 2005) — the PRODUCER for the `used`/`edited` cues, which
    // had no emitter at all (only N1's `re-asked` did). Consecutive human turns are a query chain: a
    // reformulation means the prior briefing failed, an approving advance means it served. Abstains
    // unless the evidence is positive, and never labels a briefing the extension aborted before
    // delivery. Emits onto the SAME settle seam; additive + fail-safe.
    const { findChainOutcome, settleChainOutcome, findChainResidue, settleFollowupOutcome } =
      await import('./memory/query-chain.js')
    // The FOLLOW-UP SATISFACTION READER — the ADDITIVE producer for the abstain residue. Measured live
    // 2026-07-28 the deterministic rules classified 5 of 24 eligible pairs (20.8%) and the 19 they
    // dropped were not bare topic changes but substantive engagement with the same need, skewed toward
    // dissatisfaction. Kim et al. (LLM4Eval @ SIGIR 2024, arXiv:2407.13166) follow-up taxonomy + Chow's
    // (1970) reject rule at CLASS-CONDITIONAL thresholds, so the acceptance label the bias literature
    // warns about (Ziegler arXiv:2205.06537, RealHumanEval arXiv:2404.02806) carries the strongest bar.
    const { readFollowupSatisfaction } = await import('./memory/followup-satisfaction.js')
    const { createAcpFollowupProvider, FOLLOWUP_WORKER_SIGNATURE } =
      await import('./memory/followup-satisfaction-acp.js')
    const { createAcpGateQuestionProvider, GATE_WORKER_SIGNATURE } = await (async () => {
      const acp = await import('./memory/gate-question-acp.js')
      const q = await import('./memory/gate-question.js')
      return { ...acp, GATE_WORKER_SIGNATURE: q.GATE_WORKER_SIGNATURE }
    })()
    const { generateEmbedding: gateGenerateEmbedding } = await import('./memory/embeddings.js')
    const {
      selectExplorationArm,
      isExploreRoutingEnabled,
      DEFAULT_EPSILON,
      selectBriefingArm,
      resolveBootstrapEpsilon,
      BRIEFING_CHALLENGER_ARMS,
    } = await import('./memory/explore-router.js')
    const { readCommittedRoutingPolicy } = await import('./memory/routing-policy.js')
    // L1 go-live (M1.1): the live broker maintains deterministic entity/temporal edges on EVERY
    // index pass (cold-start, post-dream, store, archive, scheduled re-index) so M1.2 intent-aware
    // retrieval can route over a complete, fresh graph. Wrap the indexer so all broker-path passes
    // carry the extraction option by default. Library defaults stay OFF (unit tests lock that);
    // opt out in prod with SCNS_ENTITY_EXTRACTION=0.
    //
    // SEMANTIC tier (the embedding-similarity edge subspace) is OPT-IN default-OFF
    // (SCNS_SEMANTIC_EDGES=1): a new MAGMA tier rolls out behind its own flag, and the build is
    // ordered after entity rebuild + orphan prune inside the indexer. Inert until the env is set.
    const indexerModule = await import('./memory/indexer.js')
    // MAGMA node-model (Eq.3 / App C.1): when SCNS_EXTRACT_FACTS is truthy, every content-changing
    // index pass offers its fresh chunks to a real, isolated, deny-all `copilot --acp` extractor
    // that returns self-contained relational fact nodes (stored as derived chunks). Default-OFF
    // (a HARD-STOP `copilot --acp` spawn): without the env flag the extractor is null ⇒ zero facts,
    // byte-identical behavior. The session cwd is an isolated temp dir, NEVER the live checkout.
    const { isFactExtractEnabled, createAcpFactExtractor } =
      await import('./memory/fact-extractor-acp.js')
    const factExtractor = isFactExtractEnabled()
      ? createAcpFactExtractor({ cwd: mkdtempSync(join(tmpdir(), 'scns-factext-')) })
      : undefined
    const entityIndexOpts = {
      extractEntities: process.env.SCNS_ENTITY_EXTRACTION !== '0',
      buildSemantic: process.env.SCNS_SEMANTIC_EDGES === '1',
      // P3: prune low-signal telemetry chunks by default (proven neutral on literal,
      // unchanged on assoc, 0% loss on narrative tiers). Escape hatch: SCNS_PRUNE_LOWSIGNAL=0.
      pruneLowSignal: process.env.SCNS_PRUNE_LOWSIGNAL !== '0',
      // MAGMA node-model — default-OFF, opt-in via SCNS_EXTRACT_FACTS (HARD-STOP real-ACP spawn).
      ...(factExtractor ? { extractFacts: true, factExtractor } : {}),
    }
    const indexVaultSync: typeof indexerModule.indexVaultSync = (
      db,
      v,
      cc,
      ep,
      eo = entityIndexOpts,
    ) => indexerModule.indexVaultSync(db, v, cc, ep, eo)
    const indexVault: typeof indexerModule.indexVault = (db, v, cc, ep, eo = entityIndexOpts) =>
      indexerModule.indexVault(db, v, cc, ep, eo)
    const { createBackfillRunner } = await import('./memory/backfill-runner.js')
    const { createMemoryStore } = await import('./memory/store-adapter.js')
    const { withIndexingLock } = await import('./memory/indexing-lock.js')
    const { resetEmbeddingClient } = await import('./memory/embeddings.js')
    const memoryDbPath = join(scnsDir, 'memory', 'vault.db')
    let memoryDb: import('better-sqlite3').Database | null = null
    let experienceStore: import('./memory/experience-store.js').ExperienceStore | null = null
    let gateTranscript: import('./memory/session-transcript.js').SessionTranscript | null = null
    let embeddingsReady = false
    // T038 [US3] — per-process bound for live shadowed exploration (SCNS_EXPLORE_ROUTING=1).
    let exploreProcessCount = 0
    // T037 [US3] — the arbiter-committed routing arm (null ⇒ incumbent hybrid).
    let committedRoutingArm: import('./memory/arm-router.js').RouterArm | null = null
    const backfillRunner = createBackfillRunner({
      batchSize: parseInt(process.env['SCNS_BACKFILL_BATCH_SIZE'] ?? '16', 10),
    })

    // Expose progressive readiness state to `/api/health` (Phase 13.9.4).
    broker.broker.setProgressiveHealthDeps({
      getEmbeddingBackfillState: () => {
        const s = backfillRunner.getState()
        return {
          status: s.status,
          progress: s.progress,
          errorMessage: s.errorMessage,
        }
      },
    })

    try {
      const { openMemoryDb } = await import('./memory/db.js')
      memoryDb = openMemoryDb(memoryDbPath)
      // Phase B — open the SHARED retrieval-experience store: a SEPARATE sibling file (experience.db)
      // that NEVER touches vault.db, so the guard invariant (vault.db mtime/size) always holds. Default-ON;
      // disable with SCNS_EXPERIENCE_STORE=0. Fail-safe: if it can't open, logging is skipped and retrieval
      // proceeds byte-identically.
      if (process.env.SCNS_EXPERIENCE_STORE !== '0') {
        try {
          experienceStore = openExperienceStore(join(scnsDir, 'memory', 'experience.db'))
        } catch {
          experienceStore = null
        }
        // Open the transcript oracle once, read-only, for the life of the broker. Degradation is
        // ANNOUNCED rather than silent: a quiet fallback is how weak labels get mistaken for strong ones.
        try {
          gateTranscript = createSessionTranscript({ env: process.env })
          if (gateTranscript.mode === 'fallback') {
            console.warn(describeAuthorshipFallback(gateTranscript.reason))
          }
        } catch {
          gateTranscript = null
        }
      }
      // T037 [US3] — the arbiter-committed routing policy (FR-026). readCommittedRoutingPolicy
      // fails CLOSED (absent/corrupt/uncertified ⇒ null ⇒ incumbent hybrid). An explicit SCNS_*
      // env always overrides the committed default (the human override is never removed).
      committedRoutingArm =
        readCommittedRoutingPolicy(
          process.env.SCNS_ROUTING_POLICY_PATH ?? join(scnsDir, 'policy', 'routing-policy.json'),
        )?.arm ?? null
      // D2a: expose the live graph handle to the (default-OFF) memory-ideation readers.
      ideateMemoryHolder.db = memoryDb
      const embDb = memoryDb
      // Defer sync index + backfill OFF the post-listen critical path so the
      // broker's HTTP listener stays responsive during cold start. `setImmediate`
      // lets queued `listen` callbacks / initial requests run first.
      setImmediate(() => {
        void (async () => {
          try {
            const t0 = Date.now()
            const indexStats = await withIndexingLock(async () => indexVaultSync(embDb, vault))
            if (indexStats.filesIndexed > 0) {
              console.log(
                `  Memory index: ${indexStats.filesIndexed} files, ${indexStats.chunksCreated} chunks (${Date.now() - t0}ms)`,
              )
            }
            // Embedding backfill deliberately NOT run on startup — ONNX inference
            // saturates all CPU cores (~85s for ~900 chunks) and was the root cause
            // of the per-restart overheat symptom. Backfill is handled by the
            // scheduled `memory-reindex` task (every 30 min). Opt-in via
            // SCNS_STARTUP_EMBED_BACKFILL=1 for first-run / debugging.
            if (process.env['SCNS_STARTUP_EMBED_BACKFILL'] === '1') {
              await backfillRunner.start(embDb)
              const finalState = backfillRunner.getState()
              if (finalState.status === 'ready' && finalState.progress.total > 0) {
                console.log(`  Embeddings: backfilled ${finalState.progress.done} chunks`)
              }
              embeddingsReady = finalState.status === 'ready'
            } else {
              // Hybrid search degrades gracefully to keyword-only until the
              // scheduled memory-reindex task fills in embeddings.
              embeddingsReady = false
            }
          } catch (err) {
            logger.warn({ err }, 'Memory index failed — using keyword-only search')
          }
        })()
      })
      // Periodic re-indexing + embedding backfill handled by the task scheduler
      // (memory-reindex handler, every 30 min).
    } catch {
      // Memory DB may not exist yet — search will be unavailable
    }

    // Dream daemon — shares the vault, uses its own DB
    const { createDreamDaemon } = await import('./dream/dream-daemon.js')
    const dreamDaemon = createDreamDaemon({
      vaultRootDir,
      dbPath: join(scnsDir, 'dream.db'),
      brokerDb: broker.db,
      projectRoot: brokerCfg.projectRoot,
      gatedNegativeMemoriesShadow: process.env.SCNS_GATED_NEG_MEM_SHADOW === '1',
      // Wedge C phase (e): default-ON (opt out with SCNS_GATED_NEG_MEM_LIVE=0).
      // Routes the daily live self-edit through the non-regression GATE instead of
      // the blind issue-#5 applicator. Real writes still require a HARD-STOP spawn
      // (SCNS_GATED_NEG_MEM_LIVE_ACP=1); without it the gate runs under Mock and
      // refuses to mutate the live guardrails (no autonomous writes).
      gatedNegativeMemoriesLive: process.env.SCNS_GATED_NEG_MEM_LIVE !== '0',
      // M1.3 L2 (DEFAULT-OFF): wire the causal-edge phase when the live memory DB is open.
      // Inert unless SCNS_DREAM_CAUSAL=1 (+ SCNS_DREAM_CAUSAL_ACP=1 selects the real edges).
      ...(memoryDb ? buildCausalDreamConfig(memoryDb, brokerCfg.projectRoot) : {}),
      // SIBLING (DEFAULT-OFF): gated, reversible memory-maintenance / "forgetting" phase.
      // Inert unless SCNS_DREAM_MAINTENANCE=1 AND the live memory DB is open. The guard
      // refuses to decay until the D2a access signal is warm (cold-start coupling fix).
      ...(memoryDb
        ? {
            memoryMaintenance: process.env.SCNS_DREAM_MAINTENANCE === '1',
            maintenanceGuard: DEFAULT_MAINTENANCE_GUARD,
            // WS-1 (DEFAULT-OFF): event/outcome substrate. Inert unless SCNS_EVENT_SEGMENTATION=1.
            eventSegmentation: process.env.SCNS_EVENT_SEGMENTATION === '1',
          }
        : {}),
    })
    // Late-bind the session completed callback now that dream daemon exists
    onSessionCompletedFn = () => dreamDaemon.notifySessionCompleted()

    // W3: children get no CLI session-end hooks, so their dream count gate
    // never fills — a completed team run is the child's unit of new material.
    // Root/singleton is a no-op here (its session hooks already feed the gate).
    {
      const { createTeamCompletionMaterialSensor } = await import('./dream/team-material-sensor.js')
      const dreamMaterialSensor = createTeamCompletionMaterialSensor({
        isMetaChild: (process.env['SCNS_INSTANCE_ID'] ?? '').trim() !== '',
        notifySessionCompleted: () => dreamDaemon.notifySessionCompleted(),
      })
      broker.dispatcher.subscribe({ event_types: ['team_completed'] }, () => {
        dreamMaterialSensor()
      })
    }

    // Memory management — archive store + lessons adapter
    const { createArchiveStore } = await import('./memory/archive-store.js')
    const { parseMemoryMd, serializeMemoryMd, resynthesizeMemoryEntries } =
      await import('./dream/memory-entries.js')
    const { synthesizeEntry, fixTypos } = await import('./dream/extraction.js')
    const { createLessonStore } = await import('./memory/lessons.js')
    const archiveStoreInstance = createArchiveStore({
      rootDir: join(vaultRootDir, 'archive'),
    })
    const lessonStoreInstance = earlyLessonStore
    void createLessonStore // retained for potential future use; silence unused-import lint

    const memoryLessonsAdapter = {
      list: () => {
        const memFile = vault.read('MEMORY.md')
        if (!memFile) return []
        const raw = parseMemoryMd(memFile.content)
        // Apply synthesis on-the-fly so lessons are always clean
        const synthesized = resynthesizeMemoryEntries(raw, synthesizeEntry, fixTypos)
        // Persist IDs back to disk so they're stable for archiving
        const needsPersist = raw.some((e) => !e.id)
        if (needsPersist) {
          vault.write('MEMORY.md', serializeMemoryMd(synthesized))
        }
        return synthesized
      },
      archiveEntry: (
        entryId: string,
        reason: string,
        note?: string,
      ): { success: boolean; archivedId?: string } => {
        const memFile = vault.read('MEMORY.md')
        if (!memFile) return { success: false }
        const entries = parseMemoryMd(memFile.content)
        // Ensure entries have IDs (re-synthesize if needed)
        const synthesized = resynthesizeMemoryEntries(entries, synthesizeEntry, fixTypos)
        const entry = synthesized.find((e) => e.id === entryId)
        if (!entry) return { success: false }

        // Archive the entry
        const archivedId = entryId
        archiveStoreInstance.archive({
          id: archivedId,
          name: entry.name,
          type: entry.type,
          content: entry.content,
          source: entry.source ?? 'MEMORY.md',
          createdAt: entry.createdAt ?? new Date().toISOString(),
          archivedAt: new Date().toISOString(),
          archiveReason: reason as 'user-rejected',
          ...(note ? { rejectionNote: note } : {}),
        })

        // Remove from MEMORY.md
        const remaining = synthesized.filter((e) => e.id !== entryId)
        vault.write('MEMORY.md', serializeMemoryMd(remaining))

        // Re-index so search reflects the change
        if (memoryDb) {
          try {
            indexVaultSync(memoryDb, vault)
          } catch {
            /* best effort */
          }
        }
        return { success: true, archivedId }
      },
    }

    // Tier summary adapter
    const tierSummaryAdapter = {
      getTierSummary: () => {
        const statDir = (subDir: string) => {
          const dirPath = join(vault.rootDir, subDir)
          const files = vault.listFiles(dirPath, subDir)
          return {
            count: files.length,
            totalBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
          }
        }
        // Archive lives outside vault listing (excluded), read directly
        const archiveEntries = archiveStoreInstance.list()
        const embeddedChunks = memoryDb
          ? (
              memoryDb.prepare('SELECT COUNT(*) as cnt FROM chunk_embeddings').get() as {
                cnt: number
              }
            ).cnt
          : 0
        const totalChunks = memoryDb
          ? (memoryDb.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }).cnt
          : 0
        return {
          daily: statDir('daily'),
          weekly: statDir('weekly'),
          monthly: statDir('monthly'),
          archive: {
            count: archiveEntries.length,
            totalBytes: archiveEntries.reduce((sum, e) => sum + (e.content?.length ?? 0), 0),
          },
          embeddingStatus: {
            ready: embeddingsReady,
            embeddedChunks,
            totalChunks,
          },
        }
      },
    }

    const { previewMemoryDeletion, applyMemoryDeletion } =
      await import('./memory/memory-deletion.js')

    broker.broker.setDashboardDeps({
      // WI-6: the dashboard's "run task now" executes the REAL handler.
      schedulerRunNow: (taskId: string) => broker.runScheduledTask(taskId),
      suggestionStore: {
        listByStatus: (status: string) =>
          suggestionStore.list(status as import('./suggest/types.js').SuggestionStatus),
        // The dashboard buttons ARE a human decision, so they record the verdict they mean. Without
        // this an older weekly answer stays attached and outranks the click that followed it.
        approve: (id: string) =>
          suggestionStore.updateStatus(id, 'approved', undefined, undefined, {
            reviewVerdict: 'approve',
          }),
        reject: (id: string) => {
          // Phase 13.12.12: when rejecting a tag-proposal, log the rejection
          // so the extractor won't re-propose the same cluster.
          try {
            const s = suggestionStore.get(id)
            if (s && s.type === 'tag-proposal' && s.tagProposal) {
              tagRejectionStoreInstance.record({
                tagName: s.tagProposal.tagName,
                candidateLessonIds: s.tagProposal.candidateLessonIds,
                reason: 'human-rejected via dashboard',
              })
            }
          } catch {
            /* non-fatal — continue with the status update */
          }
          return suggestionStore.updateStatus(id, 'rejected', undefined, undefined, {
            reviewVerdict: 'reject',
          })
        },
        save: (s: import('./suggest/types.js').Suggestion) => suggestionStore.save(s),
        retry: (id: string) => suggestionStore.clearBackoff(id),
        remove: (id: string) => suggestionStore.remove(id),
        repromote: (id: string) => suggestionStore.repromote(id),
      },
      observationManager: {
        getStatus: () => manager.getStatus(),
        toggleObserver: () => {
          /* not implemented — controlled via config */
        },
        getPlugins: () => manager.getPlugins(),
      },
      memorySearch: memoryDb
        ? {
            search: async (query: string, topK: number) => {
              // T023 [US2] — capture the ORIGINAL query's embedding the hybrid path already computes
              // (first write wins: multi-hop follow-up rounds re-enter baseSearch with derived
              // queries). Zero extra cost; NULL when the vector path never ran (keyword fallback).
              let queryVec: Float32Array | undefined
              // Today's hybrid (FTS5 + vector) path with keyword-only fallback — the base
              // retrieval the intent router falls back to. Behaviorally unchanged from before.
              const baseSearch = async (q: string, k: number) => {
                if (embeddingsReady) {
                  // Bound the hybrid path: embedding now runs in a disposable
                  // worker subprocess, so a cold spawn can cost several seconds.
                  // Race against a budget and fall back to keyword-only so an
                  // interactive query is never blocked on model load.
                  const budgetMs = parseInt(process.env.SCNS_MEMORY_SEARCH_BUDGET_MS ?? '2500', 10)
                  try {
                    let timer: ReturnType<typeof setTimeout> | undefined
                    const timeout = new Promise<never>((_, reject) => {
                      timer = setTimeout(() => reject(new Error('hybrid-search-timeout')), budgetMs)
                    })
                    try {
                      return await Promise.race([
                        hybridSearch(memoryDb!, q, {
                          limit: k,
                          onQueryEmbedding: (v) => {
                            if (!queryVec) queryVec = v
                          },
                        }),
                        timeout,
                      ])
                    } finally {
                      if (timer) clearTimeout(timer)
                    }
                  } catch {
                    // Fallback to keyword-only if hybrid fails or exceeds budget.
                  }
                }
                return keywordOnlySearch(memoryDb!, q, k)
              }
              // M1.2 intent-aware routing: DEFAULT-OFF (opt-in via SCNS_INTENT_ROUTING=1).
              // Measured 2026-06-29 on a vault copy (fusion-quality-harness, n=13): plain
              // hybrid MRR 0.779 / hit@1 9 beats the binary router even WITH entity-relevance
              // (bin-erank 0.698 / hit@1 8) and every fusion variant. The router stays available
              // for opt-in measurement but the live floor is hybrid until a config beats it.
              // SEMANTIC 2-hop augmentation is OPT-IN default-OFF (SCNS_SEMANTIC_ROUTING=1); it
              // only enriches results once semantic edges exist (SCNS_SEMANTIC_EDGES=1). Within
              // that opt-in path the 2-hop candidates are ranked by QUERY relevance (cosine over
              // stored embeddings) unless SCNS_SEMANTIC_RELEVANCE=0; SCNS_SEMANTIC_MIN_WEIGHT
              // optionally gates weak edges.
              // FUSION (MAGMA Alg.1, weighted RRF over hybrid⊕entity⊕semantic⊕temporal) is
              // OPT-IN default-OFF (SCNS_FUSION_ROUTING=1) and supersedes the binary router; its
              // semantic source is likewise relevance-ranked by the same scorer unless
              // SCNS_SEMANTIC_RELEVANCE=0. Per-subspace weights are tunable via SCNS_FUSION_WEIGHTS
              // ("hybrid=1,entity=0.5,semantic=0.8,temporal=0.2"); unset ⇒ the built-in defaults.
              // TIMELINE (WHEN-with-no-entity ⇒ chronological timeline of relevant chunks) is
              // OPT-IN default-OFF (SCNS_TEMPORAL_TIMELINE=1).
              // ENTITY-RELEVANCE (SCNS_ENTITY_RELEVANCE, default-ON; set =0 to disable): relevance-rank
              // the binary router's ENTITY route as a hybrid⊕entity RRF instead of a recency dump,
              // recovering the factual-lookup regression (harness: binary MRR 0.354 → 0.620, found 9→13/14)
              // while keeping the entity substrate. WHEN/WHY routing unchanged.
              const semanticOn = process.env.SCNS_SEMANTIC_ROUTING === '1'
              const fusionOn = process.env.SCNS_FUSION_ROUTING === '1'
              // TRAVERSE (MAGMA Alg.1 Adaptive Traversal Policy — intent-weighted BEAM SEARCH over
              // typed edges from the RRF anchors) is OPT-IN default-OFF (SCNS_TRAVERSE_ROUTING=1).
              // Measured 2026-06-29 on the controlled multi-hop fixture (scripts/multihop-eval-
              // harness.ts, indexed through the real pipeline, deterministic ×2): traverse both-hop
              // recall@3 3/3 vs flat hybrid 2/3 and hard-hop MRR 0.389 vs 0.222 — the graph reaches a
              // buried fact that shares an ENTITY with a relevant anchor but no query tokens, which
              // flat retrieval cannot. Single-hop literal is unregressed (traverse 0.769 ≈ hybrid
              // 0.779). It supersedes the fusion blend when ON; needs the same relevance scorer.
              // T037 [US3]: the arbiter-committed arm sets the DEFAULT; an explicit env always wins.
              const traverseOn =
                process.env.SCNS_TRAVERSE_ROUTING === '1' ||
                (process.env.SCNS_TRAVERSE_ROUTING === undefined && committedRoutingArm === 'magma')
              const fusionWeights = parseFusionWeights(process.env.SCNS_FUSION_WEIGHTS)
              const minWeightRaw = process.env.SCNS_SEMANTIC_MIN_WEIGHT
              const minSemanticWeight = minWeightRaw ? parseFloat(minWeightRaw) : undefined
              // ENTITY-RELEVANCE default-ON (2026-06-28): measured on a vault copy (n=14) to
              // recover the binary recency-dump regression — MRR 0.354→0.620 (hit@1 7/14 = plain
              // hybrid), found 9→13/14, no hit@1 regression, keeps the entity substrate. Set
              // SCNS_ENTITY_RELEVANCE=0 to revert to the legacy recency dump.
              const erankOn = process.env.SCNS_ENTITY_RELEVANCE !== '0'
              // LEARNED-ENTITY QUERY (A-div2 query-side) is DEFAULT-ON (B-EXPLORE §7a, permitted once the
              // B-core experience logger went live; disable with SCNS_LEARNED_ENTITY_QUERY=0): resolve a
              // query naming a LEARNED (App-C.1, non-gazetteer) entity against the data-driven
              // memory_entities vocabulary so it anchors on its entity node/neighborhood (MAGMA Alg.1
              // query→entity anchoring), additive to the gazetteer and INSIDE the default hybrid flow
              // (NOT a switch to a non-hybrid arm). Set =0 ⇒ entity resolution + routing byte-identical to
              // the pre-flip behavior.
              const learnedEntityQueryOn = isLearnedEntityQueryEnabled()
              // T017 [US1] (specs/001-learning-memory-loop) — remaining answer-path levers, OPT-IN
              // default-OFF: MULTIHOP-ITER (SCNS_MULTIHOP_ITER=1, the C2 iterative arm) and
              // EDGE-WEIGHTS (SCNS_EDGE_WEIGHTS=1, the Phase-D beam readout of learned
              // memory_edges.weight — only meaningful when a beam arm is ON). Both unset ⇒ the
              // production answer stays byte-identical (measure-before-flip; no gate has certified
              // a flip).
              const multiHopOn =
                process.env.SCNS_MULTIHOP_ITER === '1' ||
                (process.env.SCNS_MULTIHOP_ITER === undefined &&
                  committedRoutingArm === 'multihop-iter')
              const edgeWeightsOn = process.env.SCNS_EDGE_WEIGHTS === '1'
              const results = await intentAwareSearch(memoryDb!, query, topK, baseSearch, {
                enabled: process.env.SCNS_INTENT_ROUTING === '1',
                semantic: semanticOn,
                fusion: fusionOn,
                traverse: traverseOn,
                multiHop: multiHopOn,
                ...(edgeWeightsOn ? { traversalOptions: { useEdgeWeights: true } } : {}),
                entityRelevanceRank: erankOn,
                learnedEntityQuery: learnedEntityQueryOn,
                timeline: process.env.SCNS_TEMPORAL_TIMELINE === '1',
                ...(fusionWeights ? { fusionWeights } : {}),
                ...((semanticOn || fusionOn || traverseOn) &&
                process.env.SCNS_SEMANTIC_RELEVANCE !== '0'
                  ? { semanticRelevance: makeSemanticRelevanceScorer(memoryDb!, query) }
                  : {}),
                ...(minSemanticWeight !== undefined && Number.isFinite(minSemanticWeight)
                  ? { minSemanticWeight }
                  : {}),
              })
              // Phase B — FAIL-SAFE experience logging on the LIVE prompt path. Post-retrieval, so the
              // returned results are byte-identical. conversation_id/turn are unknown to the live memory
              // adapter ⇒ NULL (gate #8); there is no judge live ⇒ judge_score/human_outcome NULL.
              // T023 [US2]: query_embedding is the vector the hybrid path ALREADY computed (NULL on
              // keyword fallback — still never a synchronous embed just to log, gate #9); the live arm
              // + propensity are logged first-class — today's policy is deterministic exploit (μ=1);
              // when bounded exploration goes live (US3) the explore router's {arm, propensity} land
              // here instead. Calls the SAME shared logger as the offline retrieveContext seam.
              // T024 [US2]: the attempt id is RETURNED so a human verdict can settle that exact id.
              // T038 [US3] — bounded SHADOWED exploration (go-live-to-measure): behind
              // SCNS_EXPLORE_ROUTING=1 the ε-policy may sample a variant arm; its retrieval is run
              // and LOGGED with its selection propensity for IPS/DR, but the PRODUCTION answer
              // returned below is always the exploit results — byte-identical to exploration OFF.
              const exploring = isExploreRoutingEnabled() && experienceStore !== null
              let exploreDecision: ReturnType<typeof selectExplorationArm> | null = null
              if (exploring) {
                try {
                  exploreDecision = selectExplorationArm({
                    rng: Math.random,
                    epsilon: Number(process.env.SCNS_EXPLORE_EPSILON ?? DEFAULT_EPSILON),
                    explorations24h: countExplorations24h(experienceStore!),
                    processCount: exploreProcessCount,
                  })
                } catch {
                  exploreDecision = null /* exploration must never affect the answer */
                }
              }

              let experienceId: number | undefined
              if (experienceStore) {
                try {
                  const liveArm = multiHopOn ? 'multihop-iter' : traverseOn ? 'magma' : 'hybrid'
                  // Off-policy bookkeeping: with exploration OFF the deterministic policy chose this
                  // arm with certainty (μ=1); with exploration ON and an EXPLOIT draw, μ=1−ε (or 1
                  // when a bound forced exploit); when an EXPLORE fired, the policy's action is the
                  // SHADOW row below — this served row is not a policy draw (μ=NULL).
                  const servedPropensity =
                    exploreDecision === null
                      ? 1
                      : exploreDecision.explore
                        ? undefined
                        : exploreDecision.propensity
                  const loggedId = logRetrievalExperience(experienceStore, {
                    queryText: query,
                    levers: {
                      intentRouting: process.env.SCNS_INTENT_ROUTING === '1',
                      semantic: semanticOn,
                      fusion: fusionOn,
                      traverse: traverseOn,
                      multiHop: multiHopOn,
                      ...(edgeWeightsOn ? { traversalOptions: { useEdgeWeights: true } } : {}),
                      entityRelevanceRank: erankOn,
                      learnedEntityQuery: learnedEntityQueryOn,
                      timeline: process.env.SCNS_TEMPORAL_TIMELINE === '1',
                      exploreArm: liveArm,
                      ...(servedPropensity !== undefined ? { propensity: servedPropensity } : {}),
                    },
                    retrievedChunkIds: results.map((r) => r.chunkId),
                    intent: classifyIntent(query),
                    ...(queryVec ? { queryEmbedding: queryVec } : {}),
                    ...(servedPropensity !== undefined ? { propensity: servedPropensity } : {}),
                  })
                  if (loggedId > 0) experienceId = loggedId
                } catch {
                  /* logging never affects live retrieval */
                }
              }

              // The shadow leg: run the sampled variant arm and LOG it (never returned to the user).
              if (experienceStore && exploreDecision?.explore && exploreDecision.arm) {
                try {
                  exploreProcessCount++
                  const arm = exploreDecision.arm
                  const shadowResults = await intentAwareSearch(
                    memoryDb!,
                    query,
                    topK,
                    baseSearch,
                    {
                      enabled: false,
                      ...(arm === 'magma' ? { traverse: true } : { multiHop: true }),
                      ...(process.env.SCNS_SEMANTIC_RELEVANCE !== '0'
                        ? { semanticRelevance: makeSemanticRelevanceScorer(memoryDb!, query) }
                        : {}),
                    },
                  )
                  logRetrievalExperience(experienceStore, {
                    queryText: query,
                    levers: {
                      ...(arm === 'magma' ? { traverse: true } : { multiHop: true }),
                      exploreArm: arm,
                      epsilon: Number(process.env.SCNS_EXPLORE_EPSILON ?? DEFAULT_EPSILON),
                      propensity: exploreDecision.propensity,
                    },
                    retrievedChunkIds: shadowResults.map((r) => r.chunkId),
                    intent: classifyIntent(query),
                    ...(queryVec ? { queryEmbedding: queryVec } : {}),
                    propensity: exploreDecision.propensity,
                  })
                } catch {
                  /* the shadow leg must never affect the production answer */
                }
              }
              return { results, experienceId }
            },
            // MAGMA live briefing (default-ON) — the injected memory context IS the retrieveContext Stage-4
            // seam we measured (traverse + synthesize + maxTokens serialize-all-visited → judged LoCoMo
            // overall 0.768; Increment-2 proved Stage-4 ordering/budgeting is the load-bearing win). Flip
            // back to the plain hybrid join with SCNS_LIVE_MEMORY_BRIEFING=hybrid (one env var). A
            // self-contained budgeted base search (keyword fallback on error/timeout) keeps this ISOLATED
            // from the working search() path above — a cold embedding-worker spawn never blocks the call.
            briefing: async (
              query: string,
              topK: number,
              opts?: { sessionId?: string; cwd?: string; clientTimeoutMs?: number },
            ) => {
              const briefingBase = async (q: string, k: number) => {
                if (embeddingsReady) {
                  const budgetMs = parseInt(process.env.SCNS_MEMORY_SEARCH_BUDGET_MS ?? '2500', 10)
                  try {
                    let timer: ReturnType<typeof setTimeout> | undefined
                    const timeout = new Promise<never>((_, reject) => {
                      timer = setTimeout(() => reject(new Error('hybrid-search-timeout')), budgetMs)
                    })
                    try {
                      return await Promise.race([hybridSearch(memoryDb!, q, { limit: k }), timeout])
                    } finally {
                      if (timer) clearTimeout(timer)
                    }
                  } catch {
                    /* fall back to keyword-only on failure or budget timeout */
                  }
                }
                return keywordOnlySearch(memoryDb!, q, k)
              }
              const magmaOn =
                (process.env.SCNS_LIVE_MEMORY_BRIEFING ?? 'magma').toLowerCase() === 'magma'
              const maxTokens = Number(process.env.SCNS_MAGMA_MAX_TOKENS ?? '3400') || 3400
              // GATE recursion guard: never process our own clarifying-question worker meta-prompt.
              const isGateWorker =
                query.includes(GATE_WORKER_SIGNATURE) || query.includes(FOLLOWUP_WORKER_SIGNATURE)
              // ── RC-1 FIX (2026-07-27): ε-exploration on the LIVE briefing path ──────────────────
              // `selectExplorationArm` was called ONLY from the `search:` handler above, while THIS
              // handler carried 85 of 87 recent live rows — so `SCNS_EXPLORE_ROUTING=1` sat on the
              // broker for days producing zero challenger rows and the reward learner never saw a
              // second arm. The decision reuses the EXISTING policy (explore-router), the EXISTING
              // per-call arm seam (`retrieveContext` cfg), and the EXISTING episode logging fields —
              // no parallel routing lane.
              //
              // LIVE-ANSWER exploration (John's decision, 2026-07-27): when a challenger is sampled its
              // briefing is what the human RECEIVES, so the existing settle producers attribute the
              // human's real accept/waste verdict to the arm that produced what they saw. Shadow
              // logging was rejected: both settle producers scan `ORDER BY id DESC` matching on
              // `query_text`, so a shadow row (same query, higher id) would be settled INSTEAD of the
              // served row — a verdict on an answer the human never received.
              const briefingIncumbent = magmaOn ? 'magma' : 'hybrid'
              const armDecision = selectBriefingArm({
                enabled: isExploreRoutingEnabled() && experienceStore !== null && !isGateWorker,
                // Exploring a machine-authored briefing burns challenger exposure on a row that can
                // never settle (no human is there to answer). Decision-time signal only — the ACCEPT
                // settle uses the transcript oracle and the WASTE settle applies this same classifier
                // inside `findReaskPriorId`, so neither label's validity rests on this call.
                humanAuthored: classifyPromptAuthorship(query).author === 'human',
                incumbent: briefingIncumbent,
                rng: Math.random,
                epsilon: experienceStore
                  ? resolveBootstrapEpsilon(countSettledByArm(experienceStore), {
                      arms: [briefingIncumbent, ...BRIEFING_CHALLENGER_ARMS],
                      ...(process.env.SCNS_EXPLORE_EPSILON
                        ? { override: Number(process.env.SCNS_EXPLORE_EPSILON) }
                        : {}),
                    })
                  : DEFAULT_EPSILON,
                explorations24h: experienceStore
                  ? countExplorations24h(experienceStore, { arms: BRIEFING_CHALLENGER_ARMS })
                  : 0,
                processCount: exploreProcessCount,
              })
              if (armDecision.explore) exploreProcessCount++
              const cfg =
                armDecision.servedArm === 'multihop-iter'
                  ? { intentRouting: false, multiHop: true, synthesize: true, maxTokens, topK }
                  : magmaOn
                    ? { intentRouting: false, traverse: true, synthesize: true, maxTokens, topK }
                    : { intentRouting: false, synthesize: false, topK }
              // ROBUST session key: prefer the Copilot sessionId; fall back to cwd (reliably present at
              // the hook). Observed live: `invocation.sessionId` is undefined at onUserPromptSubmitted, so
              // sessionId-only scoping left conversation_id NULL on every row and the accept/waste loop
              // never fired. The cwd fallback makes the loop live for both N1 (re-ask) and GATE.
              const sessionId = opts?.sessionId?.trim() || undefined
              const cwd = opts?.cwd?.trim() || undefined
              const convKey = sessionId ?? cwd
              // Detect-BEFORE-log (a match is necessarily an EARLIER turn): N1 re-ask (→WASTE) and the GATE
              // answer (→ACCEPT) are mutually exclusive; a delivered pending question is surfaced below.
              const reaskPriorId =
                experienceStore && convKey
                  ? findReaskPriorId(experienceStore, { conversationId: convKey, prompt: query })
                  : null
              const gateAnswer =
                experienceStore && convKey && !isGateWorker
                  ? findGateAnswer(experienceStore, {
                      conversationId: convKey,
                      prompt: query,
                      transcript: gateTranscript,
                    })
                  : null
              const deliverable =
                experienceStore && convKey && !isGateWorker
                  ? findDeliverableGateQuestion(experienceStore, {
                      conversationId: convKey,
                      // A sub-agent or scheduled job requests briefings through this same path. Handing
                      // it the question burns the one-shot delivery flag on a turn no human will read
                      // (live: row 843's question was consumed by a sub-agent brief, row 844).
                      deliveryPrompt: query,
                    })
                  : null
              const r = await retrieveContext(memoryDb!, query, cfg, {
                baseSearch: briefingBase,
                makeSemanticRelevanceScorer: (q: string) =>
                  makeSemanticRelevanceScorer(memoryDb!, q),
                ...(experienceStore
                  ? {
                      experienceLog: {
                        store: experienceStore,
                        episode: {
                          ...(convKey ? { conversationId: convKey } : {}),
                          ...(opts?.clientTimeoutMs
                            ? { clientTimeoutMs: opts.clientTimeoutMs }
                            : {}),
                          // The FINE arm actually served + its selection propensity, for off-policy
                          // IPS/DR. Recorded ONLY when the policy actually acted: with the lever OFF
                          // (or on a machine-authored prompt) these stay absent ⇒ explore_arm and
                          // propensity remain NULL and the row is byte-identical to pre-change.
                          ...(armDecision.record
                            ? {
                                exploreArm: armDecision.servedArm,
                                ...(armDecision.epsilon !== undefined
                                  ? { epsilon: armDecision.epsilon }
                                  : {}),
                                ...(armDecision.propensity !== undefined
                                  ? { propensity: armDecision.propensity }
                                  : {}),
                              }
                            : {}),
                        },
                      },
                    }
                  : {}),
              })
              // Settle the PRIOR turn's outcome onto its EXACT experienceId (first-signal-wins; fail-safe;
              // never affects this response). Re-ask ⇒ waste; a substantive answer to a delivered GATE
              // question ⇒ ACCEPT + records the answer as the higher-confidence elicited intent.
              if (experienceStore && reaskPriorId != null) {
                // Provenance [FR-034/SC-009]: `findReaskPriorId` is an EXACT normalized-text match, so
                // this label is deterministic, not model-derived — a downstream learner must be able to
                // tell it apart from a `followup:` inference without re-deriving how it was produced.
                settleHumanOutcomeForAttempt(
                  experienceStore,
                  reaskPriorId,
                  're-asked',
                  'human-reask:exact-match',
                )
              }
              if (experienceStore && gateAnswer != null) {
                settleGateAnswered(
                  experienceStore,
                  gateAnswer.experienceId,
                  gateAnswer.answer,
                  gateAnswer.source,
                )
              }
              // QUERY-CHAIN settle — runs LAST so the two oracle-grade signals above always win the
              // row (first-signal-wins). This is the only producer of `used`/`edited`, and it settles
              // one turn late by design: a transcript turn is written when the turn COMPLETES, so the
              // chain step becomes visible on the briefing after it.
              if (experienceStore && convKey && !isGateWorker) {
                const chained = findChainOutcome(experienceStore, {
                  conversationId: convKey,
                  transcript: gateTranscript,
                })
                if (chained) settleChainOutcome(experienceStore, chained)
              }
              // FOLLOW-UP READER settle — the ABSTAIN RESIDUE only, fire-and-forget OFF the hot path.
              // It runs after every synchronous producer above, and `settleHumanOutcome` is
              // first-signal-wins at the SQL level (`WHERE human_outcome IS NULL`), so the precedence
              // is preserved twice over: the oracle-grade and deterministic labels always win the row,
              // and this reader can only ever fill one they left NULL. Settling writes to a PRIOR row,
              // so nothing here is on the critical path of the response the human is waiting for.
              // Cleanup retries transient Windows locks and reports any retained directory.
              if (experienceStore && convKey && !isGateWorker) {
                const store = experienceStore
                const residue = findChainResidue(store, {
                  conversationId: convKey,
                  transcript: gateTranscript,
                })
                if (residue) {
                  void withTemporaryDirectory('scns-followup-', async (dir) => {
                    const reading = await readFollowupSatisfaction(
                      createAcpFollowupProvider({ cwd: dir }),
                      { priorQuery: residue.priorQuery, nextTurn: residue.nextTurn },
                    )
                    if (reading) {
                      settleFollowupOutcome(store, {
                        experienceId: residue.experienceId,
                        cue: reading.cue,
                        pattern: reading.pattern,
                        confidence: reading.confidence,
                        nextTurnIndex: residue.nextTurnIndex,
                      })
                    }
                  }).catch((err: unknown) => {
                    logger.warn({ err }, 'Follow-up reader failed; leaving outcome unsettled')
                  })
                }
              }
              // DELIVER a ready clarifying question from a prior turn into THIS briefing (reaches the human).
              let text = r.text
              if (experienceStore && deliverable) {
                text = `${text}\n\n❓ SCNS clarifying question (answering this refines the memory of your intent): ${deliverable.question}`
                // Record WHICH briefing carried it — the settle needs this to locate the delivery turn in
                // the transcript, so "the answer" means the next human turn AFTER the human saw the question.
                markGateDelivered(experienceStore, deliverable.experienceId, {
                  ...(r.experienceId != null ? { deliveredByExperienceId: r.experienceId } : {}),
                })
              }
              // The weekly review's CONSUMER half — the briefing is the one surface John reliably
              // reads, so this is where the review announces itself. Self-silencing: it appears only
              // when work is pending AND no human-explained review has happened in a week, so it can
              // never become the line that gets scrolled past. Fully fail-safe — a nudge must never
              // cost a briefing.
              if (!isGateWorker) {
                try {
                  const { createSuggestionStore } = await import('./suggest/suggestion-store.js')
                  const { buildWeeklyNudge } = await import('./suggest/weekly-session.js')
                  const nudge = buildWeeklyNudge(
                    createSuggestionStore({
                      rootDir: join(resolveScnsHome(), '.scns', 'suggestions'),
                    }),
                    new Date(),
                  )
                  if (nudge) text = `${text}\n\n${nudge}`
                } catch {
                  /* the review nudge is never worth failing a briefing over */
                }
              }
              // GATE trigger + async question generation for the CURRENT prompt. ON. The ENTIRE decision —
              // the embedding/OOS signal, the shouldElicit test, AND the ACP generation — runs fire-and-
              // forget OFF the hot path, so an ambiguous prompt never adds embedding or spawn latency to the
              // briefing. Cleanup failure is reported without failing the briefing.
              if (experienceStore && convKey && !isGateWorker && r.experienceId != null) {
                const expId = r.experienceId
                const store = experienceStore
                const conv = convKey
                void (async () => {
                  try {
                    // OOS/novelty signal (best-effort): cosine to prior embedded episodes when the embedding
                    // worker is warm; otherwise unknown ⇒ the trigger falls back to the underspecification test.
                    let maxSim: number | null = null
                    if (embeddingsReady) {
                      try {
                        const { embedding } = await gateGenerateEmbedding(query)
                        maxSim = computeMaxPriorSimilarity(
                          store,
                          embedding instanceof Float32Array
                            ? embedding
                            : new Float32Array(embedding),
                        )
                      } catch {
                        /* embedding unavailable ⇒ underspecification-only trigger */
                      }
                    }
                    const decision = shouldElicit({
                      prompt: query,
                      maxPriorSimilarity: maxSim,
                      sessionAskCount: countSessionGateAsks(store, conv),
                    })
                    // Phase A — RECORD the decision (ask or decline) before acting on it, so the
                    // funnel is observed rather than inferred. Fail-safe; never gates the response.
                    recordGateDecision(store, expId, {
                      reason: decision.reason,
                      maxPriorSimilarity: maxSim,
                    })
                    if (!decision.ask) return
                    await withTemporaryDirectory('scns-gate-', async (dir) => {
                      const provider = createAcpGateQuestionProvider({ cwd: dir })
                      const q = await provider.generate({ taskDescription: query })
                      if (q) setGateQuestion(store, expId, q)
                    })
                  } catch (err) {
                    logger.warn({ err }, 'GATE elicitation failed; skipping clarifying question')
                  }
                })()
              }
              return { text, chunkIds: r.chunkIds, experienceId: r.experienceId }
            },
          }
        : undefined,
      memoryStore: memoryDb
        ? // #49 — awaits a file-scoped embedding backfill after the sync index,
          // so a stored memory is briefable immediately instead of after the
          // next scheduled re-index (up to ~20 min). See store-adapter.ts.
          createMemoryStore({ db: memoryDb, vault, indexVaultSync })
        : {
            store: async (key: string, value: string) => {
              vault.write(key, value)
              return { stored: true, key }
            },
          },
      memoryStats: {
        getStats: () => {
          const files = vault.listFiles()
          const chunks = memoryDb
            ? (memoryDb.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }).cnt
            : 0
          return {
            available: true,
            totalFiles: files.length,
            indexedChunks: chunks,
            rootDir: vaultRootDir,
          }
        },
      },
      memoryFiles: {
        listFiles: () => vault.listFiles(),
      },
      // #71 — deletion runs in THIS process because this process owns the vault.
      memoryDeletion: memoryDb
        ? {
            run: (input) => {
              const identity = {
                projectId: brokerCfg.projectId,
                projectRoot: brokerCfg.projectRoot,
                instanceId: process.env['SCNS_INSTANCE_ID'] ?? null,
                vaultRoot: vaultRootDir,
                dbPath: memoryDbPath,
              }
              const plan = previewMemoryDeletion({
                vault,
                db: memoryDb!,
                identity,
                targets: [{ path: input.path }],
                mode: input.hard ? 'hard-delete' : 'retire',
              })
              if (!input.apply) return { preview: plan, applied: false }
              return applyMemoryDeletion({
                vault,
                db: memoryDb!,
                identity,
                plan,
                allowPinned: input.allowPinned,
              })
            },
          }
        : undefined,
      negativeMemoryStore: negMemStore,
      memoryLessons: memoryLessonsAdapter,
      lessonStore: lessonStoreInstance,
      archiveStore: archiveStoreInstance,
      memoryTiers: tierSummaryAdapter,
      dreamDaemon: {
        getStatus: () => dreamDaemon.getStatus(),
        triggerRun: async (force: boolean) => {
          const result = force ? await dreamDaemon.forceRun() : await dreamDaemon.run()
          // Re-index vault after successful consolidation so new content is searchable
          if (result.success && !result.skipped && memoryDb) {
            try {
              indexVaultSync(memoryDb, vault)
            } catch (err) {
              logger.warn({ err }, 'Post-dream re-index failed')
            }
          }
          return result
        },
      },
    })

    // Late-bind restart manager deps (dream + housekeeping) for admin routes
    const { runHousekeeping, DEFAULT_HOUSEKEEPING_CONFIG } = await import('./dream/housekeeping.js')
    broker.broker.setRestartManagerDeps({
      dreamDaemon: {
        triggerRun: async (force: boolean) => {
          const result = force ? await dreamDaemon.forceRun() : await dreamDaemon.run()
          if (result.success && !result.skipped && memoryDb) {
            try {
              indexVaultSync(memoryDb, vault)
            } catch (err) {
              logger.warn({ err }, 'Post-restart-dream re-index failed')
            }
          }
          return result
        },
      },
      runHousekeeping: (config) =>
        runHousekeeping(broker.db, { ...DEFAULT_HOUSEKEEPING_CONFIG, ...config }),
      onRollback: async (reason?: string) => {
        // #61 — this used to spawn `bash scripts/broker-restart.sh rollback`,
        // which meant the rollback endpoint was a no-op on Windows: bash is not
        // there, and the failure was invisible because the child was detached
        // with stdio ignored. The cross-platform path uses each platform's own
        // mechanism (bootout/bootstrap, systemctl, or userland respawn).
        const { createBlueGreenDeps } = await import('./cli/blue-green-runtime.js')
        const { getServicePaths, detectPlatform } = await import('./cli/service-generators.js')
        const scnsHome = resolveScnsHome()
        let plistPath: string | undefined
        try {
          plistPath = getServicePaths(detectPlatform()).installPath
        } catch {
          plistPath = undefined
        }
        logger.warn({ reason, platform: process.platform }, 'Rollback requested')
        try {
          const deps = createBlueGreenDeps({
            platform: process.platform,
            port,
            scnsHome,
            execPath: process.execPath,
            ...(process.argv[1] ? { brokerEntry: process.argv[1] } : {}),
            ...(process.getuid ? { uid: process.getuid() } : {}),
            ...(plistPath ? { plistPath } : {}),
            ...(process.env['BROKER_TOKEN']
              ? { token: process.env['BROKER_TOKEN'] as string }
              : {}),
          })
          // Deliberately not awaited past construction: the rollback stops THIS
          // process, so the HTTP response must already be on its way out.
          void deps
            .rollback()
            .then((outcome) => logger.warn({ outcome }, 'Rollback executed'))
            .catch((err) => logger.error({ err }, 'Rollback failed'))
        } catch (err) {
          logger.error({ err }, 'Rollback could not be constructed')
          throw err
        }
      },
    })

    // Register task scheduler handlers (late-bound — scheduler already running)
    broker.registerTaskHandler('dream-consolidation', async () => {
      const result = await dreamDaemon.run()
      if (result.success && !result.skipped && memoryDb) {
        try {
          indexVaultSync(memoryDb, vault)
        } catch (err) {
          logger.warn({ err }, 'Post-dream re-index failed')
        }
      }
      // R3: a gate-skip or failed run must not be recorded as scheduler
      // 'success' — that hid 22 consecutive skips behind last_status=success.
      if (result.skipped) {
        return { status: 'skipped', detail: `gate: ${result.skipReason ?? 'unknown'}` }
      }
      if (!result.success) {
        return { status: 'failure', detail: result.error ?? 'dream run failed' }
      }
      return { status: 'success' }
    })

    broker.registerTaskHandler('memory-reindex', async () => {
      if (!memoryDb) return
      // Cooldown gate: skip if a successful run completed within the last
      // MEMORY_REINDEX_COOLDOWN_MS. Prevents scheduler catch-up from firing
      // a 60–90s ONNX embedding job on every broker restart (the original
      // overheat symptom). Stored in broker's shared_state so it survives
      // restarts. Override via SCNS_MEMORY_REINDEX_COOLDOWN_SEC.
      const cooldownSec = parseInt(process.env['SCNS_MEMORY_REINDEX_COOLDOWN_SEC'] ?? '1200', 10)
      const cooldownMs = Math.max(0, cooldownSec) * 1000
      const stateKey = 'memory-reindex:last_completed_ms'
      const getLast = broker.db.prepare<[string], { value: string }>(
        'SELECT value FROM shared_state WHERE key = ?',
      )
      const setLast = broker.db.prepare(
        "INSERT INTO shared_state (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
      )
      const now = Date.now()
      if (cooldownMs > 0) {
        try {
          const row = getLast.get(stateKey)
          if (row && typeof row.value === 'string') {
            const last = parseInt(row.value, 10)
            if (Number.isFinite(last) && now - last < cooldownMs) {
              logger.info(
                { lastRunAgeMs: now - last, cooldownMs },
                'memory-reindex skipped — within cooldown window',
              )
              return
            }
          }
        } catch {
          // ignore — fall through to run
        }
      }
      await withIndexingLock(async () => {
        try {
          await indexVault(memoryDb!, vault)
          embeddingsReady = true
        } catch {
          try {
            indexVaultSync(memoryDb!, vault)
          } catch (err) {
            logger.warn({ err }, 'Scheduled re-index failed')
          }
        }
      })
      try {
        await backfillRunner.start(memoryDb!)
        const st = backfillRunner.getState()
        if (st.status === 'ready') embeddingsReady = true
      } catch (err) {
        logger.warn({ err }, 'Scheduled embedding backfill failed')
      } finally {
        // Tear down the disposable embedding worker subprocess after every
        // reindex batch. The ~1.2 GB FastEmbed/ONNX native arena lives ENTIRELY
        // in that child (the broker main process stays ~40 MB), so killing it
        // returns the memory to the OS immediately. Fix for the memory-creep
        // regression (RSS grew to >1.5 GB over ~2h while V8 heap held ~30 MB —
        // the leak was native mmap outside V8, unreclaimable by release()).
        // Best-effort: must never fail a scheduled task.
        try {
          const memBefore = process.memoryUsage()
          await resetEmbeddingClient()
          logger.info(
            {
              rssMbBefore: Math.round(memBefore.rss / 1024 / 1024),
              externalMbBefore: Math.round(memBefore.external / 1024 / 1024),
            },
            'memory-reindex: resetEmbeddingClient fired — native tensors released',
          )
        } catch (err) {
          logger.warn({ err }, 'resetEmbeddingClient failed (non-fatal)')
        }
      }
      try {
        setLast.run(stateKey, String(Date.now()))
      } catch {
        // ignore — cooldown is best-effort
      }
    })

    // Phase D — the reward learner's SCHEDULED consumer. `learnArmValues` previously ran only when a
    // human remembered to invoke `scripts/reward-report.ts` by hand, so the accept-vs-waste loop had
    // no standing observer. This dogfoods the broker's own scheduler (SCNS schedules its own jobs)
    // rather than adding an external cron, and calls the SAME `runRewardReport` the script calls.
    // READ-ONLY by construction: the store is opened `{readonly, fileMustExist}` and nothing is
    // promoted here — a proposal only ever becomes a recommendation for the judged gate.
    broker.registerTaskHandler('reward-report', async () => {
      try {
        const { runRewardReport } = await import('./reward/reward-report-run.js')
        const out = runRewardReport()
        if (!out.ok) {
          logger.info({ task: 'reward-report' }, out.text)
          return
        }
        // An `insufficient-data` / single-arm report is the CORRECT output until exploration has
        // settled rows on a second arm — a measured null, logged honestly, not an error.
        logger.info(
          {
            task: 'reward-report',
            settledRows: out.settledRows,
            arms: out.arms,
            armCount: out.arms.length,
          },
          `reward-report:\n${out.text}`,
        )
      } catch (err) {
        logger.warn({ err, task: 'reward-report' }, 'reward-report failed')
      }
    })

    // The weekly review's PRODUCER half. SCNS is the actor here: it assembles the packet, renders the
    // routing-accuracy report, writes it to disk, and brings the review to John — rather than
    // printing a number into a log nobody reads.
    //
    // Step 2 (2026-08-15, NORTH_STAR "Retrieval design intent"): the promote/retire verdict and the
    // `arm-promotion` proposal are GONE. `magma` and `multihop-iter` are purpose-routed tools, not
    // rivals; the report now says whether each query went to the tool its hop-shape required. The
    // scheduler task id `weekly-promotion-review` is a stored key and is kept unchanged.
    broker.registerTaskHandler('weekly-promotion-review', async () => {
      try {
        const { createSuggestionStore } = await import('./suggest/suggestion-store.js')
        const { buildWeeklySession, explainedTerminalSuggestions } =
          await import('./suggest/weekly-session.js')

        const store = createSuggestionStore({
          rootDir: join(resolveScnsHome(), '.scns', 'suggestions'),
        })

        // Triage BEFORE building the packet. Duplicates are rejected by machine so they stop
        // resurfacing, and survivors get the spec that makes them answerable at all.
        const { runProposalTriage } = await import('./suggest/triage-wiring.js')
        const triage = await runProposalTriage({ store, scnsHome: resolveScnsHome() })
        if (triage.rejected > 0 || triage.specced > 0) {
          logger.info(
            { task: 'weekly-promotion-review', ...triage },
            `weekly-promotion-review: triaged — ${triage.rejected} duplicate(s) auto-rejected, ${triage.specced} spec(s) written`,
          )
        }

        const session = buildWeeklySession({ store, now: new Date() })

        // F1 (CRITICAL, John's ruling 2026-08-02): RENDER the report here rather than telling the
        // human to go run `scns review weekly`. Same renderer as the CLI — one renderer, two callers —
        // so the scheduled and ad-hoc runs can never disagree. The routing section reads the
        // experience store READ-ONLY and is fail-safe: an unreadable corpus renders as UNKNOWN (never
        // as zeros), and the report file is still written.
        const now = new Date()
        const { renderRoutingAccuracySection, renderWeeklyReviewDocument, writeWeeklyReviewFile } =
          await import('./suggest/weekly-report.js')
        const learning = renderRoutingAccuracySection({
          scnsDir: join(resolveScnsHome(), '.scns'),
        })
        // The write is guarded on its own: it is NOT the reason this task exists to run. A full disk
        // or a read-only home must not skip the `proposal_outcomes` sweep below, which used to run
        // unconditionally and carries John's already-written reasons the last mile to the learner.
        let reportPath: string | null = null
        try {
          reportPath = writeWeeklyReviewFile({
            scnsDir: join(resolveScnsHome(), '.scns'),
            now,
            text: renderWeeklyReviewDocument({
              session,
              learningText: learning.text,
              getSuggestion: (id) => store.get(id),
            }),
          })
        } catch (err) {
          logger.error(
            { task: 'weekly-promotion-review', err },
            'weekly-promotion-review: could not write the weekly report file — run `scns review weekly` to read it',
          )
        }

        const where = reportPath ? `report written to ${reportPath}` : 'report file UNWRITABLE'
        logger.info(
          {
            task: 'weekly-promotion-review',
            selected: session.packet.items.length,
            selectedPending: session.packet.selectedPending,
            selectedBackfill: session.packet.selectedBackfill,
            totalPending: session.packet.totalPending,
            nonActionablePending: session.packet.nonActionablePending,
            unexplained: session.packet.totalUnexplained,
            routingClassifier: learning.report?.classifierVersion ?? null,
            routingAgreement: learning.report?.agreement.rate ?? null,
            routingClassifiedRows: learning.report?.agreement.n ?? null,
            routingCutoverMet: learning.report?.cutover.met ?? null,
            evidenceError: learning.evidenceError,
            reportPath,
            engagementFlags: session.engagement.flags,
            readyToEscalate: session.engagement.readyToEscalate,
          },
          session.hasWork
            ? `weekly-promotion-review: ${session.packet.items.length} item(s) awaiting review — ${where}`
            : `weekly-promotion-review: nothing to review this week — ${where}`,
        )

        // BRING THE REVIEW TO JOHN. Everything above this line ends at a file on disk and a pino
        // line in a log nobody is watching — and the one instruction the log gave, "run
        // `scns review weekly`", is not runnable: `scns` was never `npm link`ed, so `which scns`
        // finds nothing in a login shell. The review is the ONLY source of human accept/reject
        // labels, so a review that does not happen is a week of labels that do not exist.
        //
        // Only when there is work: popping a window for an empty week trains him to ignore it.
        // Placed AFTER the report is written (he needs something to read) and BEFORE the outcome
        // sweep below, which must run whatever happens here — hence a returned outcome, never a
        // throw, and the outcome is logged so a silent failure is visible.
        if (session.hasWork) {
          const { resolveReviewCommand, launchInteractiveReview } =
            await import('./suggest/review-terminal.js')
          // Self-locating: the broker's PATH is `/usr/bin:/bin:/usr/sbin:/sbin` plus its own node
          // dir, so both paths come from this process rather than being hardcoded or assumed.
          const outcome = launchInteractiveReview({
            command: resolveReviewCommand({
              execPath: process.execPath,
              cliPath: process.argv[1] ?? 'dist/cli.js',
              env: process.env,
            }),
          })
          logger.info(
            { task: 'weekly-promotion-review', launch: outcome },
            outcome.launched
              ? `weekly-promotion-review: opened an interactive review in ${outcome.app}`
              : `weekly-promotion-review: could NOT open an interactive terminal (${outcome.reason}) — the review is still readable at ${reportPath ?? 'the report path'}`,
          )
        }

        // Carry John's reasons the last mile — into `proposal_outcomes`, where the learner reads.
        // Without this the reasons he wrote would sit in markdown: `recordSuggestionOutcome`'s only
        // other caller is the team-completion callback, which never fires for a rejection because a
        // rejected suggestion is never promoted and no team ever runs. The broker sweeps because it
        // already owns the vault handle; `recordProposalOutcome` is idempotent, so this is safe to
        // re-run every week over the same history.
        //
        // JUDGE 2026-08-05 (finding 4): "never fires for a rejection" is true and is NOT the whole
        // picture. It fires for APPROVALS, and it is ungated — `explainedTerminalSuggestions`
        // filters this sweep on `hasHumanRationale`, the callback filters nothing. An approved
        // wordless verdict therefore still reaches `proposal_outcomes` raw via that path. See the
        // KNOWN GAP note on `explainedTerminalSuggestions`; the decision is John's, not this
        // commit's.
        if (recordSuggestionOutcomeFn && ideateMemoryHolder.db) {
          const db = ideateMemoryHolder.db
          const write = recordSuggestionOutcomeFn
          let swept = 0
          let noSignal = 0
          for (const s of explainedTerminalSuggestions(store)) {
            try {
              const r = write({ db, vault, experienceStore }, s, s.status)
              if (r.recorded) swept++
              // FR-051a: an `explain`/`defer` answer is deliberately banked as nothing. Counted so
              // "his words reached the learner" and "his words were correctly withheld from the
              // learner" are distinguishable in the log rather than both looking like silence.
              else if (r.skipReason === 'human-verdict-carries-no-signal') noSignal++
            } catch (err) {
              logger.warn(
                { err, suggestionId: s.id, task: 'weekly-promotion-review' },
                'failed to record a human-explained outcome',
              )
            }
          }
          if (swept > 0) {
            logger.info(
              { task: 'weekly-promotion-review', swept },
              `weekly-promotion-review: carried ${swept} human-explained outcome(s) into proposal_outcomes`,
            )
          }
          if (noSignal > 0) {
            logger.info(
              { task: 'weekly-promotion-review', noSignal },
              `weekly-promotion-review: withheld ${noSignal} answer(s) from the learner — "explain"/"defer" is not an accept-vs-waste signal (the words are still in the rationale corpus)`,
            )
          }
        }

        // FR-046b / FR-053a: carry the markdown rationales the CLI wrote at decision time into the
        // `decision_rationale` rows. The broker does this because it owns the vault db handle —
        // the review CLI deliberately never opens it, which is what keeps the single-writer
        // invariant intact while still making John's words durable the instant he types them.
        // Idempotent by `source_path`, so re-sweeping the same history adds nothing.
        if (ideateMemoryHolder.db) {
          try {
            const { ingestDecisionRationales } = await import('./memory/decision-rationale.js')
            const ing = ingestDecisionRationales({ db: ideateMemoryHolder.db, vault })
            if (ing.ingested > 0 || ing.errors.length > 0) {
              logger.info(
                {
                  task: 'weekly-promotion-review',
                  scanned: ing.scanned,
                  ingested: ing.ingested,
                  errors: ing.errors,
                },
                `weekly-promotion-review: ingested ${ing.ingested} decision rationale(s)`,
              )
            }
          } catch (err) {
            logger.warn(
              { err, task: 'weekly-promotion-review' },
              'failed to ingest decision rationales',
            )
          }
        }
      } catch (err) {
        logger.warn({ err, task: 'weekly-promotion-review' }, 'weekly-promotion-review failed')
      }
    })

    // The HARVEST half of the accept-vs-waste loop. The producers it drives are the same ones the
    // live briefing hook calls — but the hook can only reach them when a SECOND briefing arrives in
    // the SAME conversation, and 902 of 911 live conversations (99.0%) carry exactly one. So the
    // labels the routing learner needs were never collected, and every challenger arm reported
    // BLOCKED for want of `minN` settled rows while eligible pairs sat unharvested.
    //
    // SCNS schedules this itself (broker scheduler, not launchd/cron) and it is fail-safe by
    // construction: no oracle ⇒ zero labels, bounded ACP reads per run, and it settles only rows the
    // existing rules already judge labellable.
    broker.registerTaskHandler('settle-sweep', async () => {
      if (!experienceStore || !gateTranscript) return
      try {
        const { runSettleSweep } = await import('./memory/settle-sweep.js')
        const { readFollowupSatisfaction } = await import('./memory/followup-satisfaction.js')
        const { createAcpFollowupProvider } = await import('./memory/followup-satisfaction-acp.js')
        const summary = await runSettleSweep({
          store: experienceStore,
          transcript: gateTranscript,
          readFollowup: (req) =>
            withTemporaryDirectory('scns-sweep-', (dir) =>
              readFollowupSatisfaction(createAcpFollowupProvider({ cwd: dir }), req),
            ),
        })
        logger.info(
          { task: 'settle-sweep', ...summary, settledIds: summary.settledIds.slice(0, 50) },
          `settle-sweep: scanned ${summary.conversationsScanned} conversation(s) — settled ${summary.chainSettled} by chain rule, ${summary.followupSettled} by follow-up read, ${summary.followupAbstained} abstained, ${summary.deferredByBackoff} deferred by refusal back-off (reads: ${summary.readsOnNewPairs} new / ${summary.readsOnRetriedPairs} retried)`,
        )
      } catch (err) {
        logger.warn({ err, task: 'settle-sweep' }, 'settle-sweep failed')
      }
    })

    broker.registerTaskHandler('otel-cleanup', async () => {
      const { isRetentionDisabled } = await import('./retention/retention-policy.js')
      const startedAt = Date.now()
      // P5c: kill-switch — check master + per-task before doing any work.
      if (isRetentionDisabled(broker.db, 'otel')) {
        logger.info({ task: 'otel' }, 'otel-cleanup skipped — retention kill-switch active')
        try {
          broker.eventLog.retentionSwept(null, {
            task: 'otel',
            killSwitched: true,
            success: true,
            durationMs: Date.now() - startedAt,
          })
        } catch {
          /* event-emit failure must not fail the task */
        }
        return
      }
      const result = runHousekeeping(broker.db, {
        ...DEFAULT_HOUSEKEEPING_CONFIG,
        vacuum: false,
      })
      try {
        broker.eventLog.retentionSwept(null, {
          task: 'otel',
          killSwitched: false,
          success: result.success,
          durationMs: Date.now() - startedAt,
          prunedCounts: {
            otelSpans: result.otelSpansPruned,
            otelMetrics: result.otelMetricsPruned,
            events: result.eventsPruned,
            taskRunHistory: result.taskRunHistoryPruned,
            messagesHistory: result.messagesHistoryPruned,
            otelTraceGroups: result.otelTraceGroupsPruned ?? 0,
          },
          freedBytes: result.otelSpansFreedBytesEstimated ?? 0,
          ...(result.error ? { error: result.error } : {}),
        })
      } catch {
        /* event-emit failure must not fail the task */
      }
    })

    broker.registerTaskHandler('auto-scale-tick', async () => {
      const decision = await broker.orchestrator.tickAutoScaler()
      if (decision.action !== 'hold') {
        logger.info(
          { action: decision.action, count: decision.count, reason: decision.reason },
          'Auto-scaler decision',
        )
      }
    })

    broker.registerTaskHandler('telemetry-rotation', async () => {
      const {
        rotateTelemetryIfNeeded,
        resolveTelemetryRotationConfig,
        sweepParkedTelemetry,
        pruneTelemetryArchives,
      } = await import('./retention/telemetry-rotator.js')
      const { isRetentionDisabled } = await import('./retention/retention-policy.js')
      const cfg = resolveTelemetryRotationConfig({
        ...(opts.otelPath ? { filePath: opts.otelPath } : {}),
      })
      const startedAt = Date.now()
      // P5c: kill-switch — check master + per-task before doing any work.
      if (isRetentionDisabled(broker.db, 'telemetry')) {
        logger.info(
          { task: 'telemetry' },
          'telemetry-rotation skipped — retention kill-switch active',
        )
        try {
          broker.eventLog.retentionSwept(null, {
            task: 'telemetry',
            killSwitched: true,
            success: true,
            durationMs: Date.now() - startedAt,
          })
        } catch {
          /* event-emit failure must not fail the task */
        }
        return
      }
      let rotated = false
      let rotateBeforeBytes = 0
      let sweptCount = 0
      let sweptFreedBytes = 0
      let prunedCount = 0
      let prunedFreedBytes = 0
      let capExceeded = false
      let errors = 0
      try {
        const result = await rotateTelemetryIfNeeded(cfg)
        if (result.rotated) {
          rotated = true
          rotateBeforeBytes = result.beforeBytes
          logger.info(
            {
              filePath: cfg.filePath,
              beforeBytes: result.beforeBytes,
              archivePath: result.archivePath,
              ...(result.removedPath ? { removedPath: result.removedPath } : {}),
            },
            'Telemetry log rotated',
          )
        }
      } catch (err) {
        errors += 1
        logger.warn({ err, filePath: cfg.filePath }, 'Telemetry rotation failed (non-fatal)')
      }
      try {
        const swept = sweepParkedTelemetry(cfg.filePath)
        if (swept.removed.length > 0) {
          sweptCount = swept.removed.length
          sweptFreedBytes = swept.freedBytes
          logger.info(
            { count: swept.removed.length, freedBytes: swept.freedBytes, removed: swept.removed },
            'Swept orphaned parked telemetry files',
          )
        }
      } catch (err) {
        errors += 1
        logger.warn({ err, filePath: cfg.filePath }, 'Parked telemetry sweep failed (non-fatal)')
      }
      // P5a: always enforce the total-bytes cap, even when this tick did
      // not trigger a rotation. Without this, a hostile pre-policy
      // archive sitting at `.3` would squat until ≥3 more rotations
      // shifted it off the retain window.
      try {
        const pruned = pruneTelemetryArchives(cfg)
        capExceeded = pruned.capExceeded
        if (pruned.removed.length > 0) {
          prunedCount = pruned.removed.length
          prunedFreedBytes = pruned.freedBytes
          logger.info(
            {
              count: pruned.removed.length,
              freedBytes: pruned.freedBytes,
              removed: pruned.removed,
              maxTotalBytes: cfg.maxTotalBytes,
              capExceeded: pruned.capExceeded,
            },
            'Pruned oversized telemetry archives',
          )
        } else if (pruned.capExceeded) {
          logger.warn(
            { filePath: cfg.filePath, maxTotalBytes: cfg.maxTotalBytes },
            'Telemetry archive total over cap but only .1 remains — not pruning live inode',
          )
        }
      } catch (err) {
        errors += 1
        logger.warn({ err, filePath: cfg.filePath }, 'Telemetry archive prune failed (non-fatal)')
      }
      try {
        broker.eventLog.retentionSwept(null, {
          task: 'telemetry',
          killSwitched: false,
          success: errors === 0,
          durationMs: Date.now() - startedAt,
          freedBytes: sweptFreedBytes + prunedFreedBytes,
          prunedCounts: {
            archivesPruned: prunedCount,
            parkedSwept: sweptCount,
            rotated: rotated ? 1 : 0,
          },
          ...(rotateBeforeBytes > 0 ? { rotateBeforeBytes } : {}),
          ...(capExceeded ? { capExceeded: true } : {}),
        })
      } catch {
        /* event-emit failure must not fail the task */
      }
    })

    // Synth ideation on a timer (advisory). Double default-OFF: the
    // scheduled_tasks row is enabled but the handler is a no-op unless
    // SCNS_IDEATE_SYNTH=1. When on, it runs the deterministic, evidence-first
    // synthesizer (no agent spawn, no network) and writes proposals to
    // ~/.scns/ideation for human review. Never auto-implements.
    broker.registerTaskHandler('synth-ideation', async () => {
      const { synthEnabledFromEnv } = await import('./ideate/index.js')
      if (!synthEnabledFromEnv(process.env)) {
        logger.debug('synth-ideation skipped — SCNS_IDEATE_SYNTH not set')
        return
      }
      const { runIdeateCommand } = await import('./cli/ideate.js')
      await runIdeateCommand({ k: 5, spawn: true, json: false })
    })

    // Step 3 (anti-drift) M2 — session-end NORTH_STAR nudge. Subscribes to
    // the hook_received stream (session-end only) and, when a working
    // window landed src//specs/ commits with no docs/NORTH_STAR.md commit,
    // maintains ONE deduplicated GitHub reminder + emits north_star_nudged.
    // Nudge only: never blocks a session, silent when things are fine.
    // Opt-IN (#53 AC4) — it files a GitHub issue on the operator's
    // account: set BROKER_NORTH_STAR_NUDGE=1 (or SCNS_UNATTENDED=1).
    const { createNorthStarNudge } = await import('./broker/services/north-star-nudge.js')
    const sessionStartStmt = broker.db.prepare<[string], { created_at: string }>(
      'SELECT created_at FROM sessions WHERE id = ?',
    )
    const northStarNudge = createNorthStarNudge({
      eventLog: broker.eventLog,
      dispatcher: broker.dispatcher,
      projectRoot: brokerCfg.projectRoot,
      enabled: isUnattendedEnabled('north-star-nudge'),
      getSessionStart: (sessionId) => {
        const row = sessionStartStmt.get(sessionId)
        if (!row?.created_at) return null
        // sessions.created_at is datetime('now') — UTC but zone-less
        // ('YYYY-MM-DD HH:MM:SS'). git --since would read that as LOCAL
        // time, so stamp the zone explicitly before handing it over.
        const raw = row.created_at
        return /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`
      },
    })
    void northStarNudge

    // Step 3 (anti-drift) M3 — daily staleness + deferral watchdog. The
    // specs tree lives OUTSIDE the repo (scns_root/specs), default
    // ../specs relative to projectRoot; override with SCNS_SPECS_DIR.
    // Opt-IN (#53 AC4): SCNS_DRIFT_WATCHDOG=1 (or SCNS_UNATTENDED=1) —
    // it files GitHub issues. Must register BEFORE startScheduler()
    // below or the startup tick would skip it.
    const { runDriftWatchdog } = await import('./broker/services/drift-watchdog.js')
    broker.registerTaskHandler('drift-watchdog', async () => {
      if (!isUnattendedEnabled('drift-watchdog')) {
        return { status: 'skipped', detail: unattendedStatusDetail('drift-watchdog') }
      }
      // Meta-broker children run this same code with projectRoot = the
      // child repo, which has no NORTH_STAR and must never receive
      // staleness issues about one. The doc's presence is the opt-in.
      if (!existsSync(join(brokerCfg.projectRoot, 'docs', 'NORTH_STAR.md'))) {
        return { status: 'skipped', detail: 'no docs/NORTH_STAR.md in this project' }
      }
      const outcome = await runDriftWatchdog({
        projectRoot: brokerCfg.projectRoot,
        specsDir: process.env['SCNS_SPECS_DIR'] ?? join(brokerCfg.projectRoot, '..', 'specs'),
        eventLog: broker.eventLog,
      })
      if (outcome.status === 'error') {
        return { status: 'failure', detail: 'north-star git-age probe failed' }
      }
      const detail = outcome.action ? `${outcome.status}:${outcome.action}` : outcome.status
      return { status: 'success', detail }
    })

    // Start scheduler now that all handlers are registered
    broker.startScheduler()

    // Brain spawn adapter — bridges brain decisions to agent spawner
    const { createBrainSpawnAdapter } = await import('./brain/spawn-adapter.js')
    const brainSpawnAdapter = createBrainSpawnAdapter({
      db: broker.db,
      spawner: broker.agentSpawner,
      preferredLaunchMethod: 'acp',
      workingDir: brokerCfg.projectRoot,
    })

    // Bug 2: durable self-issue lease tracker. Replaces the old fire-and-forget
    // `ingested` boolean with an in-progress/done state machine in shared_state
    // so a signal enqueued but lost to a broker restart is re-enqueued, not
    // stranded. Shared by the ingest handler + the team_completed subscriber.
    const { createSelfIssueTracker } = await import('./brain/self-issue-tracker.js')
    const { createHumanFeedbackTaskBridge } = await import('./brain/human-feedback-bridge.js')
    const {
      handleSelfIssueTeamCompletion,
      handleSelfIssueGateVerdict,
      evaluateSelfIssueSignalForEnqueue,
    } = await import('./brain/self-issue-completion.js')
    const selfIssueTracker = createSelfIssueTracker(broker.db)

    // F1 — Gate-PASS Publisher. Subscribes to quality_gate_verdict and,
    // on a PASS for an scns/auto/* branch, pushes the branch to origin and
    // opens a PR via `gh` carrying the verdict evidence. Post-verdict by
    // construction (the verdict event has already been emitted when this
    // subscriber runs), idempotent under re-delivery (gh pr list probe),
    // and it never touches the remote's default branch. Opt-IN (#53 AC4)
    // — this pushes to origin and opens PRs on the operator's account:
    // set BROKER_PUBLISH_GATE_PASS=1 (or SCNS_UNATTENDED=1). Wired here
    // (not next to the auto-merger at its seam above) because the source-
    // issue linkage needs the self-issue tracker, created just above.
    const { createGatePassPublisher } = await import('./broker/services/gate-pass-publisher.js')
    const { issueNumberFromSignalKey } = await import('./brain/self-issue-source.js')
    const gatePassPublisher = createGatePassPublisher({
      eventLog: broker.eventLog,
      dispatcher: broker.dispatcher,
      projectRoot: brokerCfg.projectRoot,
      enabled: isUnattendedEnabled('gate-pass-publisher'),
      resolveSourceIssue: (teamId) => {
        const signalKey = selfIssueTracker.findByTeam(teamId)
        return signalKey ? issueNumberFromSignalKey(signalKey) : null
      },
    })
    void gatePassPublisher

    // Phase 13.9.1: bridge team/complex suggestions to real team spawns.
    const brainOnSpawnTeam = async (input: {
      readonly suggestionId: string
      readonly goal: string
      readonly roles: readonly string[]
      readonly description?: string
    }): Promise<{ readonly teamId: string; readonly memberSessionIds: readonly string[] }> => {
      const teamId = `team-sugg-${input.suggestionId.slice(0, 8)}`
      const existing = broker.db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)
      if (!existing) {
        broker.db
          .prepare('INSERT INTO teams (id, name, description) VALUES (@id, @name, @description)')
          .run({ id: teamId, name: teamId, description: `Goal: ${input.goal}` })
        broker.eventLog.teamCreated(null, {
          team_id: teamId,
          name: teamId,
          source: 'brain-suggestion',
          suggestion_id: input.suggestionId,
        })
      }
      const memberSessionIds: string[] = []
      const projectRoot = brokerCfg.projectRoot
      for (const role of input.roles) {
        const prompt = buildTeamMemberPrompt({
          role,
          teamId,
          goal: input.goal,
          description: input.description,
          projectRoot,
        })
        try {
          const sessionId = await brainSpawnAdapter.spawnAgent(prompt, role, teamId)
          memberSessionIds.push(sessionId)
        } catch (err) {
          logger.warn(
            { err, role, teamId, suggestionId: input.suggestionId },
            'brain: failed to spawn team member',
          )
        }
      }
      return { teamId, memberSessionIds }
    }

    const agent = createBrainAgent(
      {
        classifier: createTaskClassifier(),
        decisionTree: createDecisionTree(),
        templateEngine: createTemplateEngine(),
        healthMonitor,
        taskQueue: createTaskQueue(),
        observationManager: manager,
        suggestionGenerator: suggestionGen,
        onSpawnAgent: (prompt, role, teamId) => brainSpawnAdapter.spawnAgent(prompt, role, teamId),
        markSelfIssueInProgress: (signalKey, teamId) =>
          selfIssueTracker.markInProgress(signalKey, teamId),
        onSpawnTeam: brainOnSpawnTeam,
        onSuggestionSpawnedTeam: ({ suggestionId, teamId, timestamp }) => {
          broker.eventLog.suggestionSpawnedTeam(null, {
            type: 'suggestion-spawned-team',
            suggestionId,
            teamId,
            timestamp,
          })
        },
        getDetectedPatterns: () => {
          const observations = manager.getObservations()
          if (observations.length === 0) return null

          // Feed observations to cross-source correlator (Observation → CrossSourceEvent adapter)
          const crossEvents = observations.map((obs) => ({
            source: obs.source,
            timestamp: obs.timestamp,
            eventType: obs.type,
            sessionId: (obs.metadata?.['sessionId'] as string) ?? undefined,
            tools: obs.metadata?.['tool'] ? [obs.metadata['tool'] as string] : undefined,
            tags: obs.tags,
          }))
          crossSourceCorrelator.addEvents(crossEvents)

          return patternDetector.detect(observations)
        },
        getOtelPatterns: () => {
          const now = Date.now()
          if (otelPatternsCache && now - otelPatternsCache.at < otelPatternsTtlMs) {
            return otelPatternsCache.value
          }
          try {
            const summaries = extractSessionSummaries(broker.db, { limit: 50 })
            const value = summaries.length > 0 ? extractPatterns(summaries) : null
            otelPatternsCache = { at: now, value }
            return value
          } catch (err) {
            logger.warn({ err }, 'getOtelPatterns: extraction failed (non-fatal)')
            return otelPatternsCache?.value ?? null
          }
        },
        getOtelMetrics: () => {
          try {
            ensureLearningStateTable(broker.db)
            const learningState = loadLearningState(broker.db)
            const totalSpans = getSpanCount(broker.db)

            const activeRow = broker.db
              .prepare(
                `
                SELECT COUNT(DISTINCT session_id) AS cnt
                FROM otel_spans
                WHERE session_id IS NOT NULL
                  AND COALESCE(end_time, start_time) > datetime('now', '-15 minutes')
              `,
              )
              .get() as { cnt: number } | undefined

            const lastRow = broker.db
              .prepare('SELECT MAX(created_at) AS last_ts FROM otel_spans')
              .get() as { last_ts: string | null } | undefined

            return {
              totalSpansIngested: totalSpans,
              lastIngestTime: lastRow?.last_ts ?? undefined,
              activeOtelSessions: activeRow?.cnt ?? 0,
              patternsExtracted: learningState.totalPatternsExtracted,
            }
          } catch {
            return {
              totalSpansIngested: 0,
              activeOtelSessions: 0,
              patternsExtracted: 0,
            }
          }
        },
        onLearn: async () => {
          const { runLearningPipeline } = await import('./otel/learning-pipeline.js')
          const { createVault } = await import('./memory/vault.js')
          const vault = createVault({ rootDir: vaultRootDir })
          return runLearningPipeline({ db: broker.db, vault })
        },
        onConsolidate: async () => {
          logger.info('Brain triggering dream consolidation')
          const result = await dreamDaemon.run()
          if (result.success && !result.skipped && memoryDb) {
            try {
              indexVaultSync(memoryDb, vault)
            } catch (err) {
              logger.warn({ err }, 'Post-dream re-index failed')
            }
          }
          if (result.skipped) {
            logger.info({ reason: result.skipReason }, 'Dream skipped')
          } else if (result.success) {
            logger.info(
              { entries: result.consolidation?.entriesKept },
              'Dream consolidation complete',
            )
          } else {
            logger.error({ error: result.error }, 'Dream consolidation failed')
          }
        },
        // R1 (consolidate-livelock fix): the decision tree's Consolidate entry
        // condition must equal the executor's runnability. Fail-open on error —
        // dreamDaemon.run() still applies the same gates itself.
        canConsolidate: () => {
          try {
            return dreamDaemon.getStatus().gateCheck.canRun
          } catch {
            return true
          }
        },
        getLastConsolidationAge: () => {
          try {
            const status = dreamDaemon.getStatus()
            if (!status.lastRunAt) return Infinity // never run → always past threshold
            // SQLite datetime('now') stores UTC without timezone suffix
            const utcTimestamp = status.lastRunAt.endsWith('Z')
              ? status.lastRunAt
              : status.lastRunAt + 'Z'
            const lastRunMs = new Date(utcTimestamp).getTime()
            const ageMs = Date.now() - lastRunMs
            return ageMs / (1000 * 60 * 60) // convert to hours
          } catch {
            return Infinity
          }
        },
        suggestionStore: {
          list: (filter: { status: string }) =>
            suggestionStore.list(
              filter.status as 'pending' | 'approved' | 'rejected' | 'implemented',
            ),
          // FR-050c: the brain is a MACHINE writer at every one of its status seams — declared
          // once here, at the boundary, rather than at each of the nine call sites in
          // `agent-loop.ts`, because there is no brain path on which a human is deciding.
          //
          // This also restores two arguments the adapter silently dropped: `reason` and
          // `blockedMetadata`. The brain's interface declares both, and `agent-loop.ts` passes
          // real values (`self-critique: …`, `team-stalled`, the required autonomy level), but
          // the adapter's signature was `(id, status)` — so every brain-side reason was
          // discarded at the wire and never reached the file. That made a brain transition
          // indistinguishable on disk from a reason-less one, which is the same class of defect
          // FR-048/FR-050 exist to close.
          //
          // Phase 10f pass 5: and it happened AGAIN, one argument later. The brain now sends
          // `{ escalation: 'gate-refused' }` in a 5th `opts` slot, but this adapter declared only
          // four parameters and hardcoded `{ author: 'machine' }` in the fifth — and an arrow
          // function has no `arguments` object, so the tag was dropped at the wire. `tsc` cannot
          // catch it (a lower-arity function legally satisfies a higher-arity signature) and three
          // mock-based tests asserted the tag while production discarded it. `opts` is now declared
          // and MERGED — author stays machine-forced, because a brain write is never a human
          // re-decision and must never be able to erase John's verdict.
          updateStatus: (
            id: string,
            status: string,
            reason?: string,
            blockedMetadata?: { readonly requiredLevel: number; readonly blockedAt: string },
            opts?: { readonly escalation?: import('./suggest/types.js').EscalationKind },
          ) =>
            suggestionStore.updateStatus(
              id,
              status as 'pending' | 'approved' | 'rejected' | 'implemented',
              reason,
              blockedMetadata,
              { ...opts, author: 'machine' },
            ),
          recordFailure: (id: string, error: string) => {
            suggestionStore.recordFailure(id, error)
          },
          clearBackoff: (id: string) => {
            suggestionStore.clearBackoff(id)
          },
          // Phase 13.12.20: brain uses these to move a suggestion into
          // `in-progress` on team spawn + look it up on team_completed.
          markInProgress: (id: string, teamId: string) => {
            suggestionStore.markInProgress(id, teamId)
          },
          get: (id: string) => suggestionStore.get(id),
        },
        // Phase 13.9.2: re-read autonomy level from disk each wake so
        // `POST /api/autonomy/promote` takes effect on the next tick
        // without a broker restart.
        getAutonomyLevel: () => {
          try {
            return loadAutonomy(join(scnsDir, 'state')).level
          } catch {
            return autonomyLevel
          }
        },
        // Phase 13.12.13: brain-side scaling policy. Consults historical
        // outcomes (scaling_outcomes table) to decide solo-vs-team, and
        // logs every decision to scaling_decisions for dashboard audit.
        scalingPolicy: {
          decide: (input) => {
            const outcomes = findOutcomesBySignature(
              broker.db,
              computeTaskSignature(input.description),
              50,
            )
            const decision = decideShape({
              description: input.description,
              hint: input.hint,
              suggestedRoles: input.suggestedRoles,
              history: outcomes,
            })
            try {
              recordScalingDecision(broker.db, {
                task_signature: decision.signature,
                task_snippet: input.description,
                hint_shape: decision.hintShape,
                chosen_shape: decision.shape,
                roles: decision.roles,
                reasoning: decision.reasoning,
                history_count: decision.historyCount,
                source_suggestion_id: input.sourceSuggestionId ?? null,
              })
            } catch (err) {
              logger.warn({ err }, 'Failed to persist scaling decision')
            }
            return decision
          },
          recordOutcome: (input) => {
            try {
              recordScalingOutcome(broker.db, {
                task_signature: input.signature,
                spawned_as: input.shape,
                success: input.success,
                duration_ms: input.durationMs ?? null,
                quality_score: input.qualityScore ?? null,
                source_suggestion_id: input.sourceSuggestionId ?? null,
                team_id: input.teamId ?? null,
              })
            } catch (err) {
              logger.warn({ err }, 'Failed to persist scaling outcome')
            }
          },
        },
        suggestionExecutor: {
          execute: (suggestion: import('./suggest/types.js').Suggestion) => {
            try {
              // Phase 13.12.2: hot-read live autonomy level (same source as
              // the brain) so executor gating reflects runtime promote/demote.
              let liveLevel = autonomyLevel
              try {
                liveLevel = loadAutonomy(join(scnsDir, 'state')).level
              } catch {
                // fall back to startup level
              }
              const executor = createExecutor({ autonomyLevel: liveLevel })
              const plan = executor.generatePlan(suggestion)
              if (plan.requiresUserApproval) {
                return { success: false, error: 'Requires user approval at current autonomy level' }
              }
              const result = executor.execute(plan, suggestion)
              // Evidence passthrough (steps + files written) — self-critique verifies
              // these; a bare `{success: true}` gave it nothing and false-failed every
              // artifact write (the Phase 13.12.24a regression trigger).
              const evidence = {
                stepsCompleted: result.stepsCompleted,
                stepsTotal: result.stepsTotal,
                filesCreated: result.filesCreated,
              }
              if (result.success) {
                return { success: true, ...evidence }
              }
              const errMsg = result.errors.join('; ') || undefined

              // Phase 13.12.2: if executor failed because RunCommand was
              // skipped at autonomy L<3, transition to `blocked-autonomy`
              // with metadata so the brain can auto-reset when autonomy
              // is raised, and the promoter stops log-spamming every tick.
              const blockedMatch = errMsg?.match(/RunCommand skipped at autonomy level (\d+)/)
              if (blockedMatch) {
                return {
                  success: false,
                  error: errMsg,
                  nextStatus: 'blocked-autonomy',
                  blockedMetadata: {
                    requiredLevel: 3,
                    blockedAt: new Date().toISOString(),
                  },
                }
              }

              return { success: false, error: errMsg }
            } catch (err) {
              // Phase 13.12.1 amendment: executor throws NEEDS_HUMAN for
              // types (e.g. workflow) that cannot be safely auto-executed.
              // Surface as terminal `needs-human` status so the brain moves
              // on instead of retrying every wake.
              if (err instanceof ScnsError && err.code === 'NEEDS_HUMAN') {
                return {
                  success: false,
                  error: err.message,
                  nextStatus: 'needs-human',
                }
              }
              return { success: false, error: (err as Error).message }
            }
          },
        },
        // Phase 13.12.14: deps for /api/brain/status introspection.
        getPendingSuggestionCount: () => {
          try {
            return suggestionStore.list('pending').length
          } catch {
            return 0
          }
        },
        getMostRecentDecisionId: () => {
          try {
            const row = broker.db
              .prepare('SELECT id FROM scaling_decisions ORDER BY id DESC LIMIT 1')
              .get() as { id: number } | undefined
            return row ? Number(row.id) : null
          } catch {
            return null
          }
        },
        // Phase 13.12.19: self-critique loop. Enabled at L2/L3 by default,
        // disabled at L0/L1 (human is the critic). Overridable via
        // BRAIN_SELF_CRITIQUE_ENABLED env.
        selfCritique: {
          run: async (input) => {
            let liveLevel = autonomyLevel
            try {
              liveLevel = loadAutonomy(join(scnsDir, 'state')).level
            } catch {
              /* fallback */
            }
            const cfg = selfCritiqueModule.loadSelfCritiqueConfig(liveLevel)
            return selfCritiqueModule.runSelfCritique(input, {
              enabled: cfg.enabled,
              autonomyLevel: liveLevel,
              timeoutMs: cfg.timeoutMs,
              spawnCritic:
                cfg.enabled && liveLevel >= 2
                  ? selfCritiqueModule.createDefaultCriticSpawner({
                      command: cfg.criticCommand,
                      args: cfg.criticArgs,
                    })
                  : undefined,
            })
          },
          writeCritiqueFile: (params) =>
            selfCritiqueModule.writeCritiqueFile({
              ...params,
              suggestionsRoot: suggestionsDir,
            }),
        },
      },
      { autonomyLevel, ...(autoApproveThreshold !== undefined ? { autoApproveThreshold } : {}) },
    )
    agent.start()
    broker.broker.setBrainAgent(agent)

    // Self-issue ingestion: periodically pull SCNS's own open GitHub issues
    // and author them as brain tasks so the brain can resolve them. Bounded,
    // deduplicated via shared_state, and gated by a kill-switch.
    {
      const { createSelfIssueSource, fetchGithubIssueSignals, resolveSelfIssueRepo } =
        await import('./brain/self-issue-source.js')
      const selfIssueLog = logger.child({ module: 'self-issue' })
      // Track-2: a meta-CHILD broker (SCNS_INSTANCE_ID set) must ingest ITS OWN
      // repo's issues, never fall back to the SCNS singleton's default.
      // #58: the singleton has NO default target — an unconfigured singleton
      // refuses to ingest rather than acting on a repo nobody chose (the old
      // hardcoded default pointed at the public upstream repo, which is wrong
      // for every install except the maintainer's own).
      const repoResolution = resolveSelfIssueRepo({
        explicitRepo: process.env['SCNS_SELF_ISSUE_REPO'],
        instanceId: process.env['SCNS_INSTANCE_ID'],
      })
      if (repoResolution.kind === 'unconfigured') {
        selfIssueLog.error(
          'self-issue ingestion has no target repo and will refuse to run: set ' +
            'SCNS_SELF_ISSUE_REPO=owner/name to the repository this install may ' +
            'ingest issues from — a repo the authenticated gh account owns (#58)',
        )
      }
      const repo = repoResolution.kind === 'explicit' ? repoResolution.repo : undefined
      const labelAllowlist = (process.env['SCNS_SELF_ISSUE_LABELS'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      const maxPerRun = parseInt(process.env['SCNS_SELF_ISSUE_MAX_PER_RUN'] ?? '3', 10)
      const sharedStateGet = broker.db.prepare<[string], { value: string }>(
        'SELECT value FROM shared_state WHERE key = ?',
      )
      // Env overrides must never silently disable a safety guard: parseInt('') and
      // parseInt('abc') both yield NaN, and every comparison against NaN is false,
      // so a malformed value would turn the stale sweep and the runaway cap off.
      const envInt = (name: string, fallback: number, min = 0): number => {
        const raw = process.env[name]
        if (raw === undefined || raw.trim() === '') return fallback
        const parsed = Number(raw)
        if (!Number.isFinite(parsed)) {
          selfIssueLog.warn(`${name}="${raw}" is not a number — using default ${fallback}`)
          return fallback
        }
        const value = Math.trunc(parsed)
        if (value < min) {
          selfIssueLog.warn(`${name}=${value} is below the minimum ${min} — using ${min}`)
          return min
        }
        return value
      }
      // How long a self-issue in-progress lease may sit before it is presumed
      // stranded by a crash and released for retry. The default is well above a
      // normal team's runtime: production saw a 20-minute spread between a team's
      // first and last completion event, and a TTL that expires mid-flight drops
      // the eventual success and makes the work be redone. Floored at 1 minute so
      // a misconfigured 0 cannot sweep every lease on every tick.
      const staleLeaseMs = envInt('SCNS_SELF_ISSUE_STALE_MS', 90 * 60_000, 60_000)
      // Runaway-loop guard: how many teams may be spawned for one signal before
      // it is abandoned. 0 or less disables the cap. A signal only ever burns an
      // attempt when a team is actually spawned for it, and the counter resets
      // when the signal is resolved or manually cleared.
      const maxAttempts = envInt('SCNS_SELF_ISSUE_MAX_ATTEMPTS', 3)

      broker.registerTaskHandler('self-issue-ingest', async () => {
        // #58: refuse while unconfigured — the loud explanation already went
        // out at registration above; per-tick this stays at info.
        if (repoResolution.kind === 'unconfigured') {
          selfIssueLog.info(
            'self-issue ingestion skipped — no target repo configured (set SCNS_SELF_ISSUE_REPO=owner/name)',
          )
          return
        }
        // Kill-switch: set shared_state broker:self_issue_disabled = '1' to halt.
        const disabled = sharedStateGet.get('broker:self_issue_disabled')
        if (disabled && disabled.value === '1') {
          selfIssueLog.info('self-issue ingestion disabled via kill-switch')
          return
        }
        // Bug 2: recover leases stranded by a crash mid-work (revert stale
        // in-progress → enqueueable) before deciding what to enqueue.
        const recovered = selfIssueTracker.sweepStale(staleLeaseMs)
        if (recovered > 0) {
          selfIssueLog.info({ recovered }, 'released stale self-issue leases for retry')
        }
        const source = createSelfIssueSource(
          {
            fetchSignals: () =>
              fetchGithubIssueSignals({
                ...(repo ? { repo } : {}),
                cwd: brokerCfg.projectRoot,
                labels: labelAllowlist,
              }),
            // Skip a signal only when it is already being handled: it holds a
            // durable record (in-progress/done/abandoned) OR it has burned
            // through its attempt cap OR it is already sitting in the in-memory
            // queue. After a restart the queue is empty and no lease exists for
            // a lost-before-spawn signal, so it is re-enqueued. Cap exhaustion
            // is written durably as status 'abandoned' (the honest terminal
            // state — never 'done'), so the loud warn below fires exactly once
            // per signal, even across restarts.
            isActive: (key) => {
              const disposition = evaluateSelfIssueSignalForEnqueue(
                selfIssueTracker,
                key,
                maxAttempts,
                agent.hasQueuedSignal(key),
              )
              if (disposition === 'abandoned') {
                selfIssueLog.warn(
                  { signalKey: key, attempts: selfIssueTracker.attempts(key), maxAttempts },
                  'self-issue ABANDONED — attempt cap reached without a gate PASS; ' +
                    'not re-enqueueing. To retry it, delete its shared_state rows: ' +
                    `DELETE FROM shared_state WHERE key IN ('self-issue:status:${key}','self-issue:attempts:${key}');`,
                )
              }
              return disposition !== 'enqueueable'
            },
            enqueueTask: (description, priority, signalKey) =>
              agent.addTask(description, priority, signalKey),
            log: (obj, msg) => selfIssueLog.info(obj, msg),
          },
          { maxPerRun, labelAllowlist },
        )
        const result = await source.ingest()
        if (result.ingested > 0 || result.enqueueFailed > 0) {
          selfIssueLog.info({ ...result }, 'self-issue ingestion run complete')
        }
      })

      // scns#36: the lease resolves on the QUALITY GATE VERDICT, never on
      // member exit. `team_completed` is observed for logging only (the gate
      // runs on the staged diff AFTER this event); `quality_gate_verdict` is
      // the single resolver: PASS ⇒ done, FAIL ⇒ lease retained (stale sweep
      // + attempt cap bound the retries). Both handlers are monotone under
      // the one-completion-per-exit-wave behavior — see
      // brain/self-issue-completion.ts for the full rule + live evidence.
      // Suggestion/A2A teams hold no self-issue lease, so both no-op for them.
      broker.dispatcher.subscribe({ event_types: ['team_completed'] }, (event) => {
        try {
          const payload = JSON.parse(event.payload) as {
            teamId?: string
            aggregateOutcome?: string
          }
          const { action, signalKey } = handleSelfIssueTeamCompletion(selfIssueTracker, payload)
          if (action === 'awaiting-gate-verdict') {
            selfIssueLog.info(
              { signalKey, teamId: payload.teamId, outcome: payload.aggregateOutcome ?? null },
              'self-issue team wave completed — awaiting quality-gate verdict',
            )
          }
        } catch (err) {
          selfIssueLog.warn({ err, eventId: event.id }, 'self-issue team_completed handler failed')
        }
      })

      broker.dispatcher.subscribe({ event_types: ['quality_gate_verdict'] }, (event) => {
        try {
          const payload = JSON.parse(event.payload) as {
            team_id?: string
            passed?: boolean
            reason?: string
          }
          const { action, signalKey } = handleSelfIssueGateVerdict(selfIssueTracker, payload)
          if (action === 'resolved') {
            selfIssueLog.info(
              { signalKey, teamId: payload.team_id, reason: payload.reason ?? null },
              'self-issue resolved — quality gate PASSED',
            )
          } else if (action === 'lease-retained') {
            selfIssueLog.info(
              {
                signalKey,
                teamId: payload.team_id,
                reason: payload.reason ?? null,
                attempts: selfIssueTracker.attempts(signalKey ?? ''),
                maxAttempts,
              },
              'self-issue gate FAILED — lease retained (stale sweep will retry until the attempt cap)',
            )
          }
        } catch (err) {
          selfIssueLog.warn(
            { err, eventId: event.id },
            'self-issue quality_gate_verdict handler failed',
          )
        }
      })
    }

    // Phase 13.12.4: wire auto-wake callback so POST /api/suggestions
    // triggers the brain to promote the new suggestion immediately.
    broker.broker.setDashboardDeps({
      onSuggestionPosted: () => agent.requestWake(),
      // W5.3: a HUMAN-authored negative-feedback report also enters the
      // self-issue task pipeline as a High task (the route gates on
      // promptOrigin === 'human'; machine/heuristic entries never reach this).
      // Content-keyed signal so repeated identical feedback dedupes.
      onHumanNegativeFeedback: createHumanFeedbackTaskBridge({
        addTask: (description, priority, signalKey) =>
          agent.addTask(description, priority, signalKey),
        hasQueuedSignal: (signalKey) => agent.hasQueuedSignal(signalKey),
        requestWake: () => agent.requestWake(),
      }),
    })
    // Phase 13.10.3: publish brain readiness to /api/health once the first
    // wake cycle completes (see agent-loop.ts isReady()).
    broker.broker.setProgressiveHealthDeps({
      getBrainStatus: () => (agent.isReady() ? 'ready' : 'starting'),
    })
    console.log(`  Brain agent started (autonomy L${autonomyLevel})`)

    // 4. Start OTel file watcher (if enabled)
    const { loadOtelConfig } = await import('./otel/config.js')
    const { createOtelFileWatcher } = await import('./otel/file-watcher.js')
    const { ensureTelemetryDir, getDefaultTelemetryPath } = await import('./otel/auto-config.js')

    let otelWatcher: OtelFileWatcher | null = null

    const otelConfig = loadOtelConfig()
    const cliPath = opts.otelPath?.trim() || null
    const otelEnabled = cliPath !== null || otelConfig.enabled
    let otelResolvedPath: string | null = null
    let otelStartupError: string | null = null

    if (otelEnabled) {
      const rawPath = cliPath ?? otelConfig.filePath ?? getDefaultTelemetryPath()
      const resolvedPath = resolve(rawPath.replace(/^~(?=\/|$)/, homedir()))
      otelResolvedPath = resolvedPath

      try {
        ensureTelemetryDir(resolvedPath)
        otelWatcher = createOtelFileWatcher(
          { ...otelConfig, enabled: true, filePath: resolvedPath },
          broker.db,
        )
        otelWatcher.start()
        console.log(`  OTel file watcher started (${resolvedPath})`)
      } catch (err) {
        otelStartupError = err instanceof Error ? err.message : String(err)
        console.error(`  Warning: OTel file watcher failed to start: ${otelStartupError}`)
      }
    } else {
      console.log('  OTel file watcher skipped (not configured)')
    }

    // Phase 13.12.8: publish OTel health status to /api/health.
    broker.broker.setProgressiveHealthDeps({
      getOtelStatus: () => {
        if (otelStartupError) {
          return { status: 'error', errorMessage: otelStartupError }
        }
        if (!otelEnabled || !otelResolvedPath) {
          return { status: 'unconfigured' }
        }
        try {
          const spans = getSpanCount(broker.db)
          return {
            status: 'ready',
            progress: { done: spans, total: spans },
          }
        } catch (err) {
          return {
            status: 'error',
            errorMessage: err instanceof Error ? err.message : String(err),
          }
        }
      },
    })

    console.log('\nSCNS system running. Press Ctrl+C to stop.')

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down SCNS...')
      if (otelWatcher) otelWatcher.stop()
      agent.stop()
      manager.stop()
      await broker.stop()
      experienceStore?.close()
      console.log('SCNS stopped.')
    }
    const handleSignal = () => {
      shutdown()
        .catch((err) => {
          console.error('Shutdown error:', err)
          process.exitCode = 1
        })
        .finally(() => {
          // We DO call process.exit() — observation manager / brain agent
          // poller / metrics-runtime monitor keep unref'd handles around that
          // would otherwise hold the event loop open after `shutdown()`
          // resolves. But we only do so after:
          //   (a) the shutdown manager has run its cleanups in order,
          //       including 'reset-embeddings' which drops the FastEmbed/ONNX
          //       singleton BEFORE the database closes, and
          //   (b) a brief settle delay that lets V8 finalizers + libuv worker
          //       threads finish their natural teardown.
          // Without (a) and (b) this is the libc++abi
          // "mutex lock failed: Invalid argument" abort observed in the
          // 2026-04-22 soak: native worker threads racing pthread teardown
          // because we exited while they still held mutexes. With (a) and
          // (b) the workers are quiesced first, so process.exit() is safe.
          const exitDelayMs = Number(process.env.SCNS_SHUTDOWN_EXIT_DELAY_MS ?? '750')
          setTimeout(() => process.exit(), exitDelayMs).unref()
        })
    }
    process.on('SIGINT', handleSignal)
    process.on('SIGTERM', handleSignal)

    const { registerGlobalErrorHandlers } = await import('./shared/global-error-handlers.js')
    registerGlobalErrorHandlers({ onShutdown: shutdown })
  })

program
  .command('stop')
  .description('Stop the SCNS brain agent and all managed sessions')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .action(async (opts: { brokerUrl: string }) => {
    try {
      const res = await fetch(`${opts.brokerUrl}/api/shutdown`, { method: 'POST' })
      const data = (await res.json()) as { success?: boolean; message?: string }
      if (data.success) {
        console.log('SCNS shutdown initiated.')
      } else {
        console.error('Shutdown request failed')
        process.exitCode = 1
      }
    } catch (err) {
      console.error(
        `Failed to reach broker at ${opts.brokerUrl}: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exitCode = 1
    }
  })

program
  .command('status')
  .description('Show SCNS status: brain agent, sessions, autonomy level')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .option('--json', 'Machine-readable JSON output')
  .option('--learning', 'Show learning pipeline status')
  .action(async (opts: { brokerUrl: string; json?: boolean; learning?: boolean }) => {
    const scnsDir = join(resolveScnsHome(), '.scns')
    const stateDir = join(scnsDir, 'state')
    const autonomy = loadAutonomy(stateDir)

    let brokerUp = false
    let healthData: Record<string, unknown> = {}
    let sessionCount = 0
    let teamCount = 0

    try {
      const healthRes = await fetch(`${opts.brokerUrl}/health`)
      healthData = (await healthRes.json()) as Record<string, unknown>
      brokerUp = true
    } catch {
      // broker unreachable
    }

    try {
      const sessRes = await fetch(`${opts.brokerUrl}/api/list_sessions`)
      const sessData = (await sessRes.json()) as { sessions?: unknown[] }
      sessionCount = sessData.sessions?.length ?? 0
    } catch {
      // ignore
    }

    try {
      const teamRes = await fetch(`${opts.brokerUrl}/api/teams`)
      const teamData = (await teamRes.json()) as { teams?: unknown[] }
      teamCount = teamData.teams?.length ?? 0
    } catch {
      // ignore
    }

    const summary = {
      broker: brokerUp ? 'up' : 'down',
      brokerUrl: opts.brokerUrl,
      sessions: sessionCount,
      teams: teamCount,
      autonomy: {
        level: autonomy.level,
        description: getAutonomyDescription(autonomy.level),
        changedAt: autonomy.changedAt,
      },
      health: healthData,
    }

    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2))
    } else {
      console.log('SCNS Status:')
      console.log(`  Broker:    ${summary.broker} (${opts.brokerUrl})`)
      console.log(`  Sessions:  ${sessionCount}`)
      console.log(`  Teams:     ${teamCount}`)
      console.log(`  Autonomy:  L${autonomy.level} — ${getAutonomyDescription(autonomy.level)}`)
    }

    if (opts.learning) {
      try {
        const { loadConfig: loadBrokerConfig } = await import('./broker/config.js')
        const { openDatabase } = await import('./broker/storage/db.js')
        const { ensureLearningStateTable, loadLearningState } =
          await import('./otel/learning-state.js')

        const brokerCfg = loadBrokerConfig()
        const db = openDatabase(brokerCfg.dbPath)

        try {
          ensureLearningStateTable(db)
          const state = loadLearningState(db)

          console.log('\nLearning Pipeline:')
          console.log(`  Sessions processed: ${state.totalSessionsProcessed}`)
          console.log(`  Last processed:     ${state.lastProcessedAt ?? 'never'}`)
          console.log(`  Patterns extracted:  ${state.totalPatternsExtracted}`)

          if (state.latestPatternsJson) {
            try {
              const patterns = JSON.parse(state.latestPatternsJson) as Record<string, unknown>
              const totalSessions = patterns['totalSessions'] as number | undefined
              if (totalSessions !== undefined) {
                console.log(`  Total sessions analyzed: ${totalSessions}`)
              }
              const schedule = patterns['schedule'] as Record<string, unknown> | undefined
              if (schedule) {
                const activeHours = schedule['activeHours'] as
                  | Array<{ hour: number; sessionCount: number }>
                  | undefined
                if (activeHours && activeHours.length > 0) {
                  const topHours = activeHours.slice(0, 3)
                  console.log(
                    `  Peak hours (UTC):   ${topHours.map((h) => `${h.hour}:00`).join(', ')}`,
                  )
                }
              }
              const tools = patterns['tools'] as Record<string, unknown> | undefined
              if (tools) {
                const topTools = tools['topTools'] as Array<{ tool: string }> | undefined
                if (topTools && topTools.length > 0) {
                  console.log(
                    `  Top tools:          ${topTools
                      .slice(0, 5)
                      .map((t) => t.tool)
                      .join(', ')}`,
                  )
                }
              }
              const models = patterns['models'] as Record<string, unknown> | undefined
              if (models?.['primaryModel']) {
                console.log(`  Primary model:      ${models['primaryModel']}`)
              }
            } catch {
              // invalid JSON in stored patterns
            }
          }
        } finally {
          db.close()
        }
      } catch (err) {
        console.error(
          `\nLearning status unavailable: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  })

program
  .command('dream')
  .description('Run AutoDream memory consolidation')
  .option('--dry-run', 'Preview consolidation without writing')
  .option('--force', 'Skip gate checks and run immediately')
  .option('--status', 'Show consolidation status')
  .action(async (options: { dryRun?: boolean; force?: boolean; status?: boolean }) => {
    const scnsDir = join(resolveScnsHome(), '.scns')
    const vaultRootDir = join(scnsDir, 'memory')
    const dbPath = join(scnsDir, 'dream.db')

    // M1.3 L2 (DEFAULT-OFF): open the live memory vault so the causal-edge phase can run
    // on demand via `SCNS_DREAM_CAUSAL=1 [SCNS_DREAM_CAUSAL_ACP=1] scns dream --force`.
    let causalDb: import('better-sqlite3').Database | null = null
    let causalProjectRoot = process.cwd()
    try {
      const { openMemoryDb } = await import('./memory/db.js')
      const { loadConfig: loadBrokerCfg } = await import('./broker/config.js')
      causalDb = openMemoryDb(join(vaultRootDir, 'vault.db'))
      causalProjectRoot = loadBrokerCfg().projectRoot
    } catch {
      // vault.db may not exist yet — causal phase stays unavailable (inert)
    }

    const daemon = createDreamDaemon({
      vaultRootDir,
      dbPath,
      dryRun: options.dryRun,
      gatedNegativeMemoriesShadow: process.env.SCNS_GATED_NEG_MEM_SHADOW === '1',
      // Wedge C phase (e): default-ON (opt out with SCNS_GATED_NEG_MEM_LIVE=0).
      // Routes the live self-edit through the non-regression GATE instead of the
      // blind issue-#5 applicator. Real writes still require a HARD-STOP spawn
      // (SCNS_GATED_NEG_MEM_LIVE_ACP=1); without it the gate runs under Mock and
      // refuses to mutate the live guardrails (no autonomous writes).
      gatedNegativeMemoriesLive: process.env.SCNS_GATED_NEG_MEM_LIVE !== '0',
      ...(causalDb ? buildCausalDreamConfig(causalDb, causalProjectRoot) : {}),
      // SIBLING (DEFAULT-OFF): gated, reversible memory-maintenance / "forgetting".
      ...(causalDb
        ? {
            memoryMaintenance: process.env.SCNS_DREAM_MAINTENANCE === '1',
            maintenanceGuard: DEFAULT_MAINTENANCE_GUARD,
            // WS-1 (DEFAULT-OFF): event/outcome substrate. Inert unless SCNS_EVENT_SEGMENTATION=1.
            eventSegmentation: process.env.SCNS_EVENT_SEGMENTATION === '1',
          }
        : {}),
    })

    try {
      if (options.status) {
        const status = daemon.getStatus()
        console.log('AutoDream Status:')
        console.log(`  Last run:       ${status.lastRunAt ?? 'never'}`)
        console.log(`  Sessions since: ${status.sessionsSinceLastRun}`)
        console.log(`  Total runs:     ${status.totalRuns}`)
        console.log(`  Can run now:    ${status.gateCheck.canRun}`)
        if (status.gateCheck.failedGate) {
          console.log(`  Blocked by:     ${status.gateCheck.failedGate} gate`)
        }
        return
      }

      const result = options.force ? await daemon.forceRun() : await daemon.run()

      if (result.skipped) {
        console.log(`Dream skipped: ${result.skipReason} gate not met`)
        return
      }

      if (!result.success) {
        console.error(`Dream failed: ${result.error}`)
        process.exitCode = 1
        return
      }

      const c = result.consolidation!
      console.log('Dream consolidation complete:')
      console.log(`  Entries processed: ${c.entriesProcessed}`)
      console.log(`  Entries kept:      ${c.entriesKept}`)
      console.log(`  Duplicates removed: ${c.duplicatesRemoved}`)
      console.log(`  Duration:          ${result.durationMs}ms`)
      if (options.dryRun) {
        console.log('  (dry run — MEMORY.md not written)')
      }
    } finally {
      daemon.close()
      causalDb?.close()
    }
  })

program
  .command('learn')
  .description('Run the learning pipeline: extract sessions → generate digests → store in vault')
  .option('--since <timestamp>', 'Only process sessions after this ISO timestamp')
  .action(async (opts: { since?: string }) => {
    const { loadConfig: loadBrokerConfig } = await import('./broker/config.js')
    const { openDatabase } = await import('./broker/storage/db.js')
    const { createVault } = await import('./memory/vault.js')
    const { runLearningPipeline } = await import('./otel/learning-pipeline.js')

    const scnsDir = join(resolveScnsHome(), '.scns')
    const vaultRootDir = join(scnsDir, 'memory')
    const brokerCfg = loadBrokerConfig()

    const db = openDatabase(brokerCfg.dbPath)
    const vault = createVault({ rootDir: vaultRootDir })

    try {
      const result = runLearningPipeline({
        db,
        vault,
        since: opts.since,
      })

      console.log('Learning pipeline complete:')
      console.log(`  Sessions processed: ${result.sessionsProcessed}`)
      console.log(`  Digests stored:     ${result.digestsStored}`)
      console.log(`  Memory entries:     ${result.memoryEntriesGenerated}`)

      if (result.patternsExtracted) {
        const p = result.patternsExtracted
        console.log(`  Patterns:`)
        console.log(`    Sessions analyzed: ${p.totalSessions}`)
        if (p.models.primaryModel) {
          console.log(`    Primary model:     ${p.models.primaryModel}`)
        }
        if (p.tools.topTools.length > 0) {
          console.log(
            `    Top tools:         ${p.tools.topTools
              .slice(0, 5)
              .map((t) => t.tool)
              .join(', ')}`,
          )
        }
      }

      if (result.errors.length > 0) {
        console.log(`\n  Errors (${result.errors.length}):`)
        for (const err of result.errors) {
          console.log(`    - ${err}`)
        }
      }
    } finally {
      db.close()
    }
  })

program
  .command('search <query>')
  .description('Search the memory vault (hybrid vector + keyword)')
  .option('-n, --limit <limit>', 'max results', '10')
  .option(
    '--db <path>',
    'memory vault path (default: ~/.scns/memory/vault.db; point at a copy/backup to search it safely)',
  )
  .action(async (query: string, opts: { limit: string; db?: string }) => {
    const { hybridSearch } = await import('./memory/search.js')
    const { openMemoryDb } = await import('./memory/db.js')
    const { resetEmbeddingClient } = await import('./memory/embeddings.js')

    const scnsDir = join(resolveScnsHome(), '.scns')
    const dbPath = opts.db ?? join(scnsDir, 'memory', 'vault.db')

    try {
      // Use the MEMORY opener (loads sqlite-vec + idempotent CREATE IF NOT EXISTS),
      // NOT the broker storage opener: the latter has no vec0 extension (so vector
      // search throws "no such module: vec0"), runs BROKER migrations against the
      // vault (schema pollution), and `wal_checkpoint(TRUNCATE)`s assuming sole
      // ownership — corrupting/conflicting with the live broker that holds the vault
      // open. This was the "never run `scns search`" footgun.
      const db = openMemoryDb(dbPath)
      try {
        const results = await hybridSearch(db, query, { limit: parseInt(opts.limit, 10) })

        if (results.length === 0) {
          console.log('No results found.')
          return
        }

        console.log(`Found ${results.length} result(s):\n`)
        for (const r of results) {
          console.log(`  [${r.score.toFixed(3)}] ${r.filePath} (chunk ${r.chunkIndex})`)
          console.log(`    ${r.content.slice(0, 120).replace(/\n/g, ' ')}`)
          console.log()
        }
      } finally {
        db.close()
        await resetEmbeddingClient()
      }
    } catch (err) {
      console.error(`Search failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
  })

program
  .command('reindex-facts')
  .description(
    'MAGMA missing-only fact backfill: extract relational fact nodes for indexed files that have ' +
      'none yet (bounded, incremental, converges over passes). Point --db at a COPY for safety.',
  )
  .option(
    '--db <path>',
    'memory vault path (default: ~/.scns/memory/vault.db — the LIVE vault held by the broker; prefer a copy)',
  )
  .option(
    '--batch-size <n>',
    'passages per extractor spawn (default env FACT_EXTRACT_BATCH_SIZE or 8)',
  )
  .option('--max-batches <n>', 'per-pass spawn budget (default env SCNS_EXTRACT_MAX_BATCHES or 4)')
  .option(
    '--timeout-ms <ms>',
    'per-spawn wall-clock budget for one copilot --acp round-trip (default 240000)',
  )
  .option('--dry-run', 'report eligible files/chunks + projected batches/passes; NO spawns')
  .option('--json', 'machine-readable output')
  .action(
    async (opts: {
      db?: string
      batchSize?: string
      maxBatches?: string
      timeoutMs?: string
      dryRun?: boolean
      json?: boolean
    }) => {
      const { openMemoryDb } = await import('./memory/db.js')
      const { countFactBackfillEligible, backfillFactNodes, DEFAULT_FACT_EXTRACT_BATCH_SIZE } =
        await import('./memory/indexer.js')
      const { resetEmbeddingClient } = await import('./memory/embeddings.js')

      const scnsDir = join(resolveScnsHome(), '.scns')
      const defaultDb = join(scnsDir, 'memory', 'vault.db')
      const dbPath = opts.db ?? defaultDb
      const batchSize = opts.batchSize
        ? parseInt(opts.batchSize, 10)
        : parseInt(
            process.env.FACT_EXTRACT_BATCH_SIZE ?? String(DEFAULT_FACT_EXTRACT_BATCH_SIZE),
            10,
          )
      const maxBatches = opts.maxBatches ? parseInt(opts.maxBatches, 10) : undefined

      if (dbPath === defaultDb && !opts.dryRun) {
        console.error(
          'WARNING: --db points at the LIVE vault (~/.scns/memory/vault.db) which the broker holds open. ' +
            'This spawns `copilot --acp` and WRITES fact nodes. For a safe measurement, snapshot a copy first:\n' +
            `  sqlite3 "file:${defaultDb}?mode=ro" ".backup /tmp/vault-copy.db"  &&  scns reindex-facts --db /tmp/vault-copy.db`,
        )
      }

      const db = openMemoryDb(dbPath)
      try {
        const { filesEligible, chunksEligible } = countFactBackfillEligible(db)
        const effectiveBatch =
          Number.isFinite(batchSize) && batchSize > 0 ? batchSize : DEFAULT_FACT_EXTRACT_BATCH_SIZE
        const projectedBatches = Math.ceil(chunksEligible / effectiveBatch)

        if (opts.dryRun) {
          const budget = maxBatches && maxBatches > 0 ? maxBatches : 4
          const passesNeeded = budget > 0 ? Math.ceil(projectedBatches / budget) : projectedBatches
          const report = {
            dbPath,
            filesEligible,
            chunksEligible,
            batchSize: effectiveBatch,
            projectedBatches,
            budgetPerPass: budget,
            passesNeeded,
          }
          if (opts.json) {
            console.log(JSON.stringify(report, null, 2))
          } else {
            console.log(`reindex-facts (dry-run) :: db=${dbPath}`)
            console.log(`  eligible files (no fact nodes yet): ${filesEligible}`)
            console.log(`  eligible source chunks:             ${chunksEligible}`)
            console.log(`  batch size (N):                     ${effectiveBatch}`)
            console.log(
              `  projected batches (ceil(n/N)):      ${projectedBatches}  (= spawns for a full backfill)`,
            )
            console.log(
              `  budget/pass:                        ${budget}  ⇒ passes to converge: ${passesNeeded}`,
            )
          }
          return
        }

        // Real run: construct the deny-all, isolated ACP extractor (NEVER the live checkout cwd).
        const { createAcpFactExtractor } = await import('./memory/fact-extractor-acp.js')
        const timeoutMs = opts.timeoutMs ? parseInt(opts.timeoutMs, 10) : undefined
        const factExtractor = createAcpFactExtractor({
          cwd: mkdtempSync(join(tmpdir(), 'scns-factext-')),
          ...(timeoutMs && timeoutMs > 0 ? { attemptTimeoutMs: timeoutMs } : {}),
        })
        const t0 = Date.now()
        const stats = await backfillFactNodes(db, {
          factExtractor,
          batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : undefined,
          ...(maxBatches && maxBatches > 0 ? { maxBatches } : {}),
          extractEntities: process.env.SCNS_ENTITY_EXTRACTION !== '0',
          buildSemantic: process.env.SCNS_SEMANTIC_EDGES === '1',
        })
        const elapsedMs = Date.now() - t0
        const perSpawnSec = stats.batchesRun > 0 ? elapsedMs / 1000 / stats.batchesRun : 0
        const fullVaultSec = perSpawnSec * projectedBatches
        const report = {
          dbPath,
          ...stats,
          projectedBatchesFullVault: projectedBatches,
          elapsedSec: +(elapsedMs / 1000).toFixed(2),
          perSpawnSec: +perSpawnSec.toFixed(2),
          projectedFullVaultSec: +fullVaultSec.toFixed(2),
        }
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2))
        } else {
          console.log(`reindex-facts :: db=${dbPath}`)
          console.log(
            `  filesEligible=${stats.filesEligible} chunksEligible=${stats.chunksEligible}`,
          )
          console.log(`  batchSize=${stats.batchSize} budget=${stats.budget}`)
          console.log(
            `  batchesRun(spawns)=${stats.batchesRun} filesOffered=${stats.filesOffered} factsExtracted=${stats.factsExtracted}`,
          )
          console.log(`  elapsed=${report.elapsedSec}s  perSpawn=${report.perSpawnSec}s`)
          console.log(
            `  projected full-vault: ${projectedBatches} spawns × ${report.perSpawnSec}s = ${report.projectedFullVaultSec}s`,
          )
        }
      } catch (err) {
        console.error(`reindex-facts failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
      } finally {
        db.close()
        await resetEmbeddingClient()
      }
    },
  )

const review = program
  .command('review')
  .description('Review pending suggestions from the observation layer')

review
  .command('list')
  .description('List pending suggestions')
  .action(async () => {
    const { createSuggestionStore } = await import('./suggest/suggestion-store.js')
    const { createExecutor } = await import('./suggest/executor.js')
    const { createReviewWorkflow } = await import('./suggest/review.js')
    const { formatSummaryTable } = await import('./suggest/format.js')

    const scnsDir = join(resolveScnsHome(), '.scns')
    const store = createSuggestionStore({ rootDir: join(scnsDir, 'suggestions') })
    const executor = createExecutor()
    const workflow = createReviewWorkflow({ store, executor })
    console.log(formatSummaryTable(workflow.listPending()))
  })

review
  .command('weekly')
  .description('Interactive weekly review — SCNS proposes, you decide AND explain why')
  .option('--dry-run', 'Show the packet without asking for verdicts')
  .option('--budget <n>', 'Maximum items to review', (v) => Number.parseInt(v, 10))
  .option('--offline', 'Triage with the deterministic scan only — no model round-trips')
  .option('--no-triage', 'Skip triage entirely and review what is already on disk')
  .action(
    async (opts: { dryRun?: boolean; budget?: number; offline?: boolean; triage?: boolean }) => {
      const { createSuggestionStore } = await import('./suggest/suggestion-store.js')
      const { buildWeeklySession, recordWeeklyVerdict } =
        await import('./suggest/weekly-session.js')
      const { codeIsValidFor, verdictFromInput } = await import('./suggest/review-reason.js')
      const { formatWeeklyHeader, formatReviewItem, formatReasonMenu, formatWeeklyClosing } =
        await import('./suggest/weekly-format.js')

      const scnsDir = join(resolveScnsHome(), '.scns')
      const store = createSuggestionStore({ rootDir: join(scnsDir, 'suggestions') })

      // FR-046a / FR-053a: John's words are captured to the vault as MARKDOWN, here, synchronously,
      // at the moment he types them. `vault.write` is `writeFileSync` + `renameSync` (vault.ts:83) —
      // a plain atomic filesystem write with no SQLite involved — so the CLI can make the words
      // durable immediately without contending with the broker's single writer on `vault.db`. The
      // matching row is written by the broker's Monday sweep, which already owns that handle.
      const { createVault } = await import('./memory/vault.js')
      const rationaleVault = createVault({ rootDir: join(scnsDir, 'memory') })

      /**
       * FR-053: if his words did not make it to disk, say so NOW, to his face, in the session where
       * he can still do something about it. The old failure mode was the opposite — the verdict was
       * confirmed with a tick while the reasoning quietly went nowhere, so the loss was invisible
       * until someone went looking for a corpus that had never been written.
       */
      const reportRationaleWarnings = (warnings: readonly string[] | undefined): void => {
        for (const w of warnings ?? []) {
          console.log(`   ⚠ your reasoning was NOT saved to the vault: ${w}`)
        }
      }
      // FR-051a: a different failure — the words ARE saved, but they will not teach anything. It gets
      // its own wording so the two are never confused for one another.
      const reportVerdictWarnings = (warnings: readonly string[] | undefined): void => {
        for (const w of warnings ?? []) {
          console.log(`   ⚠ saved, but it will not count: ${w}`)
        }
      }

      // Same triage the Monday task runs, so an ad-hoc review is never shown worse proposals.
      // `--offline` keeps the deterministic duplicate scan but skips the model round-trips.
      // commander maps `--no-triage` to `triage: false`; undefined means the flag was not passed.
      if (opts.triage !== false) {
        const { runProposalTriage } = await import('./suggest/triage-wiring.js')
        const t = await runProposalTriage({
          store,
          scnsHome: resolveScnsHome(),
          ...(opts.offline ? { offline: true } : {}),
        })
        if (t.rejected > 0 || t.specced > 0) {
          console.log(
            `   triaged: ${t.rejected} duplicate(s) auto-rejected, ${t.specced} spec(s) written` +
              (t.unverified > 0 ? ` (${t.unverified} unverified)` : ''),
          )
        }
      }

      // The routing-accuracy section (Step 2, purpose frame): read + render live in
      // `weekly-report.ts` so the Monday cron handler renders from the SAME code — one renderer, two
      // callers, so the two paths can never drift apart. Read-only over the experience store.
      const { renderRoutingAccuracySection } = await import('./suggest/weekly-report.js')
      const learning = renderRoutingAccuracySection({ scnsDir })
      const session = buildWeeklySession({
        store,
        now: new Date(),
        ...(opts.budget !== undefined && Number.isFinite(opts.budget)
          ? { budget: opts.budget }
          : {}),
      })

      console.log(formatWeeklyHeader(session))
      console.log(learning.text)
      if (!session.hasWork) return

      const items = session.packet.items
      if (opts.dryRun) {
        for (const [i, item] of items.entries()) {
          const s = store.get(item.id)
          if (s) console.log(formatReviewItem(s, i + 1, items.length, item.why))
        }
        console.log('\n(dry run — nothing recorded)')
        return
      }

      const { createLinePrompt } = await import('./cli/line-prompt.js')
      const prompt = createLinePrompt({ input: process.stdin, output: process.stdout })

      let recorded = 0
      let skipped = 0
      let refused = 0
      try {
        for (const [i, item] of items.entries()) {
          const s = store.get(item.id)
          if (!s) continue
          console.log(formatReviewItem(s, i + 1, items.length, item.why))

          const answer = await prompt.ask('\n   approve / reject / explain / skip? ')
          if (answer === null) break
          const raw = answer.trim().toLowerCase()
          if (raw === '' || raw.startsWith('s') || raw.startsWith('q')) {
            skipped++
            if (raw.startsWith('q')) break
            continue
          }
          // Explicit mapping. The old `startsWith('a') ? approve : reject` turned every unrecognised
          // word — including "explain" — into a REJECTION, teaching the learner the idea was bad when
          // the proposal text was what failed.
          const verdict = verdictFromInput(raw)
          if (verdict === null) {
            skipped++
            console.log(
              `   ? "${raw}" isn't approve/reject/explain/skip — skipped, nothing recorded.`,
            )
            continue
          }

          if (verdict === 'explain') {
            console.log(formatReasonMenu(verdict))
            const q = await prompt.ask('   what is unclear? ')
            if (q === null) break
            const result = recordWeeklyVerdict(
              store,
              item.id,
              { verdict, code: 'needs-explanation', text: q.trim() },
              { vault: rationaleVault },
            )
            if (result.ok) {
              recorded++
              // The status is preserved by design for a non-decision, so report the REAL one. An
              // escalated item sits at `needs-human`, and telling John it is "still pending" is the
              // same false-reassurance class as the packet claiming he approved it.
              console.log(
                item.kind === 'escalated'
                  ? '   ✓ noted — still waiting on your "try again" or "close it", and the gap is on the proposal, not on you.'
                  : '   ✓ noted — still pending, and the gap is on the proposal, not on you.',
              )
            } else {
              refused++
              console.log(`   ✗ ${result.error}`)
            }
            reportRationaleWarnings(result.rationaleWarnings)
            continue
          }

          console.log(formatReasonMenu(verdict))
          const reasonAnswer = await prompt.ask('   > ')
          if (reasonAnswer === null) break
          const reasonRaw = reasonAnswer.trim()
          // A code if he typed one, otherwise his prose stands on its own. NEVER infer a code from
          // prose — an inferred code would put words in his mouth and then train on them.
          const firstWord = reasonRaw.split(/[\s:,]+/)[0]?.toLowerCase() ?? ''
          const code = codeIsValidFor(verdict, firstWord) ? firstWord : null
          const text = code ? reasonRaw.slice(firstWord.length).replace(/^[\s:,-]+/, '') : reasonRaw

          const result = recordWeeklyVerdict(
            store,
            item.id,
            { verdict, code, text },
            { vault: rationaleVault },
          )
          if (result.ok) {
            recorded++
            console.log(`   ✓ recorded — ${verdict}: ${code ?? 'your words'}`)
          } else {
            refused++
            console.log(`   ✗ ${result.error}`)
          }
          reportRationaleWarnings(result.rationaleWarnings)
          reportVerdictWarnings(result.verdictWarnings)
        }
      } finally {
        prompt.close()
      }
      console.log(formatWeeklyClosing({ recorded, skipped, refused }))

      // Belt and braces (see review-snapshot.ts): a byte copy of the corpus now that his verdicts and
      // reasons are on disk, and before the brain's next promotion pass can transition anything.
      if (recorded > 0) {
        const { snapshotSuggestions } = await import('./suggest/review-snapshot.js')
        const snap = snapshotSuggestions({
          sourceDir: join(scnsDir, 'suggestions'),
          snapshotRootDir: join(scnsDir, 'suggestions-snapshots'),
        })
        console.log(
          snap.taken
            ? `\n   backup of your answers: ${snap.path}`
            : `\n   ⚠ could not back up your answers (${snap.reason}) — they are still in ${join(scnsDir, 'suggestions')}`,
        )
      }
    },
  )

review
  .command('detail <id>')
  .description('Show full suggestion details')
  .action(async (id: string) => {
    const { createSuggestionStore } = await import('./suggest/suggestion-store.js')
    const { formatSuggestionDetail } = await import('./suggest/format.js')

    const scnsDir = join(resolveScnsHome(), '.scns')
    const store = createSuggestionStore({ rootDir: join(scnsDir, 'suggestions') })
    const suggestion = store.get(id)
    if (!suggestion) {
      console.error(`Suggestion ${id} not found`)
      process.exitCode = 1
      return
    }
    console.log(formatSuggestionDetail(suggestion))
  })

review
  .command('approve <id>')
  .description('Approve a suggestion (reason required)')
  .requiredOption('--reason <reason>', 'Approval reason')
  .action(async (id: string, opts: { reason: string }) => {
    const { createSuggestionStore } = await import('./suggest/suggestion-store.js')
    const { createExecutor } = await import('./suggest/executor.js')
    const { createReviewWorkflow } = await import('./suggest/review.js')
    const { formatReviewResult } = await import('./suggest/format.js')

    const { createVault } = await import('./memory/vault.js')
    const { tagHumanReason } = await import('./suggest/review-reason.js')

    const scnsDir = join(resolveScnsHome(), '.scns')
    const store = createSuggestionStore({ rootDir: join(scnsDir, 'suggestions') })
    const executor = createExecutor()
    const workflow = createReviewWorkflow({
      store,
      executor,
      vault: createVault({ rootDir: join(scnsDir, 'memory') }),
    })
    // A human typed this command. Tag it as such (T128b): the `human:` prefix is what protects the
    // words from being overwritten by the auto-execute transition, and what keeps them out of the
    // machine-reason bucket. Untagged, John's `--reason` prose was indistinguishable from a
    // quality-gate string and was erased on exactly the same path.
    //
    // FR-055b (DECIDED 2026-08-04): `--reason` is now a `requiredOption`, matching `reject`. The
    // asymmetry — required to refuse, optional to accept — is precisely how the APPROVAL half of
    // the corpus came to be empty while the rejection half filled up, and an empty approval half
    // is what lets the machine infer why John accepted something. This is a breaking change to a
    // human-facing CLI contract; it was safe to make because `review approve` has no
    // non-interactive caller: the auto-approve path (`SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD`) runs
    // through `suggestion-promoter.ts` → `updateStatus` and never shells out to this command, and
    // no plist or cron entry invokes it. A machine caller that appears later must get its own
    // path rather than a placeholder rationale — FR-051/SC-025 forbid inferred reasons entering
    // the corpus.
    //
    // A BLANK `--reason` is still refused, symmetrically with `reject`: `requiredOption` only
    // enforces that the flag is present, not that it says anything.
    const approveReason = tagHumanReason('approve', opts.reason)
    if (approveReason === undefined) {
      console.log(
        '   ✗ --reason cannot be empty — an approval without a reason is the exact signal this review exists to capture.',
      )
      process.exitCode = 1
      return
    }
    let result
    try {
      result = workflow.approve(id, approveReason)
    } catch (err) {
      // FR-053 on the throw path: the executor can blow up after his words were already captured
      // (or already failed to be). Say which happened before the error surfaces, so a stack trace
      // never doubles as a silent loss.
      for (const w of (err as { rationaleWarnings?: readonly string[] }).rationaleWarnings ?? []) {
        console.log(`   ⚠ your reasoning was NOT saved to the vault: ${w}`)
      }
      throw err
    }
    console.log(formatReviewResult(result))
    // FR-053: a capture failure is said out loud, on the same seam as the weekly review. Printing
    // a tick while the reasoning went nowhere is the defect this whole change exists to remove.
    for (const w of result.rationaleWarnings ?? []) {
      console.log(`   ⚠ your reasoning was NOT saved to the vault: ${w}`)
    }
    if (!result.success) process.exitCode = 1
  })

review
  .command('reject <id>')
  .description('Reject a suggestion (reason required)')
  .requiredOption('--reason <reason>', 'Rejection reason')
  .action(async (id: string, opts: { reason: string }) => {
    const { createSuggestionStore } = await import('./suggest/suggestion-store.js')
    const { createExecutor } = await import('./suggest/executor.js')
    const { createReviewWorkflow } = await import('./suggest/review.js')
    const { formatReviewResult } = await import('./suggest/format.js')

    const { createVault } = await import('./memory/vault.js')
    const { tagHumanReason } = await import('./suggest/review-reason.js')

    const scnsDir = join(resolveScnsHome(), '.scns')
    const store = createSuggestionStore({ rootDir: join(scnsDir, 'suggestions') })
    const executor = createExecutor()
    const workflow = createReviewWorkflow({
      store,
      executor,
      vault: createVault({ rootDir: join(scnsDir, 'memory') }),
    })
    // `--reason` is a requiredOption here, so a BLANK one is a mistake worth naming rather than
    // quietly recording an unexplained rejection — the thing the weekly loop already refuses.
    const rejectReason = tagHumanReason('reject', opts.reason)
    if (rejectReason === undefined) {
      console.log('   ✗ --reason cannot be empty — a rejection without a reason teaches nothing.')
      process.exitCode = 1
      return
    }
    const result = workflow.reject(id, rejectReason)
    console.log(formatReviewResult(result))
    for (const w of result.rationaleWarnings ?? []) {
      console.log(`   ⚠ your reasoning was NOT saved to the vault: ${w}`)
    }
    if (!result.success) process.exitCode = 1
  })

review
  .command('plan <id>')
  .description('Preview implementation plan for a suggestion')
  .action(async (id: string) => {
    const { createSuggestionStore } = await import('./suggest/suggestion-store.js')
    const { createExecutor } = await import('./suggest/executor.js')
    const { createReviewWorkflow } = await import('./suggest/review.js')
    const { formatPlan } = await import('./suggest/format.js')

    const scnsDir = join(resolveScnsHome(), '.scns')
    const store = createSuggestionStore({ rootDir: join(scnsDir, 'suggestions') })
    const executor = createExecutor()
    const workflow = createReviewWorkflow({ store, executor })
    const plan = workflow.previewPlan(id)
    if (!plan) {
      console.error(`Suggestion ${id} not found`)
      process.exitCode = 1
      return
    }
    console.log(formatPlan(plan))
  })

review
  .command('preview <id>')
  .description('Preview the artifact that would be generated for a suggestion')
  .action(async (id: string) => {
    const { createSuggestionStore } = await import('./suggest/suggestion-store.js')
    const { generateArtifact } = await import('./suggest/artifact-generators.js')
    const { formatArtifactPreview } = await import('./suggest/format.js')

    const scnsDir = join(resolveScnsHome(), '.scns')
    const store = createSuggestionStore({ rootDir: join(scnsDir, 'suggestions') })
    const suggestion = store.get(id)
    if (!suggestion) {
      console.error(`Suggestion ${id} not found`)
      process.exitCode = 1
      return
    }
    const artifact = generateArtifact(suggestion)
    if (!artifact) {
      console.error(`No artifact generator for type: ${suggestion.type}`)
      process.exitCode = 1
      return
    }
    console.log(formatArtifactPreview(artifact))
  })

// Phase 13.12.16 — suggestion management (`scns suggest ...`).
// Operates on the filesystem store directly so it works with the broker down.
const suggest = program
  .command('suggest')
  .description('Manage the on-disk suggestion pile (list/delete/retry/dismiss/repromote)')

function loadSuggestStore() {
  const scnsDir = join(resolveScnsHome(), '.scns')
  // Using dynamic import keeps the CLI startup fast; same pattern as `review`.
  return import('./suggest/suggestion-store.js').then(({ createSuggestionStore }) =>
    createSuggestionStore({ rootDir: join(scnsDir, 'suggestions') }),
  )
}

suggest
  .command('list')
  .description('List suggestions; filter by --status and/or --type')
  .option('--status <status>', 'Filter by status (pending/approved/failed/...)')
  .option('--type <type>', 'Filter by type (skill/workflow/automation/...)')
  .action(async (opts: { status?: string; type?: string }) => {
    const store = await loadSuggestStore()
    const { runList } = await import('./cli/suggest.js')
    console.log(runList(store, opts))
  })

suggest
  .command('delete <id>')
  .description('Delete a suggestion (removes its markdown file)')
  .action(async (id: string) => {
    const store = await loadSuggestStore()
    const { runDelete } = await import('./cli/suggest.js')
    const r = runDelete(store, id)
    console.log(r.message)
    if (!r.ok) process.exitCode = 1
  })

suggest
  .command('retry <id>')
  .description('Retry a failed suggestion (resets attempt_count, sends back to approved)')
  .action(async (id: string) => {
    const store = await loadSuggestStore()
    const { runRetry } = await import('./cli/suggest.js')
    const r = runRetry(store, id)
    console.log(r.message)
    if (!r.ok) process.exitCode = 1
  })

suggest
  .command('dismiss <id>')
  .description('Mark a suggestion rejected with reason "dismissed by user"')
  .action(async (id: string) => {
    const store = await loadSuggestStore()
    const { runDismiss } = await import('./cli/suggest.js')
    const r = runDismiss(store, id)
    console.log(r.message)
    if (!r.ok) process.exitCode = 1
  })

suggest
  .command('repromote <id>')
  .description('Promote a needs-human suggestion back to pending')
  .action(async (id: string) => {
    const store = await loadSuggestStore()
    const { runRepromote } = await import('./cli/suggest.js')
    const r = runRepromote(store, id)
    console.log(r.message)
    if (!r.ok) process.exitCode = 1
  })

suggest
  .command('repair-labels')
  .description(
    'Repair rows the quality gate mislabelled as human refusals (dry-run unless --apply)',
  )
  .option('--apply', 'Write the repairs (default is a dry run)')
  .action(async (opts: { apply?: boolean }) => {
    const { applyQgMislabelRepair, applyDestinationTextRepair } =
      await import('./suggest/qg-mislabel-repair.js')
    const suggestionsDir = join(resolveScnsHome(), '.scns', 'suggestions')
    const report = applyQgMislabelRepair(suggestionsDir, { dryRun: !opts.apply })

    // Rows written before the location map was corrected still show the human the OLD
    // destination. Leaving that text in place keeps the reported defect visible on disk and makes
    // reviewing critics fail the row for a mismatch that no longer exists in the code.
    const textRepair = applyDestinationTextRepair(suggestionsDir, { dryRun: !opts.apply })
    for (const item of textRepair.items) {
      console.log(`${item.id}  destination text  [refresh-destination]`)
      console.log(`    ${item.from} → ${item.to}`)
    }

    if (report.items.length === 0) {
      if (textRepair.items.length > 0) {
        console.log(
          textRepair.applied
            ? `\n${textRepair.items.length} row(s) had stale destination text rewritten.`
            : `\n${textRepair.items.length} row(s) have stale destination text. Re-run with --apply.`,
        )
      } else {
        console.log('No mislabelled rows found.')
      }
      return
    }
    for (const item of report.items) {
      console.log(`${item.id}  ${item.fromStatus} → ${item.toStatus}  [${item.action}]`)
      console.log(`    ${item.why}`)
    }
    console.log(
      report.dryRun
        ? `\n${report.items.length} row(s) would be repaired. Re-run with --apply to write.`
        : `\n${report.applied} row(s) repaired.`,
    )
  })

suggest
  .command('execute <id>')
  .description('Generate and execute the plan for a suggestion (respects safety gates)')
  .action(async (id: string) => {
    const { createSuggestionStore } = await import('./suggest/suggestion-store.js')
    const { createExecutor } = await import('./suggest/executor.js')
    const { loadAutonomy } = await import('./autonomy/index.js')
    const scnsDir = join(resolveScnsHome(), '.scns')
    const store = createSuggestionStore({ rootDir: join(scnsDir, 'suggestions') })
    const suggestion = store.get(id)
    if (!suggestion) {
      console.error(`Suggestion ${id} not found`)
      process.exitCode = 1
      return
    }
    const liveLevel = loadAutonomy(join(scnsDir, 'state')).level
    const executor = createExecutor({ autonomyLevel: liveLevel })
    try {
      const plan = executor.generatePlan(suggestion)
      const result = executor.execute(plan, suggestion)
      if (result.gateDecision && !result.gateDecision.ok) {
        const terminal = result.gateDecision.status === 'needs-human' ? 'needs-human' : 'rejected'
        // FR-050c: the executor's safety-gate refusal is the machine's own verdict.
        store.updateStatus(id, terminal as never, result.gateDecision.reason, undefined, {
          author: 'machine',
        })
        console.error(`${terminal}: ${result.gateDecision.reason}`)
        process.exitCode = 1
        return
      }
      if (result.success) {
        // Phase 13.12.19: run self-critique before marking implemented so a
        // "succeeded but output empty/missing" execution gets caught.
        const {
          loadSelfCritiqueConfig,
          runSelfCritique,
          writeCritiqueFile,
          createDefaultCriticSpawner,
        } = await import('./brain/self-critique.js')
        const critiqueCfg = loadSelfCritiqueConfig(liveLevel)
        const verdict = await runSelfCritique(
          {
            suggestion,
            teamOutput: [
              `success: ${result.success}`,
              `stepsCompleted: ${result.stepsCompleted}/${result.stepsTotal}`,
              result.filesCreated.length > 0
                ? `filesCreated:\n${result.filesCreated.map((f) => `  - ${f}`).join('\n')}`
                : 'filesCreated: (none)',
            ].join('\n'),
          },
          {
            enabled: critiqueCfg.enabled,
            autonomyLevel: liveLevel,
            timeoutMs: critiqueCfg.timeoutMs,
            spawnCritic:
              critiqueCfg.enabled && liveLevel >= 2
                ? createDefaultCriticSpawner({
                    command: critiqueCfg.criticCommand,
                    args: critiqueCfg.criticArgs,
                  })
                : undefined,
          },
        )

        const targetStatus =
          verdict.verdict === 'pass'
            ? 'implemented'
            : verdict.verdict === 'fail'
              ? 'failed'
              : 'needs-human'
        const summary = verdict.findings.slice(0, 3).join('; ') || verdict.verdict

        if (verdict.verdict === 'pass') {
          store.updateStatus(id, 'implemented' as never, undefined, undefined, {
            author: 'machine',
          })
          console.log(`executed ${result.stepsCompleted}/${result.stepsTotal} steps`)
        } else if (verdict.verdict === 'fail') {
          store.recordFailure(id, `self-critique: ${summary}`)
          console.error(`self-critique FAIL: ${summary}`)
          process.exitCode = 1
        } else {
          store.updateStatus(id, 'needs-human' as never, `self-critique: ${summary}`, undefined, {
            author: 'machine',
            // See the brain's copy of this branch: critic refusal, not retry exhaustion.
            escalation: 'gate-refused',
          })
          console.error(`self-critique NEEDS-EVIDENCE: ${summary}`)
          process.exitCode = 1
        }
        try {
          const critiquePath = writeCritiqueFile({
            verdict,
            suggestion,
            targetStatus,
            suggestionsRoot: join(scnsDir, 'suggestions'),
          })
          console.log(`critique: ${critiquePath}`)
        } catch (err) {
          console.error(
            `critique write failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        if (result.filesCreated.length > 0 && verdict.verdict === 'pass') {
          console.log('files:')
          for (const f of result.filesCreated) console.log(`  ${f}`)
        }
      } else {
        console.error(`failed: ${result.errors.join('; ')}`)
        process.exitCode = 1
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`execute failed: ${msg}`)
      process.exitCode = 1
    }
  })

program
  .command('promote')
  .description('Promote SCNS to the next autonomy level')
  .action(() => {
    const stateDir = join(resolveScnsHome(), '.scns', 'state')
    const result = promoteAutonomy(stateDir)
    console.log(`Autonomy level: L${result.level} — ${getAutonomyDescription(result.level)}`)
  })

program
  .command('demote')
  .description('Demote SCNS to the previous autonomy level')
  .action(() => {
    const stateDir = join(resolveScnsHome(), '.scns', 'state')
    const result = demoteAutonomy(stateDir)
    console.log(`Autonomy level: L${result.level} — ${getAutonomyDescription(result.level)}`)
  })

// Phase 13.12.17 — secret vault (`scns secret ...`).
// Directly operates on ~/.scns/secrets/ so it works with the broker down.
// Note: there is intentionally no `scns secret get` — values leave the
// machine only through the internal-token-guarded broker route.
const secret = program
  .command('secret')
  .description('Manage the SCNS credential vault (set/list/delete; no get)')

function loadSecretStore() {
  const root = join(resolveScnsHome(), '.scns', 'secrets')
  return import('./secrets/secret-store.js').then(({ createSecretStore }) =>
    createSecretStore({ rootDir: root }),
  )
}

secret
  .command('set <key>')
  .description('Store a secret; value is read from stdin with echo suppressed')
  .action(async (key: string) => {
    const { isValidKey } = await import('./secrets/secret-store.js')
    if (!isValidKey(key)) {
      console.error(`Invalid key: ${JSON.stringify(key)}`)
      process.exitCode = 1
      return
    }
    const { readSecretFromStdin, runSet } = await import('./cli/secret-cli.js')
    let value: string
    try {
      value = await readSecretFromStdin(`Value for ${key} (input hidden): `)
    } catch (err) {
      console.error(`\nAborted: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
      return
    }
    const store = await loadSecretStore()
    const r = runSet(store, key, value)
    console.log(r.message)
    if (!r.ok) process.exitCode = 1
  })

secret
  .command('list')
  .description('List secret keys with created/updated timestamps (values never printed)')
  .action(async () => {
    const store = await loadSecretStore()
    const { runList } = await import('./cli/secret-cli.js')
    console.log(runList(store))
  })

secret
  .command('delete <key>')
  .description('Delete a secret by key (prompts for confirmation)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (key: string, opts: { yes?: boolean }) => {
    if (!opts.yes) {
      const readline = await import('node:readline')
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const answer = await new Promise<string>((resolve) =>
        rl.question(`Delete secret ${key}? [y/N] `, (a) => {
          rl.close()
          resolve(a.trim().toLowerCase())
        }),
      )
      if (answer !== 'y' && answer !== 'yes') {
        console.log('Cancelled')
        return
      }
    }
    const store = await loadSecretStore()
    const { runDelete } = await import('./cli/secret-cli.js')
    const r = runDelete(store, key)
    console.log(r.message)
    if (!r.ok) process.exitCode = 1
  })

const observe = program
  .command('observe')
  .description('Manage the observation layer (background observers)')

observe
  .command('start')
  .description('Start observation manager (foreground, Ctrl+C to stop)')
  .action(() => {
    const scnsDir = join(resolveScnsHome(), '.scns')
    const vaultRootDir = join(scnsDir, 'memory')
    const config = loadObservationConfig()

    const manager = createObservationManager({ config, vaultRootDir })
    manager.start()

    const status = manager.getStatus()
    console.log('Observation manager started')
    console.log(`  Observers: ${status.observers.map((o) => o.name).join(', ')}`)

    const shutdown = () => {
      console.log('\nStopping observation manager...')
      manager.stop()
      console.log('Stopped.')
      // See start command rationale: brief settle delay before process.exit()
      // so native worker threads quiesce before libuv tears them down.
      const exitDelayMs = Number(process.env.SCNS_SHUTDOWN_EXIT_DELAY_MS ?? '750')
      setTimeout(() => process.exit(), exitDelayMs).unref()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })

observe
  .command('stop')
  .description('Stop the SCNS system via the broker')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .action(async (opts: { brokerUrl: string }) => {
    try {
      const res = await fetch(`${opts.brokerUrl}/api/system/stop`, { method: 'POST' })
      if (res.ok) {
        console.log('SCNS shutdown initiated')
      } else {
        console.error('Failed to stop SCNS:', res.statusText)
        process.exitCode = 1
      }
    } catch (err) {
      console.error(
        `Failed to reach broker at ${opts.brokerUrl}: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exitCode = 1
    }
  })

observe
  .command('status')
  .description('Show which observers are configured')
  .action(() => {
    const config = loadObservationConfig()
    const scnsDir = join(resolveScnsHome(), '.scns')
    const vaultRootDir = join(scnsDir, 'memory')
    createObservationManager({ config, vaultRootDir })

    console.log('Observation layer status (config):')
    const entries: [string, { enabled: boolean; optIn: boolean }][] = [
      ['active-app', config.activeApp],
      ['file-changes', config.fileChanges],
      ['git-activity', config.gitActivity],
      ['terminal-history', config.terminalHistory],
      ['browser-tabs', config.browserTabs],
      ['session-hooks', config.sessionHooks],
    ]
    for (const [name, cfg] of entries) {
      const flag = cfg.enabled ? '✓' : '✗'
      const optIn = cfg.optIn ? ' (opt-in)' : ''
      console.log(`  ${flag} ${name}${optIn}`)
    }
  })

observe
  .command('install-hooks')
  .description('Generate and display Claude/Copilot hook scripts')
  .option('--broker-url <url>', 'Session broker URL', 'http://localhost:3456')
  .action((opts: { brokerUrl: string }) => {
    const logWriter = createDailyLogWriter({ appendDailyLog: () => {} })
    const handler = createSessionHookHandler({
      logWriter,
      config: { enabled: true, optIn: false },
    })

    console.log('# Claude Code hook scripts')
    console.log('# Copy into .claude/hooks/ or configure in .claude/settings.json\n')
    for (const event of handler.getRegisteredEvents()) {
      console.log(`--- ${event} ---`)
      console.log(handler.generateClaudeHookScript(event, opts.brokerUrl))
    }

    console.log('\n# Copilot hook scripts\n')
    for (const event of handler.getRegisteredEvents()) {
      console.log(`--- ${event} ---`)
      console.log(handler.generateCopilotHookScript(event, opts.brokerUrl))
    }
  })

observe
  .command('setup-telemetry')
  .description('Generate shell config to enable Copilot CLI OTel telemetry for SCNS')
  .option('--content-capture', 'Capture LLM message content in telemetry', false)
  .option('--file-path <path>', 'Custom JSONL export file path')
  .action(async (opts: { contentCapture: boolean; filePath?: string }) => {
    const { generateTelemetryEnvBlock, detectExistingConfig, ensureTelemetryDir } =
      await import('./otel/auto-config.js')

    const existing = detectExistingConfig()
    if (existing.configured) {
      console.log('Existing telemetry configuration detected:')
      console.log(`  File path: ${existing.filePath ?? '(not set)'}`)
      console.log(`  Content capture: ${existing.contentCapture}`)
      console.log()
    }

    const block = generateTelemetryEnvBlock({
      filePath: opts.filePath,
      contentCapture: opts.contentCapture,
    })

    ensureTelemetryDir(opts.filePath)

    console.log(block)
    console.log('# Add the above to your ~/.bashrc or ~/.zshrc, then run:')
    console.log('#   source ~/.bashrc')
  })

// ── Task subcommand ──────────────────────────────────────────────────

const task = program.command('task').description('Operate on broker tasks')

task
  .command('spawn <id>')
  .description('Spawn a role-specific agent against a stored task (manager/dev/qa/researcher)')
  .option(
    '--role <role>',
    'Agent role: scns-manager | scns-dev | scns-qa | scns-researcher',
    'scns-manager',
  )
  .option('--launch-method <method>', 'Launch method: acp | detached | tmux', 'acp')
  .option('--working-dir <path>', 'Working directory for the spawned agent')
  .option('--extra-context <text>', 'Additional context appended to the prompt')
  .option(
    '--broker-url <url>',
    'Broker URL',
    process.env.SCNS_BROKER_URL ?? 'http://localhost:3456',
  )
  .action(
    async (
      id: string,
      opts: {
        role: string
        launchMethod: string
        workingDir?: string
        extraContext?: string
        brokerUrl: string
      },
    ) => {
      const taskId = Number(id)
      if (!Number.isInteger(taskId) || taskId <= 0) {
        console.error(`Invalid task id: ${id}`)
        process.exit(2)
      }
      const body: Record<string, unknown> = {
        role: opts.role,
        launch_method: opts.launchMethod,
      }
      if (opts.workingDir) body.working_dir = opts.workingDir
      if (opts.extraContext) body.extra_context = opts.extraContext

      try {
        const res = await fetch(`${opts.brokerUrl}/api/tasks/${taskId}/spawn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const text = await res.text()
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }

        if (res.status === 201) {
          console.log(JSON.stringify(parsed, null, 2))
          return
        }
        if (res.status === 409) {
          const data = parsed as { current_owner?: string; error?: string }
          console.error(
            `409 Conflict: task ${taskId} already has owner ${data.current_owner ?? '(unknown)'}.`,
          )
          console.error(`Tie goes to existing owner. Resolve via team messaging before retrying.`)
          process.exit(2)
        }
        console.error(`HTTP ${res.status}: ${text}`)
        process.exit(1)
      } catch (err) {
        console.error(
          `Failed to reach broker at ${opts.brokerUrl}: ${err instanceof Error ? err.message : String(err)}`,
        )
        process.exit(1)
      }
    },
  )

// ── Research subcommand (on-demand researcher: human + CLI-agent surface) ──

program
  .command('research <question>')
  .description(
    'Dispatch an on-demand, investigate-only researcher against a question ' +
      '(scaffolds a team + task and spawns a scns-researcher)',
  )
  .option('--working-dir <path>', 'Working directory for the researcher', process.cwd())
  .option('--extra-context <text>', 'Additional context appended to the task description')
  .option('--launch-method <method>', 'Launch method: acp | detached | tmux', 'acp')
  .option(
    '--broker-url <url>',
    'Broker URL',
    process.env.SCNS_BROKER_URL ?? 'http://localhost:3456',
  )
  .option('--json', 'emit JSON instead of human-readable text')
  .action(
    async (
      question: string,
      opts: {
        workingDir: string
        extraContext?: string
        launchMethod: string
        brokerUrl: string
        json?: boolean
      },
    ) => {
      try {
        const result = await dispatchResearch(
          {
            question,
            brokerUrl: opts.brokerUrl,
            workingDir: opts.workingDir,
            extraContext: opts.extraContext,
            launchMethod: opts.launchMethod,
          },
          { fetch: (url, init) => fetch(url, init) },
        )
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2))
        } else {
          console.log(
            `Researcher dispatched: session=${result.sessionId} team=${result.teamId} task=${result.taskId}`,
          )
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    },
  )

// ── Memory subcommand ────────────────────────────────────────────────

const memory = program.command('memory').description('Inspect scoped lessons and memory vault')

memory
  .command('list')
  .description('List scoped lessons matching a context (global + project + agent scopes)')
  .option(
    '--context <pairs...>',
    'context filter key=value pairs (cwd=<path>, project=<slug>, agent=<role>)',
  )
  .option('--agent <role>', 'agent role (brain|dev|qa|reviewer|...)')
  .option('--json', 'emit JSON instead of human-readable text')
  .action(async (opts: { context?: string[]; agent?: string; json?: boolean }) => {
    const { createLessonStore, detectRepoSlug } = await import('./memory/lessons.js')
    const scnsDir = join(resolveScnsHome(), '.scns')
    const lessonsDir = join(scnsDir, 'memory', 'lessons')
    const store = createLessonStore({ rootDir: lessonsDir })

    const filter: { cwd?: string; project?: string; agent?: string } = {}
    for (const entry of opts.context ?? []) {
      const [k, v] = entry.split('=')
      if (!k || !v) continue
      if (k === 'cwd') filter.cwd = v
      else if (k === 'project') filter.project = v
      else if (k === 'agent') filter.agent = v
    }
    if (opts.agent) filter.agent = opts.agent
    if (filter.cwd && !filter.project) filter.project = detectRepoSlug(filter.cwd)

    const lessons = store.list(filter)

    if (opts.json) {
      console.log(JSON.stringify({ filter, count: lessons.length, lessons }, null, 2))
      return
    }

    console.log(
      `Context: cwd=${filter.cwd ?? '-'}  project=${filter.project ?? '-'}  agent=${filter.agent ?? '-'}`,
    )
    console.log(`Matched lessons: ${lessons.length}\n`)
    const groups = store.groupByScope(lessons)
    for (const [scope, ls] of Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`— ${scope} (${ls.length})`)
      for (const l of ls) {
        const tags = l.frontmatter.tags.length > 0 ? ` [${l.frontmatter.tags.join(', ')}]` : ''
        console.log(`  • ${l.frontmatter.id}${tags}`)
      }
    }
  })

memory
  .command('migrate')
  .description('Migrate legacy flat-file lessons into ~/.scns/memory/lessons/ (idempotent)')
  .option('--dry-run', 'show what would be migrated without touching files')
  .action(async (opts: { dryRun?: boolean }) => {
    const { migrateLegacyLessons } = await import('./memory/lessons.js')
    const scnsDir = join(resolveScnsHome(), '.scns')
    const root = join(scnsDir, 'memory')
    const lessonsDir = join(root, 'lessons')
    if (opts.dryRun) {
      console.log(`(dry-run) Would migrate legacy lessons in ${root} → ${lessonsDir}`)
      return
    }
    const result = migrateLegacyLessons(root, lessonsDir)
    console.log(`Migrated: ${result.migrated.length}`)
    for (const m of result.migrated) {
      console.log(
        `  ${m.from} → ${m.to}  (scope=${m.scope}${m.project ? ` project=${m.project}` : ''})`,
      )
    }
    if (result.skipped.length > 0) {
      console.log(`Skipped: ${result.skipped.length}`)
      for (const s of result.skipped) console.log(`  ${s.file}: ${s.reason}`)
    }
  })

// ── memory critic ────────────────────────────────────────────────────
//
// Filter the negative-memory vault before rules land in
// .github/copilot-instructions.md. The default mode is dry-run so the
// command is always safe to invoke.

const critic = memory
  .command('critic')
  .description('Review negative memories: classify pipeline-artifact noise vs real lessons')

critic
  .command('run', { isDefault: true })
  .description('Run the critic and print verdicts (dry-run by default)')
  .option('--apply', 'persist verdicts to the vault (default: dry-run only)')
  .option('--force', 're-judge memories whose verdict is already current')
  .option('--json', 'emit JSON')
  .action(async (opts: { apply?: boolean; force?: boolean; json?: boolean }) => {
    const { createVault } = await import('./memory/vault.js')
    const { runNegativeMemoryCritic } = await import('./memory/negative-memory-critic.js')
    const scnsDir = join(resolveScnsHome(), '.scns')
    const vault = createVault({ rootDir: join(scnsDir, 'memory') })
    const result = await runNegativeMemoryCritic({
      vault,
      dryRun: !opts.apply,
      forceReReview: Boolean(opts.force),
    })
    if (opts.json) {
      const verdictArr = Array.from(result.verdicts.entries()).map(([id, v]) => ({ id, ...v }))
      console.log(JSON.stringify({ ...result, verdicts: verdictArr }, null, 2))
      return
    }
    console.log(
      `total=${result.totalCandidates}  heuristic-suppress=${result.heuristicSuppressed}  ` +
        `llm-judged=${result.llmJudged}  llm-suppress=${result.llmSuppressed}  ` +
        `llm-revise=${result.llmRevised}  skipped=${result.skippedAlreadyReviewed}`,
    )
    console.log(opts.apply ? '(applied)' : '(dry-run; pass --apply to persist)')
  })

critic
  .command('list-suppressed')
  .description('List memories the critic has marked as suppressed (audit visibility)')
  .option('--json', 'emit JSON')
  .action(async (opts: { json?: boolean }) => {
    const { createVault } = await import('./memory/vault.js')
    const { createNegativeMemoryStore } = await import('./memory/negative-memory-store.js')
    const scnsDir = join(resolveScnsHome(), '.scns')
    const vault = createVault({ rootDir: join(scnsDir, 'memory') })
    const store = createNegativeMemoryStore(vault)
    const all = store.list({ limit: 10_000 })
    const suppressed = all.filter((m) => m.criticVerdict?.status === 'suppress')
    if (opts.json) {
      console.log(JSON.stringify(suppressed, null, 2))
      return
    }
    console.log(`Suppressed memories: ${suppressed.length}`)
    for (const m of suppressed) {
      const c = m.criticVerdict!
      console.log(`  ${m.id}  [${c.source}, x${c.consecutiveSuppressCount ?? 1}]`)
      console.log(`    rule: ${m.dontRule.slice(0, 100)}`)
      console.log(`    reason: ${c.rationale}`)
    }
  })

critic
  .command('purge')
  .description('Hard-delete memories with N consecutive suppress verdicts')
  .option('--threshold <n>', 'minimum consecutive suppresses to delete', '3')
  .option('--apply', 'actually delete (default: dry-run)')
  .action(async (opts: { threshold?: string; apply?: boolean }) => {
    const { createVault } = await import('./memory/vault.js')
    const { createNegativeMemoryStore } = await import('./memory/negative-memory-store.js')
    const threshold = parseInt(opts.threshold ?? '3', 10) || 3
    const scnsDir = join(resolveScnsHome(), '.scns')
    const vault = createVault({ rootDir: join(scnsDir, 'memory') })
    const store = createNegativeMemoryStore(vault)
    const all = store.list({ limit: 10_000 })
    const targets = all.filter(
      (m) =>
        m.criticVerdict?.status === 'suppress' &&
        (m.criticVerdict.consecutiveSuppressCount ?? 0) >= threshold &&
        !m.pinned,
    )
    console.log(
      `${targets.length} memorie(s) eligible for purge (threshold=${threshold} consecutive suppresses)`,
    )
    for (const t of targets) {
      console.log(`  ${t.id}  ${t.dontRule.slice(0, 80)}`)
      if (opts.apply) store.delete(t.id)
    }
    console.log(opts.apply ? '(deleted)' : '(dry-run; pass --apply to delete)')
  })

critic
  .command('pin <id>')
  .description('Pin a memory so the critic cannot suppress it')
  .action(async (id: string) => {
    const { createVault } = await import('./memory/vault.js')
    const { createNegativeMemoryStore } = await import('./memory/negative-memory-store.js')
    const scnsDir = join(resolveScnsHome(), '.scns')
    const vault = createVault({ rootDir: join(scnsDir, 'memory') })
    const store = createNegativeMemoryStore(vault)
    const updated = store.setPinned(id, true)
    if (!updated) {
      console.error(`memory not found: ${id}`)
      process.exitCode = 1
      return
    }
    console.log(`pinned: ${id}`)
  })

critic
  .command('unpin <id>')
  .description('Remove the pinned override from a memory')
  .action(async (id: string) => {
    const { createVault } = await import('./memory/vault.js')
    const { createNegativeMemoryStore } = await import('./memory/negative-memory-store.js')
    const scnsDir = join(resolveScnsHome(), '.scns')
    const vault = createVault({ rootDir: join(scnsDir, 'memory') })
    const store = createNegativeMemoryStore(vault)
    const updated = store.setPinned(id, false)
    if (!updated) {
      console.error(`memory not found: ${id}`)
      process.exitCode = 1
      return
    }
    console.log(`unpinned: ${id}`)
  })

// ── memory delete / prune / restore ──────────────────────────────────
//
// Directory-scoped, project-bound memory maintenance (#71, #73). Every command
// resolves the OWNING project through the meta registry rather than the caller's
// home vault, previews by default, and refuses to write while that project's
// broker is live (one writer per vault).

interface DirectoryScopedOptions {
  directory?: string
  metaDb?: string
  projectDbDir?: string
}

async function openScopedMemory(opts: DirectoryScopedOptions, forWrite: boolean) {
  const { resolveProjectMemory, openProjectMemory } = await import('./memory/pruning-runner.js')
  const resolved = resolveProjectMemory({
    directory: opts.directory ?? process.cwd(),
    ...(opts.metaDb ? { metaDbPath: opts.metaDb } : {}),
    ...(opts.projectDbDir ? { projectDbDir: opts.projectDbDir } : {}),
  })
  if (forWrite && resolved.brokerLive) {
    throw new Error(
      `project ${resolved.identity.projectId} has a live broker on port ${resolved.boundPort} — ` +
        'its own process owns that vault. Stop it (or apply through the broker) before writing; ' +
        'refusing to open a second writer against a live vault.',
    )
  }
  return openProjectMemory(resolved)
}

const DIRECTORY_OPTION_HELP = 'project directory to operate on (default: cwd)'

memory
  .command('delete <path>')
  .description('Delete one vault memory and reconcile its index + managed instructions (#71)')
  .option('--directory <dir>', DIRECTORY_OPTION_HELP)
  .option('--meta-db <path>', 'meta-broker registry path')
  .option('--project-db-dir <dir>', 'per-project broker DB directory')
  .option('--apply', 'actually delete (default: dry-run preview)')
  .option('--hard', 'unrecoverable hard delete (default: recoverable retire)')
  .option('--allow-pinned', 'also remove a pinned memory')
  .option('--json', 'emit JSON')
  .action(
    async (
      path: string,
      opts: DirectoryScopedOptions & {
        apply?: boolean
        hard?: boolean
        allowPinned?: boolean
        json?: boolean
      },
    ) => {
      const { previewMemoryDeletion, applyMemoryDeletion } =
        await import('./memory/memory-deletion.js')
      const { withVaultLease } = await import('./memory/pruning-runner.js')
      let opened
      try {
        opened = await openScopedMemory(opts, Boolean(opts.apply))
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
        return
      }
      try {
        const plan = previewMemoryDeletion({
          vault: opened.vault,
          db: opened.db,
          identity: opened.resolved.identity,
          targets: [{ path }],
          mode: opts.hard ? 'hard-delete' : 'retire',
        })
        if (!opts.apply) {
          console.log(opts.json ? JSON.stringify(plan, null, 2) : formatDeletionPreview(plan))
          if (!opts.json) console.log('\n(dry-run; pass --apply to execute)')
          return
        }
        const result = withVaultLease(opened.resolved.identity.vaultRoot, () =>
          applyMemoryDeletion({
            vault: opened!.vault,
            db: opened!.db,
            identity: opened!.resolved.identity,
            plan,
            allowPinned: Boolean(opts.allowPinned),
          }),
        )
        console.log(opts.json ? JSON.stringify(result, null, 2) : formatDeletionResult(result))
        if (!result.applied) process.exitCode = 1
      } finally {
        opened.close()
      }
    },
  )

memory
  .command('restore <path>')
  .description('Restore a RETIRED memory from its recovery record (hard deletes are unrecoverable)')
  .option('--directory <dir>', DIRECTORY_OPTION_HELP)
  .option('--meta-db <path>', 'meta-broker registry path')
  .option('--project-db-dir <dir>', 'per-project broker DB directory')
  .option('--json', 'emit JSON')
  .action(async (path: string, opts: DirectoryScopedOptions & { json?: boolean }) => {
    const { restoreRetiredMemory } = await import('./memory/memory-deletion.js')
    const { withVaultLease } = await import('./memory/pruning-runner.js')
    let opened
    try {
      opened = await openScopedMemory(opts, true)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
      return
    }
    try {
      const result = withVaultLease(opened.resolved.identity.vaultRoot, () =>
        restoreRetiredMemory({
          vault: opened!.vault,
          db: opened!.db,
          identity: opened!.resolved.identity,
          path,
        }),
      )
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2))
      } else if (result.restored) {
        console.log(`restored: ${result.path}`)
        if ((result.embeddingsPendingBackfill ?? 0) > 0) {
          console.log(
            `note: ${result.embeddingsPendingBackfill} restored chunk(s) await the next embedding backfill (keyword search is already current)`,
          )
        }
        if (result.managedBlockNote) console.log(`note: ${result.managedBlockNote}`)
      } else {
        console.log(`not restored: ${result.reason}`)
      }
      if (!result.restored) process.exitCode = 1
    } finally {
      opened.close()
    }
  })

memory
  .command('prune')
  .description('Review a project’s memories against current work and propose retirements (#73)')
  .option('--directory <dir>', DIRECTORY_OPTION_HELP)
  .option('--meta-db <path>', 'meta-broker registry path')
  .option('--project-db-dir <dir>', 'per-project broker DB directory')
  .option('--out <file>', 'write the reviewable plan JSON to this file')
  .option('--apply <file>', 'execute a previously reviewed plan file (no re-assessment)')
  .option(
    '--evaluator-cwd <dir>',
    'isolated working dir for the ACP evaluator (enables assessment)',
  )
  .option('--model <name>', 'evaluator model (default: session model)')
  .option('--json', 'emit JSON')
  .action(
    async (
      opts: DirectoryScopedOptions & {
        out?: string
        apply?: string
        evaluatorCwd?: string
        model?: string
        json?: boolean
      },
    ) => {
      const { createMemoryPruningService, formatPruningPlan } =
        await import('./memory/pruning-runner.js')
      let opened
      try {
        opened = await openScopedMemory(opts, Boolean(opts.apply))
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
        return
      }

      try {
        // ── apply a reviewed plan ──
        if (opts.apply) {
          const raw = readFileSync(opts.apply, 'utf-8')
          const plan = JSON.parse(raw) as import('./memory/pruning-runner.js').PruningPlan
          const service = createMemoryPruningService({
            vault: opened.vault,
            db: opened.db,
            identity: opened.resolved.identity,
            brokerDbPath: opened.resolved.brokerDbPath,
            brokerStatus: opened.resolved.status,
          })
          const result = service.apply(plan)
          console.log(opts.json ? JSON.stringify(result, null, 2) : formatDeletionResult(result))
          if (!result.applied) process.exitCode = 1
          return
        }

        // ── preview ──
        let provider
        if (opts.evaluatorCwd) {
          const { createAcpPruningEvaluator } = await import('./memory/pruning-evaluator-acp.js')
          provider = createAcpPruningEvaluator({
            cwd: opts.evaluatorCwd,
            ...(opts.model ? { model: opts.model } : {}),
          })
        }

        const service = createMemoryPruningService({
          vault: opened.vault,
          db: opened.db,
          identity: opened.resolved.identity,
          brokerDbPath: opened.resolved.brokerDbPath,
          brokerStatus: opened.resolved.status,
          ...(provider ? { provider } : {}),
        })
        const plan = await service.preview()

        if (opts.out) {
          mkdirSync(dirname(resolve(opts.out)), { recursive: true })
          writeFileSync(resolve(opts.out), JSON.stringify(plan, null, 2), 'utf-8')
        }
        console.log(opts.json ? JSON.stringify(plan, null, 2) : formatPruningPlan(plan))
        if (!opts.json) {
          console.log(
            opts.out
              ? `\n(preview only; review ${opts.out} then run: scns memory prune --apply "${opts.out}")`
              : '\n(preview only; pass --out <file> to save a reviewable plan, then --apply it)',
          )
        }
      } finally {
        opened.close()
      }
    },
  )

function formatDeletionPreview(
  plan: import('./memory/memory-deletion.js').MemoryDeletionPlan,
): string {
  const lines = [
    `Project   ${plan.project.projectId}`,
    `Vault     ${plan.project.vaultRoot}`,
    `Mode      ${plan.mode}${plan.mode === 'retire' ? ' (recoverable)' : ' (UNRECOVERABLE)'}`,
  ]
  for (const item of plan.items) {
    lines.push('', `  ${item.action} ${item.path}`)
    lines.push(`    source exists: ${item.sourceExists}  pinned: ${item.pinned}`)
    lines.push(
      `    index: file=${item.index.fileRow} chunks=${item.index.chunkCount} ` +
        `fts=${item.index.ftsCount} embeddings=${item.index.embeddingCount} edges=${item.index.edgeCount}`,
    )
    for (const r of item.managedRules) {
      lines.push(
        `    managed rule: ${r.presentInBlock ? 'present' : 'absent'}${r.soleBacker ? ', sole backer' : ', shared with another record'} — ${r.text}`,
      )
    }
  }
  lines.push('', `Managed instructions: ${plan.managedBlock.path}`)
  lines.push(
    `  remove=${plan.managedBlock.removedRules.length} revise=${plan.managedBlock.revisedRules.length} unmatched=${plan.managedBlock.unmatchedRules.length}`,
  )
  for (const w of plan.warnings) lines.push(`Warning   ${w}`)
  return lines.join('\n')
}

function formatDeletionResult(
  result: import('./memory/memory-deletion.js').MemoryDeletionResult,
): string {
  const lines: string[] = []
  if (result.refused) return `refused: ${result.refused}`
  lines.push(
    `applied=${result.applied} partial=${result.partial} recovery=${result.recoveryRef ?? 'none'}`,
  )
  for (const item of result.items) {
    lines.push(
      `  ${item.path}: source=${item.source} index=${item.index} satisfied=${item.satisfied} ` +
        `recoverable=${item.recoverable} chunks-removed=${item.chunksRemoved}` +
        (item.error ? `\n     ${item.error}` : ''),
    )
  }
  lines.push(
    `  managed block: ${result.managedBlock.status} removed=${result.managedBlock.rulesRemoved} revised=${result.managedBlock.rulesRevised}` +
      (result.managedBlock.error ? `\n     ${result.managedBlock.error}` : ''),
  )
  if (result.embeddingsPendingBackfill > 0) {
    lines.push(
      `  ${result.embeddingsPendingBackfill} revised chunk(s) await the next embedding backfill (keyword search is already current)`,
    )
  }
  for (const err of result.errors) lines.push(`  error: ${err}`)
  return lines.join('\n')
}

// ── Brain subcommand ─────────────────────────────────────────────────

const brain = program.command('brain').description('Manage the Brain Agent (wake/decide/act loop)')

brain
  .command('start')
  .description('Start the brain agent loop (foreground, Ctrl+C to stop)')
  .option('--interval <ms>', 'wake interval in milliseconds', '1800000')
  .option('--autonomy <level>', 'autonomy level (0–3)', '0')
  .action(async (opts: { interval: string; autonomy: string }) => {
    const { createBrainAgent } = await import('./brain/agent-loop.js')
    const { createTaskQueue } = await import('./brain/task-queue.js')
    const { createDecisionTree } = await import('./brain/decision-tree.js')
    const { createTaskClassifier } = await import('./brain/classifier.js')
    const { createTemplateEngine } = await import('./brain/templates.js')
    const { createHealthMonitor } = await import('./context/health-monitor.js')

    const deps = {
      classifier: createTaskClassifier(),
      decisionTree: createDecisionTree(),
      templateEngine: createTemplateEngine(),
      healthMonitor: createHealthMonitor(),
      taskQueue: createTaskQueue(),
    }

    const agent = createBrainAgent(deps, {
      intervalMs: parseInt(opts.interval, 10),
      autonomyLevel: parseInt(opts.autonomy, 10),
    })

    agent.start()
    console.log('Brain agent started')
    console.log(`  Interval: ${opts.interval}ms`)
    console.log(`  Autonomy: L${opts.autonomy}`)

    const shutdown = () => {
      console.log('\nStopping brain agent...')
      agent.stop()
      console.log('Stopped.')
      // See start command rationale: brief settle delay before process.exit()
      // so native worker threads quiesce before libuv tears them down.
      const exitDelayMs = Number(process.env.SCNS_SHUTDOWN_EXIT_DELAY_MS ?? '750')
      setTimeout(() => process.exit(), exitDelayMs).unref()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })

brain
  .command('stop')
  .description('Stop the SCNS system via the broker')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .action(async (opts: { brokerUrl: string }) => {
    try {
      const res = await fetch(`${opts.brokerUrl}/api/system/stop`, { method: 'POST' })
      if (res.ok) {
        console.log('SCNS shutdown initiated')
      } else {
        console.error('Failed to stop SCNS:', res.statusText)
        process.exitCode = 1
      }
    } catch (err) {
      console.error(
        `Failed to reach broker at ${opts.brokerUrl}: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exitCode = 1
    }
  })

brain
  .command('status')
  .description('Show brain agent status via the broker')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .action(async (opts: { brokerUrl: string }) => {
    try {
      const res = await fetch(`${opts.brokerUrl}/health/ready`)
      const data = (await res.json()) as Record<string, unknown>
      console.log('Brain agent status:')
      console.log(`  Broker:    ${data.status ?? 'unknown'}`)
      console.log(`  Uptime:    ${data.uptime_seconds ?? '?'}s`)
      const deps = data.dependencies as Record<string, string> | undefined
      if (deps) {
        console.log(`  Database:  ${deps.database ?? '?'}`)
        console.log(`  Embeddings: ${deps.embeddings ?? '?'}`)
      }
    } catch (err) {
      console.error(
        `Brain agent not reachable at ${opts.brokerUrl}: ${err instanceof Error ? err.message : String(err)}`,
      )
      console.log('  (Is the SCNS system running? Start it with: scns start)')
      process.exitCode = 1
    }
  })

brain
  .command('wake')
  .description('Trigger an immediate wake cycle on the running brain (via broker)')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .action(async (opts: { brokerUrl: string }) => {
    try {
      const res = await fetch(`${opts.brokerUrl}/api/brain/wake`, { method: 'POST' })
      const data = (await res.json()) as Record<string, unknown>
      if (res.status === 503) {
        console.error('Brain agent not available on broker')
        process.exitCode = 1
        return
      }
      if (res.status === 202) {
        console.log('Wake already in progress (debounced)')
        return
      }
      if (!res.ok) {
        console.error(`Wake failed: ${String(data.error ?? res.statusText)}`)
        process.exitCode = 1
        return
      }
      const decision = data.decision as {
        action: string
        reason: string
        confidence: number
        priority: string
      }
      console.log('Wake cycle complete:')
      console.log(`  Action:     ${decision.action}`)
      console.log(`  Reason:     ${decision.reason}`)
      console.log(`  Confidence: ${(decision.confidence * 100).toFixed(0)}%`)
      console.log(`  Priority:   ${decision.priority}`)
    } catch (err) {
      console.error(
        `Failed to reach broker at ${opts.brokerUrl}: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exitCode = 1
    }
  })

brain
  .command('add-task <description>')
  .description('Add a task to the brain agent queue')
  .option('--priority <level>', 'task priority (critical/high/normal/low)', 'normal')
  .action(async (description: string, opts: { priority: string }) => {
    const { createBrainAgent } = await import('./brain/agent-loop.js')
    const { createTaskQueue } = await import('./brain/task-queue.js')
    const { createDecisionTree } = await import('./brain/decision-tree.js')
    const { createTaskClassifier } = await import('./brain/classifier.js')
    const { createTemplateEngine } = await import('./brain/templates.js')
    const { createHealthMonitor } = await import('./context/health-monitor.js')
    const { DecisionPriority } = await import('./brain/state-types.js')

    const priorityMap: Record<string, string> = {
      critical: DecisionPriority.Critical,
      high: DecisionPriority.High,
      normal: DecisionPriority.Normal,
      low: DecisionPriority.Low,
    }
    const priority = (priorityMap[opts.priority] ??
      DecisionPriority.Normal) as (typeof DecisionPriority)[keyof typeof DecisionPriority]

    const agent = createBrainAgent({
      classifier: createTaskClassifier(),
      decisionTree: createDecisionTree(),
      templateEngine: createTemplateEngine(),
      healthMonitor: createHealthMonitor(),
      taskQueue: createTaskQueue(),
    })

    const id = agent.addTask(description, priority)
    console.log(`Task added: ${id}`)
    console.log(`  Description: ${description}`)
    console.log(`  Priority:    ${opts.priority}`)
  })

// ── Rotate subcommand ────────────────────────────────────────────

const rotate = program.command('rotate').description('Manage session rotation')

rotate
  .command('status')
  .description('Show rotation controller status')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .action(async (opts: { brokerUrl: string }) => {
    try {
      const res = await fetch(`${opts.brokerUrl}/api/rotate/status`)
      const data = await res.json()
      console.log('Rotation controller status:')
      console.log(JSON.stringify(data, null, 2))
    } catch (err) {
      console.error(
        `Failed to get rotation status: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exitCode = 1
    }
  })

rotate
  .command('candidates')
  .description('List rotation candidates from detector')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .action(async (opts: { brokerUrl: string }) => {
    try {
      const res = await fetch(`${opts.brokerUrl}/api/rotate/candidates`)
      const data = await res.json()
      console.log(JSON.stringify(data, null, 2))
    } catch (err) {
      console.error(
        `Failed to list rotation candidates: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exitCode = 1
    }
  })

rotate
  .command('session <sessionId>')
  .description('Manually trigger rotation for a session')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .action(async (sessionId: string, opts: { brokerUrl: string }) => {
    try {
      const res = await fetch(`${opts.brokerUrl}/api/rotate/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = (await res.json()) as {
        success?: boolean
        targetSessionId?: string
        error?: string
      }
      if (data.success) {
        console.log(`Rotation succeeded: ${sessionId} → ${data.targetSessionId}`)
      } else {
        console.error(`Rotation failed: ${data.error}`)
        process.exitCode = 1
      }
    } catch (err) {
      console.error(`Failed to rotate session: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
  })

// ── Team subcommand ──────────────────────────────────────────────

const team = program.command('team').description('Manage agent teams')

team
  .command('create <name>')
  .description('Create a new team')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .action(async (name: string, opts: { brokerUrl: string }) => {
    try {
      const res = await fetch(`${opts.brokerUrl}/api/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      console.log(`Team created: ${name}`)
      console.log(JSON.stringify(data, null, 2))
    } catch (err) {
      console.error(`Failed to create team: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
  })

team
  .command('list')
  .description('List all teams')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .action(async (opts: { brokerUrl: string }) => {
    try {
      const res = await fetch(`${opts.brokerUrl}/api/teams`)
      const data = await res.json()
      console.log(JSON.stringify(data, null, 2))
    } catch (err) {
      console.error(`Failed to list teams: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
  })

team
  .command('info <id>')
  .description('Show team details and members')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .action(async (id: string, opts: { brokerUrl: string }) => {
    try {
      const res = await fetch(`${opts.brokerUrl}/api/teams/${encodeURIComponent(id)}`)
      const data = await res.json()
      console.log(JSON.stringify(data, null, 2))
    } catch (err) {
      console.error(`Failed to get team info: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
  })

team
  .command('spawn <template>')
  .description('Spawn a team from a built-in template (research|implementation|review|full)')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .action(async (template: string, opts: { brokerUrl: string }) => {
    try {
      const res = await fetch(`${opts.brokerUrl}/api/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template }),
      })
      const data = await res.json()
      console.log(`Team spawned from template: ${template}`)
      console.log(JSON.stringify(data, null, 2))
    } catch (err) {
      console.error(`Failed to spawn team: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
  })

team
  .command('disband <id>')
  .description('Disband a team')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .action(async (id: string, opts: { brokerUrl: string }) => {
    try {
      const res = await fetch(`${opts.brokerUrl}/api/teams/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        console.log(`Team ${id} disbanded.`)
      } else {
        const data = await res.json()
        console.error(`Failed to disband team: ${JSON.stringify(data)}`)
        process.exitCode = 1
      }
    } catch (err) {
      console.error(`Failed to disband team: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
  })

// ── Discover subcommand ──────────────────────────────────────

const discover = program
  .command('discover')
  .description('Discover MCPs, skills, and instructions from config files')
  .action(async () => {
    const { createConfigScanner } = await import('./observe/discovery/config-scanner.js')
    const scanner = createConfigScanner()
    const result = scanner.scan()

    // MCPs
    if (result.mcpServers.length > 0) {
      console.log(`\nMCP Servers (${result.mcpServers.length} found):`)
      for (const mcp of result.mcpServers) {
        const cmdStr = [mcp.command, ...mcp.args].join(' ')
        console.log(`  ✓ ${mcp.name} — ${cmdStr}`)
      }
    } else {
      console.log('\nMCP Servers: none found')
    }

    // Skills
    if (result.skills.length > 0) {
      console.log(`\nSkills (${result.skills.length} found):`)
      for (const skill of result.skills) {
        const desc = skill.description ? ` — ${skill.description}` : ''
        console.log(`  • ${skill.name}${desc}`)
      }
    } else {
      console.log('\nSkills: none found')
    }

    // Instructions
    if (result.instructions.length > 0) {
      console.log(`\nInstructions (${result.instructions.length} found):`)
      for (const inst of result.instructions) {
        // basename, not split('/'): sources are `\`-joined on win32.
        const name = basename(inst.source)
        console.log(`  • ${name} (${inst.fullLength.toLocaleString()} chars)`)
      }
    } else {
      console.log('\nInstructions: none found')
    }

    console.log()
  })

discover
  .command('mcps')
  .description('List discovered MCP servers')
  .action(async () => {
    const { createConfigScanner } = await import('./observe/discovery/config-scanner.js')
    const scanner = createConfigScanner()
    const servers = scanner.scanMcpServers()

    if (servers.length > 0) {
      console.log(`\nMCP Servers (${servers.length} found):`)
      for (const mcp of servers) {
        const cmdStr = [mcp.command, ...mcp.args].join(' ')
        console.log(`  ✓ ${mcp.name} — ${cmdStr}`)
      }
    } else {
      console.log('\nMCP Servers: none found')
    }

    console.log()
  })

discover
  .command('skills')
  .description('List discovered skills and commands')
  .action(async () => {
    const { createConfigScanner } = await import('./observe/discovery/config-scanner.js')
    const scanner = createConfigScanner()
    const skills = scanner.scanSkills()

    if (skills.length > 0) {
      console.log(`\nSkills (${skills.length} found):`)
      for (const skill of skills) {
        const desc = skill.description ? ` — ${skill.description}` : ''
        console.log(`  • ${skill.name}${desc}`)
      }
    } else {
      console.log('\nSkills: none found')
    }

    console.log()
  })

// ── Dashboard command ─────────────────────────────────────────

program
  .command('dashboard')
  .description('Launch the SCNS dashboard')
  .option('-p, --port <port>', 'dashboard port', '3001')
  .action(async (opts: { port: string }) => {
    const port = parseInt(opts.port, 10)
    const dashboardDir = join(process.cwd(), 'dashboard')
    const outDir = join(dashboardDir, 'out')
    const nextDir = join(dashboardDir, '.next')

    if (!existsSync(outDir) && !existsSync(nextDir)) {
      console.error('Dashboard not built. Run `cd dashboard && npm run build` first.')
      process.exitCode = 1
      return
    }

    const { createServer } = await import('node:http')
    const { readFileSync: readFile } = await import('node:fs')

    if (existsSync(outDir)) {
      // Static export — serve files
      const { resolve } = await import('node:path')
      const server = createServer((req, res) => {
        const requestedPath = req.url === '/' ? 'index.html' : (req.url ?? 'index.html')
        const filePath = resolve(outDir, requestedPath.replace(/^\//, ''))

        // Prevent path traversal — resolved path must be within outDir
        if (!filePath.startsWith(resolve(outDir))) {
          res.writeHead(403)
          res.end('Forbidden')
          return
        }

        try {
          const content = readFile(filePath)
          res.writeHead(200)
          res.end(content)
        } catch {
          res.writeHead(404)
          res.end('Not found')
        }
      })
      server.listen(port, () => {
        console.log(`Dashboard running at http://localhost:${port}`)
      })
    } else {
      console.log(`Dashboard .next/ exists — use \`cd dashboard && npx next start -p ${port}\``)
    }
  })

// ── Install / Uninstall ──────────────────────────────────────

program
  .command('install')
  .description('Install SCNS supervision (macOS launchd, Linux systemd, Windows Startup folder)')
  .option('-p, --port <port>', 'broker port', '3456')
  .option('--autonomy <level>', 'autonomy level (0–3)', '0')
  .action((opts: { port: string; autonomy: string }) => {
    const platform = detectPlatform()

    const config: ServiceConfig = {
      execPath: process.execPath,
      scriptPath: process.argv[1] ?? 'scns',
      port: parseInt(opts.port, 10),
      autonomyLevel: parseInt(opts.autonomy, 10),
    }

    const { installPath, serviceName } = getServicePaths(platform)
    mkdirSync(dirname(installPath), { recursive: true })
    mkdirSync(join(resolveScnsHome(), '.scns', 'logs'), { recursive: true })

    if (platform === 'darwin') {
      writeFileSync(installPath, generateLaunchAgentPlist(config), 'utf-8')
      console.log(`Installed launchd plist: ${installPath}`)
      console.log('\nTo enable auto-start:')
      console.log(`  launchctl load ${installPath}`)
      console.log('\nTo start now:')
      console.log(`  launchctl start ${serviceName}`)
    } else if (platform === 'win32') {
      // #61 — Windows has no service manager reachable from a non-admin
      // account, so the external watchdog becomes the supervision root and the
      // Startup folder is what brings it up. See generateWindowsStartupCmd.
      writeFileSync(installPath, generateWindowsStartupCmd(config), 'utf-8')
      console.log(`Installed Startup-folder supervision root: ${installPath}`)
      console.log(`\nIt runs: scns watchdog run --port ${config.port}`)
      console.log('To start it now without logging out:')
      console.log(`  "${installPath}"`)
      console.log('\nNote: this trigger is LOGON-scoped — the only kind available to a')
      console.log('non-admin account. A machine that stays up for days without a logon is')
      console.log('covered by session-start reconciliation in the Copilot extension.')
    } else {
      writeFileSync(installPath, generateSystemdUnit(config), 'utf-8')
      console.log(`Installed systemd user unit: ${installPath}`)
      console.log('\nTo enable and start:')
      console.log('  systemctl --user daemon-reload')
      console.log(`  systemctl --user enable --now ${serviceName}`)
      console.log('\nTo check status:')
      console.log(`  systemctl --user status ${serviceName}`)
    }
  })

program
  .command('uninstall')
  .description('Uninstall SCNS supervision')
  .action(() => {
    const platform = detectPlatform()
    const { installPath, serviceName } = getServicePaths(platform)

    if (!existsSync(installPath)) {
      console.log('SCNS service not found — nothing to uninstall.')
      return
    }

    try {
      unlinkSync(installPath)
      console.log(`Removed: ${installPath}`)
      console.log('SCNS service uninstalled.')

      if (platform === 'darwin') {
        console.log('\nIf the service was loaded, also run:')
        console.log(`  launchctl unload ${installPath}`)
      } else if (platform === 'win32') {
        console.log('\nA watchdog started by the old shim keeps running until logout —')
        console.log('close its window, or Stop-Process its node.exe, to stop supervising now.')
      } else {
        console.log('\nTo stop and clean up:')
        console.log(`  systemctl --user disable --now ${serviceName}`)
        console.log('  systemctl --user daemon-reload')
      }
    } catch (err) {
      console.error(
        `Failed to remove service file: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exitCode = 1
    }
  })

// ── Service verification (Phase 0: durable, drift-proof paths) ───────

const serviceCmd = program
  .command('service')
  .description('Manage / verify installed SCNS system services')

serviceCmd
  .command('verify')
  .description('Verify installed launchd plists reference the current checkout (no drift)')
  .option(
    '--repo-root <path>',
    'checkout root the plists must reference (default: this cli.js checkout)',
  )
  .option('--agents-dir <path>', 'LaunchAgents dir to scan (default: ~/Library/LaunchAgents)')
  .action((opts: { repoRoot?: string; agentsDir?: string }) => {
    const platform = detectPlatform()
    if (platform !== 'darwin') {
      console.log('`service verify` currently supports macOS launchd plists only — nothing to do.')
      return
    }

    // Default checkout root = parent of the dir holding this cli.js (…/scns/dist/cli.js → …/scns).
    const repoRoot = opts.repoRoot
      ? resolve(opts.repoRoot)
      : resolve(dirname(process.argv[1] ?? process.cwd()), '..')
    const agentsDir = opts.agentsDir
      ? resolve(opts.agentsDir)
      : join(homedir(), 'Library', 'LaunchAgents')

    if (!existsSync(agentsDir)) {
      console.log(`LaunchAgents dir not found: ${agentsDir} — no SCNS services installed.`)
      return
    }

    const plists = readdirSync(agentsDir)
      .filter((f) => f.startsWith('com.scns.') && f.endsWith('.plist'))
      .sort()

    if (plists.length === 0) {
      console.log(`No com.scns.*.plist found in ${agentsDir}.`)
      return
    }

    console.log(`Verifying ${plists.length} SCNS service plist(s) against: ${repoRoot}\n`)

    let drifted = 0
    for (const file of plists) {
      const full = join(agentsDir, file)
      let findings: readonly PlistDriftFinding[]
      try {
        findings = findPlistDrift(readFileSync(full, 'utf-8'), repoRoot)
      } catch (err) {
        console.log(`  ✗ ${file}: unreadable (${err instanceof Error ? err.message : String(err)})`)
        drifted++
        continue
      }
      if (findings.length === 0) {
        console.log(`  ✓ ${file}`)
      } else {
        drifted++
        console.log(`  ✗ ${file}`)
        for (const f of findings) {
          console.log(`      ${f.kind} ${f.reason}: ${f.path}`)
        }
      }
    }

    if (drifted > 0) {
      console.log(
        `\nDrift detected in ${drifted}/${plists.length} plist(s). ` +
          `Reinstall the affected job(s) from the current checkout.`,
      )
      process.exitCode = 1
    } else {
      console.log(`\nAll ${plists.length} SCNS service plist(s) reference the current checkout ✓`)
    }
  })

// Phase 1c: emit the socket-activated broker plist for the current checkout.
// The live broker plist is installed-only and operator-owned — this prints the
// structural plist so the operator can merge their EnvironmentVariables and
// reinstall (a queued AWAITING-JOHN action), never done unattended here.
serviceCmd
  .command('generate-broker-plist')
  .description('Print the socket-activated com.scns.broker plist for the current checkout')
  .option('-p, --port <port>', 'broker port', '3456')
  .option('--autonomy <level>', 'autonomy level (0–3)', '2')
  .option('--out <path>', 'write to this file instead of stdout')
  .action((opts: { port: string; autonomy: string; out?: string }) => {
    if (detectPlatform() !== 'darwin') {
      console.log('The socket-activated broker plist targets macOS launchd only.')
      return
    }
    const scriptPath = process.argv[1] ?? 'scns'
    const repoRoot = resolve(dirname(scriptPath), '..')
    const config: BrokerPlistConfig = {
      execPath: process.execPath,
      scriptPath,
      port: parseInt(opts.port, 10),
      autonomyLevel: parseInt(opts.autonomy, 10),
      helperPath: join(repoRoot, 'dist', 'native', 'scns-socket-launch'),
    }
    const plist = generateBrokerPlist(config)
    if (opts.out) {
      writeFileSync(resolve(opts.out), plist, 'utf-8')
      console.log(`Wrote broker plist: ${resolve(opts.out)}`)
    } else {
      process.stdout.write(plist)
    }
    console.error(
      '\nNOTE: this emits only the structural PATH/HOME/NODE_ENV base. Merge your operator\n' +
        'EnvironmentVariables (SCNS_* flags) and confirm dist/native/scns-socket-launch exists\n' +
        'before installing. Reinstalling the LIVE broker job is operator-owned (AWAITING-JOHN).',
    )
  })

// ── Self-diagnosis ───────────────────────────────────────────────────

program
  .command('doctor')
  .description(
    'Diagnose this SCNS install layer by layer (node, build, native modules, ' +
      'embeddings, broker, routing, extension) — run FIRST when something is wrong',
  )
  .action(async () => {
    const { runDoctor, formatReport, defaultDoctorDeps } = await import('./cli/doctor.js')
    const report = await runDoctor(defaultDoctorDeps())
    console.log(formatReport(report))
    process.exitCode = report.ok ? 0 : 1
  })

// ── Copilot CLI Integration Commands ─────────────────────────────────

program
  .command('install-extension')
  .description('Install the SCNS extension for Copilot CLI')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  // 5000 = the Jul-25 delivery cutover; a bare reinstall must not regress it
  .option('--timeout <ms>', 'Extension HTTP timeout in ms', '5000')
  .option('--context-injection', 'Enable context injection by default', false)
  .action((opts: { brokerUrl: string; timeout: string; contextInjection: boolean }) => {
    import('./cli/install-extension.js')
      .then(({ installExtension }) => {
        const result = installExtension({
          brokerUrl: opts.brokerUrl,
          timeoutMs: parseInt(opts.timeout, 10),
          contextInjection: opts.contextInjection,
        })
        console.log(result.message)
        if (result.installed) {
          console.log(`\nExtension path: ${result.path}`)
          console.log('The extension will be loaded on next Copilot CLI session (or /clear).')
        }
      })
      .catch((err) => {
        console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
      })
  })

program
  .command('uninstall-extension')
  .description('Remove the SCNS extension from Copilot CLI')
  .action(() => {
    import('./cli/install-extension.js')
      .then(({ uninstallExtension }) => {
        const result = uninstallExtension()
        console.log(result.message)
      })
      .catch((err) => {
        console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
      })
  })

// Phase 13.12.16 — manual one-shot housekeeping.
// Useful when the broker DB has grown unboundedly and you want to reclaim
// space now without waiting for the next dream cycle.
program
  .command('housekeep')
  .description('Prune OTel/event data and (optionally) VACUUM the broker DB now')
  .option('--db <path>', 'Broker DB path', join(homedir(), '.session-broker', 'data.db'))
  .option('--spans-days <n>', 'OTel spans retention (days)', '7')
  .option('--metrics-days <n>', 'OTel metrics retention (days)', '2')
  .option('--events-days <n>', 'Events retention (days)', '30')
  .option('--task-run-history-days <n>', 'task_run_history retention (days)', '14')
  .option('--messages-history-days <n>', 'messages_history retention (days)', '90')
  .option('--no-vacuum', 'Skip VACUUM at the end')
  .option('--aggressive', 'Shortcut: spans=2 days, metrics=1 day, vacuum on')
  .action(
    async (opts: {
      db: string
      spansDays: string
      metricsDays: string
      eventsDays: string
      taskRunHistoryDays: string
      messagesHistoryDays: string
      vacuum: boolean
      aggressive?: boolean
    }) => {
      const { default: Database } = await import('better-sqlite3')
      const { runHousekeeping } = await import('./dream/housekeeping.js')
      const { statSync } = await import('node:fs')

      const aggressive = !!opts.aggressive
      const config = {
        otelRetentionDays: aggressive ? 1 : Number(opts.metricsDays),
        otelSpansRetentionDays: aggressive ? 2 : Number(opts.spansDays),
        otelMetricsRetentionDays: aggressive ? 1 : Number(opts.metricsDays),
        eventRetentionDays: Number(opts.eventsDays),
        taskRunHistoryRetentionDays: Number(opts.taskRunHistoryDays),
        messagesHistoryRetentionDays: Number(opts.messagesHistoryDays),
        vacuum: aggressive ? true : opts.vacuum !== false,
      }

      const sizeBefore = statSync(opts.db).size
      console.log(`Opening ${opts.db} (${(sizeBefore / 1024 / 1024).toFixed(1)} MB)`)
      const db = new Database(opts.db)
      const result = runHousekeeping(db, config)
      // Phase 13.12.16: collapse the WAL so freed pages actually return to disk
      // — VACUUM alone leaves a large -wal file when concurrent writers exist.
      try {
        db.pragma('wal_checkpoint(TRUNCATE)')
      } catch {
        /* non-fatal — DB may not be in WAL mode */
      }
      db.close()
      const sizeAfter = statSync(opts.db).size
      console.log(JSON.stringify(result, null, 2))
      console.log(
        `DB size: ${(sizeBefore / 1024 / 1024).toFixed(1)} MB → ` +
          `${(sizeAfter / 1024 / 1024).toFixed(1)} MB ` +
          `(freed ${((sizeBefore - sizeAfter) / 1024 / 1024).toFixed(1)} MB)`,
      )
      if (!result.success) process.exitCode = 1
    },
  )

program
  .command('setup-hooks')
  .description('Generate SCNS hooks config for Copilot CLI (lightweight, for CI/cloud agent)')
  .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
  .option('--project-dir <dir>', 'Project directory', process.cwd())
  .action((opts: { brokerUrl: string; projectDir: string }) => {
    import('./cli/setup-hooks.js')
      .then(({ setupHooks }) => {
        const result = setupHooks({
          brokerUrl: opts.brokerUrl,
          projectDir: opts.projectDir,
        })
        console.log(result.message)
        if (result.created) {
          console.log(`\nHooks config: ${result.path}`)
          console.log('Note: Shell hooks are for CI/cloud agent environments.')
          console.log('If the SCNS extension is installed, it provides richer integration.')
        }
      })
      .catch((err) => {
        console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
      })
  })

// ── Blue/green restart (#61 option C) ────────────────────────
// The restart sequence used to exist only as `scripts/broker-restart.sh`:
// bash + launchctl + python3, so on Windows the daily maintenance restart and
// the `POST /api/admin/rollback` handler simply did not work. This is the same
// seven phases, cross-platform, with only the swap itself platform-specific.
const brokerCmd = program
  .command('broker')
  .description('Operate on a running broker (blue/green restart)')

brokerCmd
  .command('restart')
  .description(
    'Blue/green restart: validate on a canary, drain, swap, verify, roll back on failure',
  )
  .option('--port <port>', 'broker port', (v: string) => parseInt(v, 10), 3456)
  .option('--canary-port <port>', 'canary port (default: broker port + 1)', (v: string) =>
    parseInt(v, 10),
  )
  .option('--skip-canary', 'restart without validating the binary first (not recommended)')
  .option('--broker-label <label>', 'launchd label (darwin)', 'com.scns.broker')
  .option('--service <name>', 'systemd user unit (linux)', 'scns')
  .option('--plist <path>', 'launchd plist a rollback bootstraps from (darwin)')
  .option('--broker-entry <path>', 'broker entry script for the canary and relaunch')
  .option('--autonomy <level>', 'autonomy level for a relaunched broker', (v: string) =>
    parseInt(v, 10),
  )
  .option('--rollback', 'roll back only: bring the previous broker back and verify it')
  .action(
    async (opts: {
      port: number
      canaryPort?: number
      skipCanary?: boolean
      brokerLabel: string
      service: string
      plist?: string
      brokerEntry?: string
      autonomy?: number
      rollback?: boolean
    }) => {
      const { createBlueGreenDeps, runBlueGreen, formatBlueGreenReport, resolveCanaryPort } =
        await import('./cli/blue-green-runtime.js')
      const { DEFAULT_BLUE_GREEN_CONFIG } = await import('./broker/services/blue-green.js')
      const scnsHome = resolveScnsHome()
      const brokerEntry = opts.brokerEntry ?? process.argv[1]
      let plistPath = opts.plist
      if (!plistPath && process.platform === 'darwin') {
        try {
          plistPath = getServicePaths('darwin').installPath
        } catch {
          plistPath = undefined
        }
      }

      const runtimeOptions = {
        platform: process.platform,
        port: opts.port,
        scnsHome,
        execPath: process.execPath,
        brokerLabel: opts.brokerLabel,
        service: opts.service,
        ...(opts.canaryPort !== undefined ? { canaryPort: opts.canaryPort } : {}),
        ...(brokerEntry ? { brokerEntry } : {}),
        ...(plistPath ? { plistPath } : {}),
        ...(process.getuid ? { uid: process.getuid() } : {}),
        ...(opts.autonomy !== undefined ? { autonomyLevel: opts.autonomy } : {}),
        ...(process.env['BROKER_TOKEN'] ? { token: process.env['BROKER_TOKEN'] } : {}),
        ...(opts.skipCanary ? { skipCanary: true } : {}),
      }

      // Constructed before anything runs, so a misconfiguration (no plist to
      // bootstrap from, no entry script to relaunch) fails while nothing has
      // been drained — not halfway through a restart.
      let deps: ReturnType<typeof createBlueGreenDeps>
      try {
        deps = createBlueGreenDeps(runtimeOptions)
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
        return
      }

      if (opts.rollback) {
        console.log(`Rolling back the broker on port ${opts.port}…`)
        try {
          const outcome = await deps.rollback()
          console.log(`  ${outcome.strategy}: ${outcome.detail}`)
          // A restarted broker is not ready the instant the spawn returns —
          // it has a database, a vault index and an embedding backfill to get
          // through. Checking once, immediately, reported every successful
          // rollback as a failure (caught by the live probe).
          const deadline = Date.now() + DEFAULT_BLUE_GREEN_CONFIG.healthTimeoutMs
          let healthy = await deps.probeReady(opts.port)
          while (!healthy && Date.now() < deadline) {
            await deps.sleep(DEFAULT_BLUE_GREEN_CONFIG.pollMs)
            healthy = await deps.probeReady(opts.port)
          }
          console.log(`  broker ready: ${healthy}`)
          process.exitCode = healthy ? 0 : 2
        } catch (err) {
          console.error(`Rollback failed: ${err instanceof Error ? err.message : String(err)}`)
          process.exitCode = 2
        }
        return
      }

      console.log(
        `Blue/green restart of the broker on port ${opts.port} ` +
          `(canary ${resolveCanaryPort(opts.port, opts.canaryPort)}${opts.skipCanary ? ', skipped' : ''})`,
      )
      const result = await runBlueGreen(runtimeOptions, {}, (line) => console.log(`  ${line}`))
      console.log(formatBlueGreenReport(result))
      process.exitCode = result.exitCode
    },
  )

// ── Meta-broker (P7) ─────────────────────────────────────────
// CLI surface for the per-project broker supervisor. Opt-in; does NOT
// auto-start with `scns start`. Pattern per rubber-duck (2026-06-03):
// ship as a CLI command first, add LaunchAgent integration later once
// behavior is proven in supervised manual runs.
const meta = program.command('meta-broker').description('Per-project broker supervisor (P7)')

meta
  .command('register <projectRoot>')
  .description('Register a project root with the meta-broker')
  .option('--port <port>', 'desired port (will fall back to pool on conflict)', (v: string) =>
    parseInt(v, 10),
  )
  .option(
    '--autonomy <level>',
    'per-project autonomy level (0-3) for the child broker',
    (v: string) => parseInt(v, 10),
  )
  .option(
    '--threshold <n>',
    'per-project SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD for the child',
    (v: string) => Number(v),
  )
  .option(
    '--issue-repo <owner/name>',
    "GitHub repo for the child's self-issue-ingest (default: auto-derived from the project's origin remote)",
  )
  .option(
    '--meta-db <path>',
    'meta-broker registry DB path',
    join(resolveScnsHome(), '.scns', 'meta-broker.db'),
  )
  .action(
    async (
      projectRoot: string,
      opts: {
        port?: number
        autonomy?: number
        threshold?: number
        issueRepo?: string
        metaDb: string
      },
    ) => {
      const { default: Database } = await import('better-sqlite3')
      const { applyMetaSchema, registerProject, getProject } =
        await import('./meta-broker/registry.js')
      const { deriveProjectId } = await import('./broker/project-identity.js')
      const { deriveSelfIssueRepoFromGit } = await import('./brain/self-issue-source.js')
      const root = resolve(projectRoot.replace(/^~(?=\/|$)/, homedir()))
      // Track-2: each child ingests its OWN repo's issues. Prefer an explicit
      // --issue-repo; otherwise auto-derive owner/name from the project's origin
      // remote (null when it has no GitHub remote → the child ingests nothing).
      const selfIssueRepo = opts.issueRepo ?? (await deriveSelfIssueRepoFromGit(root))
      mkdirSync(dirname(opts.metaDb), { recursive: true })
      const db = new Database(opts.metaDb)
      try {
        applyMetaSchema(db)
        const projectId = deriveProjectId(root)
        registerProject(db, {
          projectId,
          projectRoot: root,
          desiredPort: opts.port ?? null,
          autonomyLevel: opts.autonomy ?? null,
          autoApproveThreshold: opts.threshold ?? null,
          selfIssueRepo,
        })
        const proj = getProject(db, projectId)!
        console.log(JSON.stringify(proj, null, 2))
      } finally {
        db.close()
      }
    },
  )

meta
  .command('list')
  .description('List all registered projects + live state')
  .option(
    '--meta-db <path>',
    'meta-broker registry DB path',
    join(resolveScnsHome(), '.scns', 'meta-broker.db'),
  )
  .action(async (opts: { metaDb: string }) => {
    const { default: Database } = await import('better-sqlite3')
    const { applyMetaSchema, listProjects } = await import('./meta-broker/registry.js')
    if (!existsSync(opts.metaDb)) {
      console.log(JSON.stringify({ projects: [] }, null, 2))
      return
    }
    const db = new Database(opts.metaDb)
    try {
      applyMetaSchema(db)
      console.log(JSON.stringify({ projects: listProjects(db) }, null, 2))
    } finally {
      db.close()
    }
  })

meta
  .command('reset <project>')
  .description(
    'Clear a suspended (failed/stopped) project so the supervisor spawns it again. ' +
      '<project> is a project root or a project id.',
  )
  .option(
    '--meta-db <path>',
    'meta-broker registry DB path',
    join(resolveScnsHome(), '.scns', 'meta-broker.db'),
  )
  .action(async (project: string, opts: { metaDb: string }) => {
    const { default: Database } = await import('better-sqlite3')
    const { applyMetaSchema, getProject, resolveProjectForPath, resetProject } =
      await import('./meta-broker/registry.js')
    if (!existsSync(opts.metaDb)) {
      console.error(`No meta-broker registry at ${opts.metaDb}`)
      process.exitCode = 2
      return
    }
    const db = new Database(opts.metaDb)
    try {
      applyMetaSchema(db)
      // Accept either form: the id `meta-broker list` prints, or a path the
      // operator can tab-complete. The path goes through the registry's own
      // lookup (deepest registered root, win32-aware), so a subdirectory of the
      // project — or a `~\`-prefixed path on Windows — resolves mid-incident
      // instead of reporting "Not registered".
      const asRoot = resolve(project.replace(/^~(?=[\\/]|$)/, homedir()))
      const before = getProject(db, project) ?? resolveProjectForPath(db, asRoot)
      if (before === null) {
        console.error(`Not registered: ${project} (no project id or registered root matches)`)
        process.exitCode = 2
        return
      }
      if (!resetProject(db, before.projectId)) {
        console.error(
          `Nothing to reset: '${before.projectId}' is '${before.status}', not failed/stopped. ` +
            'Only a suspended project needs clearing; the supervisor already manages the rest.',
        )
        process.exitCode = 1
        return
      }
      console.log(
        `Reset '${before.projectId}' from '${before.status}' — the supervisor will respawn it ` +
          'on its next tick.',
      )
      console.log(JSON.stringify(getProject(db, before.projectId), null, 2))
    } finally {
      db.close()
    }
  })

meta
  .command('run')
  .description('Run the meta-broker supervisor loop (foreground)')
  .option(
    '--meta-db <path>',
    'meta-broker registry DB path',
    join(resolveScnsHome(), '.scns', 'meta-broker.db'),
  )
  .option(
    '--broker-entry <path>',
    'path to dist/cli.js for spawning child brokers',
    resolve(process.argv[1] ?? 'dist/cli.js'),
  )
  .option(
    '--project-db-dir <dir>',
    'per-project broker DB directory',
    join(homedir(), '.session-broker', 'projects'),
  )
  .option('--interval-ms <ms>', 'tick interval', (v: string) => parseInt(v, 10), 5000)
  .action(
    async (opts: {
      metaDb: string
      brokerEntry: string
      projectDbDir: string
      intervalMs: number
    }) => {
      const { default: Database } = await import('better-sqlite3')
      const { createMetaSupervisor } = await import('./meta-broker/meta-supervisor.js')
      const { metaBrokerPidfilePath } = await import('./cli/meta-supervision.js')
      const { claimSingleton } = await import('./cli/watchdog-runtime.js')

      // #61 — the meta-broker is now a supervised service, so it must be a
      // singleton and it must be findable. Two supervisors over one registry
      // would each spawn a child for the same project and fight over its port;
      // and with no HTTP listener of its own, a pidfile is the only thing the
      // watchdog can probe for liveness.
      const claim = claimSingleton(metaBrokerPidfilePath(resolveScnsHome()))
      if (!claim.acquired) {
        console.log(`meta-broker: already running (pid ${claim.heldBy}) — exiting.`)
        return
      }

      mkdirSync(dirname(opts.metaDb), { recursive: true })
      mkdirSync(opts.projectDbDir, { recursive: true })
      const db = new Database(opts.metaDb)
      const sup = createMetaSupervisor({
        db,
        brokerEntry: opts.brokerEntry,
        projectDbDir: opts.projectDbDir,
        intervalMs: opts.intervalMs,
      })
      console.log(
        `meta-broker supervisor running (db=${opts.metaDb}, brokerEntry=${opts.brokerEntry}, intervalMs=${opts.intervalMs})`,
      )
      sup.start()
      const shutdown = async (signal: string): Promise<void> => {
        console.log(`\nmeta-broker: received ${signal}, draining…`)
        claim.release()
        await sup.stop()
        db.close()
        process.exit(0)
      }
      process.on('SIGINT', () => void shutdown('SIGINT'))
      process.on('SIGTERM', () => void shutdown('SIGTERM'))
    },
  )

// ── External health-watchdog (Gap 3) ─────────────────────────────────
// A SEPARATE process from the broker, so it can catch event-loop hangs
// the in-process self-heal cannot. Polls /api/health and restarts the
// broker after N consecutive UNRESPONSIVE probes, gated by a startup
// grace + a file-persisted cooldown.
//
// #61 — the restart action is platform-aware (see cli/watchdog-runtime.ts).
// It was hardcoded to `launchctl kickstart -k`, which made the one portable
// piece of the healing machinery macOS-only in practice. On Windows, where no
// service manager is reachable from a non-admin account, this process IS the
// supervision root: it stops the hung broker and respawns it itself.
const watchdog = program
  .command('watchdog')
  .description('External health-watchdog that restarts a hung broker (Gap 3)')

watchdog
  .command('run')
  .description('Run the external health-watchdog loop (foreground)')
  .option('--port <port>', 'broker port to probe', (v: string) => parseInt(v, 10), 3456)
  .option('--broker-label <label>', 'launchd label to restart on hang', 'com.scns.broker')
  .option('--service <name>', 'systemd user unit to restart on hang', 'scns')
  .option(
    '--broker-entry <path>',
    'broker entry script to relaunch (platforms with no service manager; default: this CLI)',
  )
  .option('--autonomy <level>', 'autonomy level for a relaunched broker', (v: string) =>
    parseInt(v, 10),
  )
  .option('--interval-ms <ms>', 'probe interval', (v: string) => parseInt(v, 10), 15000)
  .option(
    '--max-timeouts <n>',
    'consecutive unresponsive probes before restart',
    (v: string) => parseInt(v, 10),
    3,
  )
  .option(
    '--cooldown-ms <ms>',
    'min interval between restarts',
    (v: string) => parseInt(v, 10),
    300000,
  )
  .option(
    '--grace-ms <ms>',
    'startup grace before any restart',
    (v: string) => parseInt(v, 10),
    60000,
  )
  .option(
    '--supervise-meta <mode>',
    'supervise the meta-broker: auto (when projects are registered) | on | off',
    'auto',
  )
  .option(
    '--meta-db <path>',
    'meta-broker registry DB path',
    join(resolveScnsHome(), '.scns', 'meta-broker.db'),
  )
  .option(
    '--project-db-dir <dir>',
    'per-project broker DB directory',
    join(homedir(), '.session-broker', 'projects'),
  )
  .action(
    async (opts: {
      port: number
      brokerLabel: string
      service: string
      brokerEntry?: string
      autonomy?: number
      intervalMs: number
      maxTimeouts: number
      cooldownMs: number
      graceMs: number
      superviseMeta: string
      metaDb: string
      projectDbDir: string
    }) => {
      const { createExternalWatchdog, httpHealthProbe } =
        await import('./broker/services/external-watchdog.js')
      const { createWatchdogRestart, resolveBrokerEntry, claimSingleton, ensureBrokerUp } =
        await import('./cli/watchdog-runtime.js')
      const { watchdogPidfilePath } = await import('./broker/services/broker-pidfile.js')
      const baseUrl = `http://localhost:${opts.port}`
      const scnsHome = resolveScnsHome()
      const stateFile = join(scnsHome, '.scns', 'watchdog-last-restart')
      const killFile = join(scnsHome, '.scns', 'watchdog.disabled')

      // #61 — the supervision root must be a singleton. Session-start
      // reconciliation spawns a watchdog whenever the stack looks dead, so
      // without this guard two watchdogs could end up restarting each other's
      // freshly-started broker.
      const claim = claimSingleton(watchdogPidfilePath(scnsHome, opts.port))
      if (!claim.acquired) {
        console.log(
          `scns watchdog: already supervising port ${opts.port} (pid ${claim.heldBy}) — exiting.`,
        )
        return
      }

      const restartOptions = {
        platform: process.platform,
        port: opts.port,
        scnsHome,
        brokerLabel: opts.brokerLabel,
        service: opts.service,
        ...(process.getuid ? { uid: process.getuid() } : {}),
        execPath: process.execPath,
        ...((opts.brokerEntry ?? resolveBrokerEntry()) !== null
          ? { brokerEntry: opts.brokerEntry ?? resolveBrokerEntry()! }
          : {}),
        ...(opts.autonomy !== undefined ? { autonomyLevel: opts.autonomy } : {}),
      }

      // Constructed BEFORE the loop starts: a misconfigured restart action
      // must fail here, while an operator is watching, not silently at 3am.
      let restart: ReturnType<typeof createWatchdogRestart>
      try {
        restart = createWatchdogRestart(restartOptions)
      } catch (err) {
        claim.release()
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
        return
      }

      const wd = createExternalWatchdog({
        target: baseUrl,
        probe: () => httpHealthProbe(baseUrl),
        restart: async () => {
          const outcome = await restart()
          console.log(`watchdog: restart -> ${JSON.stringify(outcome)}`)
        },
        loadLastRestartAt: () => {
          try {
            if (!existsSync(stateFile)) return null
            const n = Number(readFileSync(stateFile, 'utf8').trim())
            return Number.isFinite(n) ? n : null
          } catch {
            return null
          }
        },
        saveLastRestartAt: (t: number) => {
          try {
            mkdirSync(dirname(stateFile), { recursive: true })
            writeFileSync(stateFile, String(t))
          } catch {
            /* best-effort cooldown persistence */
          }
        },
        isKillSwitched: () => existsSync(killFile) || process.env['SCNS_WATCHDOG_DISABLED'] === '1',
        intervalMs: opts.intervalMs,
        config: {
          maxConsecutiveTimeouts: opts.maxTimeouts,
          cooldownMs: opts.cooldownMs,
          startupGraceMs: opts.graceMs,
        },
      })

      console.log(
        `scns watchdog running (probe ${baseUrl}/api/health every ${opts.intervalMs}ms; ` +
          `restart after ${opts.maxTimeouts} unresponsive probes; ` +
          `cooldown ${opts.cooldownMs}ms; grace ${opts.graceMs}ms). Kill-switch: ${killFile}`,
      )

      // #61 — a supervision root brings its child up. The startup grace exists
      // to protect a broker that is still booting; it does not apply when no
      // broker process exists at all, so an absent broker is started now rather
      // than 105s from now.
      try {
        const ensured = await ensureBrokerUp(restartOptions, {
          probe: () => httpHealthProbe(baseUrl),
          restart,
        })
        console.log(`watchdog: initial reconcile -> ${JSON.stringify(ensured)}`)
      } catch (err) {
        console.error(
          `watchdog: initial reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      wd.start()

      // ── #61: the SECOND supervised service ────────────────────────────
      //
      // macOS supervises three KeepAlive launchd jobs; Windows has one Startup
      // entry, and it starts this process. Anything this process does not watch
      // has nothing above it — and a dead meta-broker takes every per-project
      // child with it, silently routing every session in every registered repo
      // to `global:fallback`. It has no HTTP listener, so its liveness is a
      // pidfile, shaped as a ProbeResult so the same tested decision core
      // (grace, threshold, cooldown, kill-switch) applies unchanged.
      const {
        decideMetaSupervision,
        resolveSuperviseMetaOverride,
        countRegisteredProjects,
        metaBrokerPidfilePath,
        pidfileLivenessProbe,
        createMetaBrokerRestart,
      } = await import('./cli/meta-supervision.js')

      const metaOverride = resolveSuperviseMetaOverride(opts.superviseMeta)
      const metaDecision = decideMetaSupervision({
        metaDbExists: existsSync(opts.metaDb),
        registeredProjects: countRegisteredProjects(opts.metaDb),
        ...(metaOverride !== undefined ? { override: metaOverride } : {}),
      })

      let metaWd: ReturnType<typeof createExternalWatchdog> | null = null
      if (!metaDecision.supervise) {
        console.log(`watchdog: not supervising the meta-broker — ${metaDecision.reason}`)
      } else if (!restartOptions.brokerEntry) {
        console.log(
          'watchdog: not supervising the meta-broker — no entry script to relaunch it with ' +
            '(pass --broker-entry <path to dist/cli.js>)',
        )
      } else {
        const metaPidfile = metaBrokerPidfilePath(scnsHome)
        const metaProbe = pidfileLivenessProbe(metaPidfile)
        const metaRestart = createMetaBrokerRestart({
          scnsHome,
          execPath: process.execPath,
          scriptPath: restartOptions.brokerEntry,
          metaDb: opts.metaDb,
          projectDbDir: opts.projectDbDir,
        })
        const metaStateFile = join(scnsHome, '.scns', 'watchdog-meta-last-restart')

        metaWd = createExternalWatchdog({
          target: 'meta-broker',
          probe: metaProbe,
          restart: async () => {
            const outcome = await metaRestart()
            console.log(`watchdog: meta-broker restart -> ${JSON.stringify(outcome)}`)
          },
          loadLastRestartAt: () => {
            try {
              if (!existsSync(metaStateFile)) return null
              const n = Number(readFileSync(metaStateFile, 'utf8').trim())
              return Number.isFinite(n) ? n : null
            } catch {
              return null
            }
          },
          saveLastRestartAt: (t: number) => {
            try {
              mkdirSync(dirname(metaStateFile), { recursive: true })
              writeFileSync(metaStateFile, String(t))
            } catch {
              /* best-effort cooldown persistence */
            }
          },
          // One kill-switch for the whole root: disabling supervision should
          // disable ALL of it, not leave half the stack being restarted.
          isKillSwitched: () =>
            existsSync(killFile) || process.env['SCNS_WATCHDOG_DISABLED'] === '1',
          intervalMs: opts.intervalMs,
          config: {
            maxConsecutiveTimeouts: opts.maxTimeouts,
            cooldownMs: opts.cooldownMs,
            startupGraceMs: opts.graceMs,
          },
        })

        console.log(
          `watchdog: also supervising the meta-broker (${metaDecision.reason}; ` +
            `pidfile ${metaPidfile})`,
        )

        // Same reasoning as the broker's initial reconcile: the startup grace
        // protects a service that is still booting, not one that is absent.
        try {
          const alive = await metaProbe()
          if (typeof alive.status !== 'number') {
            const outcome = await metaRestart()
            console.log(`watchdog: meta-broker initial reconcile -> ${JSON.stringify(outcome)}`)
          } else {
            console.log('watchdog: meta-broker initial reconcile -> already running')
          }
        } catch (err) {
          console.error(
            `watchdog: meta-broker initial reconcile failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }

        metaWd.start()
      }

      const shutdown = (signal: string): void => {
        console.log(`\nwatchdog: received ${signal}, stopping`)
        claim.release()
        wd.stop()
        metaWd?.stop()
        process.exit(0)
      }
      process.on('SIGINT', () => shutdown('SIGINT'))
      process.on('SIGTERM', () => shutdown('SIGTERM'))
    },
  )

// ── Self-improvement: file SCNS's own gaps as GitHub issues (Gap 4) ───
// Fuels the existing self-issue-ingest path so SCNS works on improving
// ITSELF. DRY-RUN by default; --apply actually creates issues (requires
// the `scns:self-improvement` label to exist in the repo).
const selfImprove = program
  .command('self-improve')
  .description("File SCNS's own improvement gaps as GitHub issues (Gap 4)")

selfImprove
  .command('file-gaps')
  .description('File the SCNS self-improvement catalog as GitHub issues (dry-run by default)')
  .option('--apply', 'actually create issues (default: dry-run / plan only)', false)
  .option(
    '-R, --repo <repo>',
    'target repo (owner/name); falls back to SCNS_SELF_ISSUE_REPO; refused when neither is set (#58)',
  )
  .option('--max <n>', 'max issues to create per run', (v: string) => parseInt(v, 10))
  .action(async (opts: { apply: boolean; repo?: string; max?: number }) => {
    const {
      fileSelfImprovementIssues,
      ghListOpenSelfImprovementIssues,
      ghCreateIssue,
      resolveFileGapsTargetRepo,
      SCNS_SELF_IMPROVEMENT_GAPS,
      SELF_IMPROVE_LABEL,
    } = await import('./brain/self-improvement-issue.js')

    // #58: no default target — filing issues on a repo nobody chose is how a
    // user's install ends up acting on the public upstream repo.
    const target = resolveFileGapsTargetRepo(opts.repo, process.env)
    if (!target.ok) {
      console.error(target.reason)
      process.exitCode = 1
      return
    }
    const repo = target.repo

    const result = await fileSelfImprovementIssues(SCNS_SELF_IMPROVEMENT_GAPS, {
      listOpenIssues: async (label) => ghListOpenSelfImprovementIssues(label, repo),
      createIssue: async (i) => ghCreateIssue(i, repo),
      maxPerRun: opts.max,
      dryRun: !opts.apply,
    })

    console.log(JSON.stringify({ repo, dryRun: !opts.apply, ...result }, null, 2))
    if (!opts.apply) {
      console.log(
        `\n(dry-run — re-run with --apply to create. Requires the '${SELF_IMPROVE_LABEL}' label to exist in ${repo}.)`,
      )
    }
  })

// ── ideate (Ideation wedge D1 — LLM-driven novel proposals) ───────────────────

program
  .command('ideate')
  .description(
    'Generate NOVEL improvement proposals from real signals via an isolated, ' +
      'deny-all Copilot ACP session (advisory; writes to ~/.scns/ideation/). ' +
      'DEFAULT-OFF: dry-run prints the prompt; --spawn (requires SCNS_IDEATION=1) ' +
      'performs the real ideation call.',
  )
  .option('-k, --count <n>', 'number of proposals to request', (v: string) => parseInt(v, 10), 5)
  .option('--spawn', 'perform the real ACP ideation spawn (needs SCNS_IDEATION=1)', false)
  .option('--model <model>', 'model override for the ideation agent')
  .option('--json', 'emit JSON instead of human output', false)
  .action(async (opts: { count: number; spawn: boolean; model?: string; json: boolean }) => {
    const { runIdeateCommand } = await import('./cli/ideate.js')
    await runIdeateCommand({
      k: Number.isFinite(opts.count) && opts.count > 0 ? opts.count : 5,
      spawn: opts.spawn,
      json: opts.json,
      ...(opts.model ? { model: opts.model } : {}),
    })
  })

// ── selfopt (Phase 0 — measurement substrate) ─────────────────────────────────

const selfopt = program
  .command('selfopt')
  .description('Closed-loop measurement substrate: mine labelled task outcomes + held-out baseline')

/** Shared dependency resolution for selfopt subcommands (broker DB readonly). */
async function loadSelfoptDeps(opts: {
  seed?: number
  valFraction?: number
  testFraction?: number
  maxTasks?: number
}) {
  const { loadConfig: loadBrokerConfig } = await import('./broker/config.js')
  const brokerCfg = loadBrokerConfig()
  const scnsDir = join(resolveScnsHome(), '.scns')
  return {
    dbPath: brokerCfg.dbPath,
    projectRoot: brokerCfg.projectRoot,
    suggestionsDir: join(scnsDir, 'suggestions'),
    seed: opts.seed,
    valFraction: opts.valFraction,
    testFraction: opts.testFraction,
    maxTasks: opts.maxTasks,
  }
}

selfopt
  .command('mine')
  .description('Mine labelled TaskRecords from broker history; print the deterministic split')
  .option('--json', 'emit JSON instead of a human summary', false)
  .option('--seed <n>', 'split seed (default 42)', (v: string) => parseInt(v, 10))
  .option('--val-fraction <f>', 'validation fraction (default 0.34)', (v: string) => parseFloat(v))
  .option('--test-fraction <f>', 'test fraction (default 0.0)', (v: string) => parseFloat(v))
  .option('--max-tasks <n>', 'cap mined tasks (default 200)', (v: string) => parseInt(v, 10))
  .option('--limit <n>', 'tasks to show in the summary (default 12)', (v: string) =>
    parseInt(v, 10),
  )
  .action(
    async (opts: {
      json?: boolean
      seed?: number
      valFraction?: number
      testFraction?: number
      maxTasks?: number
      limit?: number
    }) => {
      const { runMine } = await import('./cli/selfopt.js')
      const deps = await loadSelfoptDeps(opts)
      console.log(await runMine(deps, { json: opts.json, limit: opts.limit }))
    },
  )

selfopt
  .command('baseline')
  .description('Compute the reproducible held-out baseline score over a split')
  .option('--json', 'emit JSON instead of a human summary', false)
  .option('--split <split>', 'split to score: train|val|test (default val)')
  .option('--metric <metric>', 'gate metric: hard|soft|mixed (default hard)')
  .option('--seed <n>', 'split seed (default 42)', (v: string) => parseInt(v, 10))
  .option('--val-fraction <f>', 'validation fraction (default 0.34)', (v: string) => parseFloat(v))
  .option('--test-fraction <f>', 'test fraction (default 0.0)', (v: string) => parseFloat(v))
  .option('--max-tasks <n>', 'cap mined tasks (default 200)', (v: string) => parseInt(v, 10))
  .action(
    async (opts: {
      json?: boolean
      split?: string
      metric?: string
      seed?: number
      valFraction?: number
      testFraction?: number
      maxTasks?: number
    }) => {
      const { runBaseline } = await import('./cli/selfopt.js')
      const deps = await loadSelfoptDeps(opts)
      const split = opts.split as 'train' | 'val' | 'test' | undefined
      const metric = opts.metric as 'hard' | 'soft' | 'mixed' | undefined
      console.log(await runBaseline(deps, { json: opts.json, split, metric }))
    },
  )

selfopt
  .command('shadow-eval')
  .description(
    'Run the shadow gated negative-memory eval on a throwaway copy of the live ' +
      'instructions file (default Mock backend; opt-in real-agent + real val via env)',
  )
  .option('--json', 'emit JSON instead of a human summary', false)
  .action(async (opts: { json?: boolean }) => {
    const { loadConfig: loadBrokerConfig } = await import('./broker/config.js')
    const { createVault } = await import('./memory/vault.js')
    const { runShadowEval } = await import('./cli/selfopt.js')
    const brokerCfg = loadBrokerConfig()
    const scnsDir = join(resolveScnsHome(), '.scns')
    const vault = createVault({ rootDir: join(scnsDir, 'memory') })
    console.log(
      await runShadowEval(
        {
          vault,
          projectRoot: brokerCfg.projectRoot,
          brokerDbPath: brokerCfg.dbPath,
        },
        { json: opts.json },
      ),
    )
  })

selfopt
  .command('validate-loss')
  .description(
    'Single-spawn empirical validation of the loss function: prove a rule-judged ' +
      'held-out task moves under a real agent where it is constant under Mock ' +
      '(default Mock/no-spawn; opt-in real spawn via SCNS_SELFOPT_VALIDATE_LOSS_ACP=1)',
  )
  .option('--json', 'emit JSON instead of a human summary', false)
  .action(async (opts: { json?: boolean }) => {
    const { loadConfig: loadBrokerConfig } = await import('./broker/config.js')
    const { runValidateLoss } = await import('./cli/selfopt.js')
    const brokerCfg = loadBrokerConfig()
    console.log(
      await runValidateLoss(
        {
          projectRoot: brokerCfg.projectRoot,
        },
        { json: opts.json },
      ),
    )
  })

program.parse()
