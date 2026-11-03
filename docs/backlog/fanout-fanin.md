# Backlog — Hierarchical fan-out / fan-in for big tasks (`manager → (manager, dev, qa) × N → fan in`)

**Status:** DEFERRED (2026-07-08). Do NOT start until the self-innovating / self-learning engine is far enough
that the *"decide to decompose"* judgment can be a **learned policy**, not a hardcoded heuristic (see §Sequencing).
**Effort:** medium-to-heavy, dedicated fresh session(s) + a multi-phase `plan.md`. The expensive parts are fan-in
aggregation and an honest live proof of a real recursive agent tree.

---

## The goal (John's model)
Every task already spins up `manager → dev, qa` (one flat team). When a task is **really big**, the manager should
**fan out** into N child teams — `manager → (manager → dev, qa) × N` — do the sub-work in parallel, then **fan in**
(roll the child results back up to the parent, which then completes). Governed by a concurrency cap; child teams
reaped on completion.

## ⚠️ Read this first (harness rule — the `__fleet__` precedent)
Before building ANYTHING, do **codebase-prior-art-first** (`.github/instructions/00-fix-first.instructions.md` §4):
map the existing paths below and REUSE them. A prior effort built a redundant `__fleet__` flat-worker lane to
"add scale-up" when the capability already existed — it had to be deleted. **The hierarchy substrate already
exists; wire it, don't rebuild it.** Validate this doc's premise against the code before coding.

## Capability map — what ALREADY EXISTS (reuse, cite verified 2026-07-08)
**Hierarchy data model (present, but NOTHING creates sub-teams at runtime — `createTeam` is only ever called with
`parentTeamId=undefined`):**
- `schema.sql:107` — `teams.parent_team_id TEXT REFERENCES teams(id) ON DELETE CASCADE`.
- `src/broker/services/team-orchestration.ts:40` — `createTeam(db, name, description, parentTeamId?, projectId?)`
  **already validates the parent exists** (`:47-59`) and sets `parent_team_id`. ← the fan-out creation primitive.
- `src/broker/storage/repositories/team-repository.ts:23` `createTeam` (accepts `input.parent_team_id`),
  `:351` `getSubTeams(parentTeamId)`, `:316/:347` `sub_teams` counts (total/active) — the hierarchy readers for fan-in.
- NOTE: "fan-out" in the code today = **neuron worktrees (Task 34)** = per-team isolated git worktree, a DIFFERENT
  concept (parallel isolation, not hierarchy). Don't conflate.

**Flat dispatch to NEST (the one-level version of the target):**
- `src/broker/services/team-task-autospawner.ts:81` `createTeamTaskAutospawner` — pending task on a team with no
  active manager → atomically claims it + spawns a `scns-manager` (the task→manager step).
- `src/broker/services/agent-spawner.ts:851` `runAutoDispatch` — a spawned `scns-manager` with a `task` auto-spawns
  one `scns-dev` + one `scns-qa` on the SAME team (`SpawnInput.task` documented ~`:119-145`; invoked `:1741`). This
  is the flat `manager→dev,qa`. Fan-out = let a manager instead create child TEAMS (via `createTeam(parent=self)`
  + child tasks) and recurse.

**Governance (reuse — do NOT rebuild a second cap/reaper):**
- Hard cap: `src/broker/services/agent-spawner.ts` — `AgentCapExceededError` when
  `activeAgents.size >= maxConcurrentAgents`; `resolveMaxConcurrentAgents` (`:468`, env `SCNS_MAX_CONCURRENT_AGENTS`,
  live broker = 12). Bounds total agents across the whole sub-tree.
- Reaper: `src/broker/services/team-reaper.ts:79` `createTeamReaper` reaps idle/empty active teams (5-min grace;
  `exemptNames` `:39`). Candidate for fan-in cleanup (reap completed child teams).

**Persisted task queue (the work unit):**
- `schema.sql` `tasks` (status `pending|in_progress|completed|failed`, `owner`, `team_id`).
- `src/broker/storage/repositories/task-repository.ts`: `createTask:11`, `findTasksByTeam:47`, `updateTask:72`,
  `countPendingTasksByTeam:165`.

**Agent coordination (what a spawned agent can actually call):**
- Spawned ACP agents get the **BROKER MCP toolset** (wired `src/broker/startup.ts:285` `agentMcpServers`), NOT the
  `scns_*` extension tools. Available: `register-tools.ts` `send_message:166`, `get_messages:198`,
  `list_sessions:315`, `create_team:238`, `join_team:256`, `register_role:280`. There is **no `update_task` MCP
  tool** — task status is changed via REST `PATCH /api/tasks/:id` (completion is gated). A manager fanning out will
  likely need a new MCP tool (e.g. `spawn_subteam` / `create_subtask`) — build it on `createTeam(parent)` + `createTask`.

## What is genuinely NEW (the build)
1. **Fan-out decision** — "is this task big enough to decompose, and into what sub-tasks?" Keep this a THIN seam so
   the learning engine can own it later (see Sequencing). Start with an explicit manager-invoked MCP tool
   (`spawn_subteam`), not an auto-heuristic.
2. **Sub-team creation wiring** — compose `createTeam(db, …, parentTeamId=self)` + child `createTask` + let the
   existing autospawner/`runAutoDispatch` staff each child. Recursion depth guard.
3. **Fan-IN aggregation** — NEW: detect when all `getSubTeams(parent)` reach a terminal state, roll their
   results/verdicts up to the parent task, then let the parent proceed/complete. Build on the existing
   `quality_gate_verdict` subscriber + team-lifecycle completion signals; do not invent a parallel completion bus.
4. **Sub-tree governance** — bound fan-out by the EXISTING cap (don't add a second one); make the reaper sub-tree-aware
   for fan-in cleanup; honor the rate monitor.
5. **Live proof** (the expensive, honest part) — a REAL recursive tree (parent manager → ≥2 child teams → real dev/qa),
   proven with pos/neg controls: a big task decomposes, children run + coordinate + complete, results fan in, parent
   completes, tree reaps. Bound hard (small N, small depth, real spend).

## Sequencing — WHY this waits for the learning engine
The fan-out DECISION ("this task warrants sub-teams") is exactly the orchestration judgment the self-learning
engine should LEARN. Building it now as a fixed heuristic invites rework once learning can drive it. Build the
substrate mechanically, but leave the decision as a thin, replaceable seam the learning loop can take over. That is
why John deferred this until self-learning is further along.

## Guards / working agreement (non-negotiable — same as this repo's discipline)
- **Isolated dev broker for real-agent proofs:** run under the REAL `HOME` (so Copilot ACP agents authenticate —
  auth is keychain/HOME-bound) with an isolated **`SCNS_HOME`** (`src/shared/scns-home.ts` `resolveScnsHome()`,
  added 2026-07-08) + temp `BROKER_DB_PATH` + a temp port (e.g. 3457). This keeps the live `~/.scns` vault safe.
  A temp-`HOME`-only broker CANNOT authenticate ACP workers (`-32000 Authentication required`).
- Live `:3456` broker, live vault (`~/.scns/memory/vault.db`), live `experience.db` are **READ-ONLY** — assert
  mtime/size unchanged around any run. Kill-by-PID only. **No push.** Prod cutover → `docs/evidence/AWAITING-JOHN.md`.
- Evidence-first: quote the real row; pos AND neg controls; a measured NULL honestly reported is a success.

## Kickstart handoff prompt (paste into the fresh session)
> Implement hierarchical fan-out / fan-in for big tasks in the SCNS broker, per
> `docs/backlog/fanout-fanin.md` (read it FIRST — it has the verified codebase capability map with file:line).
> Goal: a manager working a big task decomposes it into N child teams (`manager → (manager→dev,qa) × N`) using the
> EXISTING hierarchy substrate (`team-orchestration.ts:40` `createTeam(parentTeamId)`, `schema.sql:107`
> `parent_team_id`, `team-repository.ts:351` `getSubTeams`), runs them in parallel, then FANS IN (rolls child
> results up to the parent, which completes). REUSE the existing hard cap (`AgentCapExceededError` /
> `SCNS_MAX_CONCURRENT_AGENTS`) and `team-reaper` — do NOT build a second cap/reaper (the deleted `__fleet__` lane
> is the precedent for that mistake; codebase-prior-art-first per `.github/instructions/00-fix-first.instructions.md`
> §4). The genuinely-new work is: (1) a thin, replaceable fan-out DECISION seam (start as a manager-invoked
> `spawn_subteam` MCP tool built on `createTeam(parent)` + `createTask`, NOT an auto-heuristic — the learning engine
> will own this decision later), (2) sub-team creation wiring, (3) fan-IN aggregation on top of the existing
> `quality_gate_verdict` + team-lifecycle completion signals, (4) sub-tree-aware governance, (5) a bounded LIVE
> proof of a real recursive agent tree with pos/neg controls. Write a multi-phase `plan.md` first. Guards: isolated
> dev broker (real `HOME` + isolated `SCNS_HOME` via `resolveScnsHome()` + temp DB + port 3457) so real ACP workers
> authenticate while the live vault stays untouched; live `:3456`/vault/`experience.db` read-only (assert mtime);
> kill-by-PID; no push; prod cutover to AWAITING-JOHN. Prerequisite check: confirm the self-learning engine is ready
> to (eventually) own the fan-out decision before wiring it to a fixed heuristic.
