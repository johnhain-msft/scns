# Module Documentation

SCNS is organized into 13 domain modules. Each module has a single responsibility and communicates through well-defined interfaces.

## Module Dependency Graph

```
broker (hub)
  ├─ memory (vault + search)
  │   └─ otel → learning pipeline → pattern extractor
  ├─ dream (consolidation)
  │   └─ memory (reads/writes vault)
  ├─ brain (decision loop)
  │   ├─ context (health monitor, rotation)
  │   ├─ observe (pattern detection)
  │   └─ suggest (suggestions)
  ├─ context (rotation + handoff)
  ├─ rate-limit (throttling)
  ├─ suggest (pattern → suggestions → executor)
  │   ├─ otel (pattern extractor)
  │   └─ observe (pattern detector)
  └─ otel (telemetry ingestion)
      └─ memory (vault storage)
```

---

## src/broker/ — Session Broker

Central hub for session lifecycle, team orchestration, message routing, and MCP tool registration.

**Key files:** `server.ts` (Express 5 + MCP setup), `types.ts` (Zod schemas), `routes/index.ts` (REST endpoints), `services/` (event log, message bus, agent spawner)

**Key exports:** `createBrokerServer()`, `startBroker()`, `Session`, `Message`, `Team`, `Task`

**Architecture:** Manages concurrent sessions/agents, enforces a three-gate pattern for background tasks (enabled + lock + timing), streams events via SSE. All data models are Zod-validated. Exposes MCP alongside REST with health checks, error handling, and rate limiting middleware.

**Security surface (WI-2):** The broker (and every child broker, which inherits the env) binds
`127.0.0.1` by default — all known clients (Copilot extension, dashboard, meta-resolve) are
loopback, and loopback avoids Windows Defender Firewall prompts on the work machine. Override
with `BROKER_BIND` (e.g. `0.0.0.0`) only for deliberate LAN exposure. `BROKER_TOKEN` (default
unset = auth off, unchanged Mac behavior) turns on `Authorization: Bearer <token>` enforcement
for every route EXCEPT two deliberate exemptions: `/health*` (liveness probes must never need a
secret) and **`/api/hooks/*`** (Copilot lifecycle hooks fire before any token can be threaded;
they are loopback-only under the default bind, and carry observational session events, not
commands). `scns install-extension` embeds the token into the generated extension
(resolution: explicit option > `BROKER_TOKEN` env > `~/.scns/.internal-token` file > none;
tokenless installs generate byte-identical unauthenticated requests, so existing setups are
unaffected). Note the embedded token sits in `~/.copilot/extensions/scns/extension.mjs` with
default file perms — acceptable for a single-user machine, not a shared one. On Windows/NTFS,
POSIX `0600` modes don't apply; the internal-token file relies on default NTFS ACLs
(`%USERPROFILE%` is owner-scoped).

**Zero-downtime restart (launchd socket activation):** The daily blue/green restart (`scripts/broker-restart.sh`) uses `launchctl kickstart -k` to restart the broker process in place while launchd keeps the listening socket bound — so the kernel queues connections across the swap (0 dropped connections). It requires the socket-activated broker plist (a `Sockets → Listeners` key) produced by `scns service generate-broker-plist`; the native shim `native/scns-socket-launch` (built into `dist/native/` by `scripts/build-native.mjs`) retrieves the launchd-held fd and exports `SCNS_LISTEN_FD`, and `startup.ts` listens on that fd (`listen-retry.ts` `parseListenFd`/`listenOnFd`) when present, else falls back to port binding for dev/canary/tests. `scns service verify` checks installed `~/Library/LaunchAgents/com.scns.*.plist` for path drift.

---

## src/memory/ — Memory Vault + Hybrid Search

File-based vault (SOUL.md, USER.md, MEMORY.md, daily logs) with sqlite-vec vector search + FTS5 keyword search.

**Key files:** `vault.ts` (file I/O with path traversal prevention), `search.ts` (hybrid 0.7×vector + 0.3×keyword), `embeddings.ts` (FastEmbed ONNX, BGE-small, 384-dim), `indexer.ts` (chunking + indexing), `db.ts` (SQLite + sqlite-vec)

**Key exports:** `createVault()`, `hybridSearch()`, `generateEmbedding()`, `indexVault()`

**Architecture:** Atomic writes prevent corruption. Search combines semantic (vector) and lexical (FTS5) matching. Embeddings lazy-load on first use. Supports SOUL (core identity), USER (profile), MEMORY (consolidated facts), and daily logs (raw observations).

---

## src/dream/ — Dream Consolidation

AutoDream daemon: consolidates memory via orient→gather→consolidate→prune pipeline.

**Key files:** `consolidation.ts` (four-phase pipeline, pure functions), `dream-daemon.ts` (orchestrator), `dream-gates.ts` (session-count + time-based gates), `dream-state.ts` (SQLite state + lock management), `extraction.ts` (parse daily logs)

**Key exports:** `createDreamDaemon()`, `consolidate()`, `checkDreamGates()`, `DreamRunResult`

**Architecture:** Event-driven by session activity. Uses a dedicated SQLite database (separate from broker) for state/locks. The four-phase pipeline is pure (testable); the daemon handles I/O. Memory limits enforced post-consolidation. Entries are deduplicated and contradictions resolved automatically.

---

## src/brain/ — Brain Agent

Decision-making loop (wake→observe→decide→act) that spawns sessions/teams and respects user autonomy.

**Key files:** `agent-loop.ts` (periodic tick), `classifier.ts` (task complexity), `decision-tree.ts` (action recommender), `task-queue.ts` (pending tasks), `state-types.ts` (BrainState, Decision, BrainAction)

**Key exports:** `createBrainAgent()`, `createTaskClassifier()`, `createDecisionTree()`, `BrainAction` (Idle, Observe, SpawnSolo, SpawnTeam, Consolidate, RotateContext, YieldToUser)

**Architecture:** State machine that wakes periodically, observes metrics, makes decisions via injected decider, and acts. Respects `autonomyLevel` (0–100) and `yieldToUser` flags. Task complexity is inferred from keywords/structure.

---

## src/rate-limit/ — Rate Limiting

Token bucket rate limiter + exponential backoff calculator for API/model call throttling.

**Key files:** `token-bucket.ts`, `backoff.ts` (exponential with jitter), `rate-monitor.ts` (utilization tracking + recommendations)

**Key exports:** `createTokenBucket()`, `createBackoffCalculator()`, `createRateMonitor()`, `BucketStats`

**Architecture:** Token bucket allows bursty traffic up to capacity then throttles. Backoff is exponential with random jitter to prevent thundering herd. Rate monitor observes trends and recommends scaling (Normal, SlowDown, Pause, ScaleDown, YieldToUser). Used by broker middleware and agent spawner.

---

## src/context/ — Context Management

Detects context compaction (token overflow), generates handoffs, spawns replacement sessions, manages rotation lifecycle.

**Key files:** `rotation-controller.ts` (detect→handoff→spawn→sunset), `compaction-detector.ts` (token/error/idle signals), `handoff-generator.ts` (summary + work items), `health-monitor.ts` (per-session metrics), `quality-decay.ts` (scoring + penalties)

**Key exports:** `createRotationController()`, `createCompactionDetector()`, `createHandoffGenerator()`, `createHealthMonitor()`, `ContextStatus` (Healthy, Warning, Critical, RotationNeeded, Compacted)

**Architecture:** Rotation triggers when context health degrades. Compaction detector tracks signals over time. Handoff generator summarizes state for the replacement session. Quality scoring penalizes repeated compactions or high error rates.

---

## src/suggest/ — Suggestion Pipeline

Detects behavioral patterns, generates suggestions (skills, agents, MCPs, automations), scores confidence, executes approved suggestions.

**Key files:** `generator.ts` (pipeline), `executor.ts` (implements approved suggestions), `confidence.ts` (scoring), `evidence.ts` (gathers OTel + observation patterns), `extractors/` (per-type extractors), `types.ts` (11 suggestion types)

**Key exports:** `createSuggestionGenerator()`, `createExecutor()`, `SuggestionType`, `Suggestion`, `ImplementationPlan`

**Architecture:** Suggestions are generated from OTel telemetry patterns (work schedule, tool usage) and observation data. Each suggestion type has its own extractor. Confidence is scored from evidence weight. Approved suggestions flow to executor which generates files, installs packages, or configures tools.

---

## src/otel/ — OpenTelemetry Ingestion

Ingests JSONL OTel spans/metrics, builds trace trees, extracts behavioral patterns, drives learning pipeline.

**Key files:** `learning-pipeline.ts` (orchestrator), `pattern-extractor.ts` (work schedule, tool/model prefs), `session-extractor.ts` (spans → summaries), `otel-repository.ts` (SQL), `trace-assembler.ts` (parent-child trees), `jsonl-parser.ts`, `file-watcher.ts`

**Key exports:** `runLearningPipeline()`, `extractPatterns()`, `ExtractedPatterns`, `OtelSpan`, `createOtelFileWatcher()`

**Architecture:** Data flows: raw JSONL → parsed spans → SQLite repository → session extraction → pattern extraction → learning pipeline writes digests to vault. Patterns feed the suggestion pipeline. File watcher triggers learning on new data arrival.

---

## src/autonomy/ — Progressive Autonomy

Manages autonomy level persistence (L0-L3) with promote/demote operations.

**Key files:** `autonomy.ts` (load/save/promote/demote state from `~/.scns/state/autonomy.json`)

**Key exports:** `loadAutonomy()`, `promoteAutonomy()`, `demoteAutonomy()`, `AutonomyState`

**Architecture:** Simple state management — reads/writes a JSON file. Autonomy levels gate what actions the brain agent can take. L0 Observer (read-only) → L1 Advisor (suggest) → L2 Assistant (act with approval) → L3 Autonomous (act independently).

---

## src/shared/ — Shared Utilities

Cross-cutting utilities: types, errors, logger, config, sanitization, cost tracking.

**Key files:** `logger.ts` (Pino), `config.ts` (Zod schemas), `errors.ts` (error hierarchy), `autonomy.ts` (state persistence), `global-error-handlers.ts`, `cost-tracker.ts`, `scns-home.ts` (`resolveScnsHome()`)

**Key exports:** `createLogger()`, `ScnsConfig`, `NotFoundError`, `ValidationError`, `CostTracker`, `resolveScnsHome()`

**`SCNS_HOME` (data-vs-HOME decoupling):** `resolveScnsHome()` returns `SCNS_HOME` when set, else `os.homedir()`; every `~/.scns/...` path (vault.db, experience.db, dream.db, telemetry, state, secrets, …) is derived from it. This lets a dev/test broker run under the **real `HOME`** — so spawned Copilot ACP agents authenticate (auth is keychain/HOME-bound) — while relocating all SCNS data to an isolated `SCNS_HOME`, leaving the live `~/.scns` vault untouched (e.g. `HOME=real SCNS_HOME=/tmp/dev BROKER_DB_PATH=/tmp/dev/broker.db scns start --port 3457`).

---

## src/copilot-extension/ — Copilot CLI Integration

See [docs/copilot-integration.md](copilot-integration.md) for full documentation.

---

## src/observe/ — Observation Layer

See [docs/observer-plugins.md](observer-plugins.md) for full documentation.

---

## Learning, Human-in-the-Loop Memory Layer (specs/001-learning-memory-loop)

The 2026-07 feature completing the memory layer as a learning loop. All levers follow the
option-flag + `SCNS_*` env convention and are DEFAULT-OFF (measure-before-flip); observation-only
capture is fail-safe and byte-identical to the production answer (go-live-to-measure).

**Retrieval levers (US1):** `SCNS_NARRATIVE_SYNTHESIS=1` (Stage-4 Eq-7 briefing via
`retrieveContext`; explicit config wins), `SCNS_MULTIHOP_ITER=1` (C2 iterative arm live),
`SCNS_EDGE_WEIGHTS=1` (the beam reads learned `memory_edges.weight`). The beam transition is the
LITERAL MAGMA Eq-5 (`adaptive-traversal.ts` — no surrogate remains; closed-form-verified).

**Experience record (US2):** `retrieval_experience` gains first-class `propensity REAL` +
`target TEXT` + the `(intent,target)` index (additive migration for pre-feature DBs). The live
`/api/memory/search` seam returns `{results, experienceId}`; the human verdict binds that EXACT id
(`settleHumanOutcome`, first-signal-wins; implicit cues used/edited/re-asked via
`settleHumanOutcomeForAttempt`). Live rows carry the effective arm, μ (propensity), and the query
embedding the hybrid path already computed (`hybridSearch onQueryEmbedding`, observe-only).

**Routing on evidence (US3):** `SCNS_EXPLORE_ROUTING=1` runs bounded SHADOWED ε-exploration live
(variant arm logged with μ=ε/|arms|, never served). `src/reward/dr-estimator.ts` is the
doubly-robust off-policy estimator (Dudík 2011). The EVIDENCE ARBITER (FR-026) promotes a routing
default only via `src/memory/routing-policy.ts` — `commitRoutingPolicy` refuses uncertified
evidence (HCOPE LB ≤ 0, failing/unmeasured controls, no σ, <2 det runs, higher cost) and ANY
guardrail path (FR-027); the live cli consumes a committed arm as the default (envs override;
reads fail closed to hybrid). Bring-up is shadow/advisory (`SCNS_ARBITER_ENACT`,
`SCNS_ARBITER_DET_RUNS`).

**Learning from accept-vs-waste (US4):** the "been-here-before" CBR recall module
(`src/memory/similar-episode.ts` — cosine KNN over `query_embedding` keyed on `(intent,target)`, feeding
`routeQueryArm({episodeAdvice})`) was **deleted on 2026-08-02 (DP-F5)**: it had zero callers in `src/`,
`test/` or `scripts/`, and its `(intent, target)` key was unmatchable because `target` is NULL on all
2060 live `retrieval_experience` rows. Reuse/avoid advice is therefore **not implemented today**; recover
it from git history if revived, and give it a real producer and a non-vacuous key in the same change.
The arm-frontier gate carries the edge-weight-reinforced challenger (`SCNS_REINFORCED_ARM=1` +
read-only `SCNS_EXPERIENCE_DB`); `humanOutcomePromotion` (judge lib) is the SC-008 gate; the
reward report surfaces per-arm DR values + the promotion verdict.

**Purpose routing (Step 2, 2026-08-15 — supersedes the promote/retire framing above for the LIVE
weekly review; see `docs/NORTH_STAR.md` "Retrieval design intent" and
`docs/research/hop-shape-routing.md`):** `magma` (single-hop) and `multihop-iter` (multi-hop) are
purpose-routed tools, not rivals. `src/memory/hop-shape.ts` (+ `hop-shape-signals.ts`) is the
heuristic hop-shape classifier (`single-hop` / `multi-hop` / `ambiguous`, typed reasons, versioned),
running SHADOW/OFFLINE only; `src/reward/routing-accuracy.ts` computes per-tool accept/waste, the
per-shape split, and the stratified balanced classifier-vs-outcome agreement (chance 0.50 under any
served split; approximate 95% interval) with the cutover bar; `src/suggest/routing-format.ts` renders it and `src/suggest/weekly-report.ts` reads for it
(read-only) — the weekly review no longer computes a promotion verdict or raises an `arm-promotion`
proposal (`suggest/arm-promotion.ts` deleted; the reward learner is parked). `scripts/hop-shape-eval.ts`
is the offline harness. Live arm selection is byte-identical (golden test).

**Outward actions (US5):** `src/broker/services/outward/` — `ask_human` (internal human channel,
no egress/spend) and `consult_source` (kernel `checkEgress` first: spend precedence, deny-all
egress; the shipped `config/safety-allowlist.json` is EMPTY and human-owned). Registered as MCP
tools behind the threaded kernel instance. `acp-client` supports the async human-in-the-loop
permission path (`humanPermission`; cancel resolves pending requests per the ACP contract).

**Certification:** `scripts/locomo-judge-harness.ts` (answer accuracy + o200k tokens, NEVER
recall; σ pinned per judge model) and the new `scripts/longmemeval-judge-harness.ts` (held-out
go-live gate, mirrors LoCoMo; smoke/controls/judge modes).
