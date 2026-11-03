const BROKER_URL = process.env.NEXT_PUBLIC_BROKER_URL || 'http://localhost:3456'
const AUTH_TOKEN = process.env.NEXT_PUBLIC_BROKER_TOKEN || ''

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`API error ${status}: ${body}`)
    this.name = 'ApiError'
  }
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
  }
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...options,
    headers: { ...headers, ...(options?.headers as Record<string, string>) },
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new ApiError(res.status, await res.text())
  }
  return res.json() as Promise<T>
}

// ── Types matching actual backend contracts ──────────────────

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

export interface TraceSummary {
  readonly trace_id: string
  readonly root_span_name: string
  readonly span_count: number
  readonly start_time: string
  readonly duration_ms: number | null
  readonly status: string | null
  readonly total_tokens: number | null
}

export interface OtelSpan {
  readonly trace_id: string
  readonly span_id: string
  readonly parent_span_id: string | null
  readonly name: string
  readonly kind: string | null
  readonly start_time: string
  readonly end_time: string | null
  readonly duration_ms: number | null
  readonly status: string | null
  readonly attributes_json: string
  readonly events_json: string
  readonly resource_json: string
  readonly session_id: string | null
  readonly created_at: string
}

export interface SpanNode {
  readonly span: OtelSpan
  readonly children: readonly SpanNode[]
}

export interface MetricsSummary {
  readonly total_spans: number
  readonly total_metrics: number
  readonly total_input_tokens: number
  readonly total_output_tokens: number
  readonly avg_duration_ms: number | null
  readonly top_tools: ReadonlyArray<{ name: string; count: number }>
  readonly model_distribution: ReadonlyArray<{ model: string; count: number }>
  readonly error_count: number
}

export interface TimeseriesBucket {
  readonly bucket: string
  readonly value: number
  readonly count: number
}

export interface OtelIngestionConfig {
  readonly enabled: boolean
  readonly filePath: string | null
  readonly retentionDays: number
  readonly maxSpansPerTrace: number
  readonly pollIntervalMs: number
}

export interface AutonomyState {
  readonly level: 0 | 1 | 2 | 3
  readonly changedAt: string
  readonly changedBy: string
}

export interface CostSummary {
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly totalTokens: number
  readonly estimatedTotalCostUSD: number
  readonly sessionCount: number
  readonly perSession: ReadonlyArray<{
    sessionId: string
    inputTokens: number
    outputTokens: number
    totalTokens: number
    estimatedCostUSD: number
  }>
}

export interface Session {
  readonly id: string
  readonly status: string
  readonly created_at: string
  readonly intent?: string
  readonly model?: string
  readonly purpose?: string
  readonly working_dir?: string
  readonly last_heartbeat?: string
  readonly team?: { id: string; name: string } | null
  readonly [key: string]: unknown
}

export interface Team {
  readonly id: string
  readonly name: string
  readonly status?: string
  readonly created_at?: string
  readonly [key: string]: unknown
}

export interface TeamMember {
  readonly session_id: string
  readonly role: string
  readonly joined_at: string
  readonly [key: string]: unknown
}

// ── Health ────────────────────────────────────────────────────

export function getHealth() {
  return apiFetch<{ status: string; uptime_seconds: number }>('/health')
}

// ── Brain status (Phase 13.12.14) ────────────────────────────

export interface BrainStatus {
  readonly state: 'idle' | 'running' | 'deciding' | 'acting' | 'starting'
  readonly lastTickAt: string | null
  readonly ticksToday: number
  readonly currentDecisionId: number | null
  /** Pending suggestions — legacy alias of {@link pendingSuggestions}. */
  readonly queueDepth: number
  /** The REAL brain task queue depth (optional: older brokers omit it). */
  readonly taskQueueDepth?: number
  /** Honest name for what {@link queueDepth} has always counted. */
  readonly pendingSuggestions?: number
  readonly autonomy: number
  readonly isWoken: boolean
}

export function getBrainStatus(): Promise<BrainStatus> {
  return apiFetch<BrainStatus>('/api/brain/status')
}

// ── Sessions ─────────────────────────────────────────────────

export async function listSessions(): Promise<Session[]> {
  const res = await apiFetch<{ sessions: Session[] }>('/api/list_sessions')
  return res.sessions
}

// ── Teams ────────────────────────────────────────────────────

export async function listTeams(opts?: { includeArchived?: boolean }): Promise<Team[]> {
  const qs = opts?.includeArchived ? '?include_archived=true' : ''
  const res = await apiFetch<{ teams: Team[] }>(`/api/teams${qs}`)
  return res.teams
}

/** @public Archive a team via DELETE /api/teams/:id. */
export async function archiveTeam(id: string): Promise<Team> {
  return apiFetch<Team>(`/api/teams/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** @public Dashboard API client — may be used by future dashboard pages. */
export function getTeamById(id: string) {
  return apiFetch<Team & { members: TeamMember[] }>(`/api/teams/${id}`)
}

// ── Tasks (team work items) ──────────────────────────────────

export interface TeamTask {
  readonly id: number
  readonly team_id: string
  readonly seq: number
  readonly subject: string
  readonly description: string | null
  readonly status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'deleted'
  readonly owner: string | null
  readonly active_form: string | null
  readonly created_at: string
  readonly updated_at: string
}

export async function listTasks(teamId: string): Promise<TeamTask[]> {
  const params = new URLSearchParams({ team_id: teamId })
  const res = await apiFetch<{ tasks: TeamTask[] }>(`/api/tasks?${params}`)
  return res.tasks
}

// ── Scheduler ────────────────────────────────────────────────

export async function getSchedulerTasks(): Promise<ScheduledTask[]> {
  const res = await apiFetch<{ tasks: ScheduledTask[] }>('/api/scheduler/tasks')
  return res.tasks
}

export function updateSchedulerTask(id: string, updates: Record<string, unknown>) {
  return apiFetch<ScheduledTask>(`/api/scheduler/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  })
}

export function triggerSchedulerTask(id: string) {
  return apiFetch<{ success: boolean; task: ScheduledTask }>(`/api/scheduler/tasks/${id}/run`, {
    method: 'POST',
  })
}

export async function getSchedulerHistory(id: string, limit?: number): Promise<TaskRunRecord[]> {
  const params = limit ? `?limit=${limit}` : ''
  const res = await apiFetch<{ history: TaskRunRecord[] }>(`/api/scheduler/history/${id}${params}`)
  return res.history
}

// ── Dream ────────────────────────────────────────────────────

export function getDreamStatus() {
  return apiFetch<Record<string, unknown>>('/api/dream/status')
}

export function triggerDream(force?: boolean) {
  const params = force ? '?force=true' : ''
  return apiFetch<Record<string, unknown>>(`/api/dream/trigger${params}`, {
    method: 'POST',
  })
}

// ── Suggestions ──────────────────────────────────────────────

export async function getSuggestions(status?: string) {
  const params = status ? `?status=${status}` : ''
  const res = await apiFetch<{ suggestions: Array<Record<string, unknown>> }>(
    `/api/suggestions${params}`,
  )
  return res.suggestions
}

export function approveSuggestion(id: string) {
  return apiFetch<Record<string, unknown>>(`/api/suggestions/${id}/approve`, {
    method: 'POST',
  })
}

export function rejectSuggestion(id: string) {
  return apiFetch<Record<string, unknown>>(`/api/suggestions/${id}/reject`, {
    method: 'POST',
  })
}

// Phase 13.12.9: manual retry — clears backoff + (if failed) resets status.
export function retrySuggestion(id: string) {
  return apiFetch<{ success: boolean; suggestion: Record<string, unknown> }>(
    `/api/suggestions/${id}/retry`,
    { method: 'POST' },
  )
}

// Phase 13.12.9: explicit delete endpoint.
export function deleteSuggestion(id: string) {
  return apiFetch<{ success: boolean; id: string }>(`/api/suggestions/${id}`, {
    method: 'DELETE',
  })
}

// Phase 13.12.16: repromote needs-human → pending.
export function repromoteSuggestion(id: string) {
  return apiFetch<{ success: boolean; suggestion: Record<string, unknown> }>(
    `/api/suggestions/${id}/repromote`,
    { method: 'POST' },
  )
}

// ── Observers ────────────────────────────────────────────────

export function getObservers() {
  return apiFetch<Record<string, unknown>>('/api/observers')
}

export function toggleObserver(type: string, enabled?: boolean) {
  return apiFetch<{ type: string; enabled: boolean }>(`/api/observers/${type}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled: enabled ?? true }),
  })
}

// ── Memory ───────────────────────────────────────────────────

export async function searchMemory(query: string, topK?: number) {
  const params = new URLSearchParams({ q: query })
  if (topK) params.set('top_k', String(topK))
  const res = await apiFetch<{ results: Array<Record<string, unknown>> }>(
    `/api/memory/search?${params}`,
  )
  return res.results
}

export function getMemoryStats() {
  return apiFetch<Record<string, unknown>>('/api/memory/stats')
}

export interface MemoryFile {
  path: string
  sizeBytes: number
  modifiedAt: string
  preview: string
}

export async function getMemoryFiles(): Promise<MemoryFile[]> {
  const res = await apiFetch<{ files: MemoryFile[] }>('/api/memory/files')
  return res.files ?? []
}

// ── Memory Management ────────────────────────────────────────

export interface MemoryLesson {
  id?: string
  name: string
  type: string
  description: string
  content: string
  source?: string
  createdAt?: string
}

export interface ArchivedEntry {
  id: string
  name: string
  type: string
  content: string
  source: string
  createdAt: string
  archivedAt: string
  archiveReason: string
  rejectionNote?: string
}

export interface TierSummary {
  daily: { count: number; totalBytes: number }
  weekly: { count: number; totalBytes: number }
  monthly: { count: number; totalBytes: number }
  archive: { count: number; totalBytes: number }
  embeddingStatus: { ready: boolean; embeddedChunks: number; totalChunks: number }
}

export async function getMemoryLessons(): Promise<MemoryLesson[]> {
  const res = await apiFetch<{ lessons: MemoryLesson[] }>('/api/memory/lessons')
  return res.lessons ?? []
}

// ── Phase 13.12.11 — scoped lessons ────────────────────────────────

export interface ScopedLessonFrontmatter {
  id: string
  scope: 'global' | 'project' | 'agent'
  project?: string
  agent?: string
  tags: readonly string[]
  appliesTo: readonly string[]
  createdAt: string
}

export interface ScopedLesson {
  frontmatter: ScopedLessonFrontmatter
  body: string
  path: string
}

export interface ScopedLessonsResponse {
  available: boolean
  count: number
  totalCount: number
  lessons: ScopedLesson[]
  groups: Record<string, ScopedLesson[]>
}

export async function getScopedLessons(filter?: {
  cwd?: string
  project?: string
  agent?: string
}): Promise<ScopedLessonsResponse> {
  const qs = new URLSearchParams()
  if (filter?.cwd) qs.set('cwd', filter.cwd)
  if (filter?.project) qs.set('project', filter.project)
  if (filter?.agent) qs.set('agent', filter.agent)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return apiFetch<ScopedLessonsResponse>(`/api/memory/scoped-lessons${suffix}`)
}

export async function archiveMemoryEntry(
  entryId: string,
  reason: string,
  note?: string,
): Promise<{ success: boolean; archivedId?: string }> {
  return apiFetch('/api/memory/archive', {
    method: 'POST',
    body: JSON.stringify({ entryId, reason, note }),
  })
}

export async function getArchivedEntries(): Promise<ArchivedEntry[]> {
  const res = await apiFetch<{ entries: ArchivedEntry[] }>('/api/memory/archive')
  return res.entries ?? []
}

export async function getMemoryTiers(): Promise<TierSummary> {
  return apiFetch<TierSummary>('/api/memory/tiers')
}

// ── OTel Traces ──────────────────────────────────────────────

export async function getOtelTraces(options?: {
  limit?: number
  offset?: number
  start_after?: string
  start_before?: string
  name?: string
  status?: string
}): Promise<TraceSummary[]> {
  const params = new URLSearchParams()
  if (options?.limit) params.set('limit', String(options.limit))
  if (options?.offset) params.set('offset', String(options.offset))
  if (options?.start_after) params.set('start_after', options.start_after)
  if (options?.start_before) params.set('start_before', options.start_before)
  if (options?.name) params.set('name', options.name)
  if (options?.status) params.set('status', options.status)
  const qs = params.toString()
  const res = await apiFetch<{ traces: TraceSummary[] }>(`/api/otel/traces${qs ? `?${qs}` : ''}`)
  return res.traces
}

export function getOtelTraceDetail(traceId: string) {
  return apiFetch<{ trace_id: string; spans: OtelSpan[]; tree: SpanNode[] }>(
    `/api/otel/traces/${traceId}`,
  )
}

// ── OTel Metrics ─────────────────────────────────────────────

export function getOtelMetricsSummary(since?: string) {
  const params = since ? `?since=${since}` : ''
  return apiFetch<MetricsSummary>(`/api/otel/metrics/summary${params}`)
}

/** @public Dashboard API client — may be used by future dashboard pages. */
export async function getOtelTimeseries(
  metric: string,
  since?: string,
  interval?: 'hour' | 'day',
): Promise<TimeseriesBucket[]> {
  const params = new URLSearchParams({ metric })
  if (since) params.set('since', since)
  if (interval) params.set('interval', interval)
  const res = await apiFetch<{ buckets: TimeseriesBucket[] }>(
    `/api/otel/metrics/timeseries?${params}`,
  )
  return res.buckets
}

// ── OTel Config ──────────────────────────────────────────────

export async function getOtelConfig(): Promise<OtelIngestionConfig> {
  const res = await apiFetch<{ config: OtelIngestionConfig }>('/api/otel/config')
  return res.config
}

export async function updateOtelConfig(
  updates: Record<string, unknown>,
): Promise<OtelIngestionConfig> {
  const res = await apiFetch<{ config: OtelIngestionConfig; note: string }>('/api/otel/config', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  })
  return res.config
}

// ── Autonomy ─────────────────────────────────────────────────

export function getAutonomy() {
  return apiFetch<AutonomyState>('/api/autonomy')
}

export function promoteAutonomy() {
  return apiFetch<AutonomyState>('/api/autonomy/promote', {
    method: 'POST',
  })
}

export function demoteAutonomy() {
  return apiFetch<AutonomyState>('/api/autonomy/demote', {
    method: 'POST',
  })
}

// ── Cost ─────────────────────────────────────────────────────

export function getCostSummary() {
  return apiFetch<CostSummary>('/api/cost/summary')
}

// ── Conflicts ────────────────────────────────────────────────

/** @public Dashboard API client — may be used by future dashboard pages. */
export async function getConflicts() {
  const res = await apiFetch<{ conflicts: Array<Record<string, unknown>> }>('/api/conflicts')
  return res.conflicts
}

// ── Orchestrator Overview (Phase 13.7) ───────────────────────

export interface OrchestratorTeamMember {
  readonly session_id: string
  readonly name: string
  readonly role: string
  readonly agent_type: string | null
  readonly status: string
  readonly joined_at: string
  readonly last_heartbeat: string | null
  readonly session_status: string | null
}

export interface OrchestratorTeam {
  readonly id: string
  readonly name: string
  readonly status?: string
  readonly created_at?: string
  readonly members: OrchestratorTeamMember[]
  readonly [key: string]: unknown
}

export interface OrchestratorEvent {
  readonly id: number
  readonly event_type: string
  readonly session_id: string | null
  readonly payload: string
  readonly created_at: string
}

export interface OrchestratorMessage {
  readonly id: string
  readonly sender_id: string | null
  readonly receiver_id: string | null
  readonly content: string
  readonly team_id: string | null
  readonly created_at: string
}

export interface OrchestratorOverview {
  readonly teams: OrchestratorTeam[]
  readonly suggestions: Array<Record<string, unknown>>
  readonly verdicts: OrchestratorEvent[]
  readonly completions: OrchestratorEvent[]
  readonly messages: OrchestratorMessage[]
  readonly scalingDecisions?: ScalingDecision[]
}

export interface ScalingDecision {
  readonly id: number
  readonly task_signature: string
  readonly task_snippet: string
  readonly hint_shape: 'solo' | 'team'
  readonly chosen_shape: 'solo' | 'team'
  readonly roles: string[]
  readonly reasoning: string
  readonly history_count: number
  readonly source_suggestion_id: string | null
  readonly created_at: string
  readonly outcome_success: number | null
  readonly outcome_quality: number | null
}

export async function getOrchestratorOverview(since?: string): Promise<OrchestratorOverview> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : ''
  return apiFetch<OrchestratorOverview>(`/api/orchestrator/overview${qs}`)
}

// ── Events ───────────────────────────────────────────────────

/** @public Dashboard API client — may be used by future dashboard pages. */
export async function getEventsSince(afterId?: number) {
  const afterParam = afterId != null ? afterId : 0
  const res = await apiFetch<{
    events: Array<{
      id: number
      type: string
      session_id: string | null
      payload: unknown
      team_id: string | null
      created_at: string
    }>
  }>(`/api/events/since/${afterParam}`)
  return res.events
}
