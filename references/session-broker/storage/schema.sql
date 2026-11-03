-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  purpose TEXT,
  working_dir TEXT,
  worktree TEXT,
  repo_context TEXT,
  status TEXT DEFAULT 'active',
  last_heartbeat DATETIME DEFAULT (datetime('now')),
  created_at DATETIME DEFAULT (datetime('now')),
  archived_at DATETIME DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_repo_context ON sessions(repo_context);

-- Messages (queue)
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  receiver_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  story_id TEXT,
  reply_to TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT (datetime('now')),
  read_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_story ON messages(story_id);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);

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
  created_at DATETIME DEFAULT (datetime('now')),
  archived_at DATETIME DEFAULT NULL
);

-- Team members (links sessions to teams with roles)
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'general' CHECK (role IN ('lead', 'dev', 'qa', 'reviewer', 'general', 'manager', 'pm', 'scrum-master', 'orchestrator', 'admin')),
  agent_type TEXT,
  status TEXT DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'shutdown')),
  joined_at DATETIME DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_session ON team_members(session_id);

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
  created_at DATETIME DEFAULT (datetime('now')),
  updated_at DATETIME DEFAULT (datetime('now'))
);
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
  created_at DATETIME,
  read_at DATETIME,
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
