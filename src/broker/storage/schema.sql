-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  purpose TEXT,
  working_dir TEXT,
  worktree TEXT,
  repo_context TEXT,
  parent_session_id TEXT REFERENCES sessions(id),
  branch_point_message_id TEXT,
  status TEXT DEFAULT 'active',
  -- Multi-project foundation (P3): the project this session belongs to.
  -- NULL = legacy/unmigrated. Derived from deriveProjectId(cfg.projectRoot).
  project_id TEXT,
  last_heartbeat DATETIME DEFAULT (datetime('now')),
  created_at DATETIME DEFAULT (datetime('now')),
  archived_at DATETIME DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_repo_context ON sessions(repo_context);

-- Multi-project foundation (P3): durable map of project_id -> work-tree root.
-- One row per project the broker has managed; lets supervisor/admin tooling
-- explain ids and drives legacy-row migration reporting.
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  project_root TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  last_seen_at DATETIME DEFAULT (datetime('now'))
);

-- Messages (queue)
-- Issue #70 retention invariant: rows in this table are durable correspondence,
-- not execution state. Liveness expiry must never delete them; only explicit
-- settlement (session termination via session-retirement.ts, TTL GC, or
-- archival) may move them to messages_history. The sender/receiver FKs use
-- ON DELETE SET NULL, and findMessagesByReceiver treats a NULL receiver as
-- broadcast — so a receiver row must never be deleted while its directed mail
-- is live (that would leak private mail to every inbox).
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  receiver_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  story_id TEXT,
  reply_to TEXT REFERENCES messages(id) ON DELETE SET NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  seq INTEGER,
  to_role TEXT,
  to_team TEXT,
  -- Issue #70: stable client-supplied id for safe send retries. Unique per
  -- sender (partial index below); a replay with identical payload returns the
  -- original row, conflicting reuse is rejected.
  client_message_id TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  -- Delivery/acknowledgement ladder (issue #70): accepted (row exists) →
  -- delivered_at (reached the recipient's context) → read_at (explicit read)
  -- → disposition (explicit accepted/rejected/deferred verdict). A successful
  -- send implies none of the later stages.
  delivered_at DATETIME,
  read_at DATETIME,
  -- `IN (..., NULL)` would be a no-op CHECK (three-valued logic); the
  -- IS NULL OR form actually constrains.
  disposition TEXT CHECK (disposition IS NULL OR disposition IN ('accepted', 'rejected', 'deferred')),
  disposition_at DATETIME,
  disposition_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_story ON messages(story_id);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);
-- NOTE: idx_messages_client_id (partial unique on sender_id,
-- client_message_id) is created by the migration loop in db.ts, AFTER the
-- ALTER TABLE that adds client_message_id — same rule as
-- idx_tasks_dispatch_lookup: on an existing database the IF-NOT-EXISTS
-- table create above is skipped, so an index here would reference a column
-- that does not exist yet and abort the whole schema exec (this crash-looped
-- the live Cosmere child broker on 2026-09-17).

-- Message embeddings for semantic search
CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  content_text TEXT NOT NULL,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- File intent tracking (advisory)
CREATE TABLE IF NOT EXISTS file_intents (
  file_path TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  intent TEXT DEFAULT 'edit' CHECK (intent IN ('edit', 'read', 'create', 'delete')),
  declared_at DATETIME DEFAULT (datetime('now')),
  PRIMARY KEY (file_path, session_id)
);
CREATE INDEX IF NOT EXISTS idx_intents_session ON file_intents(session_id);

-- Shared state (key-value with JSON)
CREATE TABLE IF NOT EXISTS shared_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  story_id TEXT,
  session_id TEXT REFERENCES sessions(id),
  updated_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_state_story ON shared_state(story_id);

-- Event log (append-only, crash recovery)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  session_id TEXT,
  payload TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type, created_at);

-- Semantic embeddings for session search
CREATE TABLE IF NOT EXISTS session_embeddings (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  purpose_text TEXT NOT NULL,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL DEFAULT 'fastembed:fast-bge-small-en-v1.5',
  dimensions INTEGER NOT NULL DEFAULT 384,
  created_at DATETIME DEFAULT (datetime('now')),
  updated_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON session_embeddings(model);

-- Teams (Phase 1: Agent Teams)
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  parent_team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disbanded')),
  -- Multi-project foundation (P3): the project this team belongs to. NULL =
  -- legacy/unmigrated (excluded from autonomous project-scoped behaviour).
  -- Derived from the git work-tree root via deriveProjectId(cfg.projectRoot).
  project_id TEXT,
  -- Neuron fan-out (task 34): per-team isolated git working tree.
  -- NULL = legacy behaviour (use broker cwd). Non-null = neuron mode: every
  -- agent spawned for this team is forced into this directory, isolating
  -- staged diffs and quality_gate verdicts across concurrent neurons.
  working_dir TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  archived_at DATETIME DEFAULT NULL
);

-- Team members (links sessions to teams with roles)
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- P4 (de-hardcode roles): role is free-text so the system can self-innovate
  -- (mint novel agent roles at runtime). The former static CHECK allowlist was
  -- dropped; the agent_roles table below is a discoverability catalogue, not a
  -- gate. db.ts rebuilds legacy tables that still carry the old CHECK.
  role TEXT NOT NULL DEFAULT 'general',
  agent_type TEXT,
  status TEXT DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'shutdown')),
  joined_at DATETIME DEFAULT (datetime('now')),
  last_activity_at DATETIME DEFAULT NULL,
  PRIMARY KEY (team_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_session ON team_members(session_id);

-- Agent role registry (P4: de-hardcode roles). Discoverability catalogue for
-- agent roles — NOT a gate on team_members.role (which is free-text so the
-- system can self-innovate). Builtins are seeded by db.ts; `spawnable` marks
-- roles that have a bespoke task-spawn prompt strategy (scns-manager/dev/qa).
CREATE TABLE IF NOT EXISTS agent_roles (
  role TEXT PRIMARY KEY,
  description TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  spawnable INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now'))
);

-- Tasks (Kanban board for agent coordination)
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'deleted', 'failed')),
  owner TEXT,
  active_form TEXT,
  -- WS P (Phase 13.13.x): durable dispatch audit columns. The task row is the
  -- audit trail that survives messages + messages_history purging, so
  -- manager-exit-monitor can short-circuit no_readback false-positives.
  dispatch_id TEXT,
  dispatch_readback_at TEXT,
  dispatch_manager_session_id TEXT,
  dispatch_dev_session_id TEXT,
  dispatch_qa_session_id TEXT,
  -- WS R (Phase 13.13.x): gate-driven completion. quality_check_id is
  -- the verdict row that authorised the system-initiated transition;
  -- completed_at is the wall-clock ISO timestamp of that transition.
  -- Both NULL until the quality_gate_verdict subscriber transitions
  -- the task; populated only on the WS-R auto-completion path.
  quality_check_id TEXT,
  completed_at TEXT,
  -- P0.3 (2026-05-19): durable audit columns for auto-merge-driven completion.
  -- The auto-merger transitions the row when an `scns/auto/*` branch passes
  -- 7 structural safety gates and merges into main. merge_sha is the resulting
  -- merge commit SHA; completion_source is 'auto_merge' (set here) or
  -- 'quality_gate_verdict' (set by the WS-R verdict subscriber when the
  -- staged-diff path wins). Both NULL on legacy human-completed rows.
  merge_sha TEXT,
  completion_source TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  updated_at DATETIME DEFAULT (datetime('now'))
);
-- NOTE: idx_tasks_dispatch_lookup is created by the migration loop in db.ts
-- (after ALTER TABLE tasks ADD COLUMN dispatch_manager_session_id) so that
-- existing databases whose tasks table predates the WS-P columns can apply
-- the schema without referencing a column that the IF-NOT-EXISTS table
-- create skipped.
CREATE INDEX IF NOT EXISTS idx_tasks_team ON tasks(team_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner);

-- Task dependencies (blocks/blockedBy relationships)
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on)
);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(depends_on);

-- Agent capabilities (Stream 12: Smart Routing)
CREATE TABLE IF NOT EXISTS agent_capabilities (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, capability)
);
CREATE INDEX IF NOT EXISTS idx_capabilities_capability ON agent_capabilities(capability);

-- Respawn policies (Stream 10: Self-Healing)
CREATE TABLE IF NOT EXISTS respawn_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  min_count INTEGER NOT NULL DEFAULT 1,
  max_retries INTEGER NOT NULL DEFAULT 3,
  backoff_base_ms INTEGER NOT NULL DEFAULT 5000,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT (datetime('now')),
  updated_at DATETIME DEFAULT (datetime('now')),
  UNIQUE(team_id, role)
);
CREATE INDEX IF NOT EXISTS idx_respawn_policies_team ON respawn_policies(team_id);

-- Respawn history (Stream 10: Self-Healing)
CREATE TABLE IF NOT EXISTS respawn_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  original_session_id TEXT NOT NULL,
  new_session_id TEXT,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  agent_type TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'spawned', 'failed', 'abandoned')),
  error_message TEXT,
  created_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_respawn_history_team ON respawn_history(team_id);
CREATE INDEX IF NOT EXISTS idx_respawn_history_original ON respawn_history(original_session_id);

-- Auto-Scaling Policies (P1 Demo Feature)
CREATE TABLE IF NOT EXISTS scaling_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  min_count INTEGER NOT NULL DEFAULT 1,
  max_count INTEGER NOT NULL DEFAULT 5,
  scale_up_threshold INTEGER NOT NULL DEFAULT 3,
  scale_down_threshold INTEGER NOT NULL DEFAULT 0,
  cooldown_ms INTEGER NOT NULL DEFAULT 60000,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_scale_action_at DATETIME,
  UNIQUE(team_id, role)
);
CREATE INDEX IF NOT EXISTS idx_scaling_policies_team ON scaling_policies(team_id);

-- Usage Records (Token/Cost Tracking)
CREATE TABLE IF NOT EXISTS usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  team_id TEXT,
  task_id INTEGER,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  recorded_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_team ON usage_records(team_id);

-- Branch-level file intents (Git Conflict Detection)
CREATE TABLE IF NOT EXISTS branch_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  file_path TEXT NOT NULL,
  commit_sha TEXT,
  declared_at DATETIME DEFAULT (datetime('now')),
  UNIQUE(session_id, branch, file_path)
);
CREATE INDEX IF NOT EXISTS idx_branch_intents_branch ON branch_intents(branch);
CREATE INDEX IF NOT EXISTS idx_branch_intents_file ON branch_intents(file_path);

-- History Tables (Two-Tier Archival)

CREATE TABLE IF NOT EXISTS teams_history (
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT,
  created_at DATETIME,
  archived_at DATETIME,
  member_summary TEXT,
  task_summary TEXT,
  purged_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_teams_history_purged ON teams_history(purged_at);
CREATE INDEX IF NOT EXISTS idx_teams_history_name ON teams_history(name);

CREATE TABLE IF NOT EXISTS sessions_history (
  id TEXT NOT NULL,
  purpose TEXT,
  working_dir TEXT,
  worktree TEXT,
  status TEXT,
  last_heartbeat DATETIME,
  created_at DATETIME,
  archived_at DATETIME,
  team_name TEXT,
  purged_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_history_purged ON sessions_history(purged_at);

CREATE TABLE IF NOT EXISTS tasks_history (
  id INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  seq INTEGER,
  subject TEXT NOT NULL,
  description TEXT,
  status TEXT,
  owner TEXT,
  active_form TEXT,
  created_at DATETIME,
  updated_at DATETIME,
  team_name TEXT,
  purged_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_history_purged ON tasks_history(purged_at);
CREATE INDEX IF NOT EXISTS idx_tasks_history_team ON tasks_history(team_id);

CREATE TABLE IF NOT EXISTS messages_history (
  id TEXT NOT NULL,
  sender_id TEXT,
  receiver_id TEXT,
  content TEXT NOT NULL,
  story_id TEXT,
  reply_to TEXT,
  client_message_id TEXT,
  created_at DATETIME,
  -- Issue #70: settlement must not destroy the acknowledgement record — the
  -- delivery timestamp and the explicit accepted/rejected/deferred verdict
  -- (with its note) travel with the message into history.
  delivered_at DATETIME,
  read_at DATETIME,
  disposition TEXT,
  disposition_at DATETIME,
  disposition_note TEXT,
  purged_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_history_purged ON messages_history(purged_at);

-- Background Tasks (Three-Gate Pattern: lock + time + count)
CREATE TABLE IF NOT EXISTS background_tasks (
  task_name TEXT PRIMARY KEY,
  last_run_at DATETIME,
  run_count INTEGER NOT NULL DEFAULT 0,
  lock_holder TEXT,
  locked_at DATETIME,
  interval_ms INTEGER NOT NULL DEFAULT 300000,
  enabled INTEGER NOT NULL DEFAULT 1
);

-- ── Scheduled Tasks ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('cron', 'on-demand')),
  cron_expression TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_status TEXT CHECK (last_status IN ('success', 'failure', 'skipped', NULL)),
  config_json TEXT DEFAULT '{}',
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_run_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('success', 'failure', 'skipped')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms REAL,
  error_message TEXT,
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_run_history_task ON task_run_history(task_id);
CREATE INDEX IF NOT EXISTS idx_task_run_history_time ON task_run_history(started_at);

-- Quality Checks (Phase 12.4: Quality Gate)
CREATE TABLE IF NOT EXISTS quality_checks (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  task_type TEXT NOT NULL DEFAULT 'implementation',
  output TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  findings TEXT NOT NULL DEFAULT '[]',
  created_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_quality_checks_session ON quality_checks(session_id, created_at);

-- Session Handoffs (Phase 12.4: Session Handoff Protocol)
CREATE TABLE IF NOT EXISTS session_handoffs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'claimed', 'consumed', 'expired')),
  progress TEXT NOT NULL,
  files_modified TEXT NOT NULL DEFAULT '[]',
  tests_status TEXT,
  remaining_work TEXT,
  context TEXT,
  handoff_payload TEXT,
  claimed_by TEXT,
  claimed_at DATETIME,
  consumed_at DATETIME,
  created_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_session_handoffs_session ON session_handoffs(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_handoffs_status ON session_handoffs(status);

-- Recovery Snapshots (Session Context Recovery)
-- Captures active agent state before scheduled restarts for context-aware respawn.
CREATE TABLE IF NOT EXISTS recovery_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  working_dir TEXT NOT NULL,
  purpose TEXT,
  launch_method TEXT NOT NULL CHECK (launch_method IN ('acp', 'tmux', 'detached')),
  pending_tasks TEXT,
  recent_messages TEXT,
  recovery_prompt TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'recovered', 'failed', 'expired')),
  created_at DATETIME DEFAULT (datetime('now')),
  recovered_at DATETIME,
  new_session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_recovery_snapshots_status ON recovery_snapshots(status);

-- Phase 13.12.13 — Brain-side scaling decisions + outcome learning.
-- `scaling_outcomes` records how each spawned shape fared for a given
-- task signature so the policy can learn over time.
CREATE TABLE IF NOT EXISTS scaling_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_signature TEXT NOT NULL,
  spawned_as TEXT NOT NULL CHECK (spawned_as IN ('solo', 'team')),
  success INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  quality_score REAL,
  source_suggestion_id TEXT,
  team_id TEXT,
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scaling_outcomes_sig ON scaling_outcomes(task_signature, created_at);
-- Idempotency: at most one outcome per (suggestion, shape). NULLs are
-- treated as distinct by SQLite's UNIQUE index, so anonymous outcomes
-- can coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scaling_outcomes_unique
  ON scaling_outcomes(source_suggestion_id, spawned_as);

-- `scaling_decisions` logs each policy invocation for audit + dashboard display.
CREATE TABLE IF NOT EXISTS scaling_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_signature TEXT NOT NULL,
  task_snippet TEXT NOT NULL,
  hint_shape TEXT NOT NULL CHECK (hint_shape IN ('solo', 'team')),
  chosen_shape TEXT NOT NULL CHECK (chosen_shape IN ('solo', 'team')),
  roles_json TEXT NOT NULL DEFAULT '[]',
  reasoning TEXT NOT NULL,
  history_count INTEGER NOT NULL DEFAULT 0,
  source_suggestion_id TEXT,
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scaling_decisions_created ON scaling_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_scaling_decisions_sig ON scaling_decisions(task_signature);

-- WS-0 Immutable Safety Kernel — append-only, hash-chained audit of every
-- gated decision (allow AND deny). Mirrors `ensureKernelAuditTable` in
-- src/broker/services/safety-kernel/kernel-audit.ts. Tamper/deletion is
-- detectable via `verifyAuditChain` (row_hash chains to prev_hash).
CREATE TABLE IF NOT EXISTS kernel_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  session_id TEXT,
  gate TEXT NOT NULL,
  allow INTEGER NOT NULL,
  detail TEXT NOT NULL,
  payload TEXT,
  prev_hash TEXT NOT NULL,
  row_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kernel_audit_session ON kernel_audit(session_id);
CREATE INDEX IF NOT EXISTS idx_kernel_audit_gate ON kernel_audit(gate, allow);
