# SCNS: Second Central Nervous System

## Vision

An autonomous, self-managing AI agent system that operates as a true **second brain** (persistent memory, knowledge retrieval, learning from observation) backed by a **nervous system** (dynamic multi-agent coordination that scales up/down based on task complexity).

It starts manually (`scns start`), observes both your Claude Code sessions AND your general computer activity, learns who you are and how you work, and progressively earns more autonomy. Early on it only _suggests_ — new agents, skills, MCPs, workflows. You review and approve. Over time, as it proves itself, you grant it permission to act independently.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SCNS BRAIN AGENT                           │
│  Manually started. Decides what to do. Routes tasks. Observes.     │
│  Model: Opus 4 (for task classification + orchestration decisions)  │
│  Wakes every 5 min once running. Learns from ALL computer usage.   │
└────────────┬───────────────────────────────┬───────────────────────┘
             │                               │
     ┌───────▼───────┐             ┌─────────▼──────────┐
     │  SIMPLE PATH  │             │   COMPLEX PATH     │
     │  Subagents +  │             │   Teams + Session   │
     │  Scratchpad   │             │   Broker + Msg Bus  │
     └───────┬───────┘             └─────────┬──────────┘
             │                               │
     ┌───────▼───────────────────────────────▼──────────┐
     │              SESSION BROKER (MCP Server)          │
     │  Express + MCP + SSE | Port 3456                  │
     │  Heartbeats | Zombie cleanup | Auto-scale         │
     │  Team manifests | Respawn policies                │
     │  Message bus | File conflict detection            │
     └───────────────────────┬──────────────────────────┘
                             │
     ┌───────────────────────▼──────────────────────────┐
     │              MEMORY LAYER                         │
     │  SQLite + sqlite-vec (hybrid search)              │
     │  File vault (SOUL/USER/MEMORY.md + daily logs)    │
     │  FastEmbed (all-MiniLM-L6-v2, 384-dim, local)    │
     │  AutoDream consolidation daemon                   │
     └──────────────────────────────────────────────────┘
                             │
     ┌───────────────────────▼──────────────────────────┐
     │              OBSERVATION LAYER                    │
     │  Claude Code hooks (sessions, tools, patterns)    │
     │  Computer activity (apps, files, git, browser)    │
     │  Suggestion engine (agents, skills, MCPs)         │
     │  Progressive autonomy (suggest → auto-act)        │
     └──────────────────────────────────────────────────┘
```

---

## Progressive Autonomy Model

The system has four trust levels. You control promotion.

| Level  | Name           | Behavior                                                                             | When                           |
| ------ | -------------- | ------------------------------------------------------------------------------------ | ------------------------------ |
| **L0** | **Observer**   | Watches and logs only. No suggestions.                                               | Day 1 — learning baseline      |
| **L1** | **Advisor**    | Suggests new agents, skills, MCPs, workflows. You review/approve via `/scns-review`. | After ~1 week of observation   |
| **L2** | **Assistant**  | Implements approved suggestions autonomously. Proposes larger changes for review.    | After you trust its judgment   |
| **L3** | **Autonomous** | Acts independently within guardrails. Only escalates novel/risky actions.            | When it has proven reliability |

**Promotion**: `scns promote` (with confirmation). **Demotion**: `scns demote` (immediate, no confirmation needed).

Trust state is persisted in `~/.scns/state/autonomy.json`:

```json
{
  "level": 1,
  "promoted_at": "2026-04-10T14:00:00Z",
  "promotion_history": [...],
  "guardrails": {
    "respect_session_limits": true,
    "max_concurrent_sessions": 3,
    "yield_to_user": true,
    "allowed_actions": ["suggest", "create_skill_draft", "create_agent_draft"],
    "blocked_actions": ["git_push", "install_package", "modify_settings"]
  }
}
```

---

## What SCNS Observes

### Claude Code Sessions (via hooks)

- Session start/end times, working directories, project context
- Tools used (frequency, patterns, favorites)
- Key decisions extracted before compaction
- Errors encountered, how they were resolved
- Which skills/agents are invoked most
- Conversation patterns (what gets asked repeatedly)

### Computer Activity (via native observers)

- **Active application** (frontmost app name + window title via `osascript`)
- **File changes** (fswatch on working directories — what files are created/modified)
- **Git activity** (commits, branches, PRs across all repos)
- **Terminal commands** (shell history — opt-in, sanitized to remove secrets)
- **Browser tabs** (active tab URL + title via osascript — opt-in, privacy-respectable)
- **Work schedule** (when active, when idle, break patterns)

**Privacy controls** (`~/.scns/state/observation-config.json`):

```json
{
  "claude_sessions": true,
  "active_app": true,
  "file_changes": true,
  "git_activity": true,
  "terminal_history": false,
  "browser_tabs": false,
  "excluded_apps": ["1Password", "Messages", "Mail"],
  "excluded_paths": ["~/.ssh", "~/.gnupg", "~/Private"]
}
```

### What it Learns From This

- Your work schedule and focus patterns
- Which tools/languages/frameworks you use most
- Projects you're actively working on
- Repetitive tasks that could be automated
- Gaps in your toolchain (missing MCPs, useful skills)
- Your coding style preferences (beyond what's in CLAUDE.md)
- What kind of research you do and how

---

## Suggestion Engine

The Brain Agent produces **suggestions** stored in `~/.scns/suggestions/`:

```
~/.scns/suggestions/
├── pending/
│   ├── 2026-04-10-mcp-postgres.md
│   ├── 2026-04-11-skill-django-deploy.md
│   └── 2026-04-12-agent-code-reviewer.md
├── approved/
├── rejected/
└── implemented/
```

Each suggestion is a markdown file:

```markdown
---
type: skill | agent | mcp | automation | workflow
confidence: 0.85
evidence:
  - "User has run Django migrations 14 times this week"
  - "No Django-specific deployment skill detected"
priority: medium
autonomy_level_required: 2
---

# Suggestion: Django Deploy Skill

## What

Create a `/deploy-django` skill that handles migrations, collectstatic,
and Azure App Service deployment in one command.

## Why

You've manually run the same 5-command deployment sequence 14 times
in the past week across 3 Django projects. This could be a single skill.

## Implementation

[Draft skill definition here]

## Estimated Effort

~30 minutes to implement and test.
```

### Review Skill: `/scns-review`

A Claude Code skill you invoke to review pending suggestions:

```
> /scns review

SCNS has 3 pending suggestions:

1. [HIGH] MCP: Add postgres MCP server for real_estate_analysis
   Evidence: 23 manual SQL queries this week, DATABASE_URL already in .env
   Confidence: 0.92

2. [MED] Skill: Django deployment automation
   Evidence: 14 identical deploy sequences across 3 projects
   Confidence: 0.85

3. [LOW] Agent: Automated code reviewer for Python projects
   Evidence: You review PRs manually but have the code-reviewer agent unused
   Confidence: 0.71

Actions: [a]pprove  [r]eject  [d]etails  [s]kip  [q]uit
```

On approve:

- **L1 (Advisor)**: Generates implementation plan, waits for you to execute
- **L2 (Assistant)**: Implements it in a branch, opens a PR-like review for you
- **L3 (Autonomous)**: Implements and activates immediately (within guardrails)

---

## Critical Design Principles

### 1. TDD Everything — Tests Gate Phase Progression

**Every phase has a test suite that must pass 100% before moving to the next phase.**

Test pyramid per phase:

- **Unit tests**: Every function, every edge case. Fast. Mocked dependencies.
- **Integration tests**: Components working together. Real SQLite. Real file I/O.
- **E2E tests**: Full system flows. Brain Agent → Broker → Workers → Results.
- **Stress tests**: Concurrent agents, message floods, large memory vaults, context rotation under load.

**Phase gate criteria**:

```
Phase N tests pass (unit + integration + E2E + stress)
  → Coverage ≥ 80%
  → No CRITICAL or HIGH issues from code review
  → All stress tests pass within performance budgets
THEN Phase N+1 may begin
```

### 2. Classify Before Spawning (Google/MIT #1 Rule)

| Task Type                                                          | Routing                                       | Why                               |
| ------------------------------------------------------------------ | --------------------------------------------- | --------------------------------- |
| **Parallelizable** (research, data gathering, multi-file analysis) | Multi-agent centralized (3-10 workers)        | +81% performance gain             |
| **Sequential** (reasoning chains, planning, step-by-step logic)    | Single agent only                             | Multi-agent degrades -39% to -70% |
| **Hybrid** (parallel research → sequential synthesis)              | Phased: parallel workers → single synthesizer | Best of both worlds               |

### 3. Two-Level Heartbeats

- **L1 (Liveness)**: Process heartbeat to broker every 25s. Proves process exists.
- **L2 (Work Progress)**: Inside work loop, updates `last_work_at`. Proves agent isn't hung.

### 4. Artifact Bypass

Large outputs written to filesystem/SQLite, never routed through conversation chains. Pass lightweight references only.

### 5. MCP for Tools, A2A as the Broker's Communication Protocol

- **MCP**: How agents access the session broker, memory, tools
- **A2A**: The wire format and protocol the broker speaks. Not a separate layer — integrated into the broker itself:
  - **Agent Cards** replace custom registration (agents register capabilities, not just IDs)
  - **JSON-RPC 2.0** standardizes the message format on the broker's message bus
  - **Task lifecycle** (`submitted → working → completed/failed`) replaces ad-hoc status tracking
  - **SSE streaming** for long-running task updates (broker already has SSE infrastructure)
  - External interop comes for free later — the broker already speaks the standard

### 6. Session Rotation (Sunset Tired Sessions)

When context reaches 80%: spawn fresh session → handoff summary → sunset old one.

### 7. Respect the Rate Ceiling

SCNS runs on your Claude Code Max plan. No API billing — but rate limits are real. The system MUST:

- Detect rate limit proximity and back off before hitting the wall
- Yield to your interactive sessions (user always has priority)
- Queue work when rate-limited, resume on backoff expiry
- Never spawn more concurrent sessions than configured cap (default: 3)

---

## Implementation Phases (TDD-Gated)

### Phase 0: Project Scaffolding + Test Infrastructure

**Goal**: Buildable, testable TypeScript project with CI-ready test harness.

**Deliverables**:

- [ ] package.json with all dependencies
- [ ] tsconfig.json (ESM, strict, paths)
- [ ] vitest.config.ts with coverage thresholds (80%)
- [ ] ESLint + Prettier config
- [ ] Test helpers: fixtures, factories, mocks, SQLite test harness
- [ ] Directory structure (empty modules with barrel exports)
- [ ] `scns` CLI skeleton (commander.js, `start`/`stop`/`status` stubs)
- [ ] CI script: `npm test` runs unit + integration, `npm run test:e2e` for E2E
- [ ] CLAUDE.md for the project

**Tests (gate to Phase 1)**:

- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` runs and reports 0 tests (scaffold is clean)
- [ ] CLI prints help text for all commands
- [ ] Test harness creates/destroys temp SQLite DBs correctly

---

### Phase 1: Memory Vault + Hybrid Search

**Goal**: File-based memory vault with hybrid vector+keyword search that actually works.

**Implementation**:

- [ ] File vault: read/write SOUL.md, USER.md, MEMORY.md, daily logs
- [ ] Daily log append (timestamped entries, atomic writes)
- [ ] SQLite schema (sqlite-vec + FTS5, WAL mode)
- [ ] FastEmbed integration (all-MiniLM-L6-v2, local ONNX)
- [ ] Chunking pipeline (400 tokens, configurable overlap)
- [ ] Hybrid search: `0.7 * vector_score + 0.3 * keyword_score`
- [ ] Incremental indexing (mtime-based change detection)
- [ ] MCP tool wrappers: `memory_search`, `memory_read`, `memory_write`, `memory_index`

**Unit tests**:

- [ ] Vault CRUD operations (create, read, update, append, delete)
- [ ] Daily log atomicity (concurrent appends don't corrupt)
- [ ] Chunking correctness (token count, overlap, boundary handling)
- [ ] Embedding dimension validation (384-dim output)
- [ ] FTS5 query parsing and matching
- [ ] Hybrid score calculation (weight blending, edge cases)
- [ ] Incremental indexer (detects changes, skips unchanged, handles deletions)

**Integration tests**:

- [ ] Full pipeline: write markdown → index → search → retrieve correct chunks
- [ ] Search relevance: known queries return expected results (precision/recall)
- [ ] Large vault (1000+ files): indexing completes, search returns in <500ms
- [ ] Concurrent read/write: vault reads don't block during indexing

**Stress tests**:

- [ ] 10,000 document vault: index time, search latency, memory usage
- [ ] Rapid concurrent searches (100 parallel queries)
- [ ] Index while searching (no corruption, no stale results)

**Gate**: All tests pass, coverage ≥80%, search returns relevant results for 10 hand-crafted test queries.

---

### Phase 2: Session Broker (Port + Adapt)

**Goal**: Session broker from everything-copilot running, tested, with SCNS-specific additions.

**Implementation**:

- [ ] Port session broker source (adapt imports, remove Copilot-specific code)
- [ ] Session lifecycle state machine
- [ ] Heartbeat poller (30s interval, 300s grace, zombie cleanup)
- [ ] Message bus (direct + broadcast)
- [ ] Team orchestration (create, join, disband, hierarchical)
- [ ] Agent spawner (tmux/detached process)
- [ ] Three-gate background tasks
- [ ] Event dispatcher + SSE manager
- [ ] Startup cleanup + shutdown manager
- [ ] Health endpoints (`/health/live`, `/health/ready`)
- [ ] Wire memory vault as MCP tools on the broker

**Unit tests**:

- [ ] Lifecycle state machine: all valid transitions pass, all invalid transitions throw
- [ ] Heartbeat: grace period math, zombie detection query
- [ ] Message routing: direct delivery, broadcast fan-out, unread filtering
- [ ] Team CRUD: create, add member, remove member, disband, hierarchical tree
- [ ] Three-gate logic: disabled gate, lock gate, time gate, count gate
- [ ] Event dispatcher: subscribe, filter, unsubscribe, max listeners
- [ ] Config loading: all env vars parsed, defaults correct, frozen

**Integration tests**:

- [ ] Full broker startup → health check → register session → heartbeat → deregister
- [ ] Two agents: register → send message → receive message → mark read
- [ ] Team lifecycle: create team → add members → send team messages → disband → GC
- [ ] Zombie cleanup: register → stop heartbeat → wait grace → verify cleanup
- [ ] Startup cleanup: pre-populate stale sessions → restart → verify clean state
- [ ] Graceful shutdown: active sessions → shutdown → verify ordered cleanup

**E2E tests**:

- [ ] Spawn a real Claude Code agent via broker → agent registers → sends heartbeat → completes task → deregisters
- [ ] Two-agent coordination: spawn lead + worker → lead delegates → worker completes → lead collects

**Stress tests**:

- [ ] 50 concurrent session registrations
- [ ] 1000 messages/sec through message bus
- [ ] Zombie cleanup with 100 stale sessions
- [ ] SSE with 20 concurrent dashboard connections

**Gate**: All tests pass, broker starts in <2s, handles 50 concurrent sessions without degradation.

---

### Phase 3: AutoDream Consolidation

**Goal**: Background memory consolidation that actually improves memory quality over time.

**Implementation**:

- [ ] Three-gate trigger (time ≥24h + sessions ≥5 + lock acquired)
- [ ] Four-phase consolidation (orient → gather → consolidate → prune)
- [ ] Consolidation prompt templates (based on claurst spec)
- [ ] Session memory extraction (after 20+ messages, extract key facts)
- [ ] MEMORY.md enforced limit (≤200 lines, ≤25KB)
- [ ] Consolidation state persistence
- [ ] Process isolation (runs as separate sub-agent, read-only to codebase)

**Unit tests**:

- [ ] Gate logic: each gate independently (time, session count, lock)
- [ ] Gate combination: all three must pass
- [ ] Lock acquisition and release (including stale lock cleanup)
- [ ] MEMORY.md line counting and truncation
- [ ] Date conversion (relative → absolute)
- [ ] Duplicate detection in memory entries

**Integration tests**:

- [ ] Full consolidation cycle: populate daily logs → trigger → verify MEMORY.md updated
- [ ] Contradiction removal: add contradicting facts → consolidate → verify only latest survives
- [ ] Session extraction: create 25-message transcript → extract → verify key facts captured
- [ ] Idempotency: run consolidation twice → same result

**Stress tests**:

- [ ] 90 days of daily logs (2700+ entries): consolidation completes in <10 min
- [ ] Concurrent consolidation attempts: only one proceeds, others back off

**Gate**: All tests pass, consolidation produces measurably better MEMORY.md (human review of 3 test scenarios).

---

### Phase 4: Observation Layer

**Goal**: System watches Claude sessions AND computer activity, logs everything to daily vault.

**Observation polling frequencies**:

| Observer         | Method                     | Frequency | Notes                                      |
| ---------------- | -------------------------- | --------- | ------------------------------------------ |
| Active app       | Poll (osascript)           | **30s**   | Lightweight, captures workflow transitions |
| File changes     | **Event-driven** (fswatch) | Instant   | Fires on change, no polling                |
| Git activity     | Poll (git log)             | **5 min** | Commits are infrequent                     |
| Terminal history | Watch file mtime           | **60s**   | Batch reads, secrets stripped              |
| Browser tabs     | Poll (osascript)           | **60s**   | Opt-in, context changes slowly             |
| Claude hooks     | **Event-driven**           | Instant   | Hooks fire on session events               |

**Implementation**:

- [ ] Claude Code hooks: SessionStart, PreCompact, SessionEnd, PostToolUse
- [ ] Active app observer (osascript, polls every 30s)
- [ ] File change observer (fswatch on configured directories, event-driven)
- [ ] Git activity observer (poll repos every 5 min for new commits/branches)
- [ ] Terminal history observer (opt-in, watch every 60s, sanitized, secrets stripped)
- [ ] Browser tab observer (opt-in, osascript, polls every 60s)
- [ ] Observation config (privacy controls, excludes)
- [ ] All observations → daily log with structured tags
- [ ] Pattern detection (work schedule, tool frequency, project focus)

**Unit tests**:

- [ ] Each observer: correct data extraction, error handling on unavailable data
- [ ] Privacy filter: excluded apps/paths never logged
- [ ] Secret sanitization: API keys, tokens, passwords stripped from terminal history
- [ ] Structured tagging: each observation type produces correct tag format
- [ ] Pattern detection: given known input sequences, correct patterns identified

**Integration tests**:

- [ ] Hooks fire on real Claude Code events → data appears in daily log
- [ ] App observer: switch apps → log entries appear with correct timestamps
- [ ] File observer: create/modify files → changes logged
- [ ] Git observer: make commits → activity logged
- [ ] Full day simulation: feed 8 hours of activity → verify daily log completeness

**E2E tests**:

- [ ] Start SCNS → work normally for 5 min → stop → daily log has meaningful data
- [ ] Privacy: work in excluded app → nothing logged for that period

**Gate**: All tests pass, 5-minute real-usage test produces accurate activity log.

---

### Phase 5: Brain Agent + Task Classification

**Goal**: Brain Agent wakes every 30 min, classifies tasks, routes correctly, manages simple subagents.

**Implementation**:

- [ ] Brain Agent main loop (wake → observe → decide → act/sleep)
- [ ] Task classifier (parallel vs sequential vs hybrid)
- [ ] Decision tree: idle / subagent / team / solo / observe
- [ ] Subagent spawning for simple tasks + scratchpad communication
- [ ] Context health monitoring per session
- [ ] 30-minute wake interval (configurable)
- [ ] Brain Agent prompt templates (role-based, memory-informed)

**Unit tests**:

- [ ] Classifier: 20 test cases spanning parallel, sequential, hybrid → correct routing
- [ ] Decision tree: each branch reachable, correct action for each state
- [ ] Wake interval: timer fires correctly, handles system sleep/resume
- [ ] Prompt template rendering: all variables substituted correctly

**Integration tests**:

- [ ] Brain Agent wakes → no work → sleeps (clean cycle)
- [ ] Brain Agent wakes → simple task → spawns subagent → collects result → logs
- [ ] Brain Agent wakes → parallel task → spawns 3 workers → waits → synthesizes
- [ ] Brain Agent wakes → sequential task → handles solo → completes
- [ ] Context health: agent at 85% → Brain Agent detects → prepares rotation

**E2E tests**:

- [ ] Full cycle: start SCNS → Brain Agent wakes → classifies real task → spawns agents → completes → consolidates

**Stress tests**:

- [ ] 10 concurrent tasks queued: Brain Agent processes in correct order
- [ ] Agent failure mid-task: Brain Agent detects, respawns or reassigns

**Gate**: All tests pass, classifier accuracy ≥85% on test suite, Brain Agent correctly handles all 4 routing paths.

---

### Phase 6: Suggestion Engine + Review Skill

**Goal**: SCNS generates actionable suggestions from observations; `/scns-review` skill for approval.

**Implementation**:

- [ ] Suggestion generation (runs during Brain Agent wake cycle)
- [ ] Suggestion types: skill, agent, mcp, automation, workflow
- [ ] Evidence gathering (query observation logs + memory for patterns)
- [ ] Confidence scoring (frequency, consistency, impact estimate)
- [ ] Suggestion file format (markdown with frontmatter)
- [ ] Suggestion deduplication (don't re-suggest rejected items)
- [ ] `/scns-review` Claude Code skill (interactive review UI)
- [ ] Approve → implementation plan generation
- [ ] Reject → move to rejected/ with reason
- [ ] Implementation executor (at L2+: auto-create skills, install MCPs, configure agents)

**Unit tests**:

- [ ] Pattern → suggestion mapping (given known patterns, correct suggestions generated)
- [ ] Confidence scoring (frequency/consistency/impact math)
- [ ] Deduplication (similar suggestions merged, rejected items not re-suggested)
- [ ] Suggestion file parsing and validation
- [ ] Evidence formatting

**Integration tests**:

- [ ] Populate 7 days of observations → generate suggestions → verify relevance
- [ ] Approve suggestion → implementation plan generated correctly
- [ ] Reject suggestion → not re-suggested in next cycle
- [ ] L1 approve: plan generated, no auto-implementation
- [ ] L2 approve: implementation executes, creates real files

**E2E tests**:

- [ ] Full loop: observe for session → Brain Agent generates suggestion → `/scns-review` → approve → skill/MCP installed

**Gate**: All tests pass, suggestions are relevant (human review of 5 generated suggestions).

---

### Phase 7: Team Orchestration + A2A Wire Protocol

**Goal**: Complex tasks spawn full agent teams. Broker speaks A2A (Agent Cards, JSON-RPC 2.0, task lifecycle).

**Implementation**:

- [ ] A2A Agent Card schema (agents register capabilities, not just IDs)
- [ ] A2A JSON-RPC 2.0 message format for broker message bus
- [ ] A2A task lifecycle integration (submitted → working → completed/failed)
- [ ] Agent Card endpoint (`/.well-known/agent.json`) on broker
- [ ] TeamManifest for SCNS roles (researcher, implementer, reviewer, tester)
- [ ] Team templates (research, implementation, review, full)
- [ ] Orchestration phases (research → synthesis → implementation → verification)
- [ ] Auto-scaler integration with Brain Agent
- [ ] Respawn controller with context health checks
- [ ] Rate limit awareness (scale down when approaching limits, yield to user)

**Unit tests**:

- [ ] Agent Card generation and schema validation
- [ ] JSON-RPC 2.0 message serialization/deserialization
- [ ] A2A task state machine (all valid transitions, invalid transitions throw)
- [ ] Team template expansion (role counts, prompt assignment)
- [ ] Orchestration phase gate logic (all tasks complete before transition)
- [ ] Rate limit backoff math (exponential, cap, queue depth)
- [ ] Manifest reconciliation (desired state vs actual state delta)

**Integration tests**:

- [ ] Agent Card registration → discover via Agent Card endpoint → capabilities match
- [ ] A2A task delegation: submit task → worker picks up → status transitions → completed
- [ ] Team creation from manifest → all members spawned → tasks assigned → completion
- [ ] Auto-scale: add pending tasks → scaler spawns workers → tasks consumed
- [ ] Respawn: kill worker → respawn controller detects → new worker spawns
- [ ] Rate limit: hit limit → workers pause → queue fills → resume on backoff expiry

**E2E tests**:

- [ ] Full team flow: Brain Agent creates research team → 3 workers research in parallel → synthesizer combines → result stored in memory

**Stress tests**:

- [ ] 5 concurrent teams (20+ agents total): broker handles coordination
- [ ] Rapid scale up/down: 10 agents → 2 agents → 10 agents

**Gate**: All tests pass, team completes a real multi-agent research task end-to-end.

---

### Phase 8: Session Rotation + Context Management

**Goal**: Tired sessions are automatically rotated with zero data loss.

**Implementation**:

- [ ] Context health scoring per session (tokens, compaction count, quality score)
- [ ] Compaction detection (hook into broker events)
- [ ] Session rotation protocol (handoff summary → spawn fresh → sunset old)
- [ ] Handoff summary generation (key context, current task state, relevant memory refs)
- [ ] Rotation triggered by Brain Agent or cron watchdog
- [ ] Verify fresh session resumes correctly from handoff

**Unit tests**:

- [ ] Context health calculation (token estimation, quality decay curve)
- [ ] Rotation trigger thresholds (80% warning, 90% autocompact, 3+ compactions → rotate)
- [ ] Handoff summary format and completeness validation

**Integration tests**:

- [ ] Simulate high-context session → rotation triggers → fresh session starts → reads handoff → continues work
- [ ] Rotation mid-team-task: worker rotates → team continues without interruption
- [ ] No data loss: compare pre-rotation memory state vs post-rotation

**Stress tests**:

- [ ] 10 agents all hitting rotation threshold simultaneously
- [ ] Rapid rotation cycling (rotate every 2 min): no resource leaks

**Gate**: All tests pass, rotation completes in <30s, fresh session correctly resumes work from handoff.

---

### Phase 9: CLI + Dashboard + Polish

**Goal**: Clean CLI, monitoring dashboard, documentation, production-ready.

**Implementation**:

- [ ] Full CLI: `start`, `stop`, `status`, `dream`, `search`, `observe`, `review`, `promote`, `demote`, `dashboard`
- [ ] Adapt dashboard from everything-copilot (Next.js 15)
- [ ] Dashboard pages: Overview, Sessions, Teams, Memory, Suggestions, Observations, Autonomy, Cost
- [ ] Log rotation (daily, 30-day retention)
- [ ] `scns install` (install launchd plist for optional auto-start later)
- [ ] `scns uninstall` (remove launchd plist)
- [ ] Cost tracking (per-session and aggregate token usage)
- [ ] Full documentation

**Tests**:

- [ ] CLI: every command has a test (args, output, error cases)
- [ ] Dashboard: API integration tests (all endpoints return expected data)
- [ ] Log rotation: verify old logs cleaned, current logs preserved
- [ ] Install/uninstall: plist created/removed correctly

**Gate**: All tests pass, full system integration test (start → observe → suggest → review → team task → rotate → stop).

---

### Phase 10: External Tool Integration (Hermes + OpenClaw + Discord)

**Goal**: Make Hermes, OpenClaw, and Discord fully operational — each tool works independently AND together. The broker doesn't replace these tools; it's the coordination layer that automatically routes tasks to whichever runtime is best suited, forces communication between agents, and turns tools on/off as needed.

**Prerequisites**: Hermes cloned to `~/Coding_Projects/hermes-agent/` (venv + locked config). OpenClaw installed globally (locked config). Both are inert until this phase activates them.

**Key Principle**: Each tool must be fully set up and functional on its own FIRST. Broker integration is the glue that lets them cooperate — not a replacement for the tools themselves.

**Implementation**:

**10a — SOUL.md + USER.md Bootstrap**
- [ ] SOUL.md template generator — personality, behavioral rules, hard boundaries, autonomy guardrails
- [ ] USER.md template generator — user profile, preferences, account IDs, tool configs
- [ ] `scns init` command that creates `~/.scns/SOUL.md` and `~/.scns/USER.md` interactively
- [ ] Validation: SOUL.md loaded and enforced on every brain agent wake cycle
- [ ] Validation: USER.md loaded and available to all subsystems (observe, suggest, brain)
- [ ] SOUL.md shared with Hermes/OpenClaw — consistent personality across all runtimes
- [ ] USER.md provides tool-specific config sections (Hermes prefs, OpenClaw prefs, Discord prefs)

**10b — Hermes Standalone Setup**
- [ ] Hermes configuration profile — model selection, tool permissions, skill definitions (all in-house, no external)
- [ ] Hermes skill authoring — create custom skills for SCNS use cases (research, code review, documentation)
- [ ] Hermes user modeling — feed USER.md into Hermes persistent memory so it knows the user
- [ ] Hermes CLI wrapper — `scns hermes <command>` for direct Hermes interaction independent of broker
- [ ] Hermes standalone tests — verify Hermes runs, executes skills, produces output without broker
- [ ] Security: verify locked config on every spawn (reject if plugins/network re-enabled)
- [ ] Security: Hermes runs in restricted venv — no system PATH access, no pip install at runtime

**10c — OpenClaw Standalone Setup**
- [ ] OpenClaw configuration profile — session settings, tool permissions, workspace rules
- [ ] OpenClaw workspace setup — configure for SCNS project directories, memory vault access
- [ ] OpenClaw CLI wrapper — `scns openclaw <command>` for direct OpenClaw interaction independent of broker
- [ ] OpenClaw standalone tests — verify OpenClaw runs, creates sessions, produces output without broker
- [ ] Security: verify locked config on every spawn (reject if plugins/discovery re-enabled)
- [ ] Security: config integrity check — hash `~/.openclaw/openclaw.json`, alert on modification

**10d — Discord Gateway (standalone communication layer)**
- [ ] Discord bot setup (reference: `~/Documents/Coding_Projects` discord implementation)
- [ ] Discord bot standalone — works independently as a command interface to SCNS
- [ ] Session control via Discord commands (`/scns status`, `/scns team list`, `/scns wake`)
- [ ] User can interact with Hermes directly via Discord (no broker required)
- [ ] User can interact with OpenClaw directly via Discord (no broker required)
- [ ] Security: Discord bot token in env var only, no hardcoded tokens
- [ ] Security: command allowlist — only approved commands accepted from Discord

**10e — Broker Bridges (automatic coordination)**
- [ ] Hermes subprocess adapter — broker spawns Hermes as child process with locked config
- [ ] Hermes ↔ broker message bus bridge (JSON protocol over stdin/stdout)
- [ ] Hermes Agent Card registration — capabilities advertised to broker on spawn
- [ ] OpenClaw subprocess adapter — broker spawns OpenClaw sessions
- [ ] OpenClaw ↔ broker message bus bridge (JSON protocol)
- [ ] OpenClaw Agent Card registration — capabilities advertised to broker on spawn
- [ ] Discord ↔ broker message bus bridge (bidirectional message routing)
- [ ] Cross-session communication: Claude Code ↔ Copilot ↔ Hermes ↔ OpenClaw via any transport
- [ ] All tool output passes through privacy filter + sanitization before storage

**10f — Smart Task Routing + Multi-Runtime Orchestration**
- [ ] Task router: brain agent classifies tasks → routes to best-suited runtime automatically
- [ ] Routing heuristics: Hermes for research/skills, OpenClaw for multi-channel, Claude/Copilot for code
- [ ] Unified agent spawner: broker can spawn ANY runtime (Claude Code, Copilot, Hermes, OpenClaw)
- [ ] Cross-runtime team composition: teams mix agent types (e.g., Hermes researcher + Claude implementer)
- [ ] Broker turns tools on/off as needed — idle tools are stopped, hot tools are spawned on demand
- [ ] Transport fallback chain: broker message bus (local) → trackpad/.md files (durable) → Discord (remote)
- [ ] Durable multi-session: sessions survive restarts via broker state + Discord reconnection
- [ ] Health monitoring: heartbeats from all runtimes, zombie detection across all agent types
- [ ] Lifecycle management: spawner tracks all PIDs, respawn controller handles crashes across runtimes

**Unit tests**:
- [ ] SOUL.md/USER.md template generation and validation
- [ ] Hermes standalone adapter (spawn, run skill, kill)
- [ ] OpenClaw standalone adapter (spawn, create session, kill)
- [ ] Hermes subprocess bridge (stdin/stdout JSON protocol)
- [ ] OpenClaw subprocess bridge (JSON protocol)
- [ ] Config integrity checks (detect tampering)
- [ ] Discord message serialization/deserialization
- [ ] Task router heuristics (correct runtime selected for each task type)
- [ ] Cross-runtime agent card registration
- [ ] Transport fallback chain (local → durable → remote)

**Integration tests**:
- [ ] Hermes standalone: spawn → run skill → get output (no broker)
- [ ] OpenClaw standalone: spawn → create session → get output (no broker)
- [ ] Hermes via broker: spawn → register → receive task → complete → result stored
- [ ] OpenClaw via broker: spawn → register → session rotation → handoff preserved
- [ ] Discord standalone: send command → tool executes → response posted (no broker)
- [ ] Discord via broker: send command → broker routes → response posted
- [ ] Mixed team: spawn Hermes + Claude agents → tasks distributed by router → all complete
- [ ] Config tampering: modify locked config → spawn rejected with security alert
- [ ] Transport fallback: broker down → communication falls back to .md files → still works

**E2E tests**:
- [ ] Full flow: user sends Discord command → brain agent creates team → Hermes + OpenClaw + Claude agents spawned → tasks routed by type → research completes → result posted to Discord
- [ ] Session durability: kill agent mid-task → respawn → resume from broker state → complete
- [ ] Independent operation: broker stopped → Hermes and OpenClaw still work via Discord + direct CLI

**Gate**: All tests pass. Each tool works standalone. Mixed-runtime team completes a real task end-to-end. Discord round-trip works. Tools function independently when broker is down.

---

## Component Details

### Memory Vault (File-Based)

```
~/.scns/
├── SOUL.md              # Agent personality, behavioral rules, hard boundaries
├── USER.md              # User profile, preferences, account IDs, integration config
├── MEMORY.md            # Long-term memory index (≤200 lines, loaded every session)
├── daily/
│   └── YYYY-MM-DD.md   # Append-only daily logs (observations + session transcripts)
├── topics/              # Thematic memory files (promoted from daily logs)
│   ├── coding-patterns.md
│   ├── project-decisions.md
│   ├── tool-preferences.md
│   ├── work-schedule.md
│   └── ...
├── suggestions/
│   ├── pending/
│   ├── approved/
│   ├── rejected/
│   └── implemented/
├── state/
│   ├── autonomy.json           # Current trust level + guardrails
│   ├── observation-config.json # Privacy controls
│   ├── heartbeat-state.json    # Last heartbeat snapshot
│   ├── consolidation-state.json # AutoDream state + lock
│   └── context-health.json     # Per-session context tracking
└── data/
    ├── scns.db         # SQLite: hybrid search (sqlite-vec + FTS5)
    ├── chat.db           # Conversation thread persistence
    └── broker.db         # Session broker state
```

### Hybrid Search Engine

- **Vector**: sqlite-vec, FastEmbed `all-MiniLM-L6-v2` (384-dim, ONNX local)
- **Keyword**: SQLite FTS5
- **Merge**: `0.7 * vector + 0.3 * keyword` (configurable)
- **Chunking**: ~400 tokens with overlap
- **Incremental**: mtime-based change detection, only re-embed modified files

### Session Broker (Ported from everything-copilot)

**Kept as-is**:

- Session lifecycle state machine
- Heartbeat poller (30s interval, 300s grace)
- Message bus (direct + broadcast)
- Team orchestration (hierarchical)
- TeamManifest + reconciliation
- Agent spawner (tmux/detached)
- Respawn controller (exponential backoff)
- Auto-scaler (demand-based)
- Three-gate background tasks
- Two-tier archival
- File conflict detection
- Tool risk profiles
- Event dispatcher + SSE
- Startup cleanup + shutdown manager

**Added for SCNS**:

- A2A as wire protocol (Agent Cards for registration, JSON-RPC 2.0 messages, task lifecycle)
- Memory vault MCP tools
- L2 work-progress heartbeat
- Context health tracking
- Session rotation triggers
- Observation data ingestion
- Suggestion generation hooks
- Rate limit detection + backoff + user-yield logic

---

## Directory Structure

```
scns/
├── PLAN.md
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example
├── .gitignore
│
├── references/                      # Source material (not built)
│   ├── second-brain/
│   ├── claurst-specs/
│   ├── session-broker/
│   └── dashboard/
│
├── src/
│   ├── cli.ts                       # CLI entry point
│   │
│   ├── brain/                       # Brain Agent
│   │   ├── agent.ts                 # Main loop (wake → observe → decide → act)
│   │   ├── classifier.ts            # Task type classifier
│   │   ├── decision.ts              # Decision tree
│   │   ├── prompts.ts               # Prompt templates
│   │   └── suggestions.ts           # Suggestion generator
│   │
│   ├── memory/                      # Memory Vault + Search
│   │   ├── vault.ts                 # File-based memory (read/write/append)
│   │   ├── search.ts                # Hybrid search engine
│   │   ├── embeddings.ts            # FastEmbed wrapper
│   │   ├── indexer.ts               # Incremental indexing pipeline
│   │   ├── schema.sql               # SQLite schema
│   │   └── db.ts                    # Database abstraction
│   │
│   ├── dream/                       # AutoDream Consolidation
│   │   ├── daemon.ts                # 3-gate trigger
│   │   ├── phases.ts                # 4-phase consolidation
│   │   ├── extractor.ts             # Session memory extraction
│   │   └── reflection.ts            # Daily reflection
│   │
│   ├── observe/                     # Observation Layer
│   │   ├── manager.ts               # Observation orchestrator
│   │   ├── claude-hooks.ts          # Claude Code hook handlers
│   │   ├── app-observer.ts          # Active application tracking
│   │   ├── file-observer.ts         # File change tracking
│   │   ├── git-observer.ts          # Git activity tracking
│   │   ├── terminal-observer.ts     # Shell history (opt-in)
│   │   ├── browser-observer.ts      # Browser tabs (opt-in)
│   │   ├── pattern-detector.ts      # Work pattern analysis
│   │   ├── privacy-filter.ts        # Secret/app/path exclusions
│   │   └── config.ts                # Observation privacy config
│   │
│   ├── broker/                      # Session Broker (ported)
│   │   ├── index.ts
│   │   ├── server.ts
│   │   ├── config.ts
│   │   ├── lifecycle.ts
│   │   ├── heartbeat-poller.ts
│   │   ├── event-dispatcher.ts
│   │   ├── sse-manager.ts
│   │   ├── shutdown.ts
│   │   ├── startup-cleanup.ts
│   │   ├── orchestration.ts
│   │   ├── team-templates.ts
│   │   ├── tool-profiles.ts
│   │   ├── tool-risk.ts
│   │   ├── tools/
│   │   ├── services/
│   │   ├── storage/
│   │   ├── manifest/
│   │   ├── routes/
│   │   ├── middleware/
│   │   └── a2a/                 # A2A protocol integration (inside broker)
│   │       ├── agent-card.ts    # Agent Card generation + serving
│   │       ├── task-lifecycle.ts # A2A task state machine
│   │       ├── json-rpc.ts      # JSON-RPC 2.0 message format
│   │       └── types.ts         # A2A type definitions
│   │
│   ├── rate-limit/                  # Rate Limit Management
│   │   ├── detector.ts              # Detect rate limit proximity
│   │   ├── backoff.ts               # Exponential backoff + queue
│   │   └── user-yield.ts            # Yield to interactive sessions
│   │
│   ├── context/                     # Context Health
│   │   ├── monitor.ts
│   │   ├── rotation.ts
│   │   └── handoff.ts
│   │
│   ├── autonomy/                    # Progressive Autonomy
│   │   ├── levels.ts                # Trust level definitions
│   │   ├── guardrails.ts            # Action permission checks
│   │   └── promotion.ts             # Promote/demote logic
│   │
│   └── shared/
│       ├── types.ts
│       ├── errors.ts
│       ├── logger.ts
│       ├── sanitize.ts
│       └── config.ts
│
├── skills/                          # Claude Code skills
│   └── scns-review/
│       └── SKILL.md                 # /scns review skill definition
│
├── dashboard/                       # Monitoring UI (Next.js 15)
│   ├── package.json
│   ├── app/
│   ├── components/
│   └── lib/
│
├── scripts/
│   ├── install.sh
│   ├── uninstall.sh
│   └── migrate.sh
│
└── test/
    ├── helpers/                     # Test utilities, factories, fixtures
    ├── unit/
    │   ├── memory/
    │   ├── dream/
    │   ├── observe/
    │   ├── brain/
    │   ├── broker/
    │   ├── rate-limit/
    │   ├── context/
    │   └── autonomy/
    ├── integration/
    │   ├── memory/
    │   ├── broker/
    │   ├── brain/
    │   ├── observe/
    │   └── full-cycle/
    ├── e2e/
    │   ├── brain-wake.test.ts
    │   ├── team-task.test.ts
    │   ├── session-rotation.test.ts
    │   └── suggestion-review.test.ts
    └── stress/
        ├── concurrent-sessions.test.ts
        ├── message-flood.test.ts
        ├── large-vault.test.ts
        └── rotation-storm.test.ts
```

---

## Tech Stack

| Layer         | Technology                       | Why                                           |
| ------------- | -------------------------------- | --------------------------------------------- |
| Runtime       | Node.js 20+                      | Session broker already Node, consistent stack |
| Language      | TypeScript 5.7+ (ESM, strict)    | Type safety, user preference                  |
| HTTP Server   | Express 5                        | Proven, session broker already uses it        |
| MCP           | @modelcontextprotocol/sdk        | Standard agent-tool protocol                  |
| A2A Protocol  | JSON-RPC 2.0 + SSE + Agent Cards | Broker's wire format for agent communication  |
| Database      | SQLite via better-sqlite3        | Zero-config, WAL mode                         |
| Vector Search | sqlite-vec                       | No separate process                           |
| Full-Text     | SQLite FTS5                      | Built into SQLite                             |
| Embeddings    | FastEmbed (BGE-small-en-v1.5)    | 384-dim, local ONNX                           |
| Validation    | Zod                              | Runtime schema validation                     |
| Logging       | Pino                             | Fast structured logging                       |
| Testing       | Vitest                           | Fast, ESM-native                              |
| CLI           | Commander.js                     | Standard Node CLI framework                   |
| Dashboard     | Next.js 15 + Radix + Tailwind    | From everything-copilot                       |
| Process Mgmt  | tmux / child_process             | Agent isolation                               |
| Observers     | osascript, fswatch, git CLI      | macOS native                                  |
| Agent Runtime | Claude Code CLI                  | Spawned as child processes                    |

---

## Cost Model (Claude Code Max Plan — Rate-Limited, Not Per-Token)

SCNS runs entirely on your Claude Code Max subscription. No API keys, no OAuth, no per-token billing. The constraint is **rate limits**, not dollars.

**Key principles**:

- All agent sessions are spawned via `claude` CLI (your Max plan account)
- SCNS must **detect rate limit proximity and back off** before hitting the wall
- **User's interactive sessions always take priority** over SCNS background work
- When rate-limited, SCNS queues work rather than dropping it

**Rate limit management**:

```typescript
interface RateLimitState {
  sessions_active: number; // Currently running claude processes
  max_concurrent_sessions: number; // Configurable cap (default: 3)
  user_session_active: boolean; // True if user is interactively using Claude
  rate_limited_until: string | null; // ISO timestamp if currently throttled
  queued_tasks: number; // Work waiting for capacity
}
```

**Backoff strategy**:

1. If user is actively using Claude → SCNS pauses all non-critical background work
2. If rate limit hit → exponential backoff (30s → 1m → 5m → 15m), queue work
3. If 3+ rate limit hits in 10 minutes → sleep until next wake cycle (30 min)
4. Brain Agent uses Opus sparingly; workers default to Sonnet; classification uses Haiku
5. Pre-gather data in TypeScript before any LLM call (second-brain pattern: 7.6x fewer tokens)
6. Brain Agent exits immediately on idle cycles — no token burn

**Monthly cost**: Fixed at your Max plan rate ($100 or $200/mo depending on tier). No overages possible — SCNS respects the ceiling.

---

## Security Model

1. **Sanitization**: Pattern detection + markdown escaping on external text
2. **Guardrails**: Deterministic pre-check + LLM evaluation
3. **API Key Isolation**: TypeScript handles auth, LLM never sees tokens
4. **Privacy Controls**: Configurable observation excludes, opt-in for sensitive sources
5. **Progressive Autonomy**: Actions gated by trust level
6. **Local Only**: Broker accepts localhost connections only

---

## Resolved Decisions

| Question            | Decision                                                                  | Rationale                                                                                                             |
| ------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Project name        | **SCNS** (Second Central Nervous System)                                  | Accurately describes what we're building                                                                              |
| Cost model          | **Claude Code Max plan** — rate-limited, not per-token                    | No API key/OAuth. Respect session limits, never go over. Yield to user.                                               |
| Dashboard timing    | **Phase 9 (last)**                                                        | CLI `scns status` is sufficient through core phases. Broker has health endpoints ready for when we build it.          |
| A2A protocol        | **Integrated into broker (Phase 7)**                                      | A2A is the wire format, not a separate layer. Broker speaks A2A natively (Agent Cards, JSON-RPC 2.0, task lifecycle). |
| Observation polling | **30s** app, **event-driven** files, **5m** git, **60s** terminal/browser | Balances signal quality vs noise. Event-driven where possible.                                                        |
| Startup             | **Manual** (`scns start`)                                                 | Optional `scns install` for launchd auto-start later, once system is trusted.                                         |

---

## Future Enhancements (Post-v1)

- **Cross-machine sync**: Sync memory vault across devices via git or cloud storage.
- **Mobile notifications**: Push suggestions/alerts to phone (via Slack, Pushover, etc.)
- **Multi-user**: Multiple users sharing a broker instance with isolated memory vaults.
- **Custom integrations**: Gmail, Calendar, Linear, Slack adapters (second-brain-starter pattern).
- **Voice mode**: Conversational interface via VoiceMode MCP for hands-free reviews.

---

## References

| Source               | Location                                                                                       | Key Concepts                                          |
| -------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Second Brain Starter | `references/second-brain/`                                                                     | File vault, hybrid search, heartbeat, integrations    |
| CLAURST Specs        | `references/claurst-specs/`                                                                    | AutoDream, context collapse, coordinator mode, memdir |
| Session Broker       | `references/session-broker/`                                                                   | Session lifecycle, teams, auto-scale, respawn, 3-gate |
| Dashboard            | `references/dashboard/`                                                                        | Next.js monitoring UI                                 |
| Google/MIT Study     | [arXiv 2512.08296](https://arxiv.org/abs/2512.08296)                                           | +81% parallel / -70% sequential                       |
| A2A Protocol         | [github.com/a2aproject/A2A](https://github.com/a2aproject/A2A)                                 | Agent Cards, JSON-RPC 2.0, task lifecycle             |
| Anthropic Research   | [anthropic.com/engineering](https://www.anthropic.com/engineering/multi-agent-research-system) | Dynamic spawning, artifact bypass                     |
