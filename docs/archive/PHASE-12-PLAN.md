# Phase 12: Fix the Tools That Fix Everything Else

## Problem Statement

Phase 11 achieved 12/18 fixes but exposed a deeper issue: **we keep building components that never get wired**. The team orchestrator, task scheduler, and quality gate all exist as code but none execute in production. Without these tools working, every remediation session is a single agent doing everything manually — which is why plans fall apart in long sessions.

**Root cause**: The meta-tools (coordination, scheduling, quality checking) are the ones that are broken. Fix those first, and future work becomes parallelizable, self-checking, and recoverable across sessions.

## Execution Model

Each phase is designed for **one session pair**:
1. **Implementation session** — TDD, write code, run automated tests
2. **QA session** — `/quality-gate`, manual verification, fresh-eyes review

If QA finds issues → new implementation session with specific fixes → QA again.

**No phase is "done" until QA passes.** Progress is tracked in this document.

---

## Current System State (as of 2026-04-16)

| Component | Code Exists | Actually Wired | Actually Running |
|-----------|:-----------:|:--------------:|:----------------:|
| Broker (Express+MCP) | ✅ | ✅ | ✅ port 3456 |
| Agent Spawner (tmux/detached/acp) | ✅ | ✅ | ✅ |
| Team Orchestrator (A2A) | ✅ | ❌ | ❌ |
| Auto-Scaler | ✅ | ❌ | ❌ |
| Respawn Controller | ✅ | ❌ | ❌ |
| Task Scheduler | ✅ | ✅ | ✅ (3 handlers wired) |
| Health Watchdog | ✅ | ✅ | ✅ |
| Brain Agent Loop | ✅ | ✅ | ✅ (observe only) |
| Dream Daemon | ✅ | ✅ | ❌ (uninitialized) |
| Suggestion Pipeline | ✅ | ✅ | ❌ (no observations) |
| Blue/Green Restart | ✅ | ✅ | ⚠️ (no rollback) |
| Quality Gate Skill | ❌ | ❌ | ❌ |
| Session Handoff | ❌ | ❌ | ❌ |
| Autonomy (L0-L3) | ✅ | ✅ | ✅ (L1) |
| Negative Memories | ✅ | ✅ | ✅ |
| Cross-Source Correlator | ✅ | ✅ | ✅ |

**Key numbers**: 13 scheduled tasks seeded, 0 ever run. 0 teams created. Brain stuck on "observe" (1-2 observations, needs 5). Dream state table uninitialized.

---

## Phase 1: Wire the Task Scheduler + Sleep Catch-up

**Why first**: Every timed operation (dream, cleanup, reindex, health checks) depends on this. It's small, focused, and unblocks everything.

### What to Build

1. **Wire `createTaskScheduler()` into `startup.ts`**
   - Create scheduler instance with `db` and `handlers` map
   - Register handlers for each seeded task that has existing logic:
     - `dream-consolidation` → calls `dreamDaemon.run()`
     - `zombie-cleanup` → calls heartbeat poller's cleanup
     - `memory-reindex` → calls vault reindex
     - `otel-cleanup` → calls housekeeping OTel prune
   - Call `scheduler.start()` after listen
   - Register `scheduler.stop()` in shutdown handlers

2. **Add sleep catch-up logic to task-scheduler.ts**
   - Track `lastTickTime` on each tick
   - On tick: if `now - lastTickTime > 2 * intervalMs`, we likely slept
   - On catch-up: for each enabled task, check if `last_run_at` + expected interval < now
   - Run missed tasks (oldest first, cap at 3 catch-up runs per tick)
   - Log catch-up runs distinctly from normal runs

3. **Initialize dream_state on startup**
   - Call `initDreamState(db)` in startup.ts if table is empty
   - This unblocks the dream gate from returning 'uninitialized'

### Files to Modify

- `src/broker/startup.ts` — scheduler creation, dream state init
- `src/broker/services/task-scheduler.ts` — sleep catch-up logic
- `src/cli.ts` — pass handler functions to startup config

### Automated Tests (TDD)

- `test/unit/broker/services/task-scheduler.test.ts`:
  - Test: sleep catch-up detects time gap > 2x interval
  - Test: catch-up runs missed tasks, caps at 3
  - Test: normal tick doesn't trigger catch-up
  - Test: catch-up logs include `catchUp: true` marker
- `test/unit/broker/startup.test.ts`:
  - Test: scheduler created and started after listen
  - Test: scheduler stopped during shutdown
  - Test: dream_state initialized if empty

### Manual Test Scenarios

```bash
# === SETUP ===
npm run build
# Restart broker
launchctl bootout gui/$(id -u)/com.scns.broker 2>/dev/null; sleep 2
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.scns.broker.plist
sleep 5

# === TEST 1: Scheduler is running ===
# Verify scheduler logs appear (search for "Task scheduler starting")
grep "task-scheduler" ~/.scns/logs/broker.log | tail -5
# EXPECT: "Task scheduler starting" with intervalMs

# === TEST 2: Tasks actually execute ===
# Wait 2 minutes for cron tasks to fire, then check
sleep 120
sqlite3 ~/.session-broker/data.db "SELECT id, run_count, last_status, last_run_at FROM scheduled_tasks WHERE run_count > 0;"
# EXPECT: At least heartbeat-poller and rotation-watchdog have run_count > 0

# === TEST 3: Task run history recorded ===
sqlite3 ~/.session-broker/data.db "SELECT task_id, status, started_at, duration_ms FROM task_run_history ORDER BY started_at DESC LIMIT 10;"
# EXPECT: Rows with 'success' status and reasonable duration

# === TEST 4: Dream state initialized ===
sqlite3 ~/.session-broker/data.db "SELECT * FROM dream_state;"
# EXPECT: Row with id=1, sessions_since_last_run >= 0, lock_holder IS NULL

# === TEST 5: Health endpoint shows scheduler ===
curl -s http://localhost:3456/api/admin/health | python3 -m json.tool
# EXPECT: status=ok, hasDreamDaemon=true

# === TEST 6: Force-trigger dream to verify handler works ===
curl -s -X POST http://localhost:3456/api/dream/run?force=true | python3 -m json.tool
# EXPECT: success=true (may skip due to gates, but should not error)
```

### Acceptance Criteria

- [ ] `createTaskScheduler()` called in startup with real handlers
- [ ] At least 4 handlers registered (dream, zombie, reindex, otel-cleanup)
- [ ] Sleep catch-up detects gaps > 2x interval and runs missed tasks
- [ ] `dream_state` table initialized on startup
- [x] All automated tests pass (`npm test`) — 3930 unit+integration, 75 E2E
- [x] Manual tests 1-6 all pass on live broker
- [x] No regressions in existing E2E tests

### Status: ✅ Complete (d44f3a3)

---

## Phase 2: Wire Team Orchestrator + A2A Routes

**Why second**: This is the force multiplier. Once teams work, future phases can be parallelized across agents. The code is 100% written — it just needs wiring.

### What to Build

1. **Instantiate TeamOrchestrator in startup.ts**
   - Import `createTeamOrchestrator` from `src/broker/a2a/index.ts`
   - Create instance with `db`, `agentSpawner`, broker config
   - Pass to `createBrokerServer()` as a dep

2. **Add A2A JSON-RPC route**
   - `POST /api/a2a` — accepts JSON-RPC 2.0 messages, dispatches to `orchestrator.handleJsonRpc()`
   - This exposes: `tasks/submit`, `tasks/assign`, `tasks/update`, `agents/register`, `teams/create`, `teams/advance`, `teams/status`

3. **Wire auto-scaler tick into scheduler**
   - Register `auto-scale-tick` as a scheduled task (every 60s)
   - Handler calls `orchestrator.scalerTick()`

4. **Wire respawn into heartbeat poller**
   - When heartbeat poller detects a dead agent, call `orchestrator.respawnDeadAgent()`
   - Currently heartbeat poller just marks sessions as zombie — need to also trigger respawn

5. **Add team REST endpoints** (convenience wrappers around JSON-RPC)
   - `POST /api/teams` — create team
   - `GET /api/teams` — list teams (already exists, verify it reads from orchestrator)
   - `GET /api/teams/:id` — team status
   - `POST /api/teams/:id/tasks` — submit task to team
   - `GET /api/teams/:id/tasks` — list team tasks

### Files to Modify

- `src/broker/startup.ts` — orchestrator creation
- `src/broker/server.ts` — accept orchestrator dep
- `src/broker/routes/index.ts` — A2A route + team REST routes
- `src/broker/startup.ts` — wire auto-scaler to scheduler, respawn to heartbeat

### Automated Tests (TDD)

- `test/integration/broker/a2a-wiring.test.ts` (NEW):
  - Test: create team via POST /api/teams → 201 with team ID
  - Test: submit task via POST /api/teams/:id/tasks → task created
  - Test: JSON-RPC dispatch via POST /api/a2a → correct response
  - Test: list teams includes created team
  - Test: team status shows members and task count
- `test/e2e/team-coordination.test.ts` (NEW):
  - Test: create team → spawn agent → submit task → agent picks up task → task completes
  - Test: dead agent detected → respawn triggered → new agent joins team
  - Test: auto-scaler adds agent when queue depth > threshold

### Manual Test Scenarios

```bash
# === SETUP ===
npm run build
# Restart broker fresh
launchctl bootout gui/$(id -u)/com.scns.broker 2>/dev/null; sleep 2
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.scns.broker.plist
sleep 5

# === TEST 1: Create a team ===
TEAM_RESP=$(curl -s -X POST http://localhost:3456/api/teams \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-alpha","description":"Test team for coordination"}')
echo "$TEAM_RESP" | python3 -m json.tool
TEAM_ID=$(echo "$TEAM_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
# EXPECT: 201 with team id

# === TEST 2: Verify team shows in list ===
curl -s http://localhost:3456/api/teams | python3 -m json.tool
# EXPECT: teams array contains test-alpha

# === TEST 3: Submit a task to the team ===
TASK_RESP=$(curl -s -X POST "http://localhost:3456/api/teams/${TEAM_ID}/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"subject":"Test task","description":"Verify team coordination works"}')
echo "$TASK_RESP" | python3 -m json.tool
# EXPECT: task created with pending status

# === TEST 4: JSON-RPC dispatch works ===
curl -s -X POST http://localhost:3456/api/a2a \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"teams/status","params":{"teamId":"'$TEAM_ID'"},"id":1}' \
  | python3 -m json.tool
# EXPECT: JSON-RPC response with team status

# === TEST 5: Spawn an agent into the team ===
curl -s -X POST http://localhost:3456/api/spawn \
  -H 'Content-Type: application/json' \
  -d '{"teamId":"'$TEAM_ID'","name":"worker-1","role":"dev","prompt":"You are a test worker","launchMethod":"detached"}' \
  | python3 -m json.tool
# EXPECT: agent spawned, appears in team members

# === TEST 6: Verify team has the agent ===
curl -s "http://localhost:3456/api/teams/${TEAM_ID}" | python3 -m json.tool
# EXPECT: members array contains worker-1

# === TEST 7: Full round-trip — real task ===
# Create a team, spawn a copilot agent (ACP), give it a simple task
# This is the REAL test — can the broker coordinate an actual agent?
curl -s -X POST http://localhost:3456/api/a2a \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tasks/submit","params":{"teamId":"'$TEAM_ID'","subject":"List files in /tmp","description":"Run ls /tmp and report results"},"id":2}' \
  | python3 -m json.tool
# EXPECT: task submitted, eventually picked up by agent

# === CLEANUP ===
# Delete test team (or let it expire)
```

### Acceptance Criteria

- [ ] TeamOrchestrator instantiated in startup.ts
- [ ] POST /api/a2a dispatches JSON-RPC to orchestrator
- [ ] REST team endpoints (create, list, status, submit task) all work
- [ ] Auto-scaler tick registered in task scheduler
- [ ] Dead agent triggers respawn via orchestrator
- [ ] Can create team → spawn agent → submit task → see it picked up (manual)
- [ ] All automated tests pass
- [ ] No regressions

### Status: ✅ Complete (5254629)

---

## Phase 3: Dream Initialization + Brain Activation

**Why third**: With scheduler running (Phase 1), dream can fire on schedule. With teams working (Phase 2), brain can spawn agents. This phase makes the "second brain" actually think.

### What to Build

1. **Fix brain observation threshold**
   - Brain needs 5 observations to do anything other than "observe"
   - Hook events should count as observations
   - Verify session-hooks observer is feeding ObservationManager
   - If observation count is truly low, lower threshold or add synthetic startup observations

2. **Verify dream consolidation end-to-end**
   - Force-run dream, verify it processes daily logs
   - Verify MEMORY.md gets written/updated
   - Verify negative memories applied to copilot-instructions.md
   - Verify weekly/monthly tiered consolidation logic

3. **Wire `incrementSessionCount` for dream gates**
   - Session-end hooks should call `dreamDaemon.notifySessionCompleted()`
   - Verify the count gate (minSessionsSinceLastRun: 5) increments properly
   - Without this, dream's count gate always blocks

4. **Verify brain decision tree completeness**
   - At L1: brain should Suggest (not just Observe)
   - At L2: brain should execute approved suggestions
   - Test each decision path with real broker state

### Files to Modify

- `src/cli.ts` — observation wiring, dream session count
- `src/brain/decision-tree.ts` — threshold tuning if needed
- `src/observe/observation-manager.ts` — verify hook → observation pipeline

### Automated Tests (TDD)

- `test/integration/dream/end-to-end.test.ts` (NEW or extend existing):
  - Test: force-run dream → MEMORY.md written
  - Test: session count increments on hook session-end
  - Test: dream gates pass after 5 sessions + 24h
- `test/unit/brain/decision-tree.test.ts` (extend):
  - Test: with 5+ observations at L1 → action is Suggest, not Observe
  - Test: with approved suggestions at L2 → action is ApprovedSuggestions

### Manual Test Scenarios

```bash
# === SETUP ===
npm run build && launchctl bootout gui/$(id -u)/com.scns.broker 2>/dev/null
sleep 2 && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.scns.broker.plist
sleep 5

# === TEST 1: Dream force-run produces output ===
DREAM=$(curl -s -X POST "http://localhost:3456/api/dream/run?force=true")
echo "$DREAM" | python3 -m json.tool
# EXPECT: success=true, skipped=false, OR clear gate failure reason

# === TEST 2: Session count increments ===
# Simulate session-end hook
curl -s -X POST http://localhost:3456/api/hooks/session-end \
  -H 'Content-Type: application/json' \
  -d '{"event":"session-end","sessionId":"test-dream-1","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'
# Check dream_state
sqlite3 ~/.session-broker/data.db "SELECT sessions_since_last_run FROM dream_state;"
# EXPECT: sessions_since_last_run incremented

# === TEST 3: Brain makes non-observe decisions ===
# Check recent brain decisions in logs
grep "Brain wake cycle decision" ~/.scns/logs/broker.log | tail -10 | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line)
        print(f'action={d.get(\"action\")} reason={d.get(\"reason\",\"\")[:60]} obs={d.get(\"observations\",0)}')
    except: pass
"
# EXPECT: After enough observations, action should be 'suggest' or 'consolidate', not always 'observe'

# === TEST 4: MEMORY.md exists and has content ===
ls -la ~/.scns/memory/MEMORY.md 2>/dev/null && wc -l ~/.scns/memory/MEMORY.md
# EXPECT: File exists with consolidated entries (after dream runs)

# === TEST 5: Observations are being collected ===
curl -s http://localhost:3456/api/observers | python3 -m json.tool
# EXPECT: observers listed with observation counts > 0
```

### Acceptance Criteria

- [ ] Dream daemon runs successfully when force-triggered
- [ ] Session-end hooks increment dream session count
- [ ] Brain makes Suggest/Consolidate decisions (not stuck on Observe)
- [ ] MEMORY.md written with real consolidated content
- [ ] Observations pipeline delivers hook events to brain
- [ ] All automated tests pass
- [ ] Manual tests 1-5 pass on live broker

### Status: ✅ Complete (8096c62) — QA passed 100%, all hard gates clear

---

## Phase 4: Quality Gate + Session Handoff

**Why fourth**: With coordination working (Phase 2) and brain thinking (Phase 3), we need the ability to check quality and cycle sessions. This is what prevents "long session degradation."

### What to Build

1. **Quality gate mechanism** (broker-side)
   - `POST /api/quality-check` — accepts session output, returns pass/fail with findings
   - Uses rubric-based evaluation (configurable per task type)
   - Stores results in `quality_checks` table
   - Brain can trigger quality checks at L2+

2. **Session handoff protocol**
   - `POST /api/sessions/:id/handoff` — creates handoff document with:
     - Current progress summary
     - Files modified
     - Tests passing/failing
     - Remaining work
     - Context for the next session
   - Stores in `session_handoffs` table
   - Next session can `GET /api/sessions/:id/handoff` to resume

3. **Blue/green session rotation**
   - When quality check fails, brain can:
     - Create handoff document for current session
     - Spawn fresh agent with handoff context
     - Mark old session as "rotated-out"
   - This is session-level blue/green, not broker-level

### Files to Create

- `src/broker/services/quality-checker.ts` — quality evaluation logic
- `src/broker/services/session-handoff.ts` — handoff document generation
- `src/broker/storage/repositories/quality-repository.ts` — DB operations
- Schema additions to `src/broker/storage/schema.sql`

### Files to Modify

- `src/broker/routes/index.ts` — quality + handoff endpoints
- `src/brain/decision-tree.ts` — quality check decision
- `src/brain/agent-loop.ts` — quality check + handoff execution

### Automated Tests (TDD)

- `test/unit/broker/services/quality-checker.test.ts` (NEW):
  - Test: passing output → pass result
  - Test: output with errors → fail result with findings
  - Test: result persisted to quality_checks table
- `test/unit/broker/services/session-handoff.test.ts` (NEW):
  - Test: handoff document includes progress, files, remaining work
  - Test: handoff retrievable by next session
- `test/integration/quality-handoff.test.ts` (NEW):
  - Test: quality fail → handoff created → new session spawned with context

### Manual Test Scenarios

```bash
# === TEST 1: Quality check endpoint works ===
curl -s -X POST http://localhost:3456/api/quality-check \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test-1","output":"All 50 tests pass. Build clean.","taskType":"implementation"}' \
  | python3 -m json.tool
# EXPECT: {passed: true, score: ..., findings: []}

# === TEST 2: Quality check catches issues ===
curl -s -X POST http://localhost:3456/api/quality-check \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test-2","output":"3 tests fail. TypeError in auth.ts. Did not run manual verification.","taskType":"implementation"}' \
  | python3 -m json.tool
# EXPECT: {passed: false, score: ..., findings: ["test failures", "no manual verification"]}

# === TEST 3: Session handoff creates document ===
# First register a session
curl -s -X POST http://localhost:3456/api/hooks/session-start \
  -H 'Content-Type: application/json' \
  -d '{"event":"session-start","sessionId":"handoff-test","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'
# Then create handoff
curl -s -X POST http://localhost:3456/api/sessions/handoff-test/handoff \
  -H 'Content-Type: application/json' \
  -d '{"progress":"Completed auth module","filesModified":["src/auth.ts"],"testsStatus":"48/50 pass","remainingWork":"Fix 2 failing tests","context":"Auth uses JWT with bcrypt"}' \
  | python3 -m json.tool
# EXPECT: handoff document created with ID

# === TEST 4: Handoff retrievable ===
curl -s http://localhost:3456/api/sessions/handoff-test/handoff | python3 -m json.tool
# EXPECT: handoff document with all fields populated

# === TEST 5: End-to-end quality-gated rotation ===
# This is the real test: trigger a quality check that fails,
# verify handoff is created, verify new session is spawned
# (Requires Phase 2 team coordination to be working)
```

### Acceptance Criteria

- [ ] Quality check endpoint evaluates output and returns pass/fail
- [ ] Failed quality checks include actionable findings
- [ ] Session handoff creates retrievable document
- [ ] Handoff includes progress, files, tests, remaining work, context
- [ ] Brain can trigger quality check at L2+
- [ ] Quality fail → automatic handoff + fresh session spawn (at L2+)
- [ ] All automated tests pass
- [ ] Manual tests 1-5 pass

### Status: ✅ Complete

---

## Phase 5: Blue/Green Restart Hardening

**Why fifth**: Now that session-level quality/handoff works (Phase 4), harden the broker-level restart to be truly zero-downtime.

### What to Build

1. **Restart script rollback**
   - If green broker fails health check, re-bootstrap blue from plist
   - Add `rollback()` function to broker-restart.sh
   - Add `/api/admin/rollback` endpoint for programmatic rollback

2. **Drain timeout fix**
   - Change `sleep 2` to poll-based drain wait (up to 30s)
   - Poll `/api/admin/health` for active request count = 0

3. **Memory store size limits**
   - Set `express.json({ limit: '64kb' })` explicitly
   - Add per-session rate limiting on write endpoints (10 req/min)

### Files to Modify

- `scripts/broker-restart.sh` — rollback function, drain polling
- `src/broker/server.ts` — explicit body size limit
- `src/broker/routes/admin-routes.ts` — rollback endpoint

### Manual Test Scenarios

```bash
# === TEST 1: Restart with rollback ===
# Start broker, verify healthy
curl -s http://localhost:3456/api/admin/health
# Simulate failed restart (corrupt the binary temporarily)
# Run restart script, verify it detects failure and rolls back
# Verify broker still healthy after rollback

# === TEST 2: Drain waits for requests ===
# Start a long-running request (if available)
# Trigger drain
# Verify drain waits, doesn't kill mid-request

# === TEST 3: Oversized payload rejected ===
# Generate 100KB payload
python3 -c "print('{\"key\":\"test\",\"value\":\"' + 'x'*100000 + '\"}')" > /tmp/big.json
curl -s -X POST http://localhost:3456/api/memory/store \
  -H 'Content-Type: application/json' \
  -d @/tmp/big.json
# EXPECT: 413 Payload Too Large
rm /tmp/big.json
```

### Acceptance Criteria

- [ ] Restart script rolls back to blue if green fails
- [ ] Drain polling waits for active requests
- [ ] Oversized payloads rejected with 413
- [ ] All automated tests pass
- [ ] Manual tests pass on live broker

### Status: ⬜ Not Started

---

## Phase 6: Remaining P2 Polish

**Why sixth**: These are real bugs that affect reliability but aren't blockers for the coordination system.

### What to Build

1. **Dashboard deps race condition** — populate deps BEFORE listen, or add readiness gate
2. **Session recovery REST endpoints** — expose snapshot list, manual retry, status
3. **Plugin autodiscovery** — detect dist/ vs src/, use correct paths
4. **Dashboard deps race** — move dep population before `listenWithRetry()`

### Manual Test Scenarios

```bash
# === TEST 1: Dashboard deps available immediately ===
# Restart broker, immediately hit dashboard endpoints
launchctl bootout gui/$(id -u)/com.scns.broker 2>/dev/null; sleep 1
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.scns.broker.plist
# Immediately query (within 1s of startup)
for i in 1 2 3 4 5; do
  sleep 1
  RESP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3456/api/suggestions?status=pending)
  echo "Attempt $i: HTTP $RESP"
done
# EXPECT: All attempts return 200, never 500 or empty

# === TEST 2: Recovery snapshots visible ===
curl -s http://localhost:3456/api/admin/recovery/snapshots | python3 -m json.tool
# EXPECT: array of snapshots (may be empty, but endpoint works)

# === TEST 3: Recovery status ===
curl -s http://localhost:3456/api/admin/recovery/status | python3 -m json.tool
# EXPECT: {total: N, recovered: N, failed: N, pending: N}
```

### Acceptance Criteria

- [ ] Dashboard endpoints work within 1s of broker startup
- [ ] Recovery snapshots listable via REST
- [ ] Plugin loading works from dist/ directory
- [ ] No regressions

### Status: ⬜ Not Started

---

## Phase 7: Full Integration Regression

**Why last**: Everything is wired. This phase verifies the whole system works together.

### Manual Test Scenarios — The Full Gauntlet

```bash
# === FULL SYSTEM TEST ===
# This is the definitive test: start clean, verify everything works together.

# 1. Clean restart
npm run build
launchctl bootout gui/$(id -u)/com.scns.broker 2>/dev/null; sleep 3
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.scns.broker.plist
sleep 10

# 2. Verify broker healthy
curl -s http://localhost:3456/api/admin/health | python3 -m json.tool
# EXPECT: status=ok, all subsystems reporting

# 3. Verify scheduler running tasks
sleep 120  # Wait for cron tasks to fire
sqlite3 ~/.session-broker/data.db "SELECT id, run_count FROM scheduled_tasks WHERE run_count > 0;"
# EXPECT: Multiple tasks have run

# 4. Create a team and coordinate work
TEAM=$(curl -s -X POST http://localhost:3456/api/teams \
  -H 'Content-Type: application/json' \
  -d '{"name":"integration-test","description":"Full system test"}')
TEAM_ID=$(echo "$TEAM" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# 5. Submit a real task
curl -s -X POST "http://localhost:3456/api/teams/${TEAM_ID}/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"subject":"Verify SCNS health","description":"Check all subsystems and report status"}'

# 6. Spawn an agent to handle it
curl -s -X POST http://localhost:3456/api/spawn \
  -H 'Content-Type: application/json' \
  -d '{"teamId":"'$TEAM_ID'","name":"health-checker","role":"qa","prompt":"Check broker health at localhost:3456 and report all subsystem statuses","launchMethod":"detached"}'

# 7. Verify dream can run
curl -s -X POST "http://localhost:3456/api/dream/run?force=true" | python3 -m json.tool
# EXPECT: Consolidation runs or clear gate failure

# 8. Verify brain is active
grep "Brain wake cycle decision" ~/.scns/logs/broker.log | tail -3 | \
  python3 -c "import sys,json; [print(json.loads(l).get('action','?')) for l in sys.stdin]"
# EXPECT: Actions beyond just "observe"

# 9. Verify quality check works
curl -s -X POST http://localhost:3456/api/quality-check \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"final-test","output":"All tests pass, manual verification complete","taskType":"qa"}'
# EXPECT: passed=true

# 10. Verify session handoff works
curl -s -X POST http://localhost:3456/api/sessions/final-test/handoff \
  -H 'Content-Type: application/json' \
  -d '{"progress":"Full integration test complete","remainingWork":"None","context":"All systems operational"}'
# EXPECT: Handoff document created

# 11. Run full automated suite
npm test
npm run test:e2e
# EXPECT: All pass, no regressions

# 12. Verify no error spam in logs
grep '"level":50' ~/.scns/logs/broker.log | tail -20
# EXPECT: No unexpected errors (level 50 = error)
```

### Acceptance Criteria

- [ ] All 12 manual tests pass
- [ ] Full automated test suite passes
- [ ] Broker runs stable for 10+ minutes under load
- [ ] Team coordination works end-to-end with real agent
- [ ] Dream consolidation produces real output
- [ ] Quality gate evaluates correctly
- [ ] Session handoff creates retrievable context
- [ ] No error spam in logs
- [ ] System deployable to fresh machine via git clone + npm install + npm run build

### Status: ✅ Complete

**QA summary (2026-04-17, broker pid 78003):**
- All 12 gauntlet steps passed live against launchd-managed broker on :3456
- All 3 Phase-12.6 regression checks re-verified (recovery endpoints, readiness gate, dist-mode plist)
- Unit: 4026/4026 passing (217 files) · E2E: 86/86 passing (11 files)
- Broker uptime: 712s stable, 0 `level:50` errors from current pid
- Bug fixed during gauntlet: `launchDetached` in `src/broker/services/agent-spawner.ts`
  replaced `createWriteStream`-based stdio (fd=null race under Node 22
  `child_process.spawn` validation → `ERR_INVALID_ARG_VALUE`) with
  `openSync`/`closeSync` numeric fd. +4 unit tests covering openSync failure,
  spawn failure with fd cleanup, numeric fd passed to stdio, and post-spawn
  closeSync failure being non-fatal.
- Quality gate: 100% score, all 8 hard gates PASS

**Plan-path drift noted for future plans** (gauntlet commands in lines 611-645
referenced endpoints that don't exist as written; correct paths used in QA):
- `POST /api/teams/:id/tasks` → `POST /api/tasks` with `{team_id, subject, description}`
- `POST /api/spawn` body: `teamId` → `team_id`
- `POST /api/dream/run?force=true` → `POST /api/dream/trigger?force=true`

---

## Progress Tracker

| Phase | Description | Impl Session | QA Session | Status |
|:-----:|-------------|:------------:|:----------:|:------:|
| 1 | Task Scheduler + Sleep Catch-up | d44f3a3 | ✅ | ✅ |
| 2 | Team Orchestrator + A2A Routes | 5254629 | ✅ | ✅ |
| 3 | Dream Init + Brain Activation | 8096c62 | ✅ | ✅ |
| 4 | Quality Gate + Session Handoff | bbe0db5 | ✅ | ✅ |
| 5 | Blue/Green Restart Hardening | ecdfb63 | ✅ | ✅ |
| 6 | P2 Polish (deps race, recovery, plugins) | c737119 | ✅ | ✅ |
| 7 | Full Integration Regression | (this commit) | 2026-04-17 | ✅ |

**Session tracking**: After each session, update the Impl/QA columns with the session ID or date. Mark status as:
- ⬜ Not Started
- 🔧 Implementation In Progress
- 🧪 QA In Progress
- 🔴 QA Failed (needs re-impl)
- ✅ Complete

---

## Dependencies

```
Phase 1 (Scheduler) ─────────────► Phase 3 (Dream/Brain)
                     ╲
Phase 2 (Teams/A2A) ──────────────► Phase 4 (Quality/Handoff) ──► Phase 7 (Regression)
                                            │
Phase 5 (Blue/Green) ──────────────────────►│
Phase 6 (P2 Polish) ───────────────────────►┘
```

- Phase 1 and 2 can run in parallel (no interdependency)
- Phase 3 depends on Phase 1 (scheduler must be running for dream)
- Phase 4 depends on Phase 2 (quality gate needs team coordination)
- Phase 5 and 6 are independent, can run any time after Phase 2
- Phase 7 depends on all others

---

## Issues Identified During QA

Issues discovered during QA sessions that need to be addressed somewhere in Phase 12. Each issue has a suggested phase, but the implementing session should decide final placement.

| # | Issue | Severity | Found In | Suggested Phase | Status |
|---|-------|----------|----------|-----------------|--------|
| 1 | **SIGTERM mutex crash**: `process.exit()` in cli.ts:657 races with better-sqlite3 native destructor → `mutex lock failed: Invalid argument` + `Abort trap: 6` on every graceful shutdown. Fix: replace `process.exit()` with natural event loop drain, or add WAL checkpoint + delay before exit. | High | 12.1 QA | Phase 5 (Blue/Green Restart Hardening) | ⬜ |
| 2 | **Double signal handlers**: Both `startup.ts` (`process.once`) and `cli.ts` (`process.on`) register SIGTERM/SIGINT handlers. Shutdown is idempotent so no crash, but the duplication is confusing and should be consolidated. | Low | 12.1 QA | Phase 5 | ⬜ |
| 3 | **Seeded tasks without handlers**: 8 enabled cron tasks seeded but only 3 have handlers. Unhandled tasks silently skip with no history record — hides wiring mistakes. Consider: seed only tasks with handlers, or log 'skipped' status. | Low | 12.1 QA | Phase 6 (P2 Polish) | ⬜ |
| 4 | **6-field cron catch-up cap**: 50K iteration cap = ~13.9 hours for 6-field (seconds-based) cron. Only affects heartbeat-poller which has no handler, but would be a problem if seconds-based tasks get handlers. | Low | 12.1 QA | Phase 6 | ⬜ |
