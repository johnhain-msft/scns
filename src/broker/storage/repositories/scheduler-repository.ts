import type Database from 'better-sqlite3'

// ── Types ────────────────────────────────────────────────────

export interface ScheduledTask {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly category: 'cron' | 'on-demand'
  readonly cron_expression: string | null
  readonly enabled: boolean
  readonly last_run_at: string | null
  readonly next_run_at: string | null
  readonly run_count: number
  readonly last_status: 'success' | 'failure' | 'skipped' | null
  readonly config_json: string
  readonly created_at: string
  readonly updated_at: string
}

export interface TaskRunRecord {
  readonly id: number
  readonly task_id: string
  readonly status: 'success' | 'failure' | 'skipped'
  readonly started_at: string
  readonly finished_at: string | null
  readonly duration_ms: number | null
  readonly error_message: string | null
  readonly created_at: string
}

interface ScheduledTaskRow {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly category: 'cron' | 'on-demand'
  readonly cron_expression: string | null
  readonly enabled: number
  readonly last_run_at: string | null
  readonly next_run_at: string | null
  readonly run_count: number
  readonly last_status: 'success' | 'failure' | 'skipped' | null
  readonly config_json: string
  readonly created_at: string
  readonly updated_at: string
}

interface UpdateTaskInput {
  readonly name?: string
  readonly description?: string
  readonly enabled?: boolean
  readonly cron_expression?: string
  readonly config_json?: string
}

// ── Helpers ──────────────────────────────────────────────────

function rowToTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    cron_expression: row.cron_expression,
    enabled: row.enabled === 1,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    run_count: row.run_count,
    last_status: row.last_status,
    config_json: row.config_json,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ── Default Tasks ────────────────────────────────────────────

const DEFAULT_TASKS = [
  {
    id: 'heartbeat-poller',
    name: 'Heartbeat Poller',
    description: 'Monitor session liveness and detect zombies',
    category: 'cron',
    cron_expression: '*/10 * * * * *',
    enabled: true,
  },
  {
    id: 'zombie-cleanup',
    name: 'Zombie Cleanup',
    description: 'Clean up dead sessions and release resources',
    category: 'cron',
    cron_expression: '*/5 * * * *',
    enabled: true,
  },
  {
    id: 'dream-consolidation',
    name: 'Dream Consolidation',
    description: 'Consolidate daily observations into long-term memory',
    category: 'cron',
    cron_expression: '0 3 * * *',
    enabled: true,
  },
  {
    id: 'memory-reindex',
    name: 'Memory Re-indexing',
    description: 'Re-index vault files for search',
    category: 'cron',
    cron_expression: '*/30 * * * *',
    enabled: true,
  },
  {
    id: 'rotation-watchdog',
    name: 'Context Rotation Watchdog',
    description: 'Check for sessions needing context rotation',
    category: 'cron',
    cron_expression: '* * * * *',
    enabled: true,
  },
  {
    id: 'settle-sweep',
    name: 'Human Outcome Settle Sweep',
    description:
      'Harvest accept-vs-waste labels across conversations the live briefing hook can never revisit. The hook settles a prior turn only when a SECOND briefing arrives in the same conversation, but 99% of conversations carry exactly one \u2014 so eligible pairs were never labelled and the routing learner starved. Runs the existing producers only: no new gradient, no new classifier, and no labels at all without the transcript oracle.',
    category: 'cron',
    cron_expression: '17 * * * *',
    enabled: true,
  },
  {
    id: 'reward-report',
    name: 'Reward Learner Report',
    description:
      'Phase D — run the accept-vs-waste arm-value learner READ-ONLY over the settled experience rows and log the report. Observes only: it never writes the store and never flips a default.',
    category: 'cron',
    cron_expression: '0 5 * * *',
    enabled: true,
  },
  {
    id: 'weekly-promotion-review',
    name: 'Weekly Promotion Review',
    description:
      'Assemble the week\u2019s review packet and raise the reward learner\u2019s promotion verdict as a reviewable proposal, so SCNS brings the review to the human instead of waiting to be asked. Writes nothing but `pending` suggestions \u2014 every decision stays human.',
    category: 'cron',
    cron_expression: '0 9 * * 1',
    enabled: true,
  },
  {
    id: 'otel-cleanup',
    name: 'OTel Data Cleanup',
    description: 'Delete OTel spans and metrics older than retention period',
    category: 'cron',
    cron_expression: '0 4 * * *',
    enabled: true,
  },
  {
    id: 'telemetry-rotation',
    name: 'Telemetry JSONL Rotation',
    description:
      'Rotate copilot-otel.jsonl when over SCNS_TELEMETRY_MAX_BYTES (default 100MB), keeping SCNS_TELEMETRY_RETAIN_COUNT archives. Prevents the 1.5GB ONNX-embedding hang threshold on broker startup.',
    category: 'cron',
    cron_expression: '0 */6 * * *',
    enabled: true,
  },
  {
    id: 'suggestion-generation',
    name: 'Suggestion Generation',
    description: 'Detect patterns and generate skill/workflow suggestions',
    category: 'on-demand',
    cron_expression: null,
    enabled: true,
  },
  {
    id: 'memory-search',
    name: 'Memory Search',
    description: 'Hybrid RAG search for agent queries',
    category: 'on-demand',
    cron_expression: null,
    enabled: true,
  },
  {
    id: 'context-handoff',
    name: 'Context Handoff',
    description: 'Generate handoff document for session rotation',
    category: 'on-demand',
    cron_expression: null,
    enabled: true,
  },
  {
    id: 'dream-force-run',
    name: 'Dream Force Run',
    description: 'Manually triggered memory consolidation',
    category: 'on-demand',
    cron_expression: null,
    enabled: true,
  },
  {
    id: 'suggestion-auto-execute',
    name: 'Suggestion Auto-Execute',
    description: 'Auto-implement approved suggestions (requires L2+ autonomy)',
    category: 'on-demand',
    cron_expression: null,
    enabled: false,
  },
  {
    id: 'newsletter-daily',
    name: 'Morning Pod Newsletter',
    description:
      'Generate daily morning podcast/newsletter via automated_newsletter (launchd: com.morningpod.daily)',
    category: 'cron',
    cron_expression: '0 8 * * *',
    enabled: true,
  },
  {
    id: 'realestate-news-learner',
    name: 'Real Estate News Learner',
    description:
      'Fetch market data, news, and insights for real estate knowledge base (launchd: com.realestate.newslearner)',
    category: 'cron',
    cron_expression: '0 7 * * *',
    enabled: true,
  },
  {
    id: 'auto-scale-tick',
    name: 'Auto-Scale Tick',
    description: 'Evaluate cluster state and make scaling decisions for A2A teams',
    category: 'cron',
    cron_expression: '* * * * *',
    enabled: true,
  },
  {
    id: 'self-issue-ingest',
    name: 'Self-Issue Ingestion',
    description:
      "Pull SCNS's own open GitHub issues (and failing tests) and author them as brain tasks so the brain can resolve them. Bounded + deduplicated; kill-switch: shared_state broker:self_issue_disabled.",
    category: 'cron',
    cron_expression: '*/15 * * * *',
    enabled: true,
  },
  {
    id: 'drift-watchdog',
    name: 'Drift Watchdog',
    description:
      'Step 3 anti-drift: daily check that written intent is not decaying. Files/refreshes ONE tracking issue (label scns:self-improvement, never scns-auto) when docs/NORTH_STAR.md has gone >14 days without a commit or a specs/*/tasks.md|spec.md unchecked item carries a past-due Due: date. Update-in-place, reopen-on-still-stale, self-closing on all-clear. Kill-switch: SCNS_DRIFT_WATCHDOG=0.',
    category: 'cron',
    cron_expression: '43 7 * * *',
    enabled: true,
  },
  {
    id: 'synth-ideation',
    name: 'Synth Ideation',
    description:
      'Run the deterministic, evidence-first synthesizer to write NOVEL improvement proposals to the ~/.scns/ideation inbox (advisory; no agent spawn, no network). Double default-OFF: only acts when SCNS_IDEATE_SYNTH=1, else the handler returns immediately.',
    category: 'cron',
    cron_expression: '30 */6 * * *',
    enabled: true,
  },
] as const

// ── Repository Functions ─────────────────────────────────────

export function seedDefaultTasks(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO scheduled_tasks (id, name, description, category, cron_expression, enabled)
     VALUES (@id, @name, @description, @category, @cron_expression, @enabled)`,
  )

  const insertAll = db.transaction(() => {
    for (const task of DEFAULT_TASKS) {
      stmt.run({
        ...task,
        enabled: task.enabled ? 1 : 0,
      })
    }
  })

  insertAll()
}

export function findAllTasks(db: Database.Database): ReadonlyArray<ScheduledTask> {
  const rows = db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at')
    .all() as ScheduledTaskRow[]
  return rows.map(rowToTask)
}

export function findTaskById(db: Database.Database, id: string): ScheduledTask | null {
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTaskRow
    | undefined
  return row ? rowToTask(row) : null
}

export function findTasksByCategory(
  db: Database.Database,
  category: 'cron' | 'on-demand',
): ReadonlyArray<ScheduledTask> {
  const rows = db
    .prepare('SELECT * FROM scheduled_tasks WHERE category = ? ORDER BY created_at')
    .all(category) as ScheduledTaskRow[]
  return rows.map(rowToTask)
}

export function findEnabledTasks(db: Database.Database): ReadonlyArray<ScheduledTask> {
  const rows = db
    .prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY created_at')
    .all() as ScheduledTaskRow[]
  return rows.map(rowToTask)
}

export function updateTask(
  db: Database.Database,
  id: string,
  updates: UpdateTaskInput,
): ScheduledTask | null {
  const setClauses: string[] = []
  const params: Record<string, unknown> = { id }

  if (updates.name !== undefined) {
    setClauses.push('name = @name')
    params.name = updates.name
  }
  if (updates.description !== undefined) {
    setClauses.push('description = @description')
    params.description = updates.description
  }
  if (updates.enabled !== undefined) {
    setClauses.push('enabled = @enabled')
    params.enabled = updates.enabled ? 1 : 0
  }
  if (updates.cron_expression !== undefined) {
    setClauses.push('cron_expression = @cron_expression')
    params.cron_expression = updates.cron_expression
  }
  if (updates.config_json !== undefined) {
    setClauses.push('config_json = @config_json')
    params.config_json = updates.config_json
  }

  if (setClauses.length === 0) {
    return findTaskById(db, id)
  }

  setClauses.push("updated_at = datetime('now')")

  const result = db
    .prepare(`UPDATE scheduled_tasks SET ${setClauses.join(', ')} WHERE id = @id`)
    .run(params)

  if (result.changes === 0) {
    return null
  }

  return findTaskById(db, id)
}

export function recordTaskRun(
  db: Database.Database,
  taskId: string,
  status: 'success' | 'failure' | 'skipped',
  startedAt: string,
  finishedAt: string | null,
  durationMs: number | null,
  errorMessage?: string,
): void {
  const insertAndUpdate = db.transaction(() => {
    db.prepare(
      `INSERT INTO task_run_history (task_id, status, started_at, finished_at, duration_ms, error_message)
       VALUES (@task_id, @status, @started_at, @finished_at, @duration_ms, @error_message)`,
    ).run({
      task_id: taskId,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs,
      error_message: errorMessage ?? null,
    })

    db.prepare(
      `UPDATE scheduled_tasks
       SET last_run_at = @started_at,
           last_status = @status,
           run_count = run_count + 1,
           updated_at = datetime('now')
       WHERE id = @task_id`,
    ).run({
      task_id: taskId,
      started_at: startedAt,
      status,
    })
  })

  insertAndUpdate()
}

export function getTaskRunHistory(
  db: Database.Database,
  taskId: string,
  limit?: number,
): ReadonlyArray<TaskRunRecord> {
  const sql =
    limit !== undefined
      ? 'SELECT * FROM task_run_history WHERE task_id = ? ORDER BY started_at DESC LIMIT ?'
      : 'SELECT * FROM task_run_history WHERE task_id = ? ORDER BY started_at DESC'

  const params = limit !== undefined ? [taskId, limit] : [taskId]
  const rows = db.prepare(sql).all(...params) as TaskRunRecord[]
  return rows.map((row) => ({ ...row }))
}

export function deleteTask(db: Database.Database, id: string): boolean {
  const result = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
  return result.changes > 0
}
