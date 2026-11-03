const BROKER_URL = process.env.NEXT_PUBLIC_BROKER_URL || "http://localhost:3456";

// ─── Helpers ───────────────────────────────────────────────────────────────

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${url}`);
  }
  return res.json();
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  return fetchJSON<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchJSON<T>(url: string, body: unknown): Promise<T> {
  return fetchJSON<T>(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── Session Types ─────────────────────────────────────────────────────────

export interface Session {
  id: string;
  purpose: string;
  working_dir: string;
  worktree: string | null;
  status: string;
  last_heartbeat: string;
  created_at: string;
  team: string | null;
}

export interface ListSessionsResponse {
  sessions: Session[];
}

// ─── Health Types ──────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  uptime_seconds: number;
  sessions: {
    active: number;
    zombie: number;
    total: number;
  };
  active_teams: number;
  pending_tasks: number;
  in_progress_tasks: number;
}

export interface IndexStatsResponse {
  indexed_sessions: number;
  embedding_dimension: number;
}

// ─── Message Types ─────────────────────────────────────────────────────────

export interface Message {
  id: string;
  sender_id: string;
  receiver_id: string | null;
  content: string;
  story_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface ListMessagesResponse {
  messages: Message[];
}

// ─── Team Types ────────────────────────────────────────────────────────────

export interface Team {
  id: string;
  name: string;
  description: string;
  status: "active" | "disbanded";
  created_at: string;
}

export interface TeamStatus {
  name: string;
  member_count: number;
  task_counts: {
    pending: number;
    in_progress: number;
    completed: number;
  };
  idle: boolean;
}

export interface TeamMember {
  session_id: string;
  name: string;
  role: string;
  agent_type: string | null;
  status: string;
  last_heartbeat: string | null;
}

export interface TeamMembersResponse {
  team_id: string;
  team_name: string;
  members: TeamMember[];
}

export interface MemberStats {
  session_id: string;
  name: string;
  role: string;
  messages_sent: number;
  tasks_completed: number;
  tasks_in_progress: number;
  avg_task_duration_seconds: number | null;
  active_intents: number;
  last_heartbeat: string | null;
}

export interface MemberStatsResponse {
  team_id: string;
  members: MemberStats[];
}

// ─── Task Types ────────────────────────────────────────────────────────────

export interface Task {
  id: number;
  team_id: string;
  subject: string;
  description: string | null;
  active_form: string | null;
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskDetail extends Task {
  blocks: number[];
  blocked_by: number[];
}

export interface TaskUpdateInput {
  status?: string;
  owner?: string;
  subject?: string;
  description?: string;
  active_form?: string;
  add_blocks?: number[];
  add_blocked_by?: number[];
}

// ─── Scaling Types ─────────────────────────────────────────────────────────

export interface ScalingPolicy {
  team_id: string;
  role: string;
  min_count: number;
  max_count: number;
  scale_up_threshold: number;
  scale_down_threshold: number;
  cooldown_ms: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ScalingPoliciesResponse {
  team_id: string;
  policies: ScalingPolicy[];
}

// ─── Usage / Cost Types ────────────────────────────────────────────────────

export interface UsageRecord {
  session_id: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  model: string | null;
  created_at: string;
}

export interface UsageSummary {
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  record_count: number;
  by_model?: Record<string, { tokens_in: number; tokens_out: number; cost_usd: number }>;
}

export interface TeamBudget {
  team_id: string;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  by_session: Record<string, { tokens_in: number; tokens_out: number; cost_usd: number }>;
}

// ─── Branch Conflict Types ─────────────────────────────────────────────────

export interface BranchConflict {
  file_path: string;
  branches: {
    branch: string;
    session_id: string;
    commit_sha: string | null;
    declared_at: string;
  }[];
}

export interface BranchConflictsResponse {
  conflicts: BranchConflict[];
}

// ─── Capability Types ──────────────────────────────────────────────────────

export interface CapableAgent {
  session_id: string;
  capability: string;
  declared_at: string;
}

export interface CapabilityMatchResponse {
  capabilities: string[];
  agents: CapableAgent[];
}

// ─── Respawn Types ─────────────────────────────────────────────────────────

export interface RespawnPolicy {
  team_id: string;
  role: string;
  min_count: number;
  max_retries: number;
  backoff_base_ms: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface RespawnPoliciesResponse {
  team_id: string;
  policies: RespawnPolicy[];
}

export interface RespawnEvent {
  id: number;
  team_id: string;
  role: string;
  session_id: string | null;
  status: "pending" | "spawned" | "failed" | "abandoned";
  attempt: number;
  error: string | null;
  created_at: string;
}

export interface RespawnHistoryResponse {
  team_id: string;
  history: RespawnEvent[];
}

// ─── Activity Types ────────────────────────────────────────────────────────

export interface ActivityEvent {
  id: number;
  event_type: string;
  session_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface ActivityResponse {
  team_id: string;
  events: ActivityEvent[];
  total: number;
}

// ─── Conflict Types (file-level) ──────────────────────────────────────────

export interface FileConflict {
  file_path: string;
  sessions: {
    session_id: string;
    intent: string;
    declared_at: string;
  }[];
}

export interface ConflictsResponse {
  conflicts: FileConflict[];
}

// ─── Broker Info Types ─────────────────────────────────────────────────────

export interface BrokerInfo {
  version: string;
  uptime_seconds: number;
  sessions: { active: number; zombie: number; total: number };
  teams: { active: number; disbanded: number };
  tasks: { pending: number; in_progress: number; completed: number };
}

// ─── History Types (for future history tables) ─────────────────────────────

export interface HistoryTeam {
  id: string;
  name: string;
  description: string;
  status: string;
  created_at: string;
  purged_at: string;
  member_count: number;
  task_count: number;
}

export interface HistorySession {
  id: string;
  purpose: string;
  status: string;
  created_at: string;
  purged_at: string;
  team_id: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// FETCH FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

// ─── Sessions ──────────────────────────────────────────────────────────────

export async function listSessions(includeArchived = false): Promise<Session[]> {
  const params = includeArchived ? "?include_archived=true" : "";
  const data = await fetchJSON<ListSessionsResponse>(
    `${BROKER_URL}/api/list_sessions${params}`
  );
  return data.sessions;
}

// ─── Health ────────────────────────────────────────────────────────────────

export async function getHealth(): Promise<HealthResponse> {
  return fetchJSON<HealthResponse>(`${BROKER_URL}/health`);
}

export async function getIndexStats(): Promise<IndexStatsResponse> {
  return fetchJSON<IndexStatsResponse>(`${BROKER_URL}/api/index_stats`);
}

export async function getBrokerInfo(): Promise<BrokerInfo> {
  return fetchJSON<BrokerInfo>(`${BROKER_URL}/api/broker/info`);
}

// ─── Messages ──────────────────────────────────────────────────────────────

export async function listMessages(limit = 100): Promise<Message[]> {
  const data = await fetchJSON<ListMessagesResponse>(
    `${BROKER_URL}/api/list_messages?limit=${limit}`
  );
  return data.messages;
}

// ─── Teams ─────────────────────────────────────────────────────────────────

export async function listTeams(includeArchived = false): Promise<Team[]> {
  const params = includeArchived ? "?include_archived=true" : "";
  return fetchJSON<Team[]>(`${BROKER_URL}/api/teams${params}`);
}

export async function getTeamStatus(teamId: string): Promise<TeamStatus> {
  return fetchJSON<TeamStatus>(`${BROKER_URL}/api/teams/${teamId}/status`);
}

export async function getTeamMembers(teamId: string): Promise<TeamMembersResponse> {
  return fetchJSON<TeamMembersResponse>(`${BROKER_URL}/api/teams/${teamId}`);
}

export async function getMemberStats(teamId: string): Promise<MemberStatsResponse> {
  return fetchJSON<MemberStatsResponse>(`${BROKER_URL}/api/teams/${teamId}/members/stats`);
}

export async function disbandTeam(teamId: string): Promise<void> {
  await fetchJSON(`${BROKER_URL}/api/teams/${teamId}`, { method: "DELETE" });
}

export async function purgeTeam(teamId: string): Promise<void> {
  await postJSON(`${BROKER_URL}/api/teams/${teamId}/purge`, {});
}

// ─── Tasks ─────────────────────────────────────────────────────────────────

export async function listTasks(teamId: string, status?: string): Promise<Task[]> {
  const params = status ? `?status=${status}` : "";
  return fetchJSON<Task[]>(`${BROKER_URL}/api/teams/${teamId}/tasks${params}`);
}

export async function getTask(taskId: number): Promise<TaskDetail> {
  return fetchJSON<TaskDetail>(`${BROKER_URL}/api/tasks/${taskId}`);
}

export async function createTask(
  teamId: string,
  input: { subject: string; description?: string; active_form?: string }
): Promise<TaskDetail> {
  return postJSON<TaskDetail>(`${BROKER_URL}/api/teams/${teamId}/tasks`, input);
}

export async function updateTask(
  taskId: number,
  input: TaskUpdateInput
): Promise<TaskDetail> {
  return patchJSON<TaskDetail>(`${BROKER_URL}/api/tasks/${taskId}`, input);
}

// ─── Scaling ───────────────────────────────────────────────────────────────

export async function getScalingPolicies(teamId: string): Promise<ScalingPoliciesResponse> {
  return fetchJSON<ScalingPoliciesResponse>(
    `${BROKER_URL}/api/teams/${teamId}/scaling-policy`
  );
}

export async function setScalingPolicy(
  teamId: string,
  input: {
    role: string;
    min_count?: number;
    max_count?: number;
    scale_up_threshold?: number;
    scale_down_threshold?: number;
    cooldown_ms?: number;
    enabled?: boolean;
  }
): Promise<void> {
  await postJSON(`${BROKER_URL}/api/teams/${teamId}/scaling-policy`, input);
}

// ─── Usage / Cost ──────────────────────────────────────────────────────────

export async function getUsageSummary(filters?: {
  session_id?: string;
  team_id?: string;
  task_id?: number;
}): Promise<UsageSummary> {
  const params = new URLSearchParams();
  if (filters?.session_id) params.set("session_id", filters.session_id);
  if (filters?.team_id) params.set("team_id", filters.team_id);
  if (filters?.task_id) params.set("task_id", String(filters.task_id));
  const qs = params.toString();
  return fetchJSON<UsageSummary>(
    `${BROKER_URL}/api/usage/summary${qs ? `?${qs}` : ""}`
  );
}

export async function getTeamBudget(teamId: string): Promise<TeamBudget> {
  return fetchJSON<TeamBudget>(`${BROKER_URL}/api/teams/${teamId}/budget`);
}

export async function recordUsage(input: {
  session_id: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  team_id?: string;
  task_id?: number;
  model?: string;
}): Promise<void> {
  await postJSON(`${BROKER_URL}/api/usage`, input);
}

// ─── Branch Conflicts ──────────────────────────────────────────────────────

export async function getBranchConflicts(filters?: {
  file_path?: string;
  branch?: string;
}): Promise<BranchConflictsResponse> {
  const params = new URLSearchParams();
  if (filters?.file_path) params.set("file_path", filters.file_path);
  if (filters?.branch) params.set("branch", filters.branch);
  const qs = params.toString();
  return fetchJSON<BranchConflictsResponse>(
    `${BROKER_URL}/api/branch-conflicts${qs ? `?${qs}` : ""}`
  );
}

// ─── Capabilities ──────────────────────────────────────────────────────────

export async function getSessionCapabilities(sessionId: string): Promise<string[]> {
  return fetchJSON<string[]>(`${BROKER_URL}/api/sessions/${sessionId}/capabilities`);
}

export async function getCapableAgents(capability: string): Promise<{
  capability: string;
  agents: CapableAgent[];
}> {
  return fetchJSON(`${BROKER_URL}/api/capabilities/${capability}/agents`);
}

export async function matchCapabilities(capabilities: string[]): Promise<CapabilityMatchResponse> {
  return postJSON<CapabilityMatchResponse>(`${BROKER_URL}/api/capabilities/match`, {
    capabilities,
  });
}

// ─── Respawn ───────────────────────────────────────────────────────────────

export async function getRespawnPolicies(teamId: string): Promise<RespawnPoliciesResponse> {
  return fetchJSON<RespawnPoliciesResponse>(
    `${BROKER_URL}/api/teams/${teamId}/respawn-policy`
  );
}

export async function setRespawnPolicy(
  teamId: string,
  input: {
    role: string;
    min_count?: number;
    max_retries?: number;
    backoff_base_ms?: number;
    enabled?: boolean;
  }
): Promise<void> {
  await postJSON(`${BROKER_URL}/api/teams/${teamId}/respawn-policy`, input);
}

export async function getRespawnHistory(
  teamId: string,
  filters?: { limit?: number; status?: string }
): Promise<RespawnHistoryResponse> {
  const params = new URLSearchParams();
  if (filters?.limit) params.set("limit", String(filters.limit));
  if (filters?.status) params.set("status", filters.status);
  const qs = params.toString();
  return fetchJSON<RespawnHistoryResponse>(
    `${BROKER_URL}/api/teams/${teamId}/respawn-history${qs ? `?${qs}` : ""}`
  );
}

// ─── Activity Feed ─────────────────────────────────────────────────────────

export async function getTeamActivity(
  teamId: string,
  filters?: {
    limit?: number;
    offset?: number;
    event_types?: string[];
    since?: string;
  }
): Promise<ActivityResponse> {
  const params = new URLSearchParams();
  if (filters?.limit) params.set("limit", String(filters.limit));
  if (filters?.offset) params.set("offset", String(filters.offset));
  if (filters?.event_types) params.set("event_types", filters.event_types.join(","));
  if (filters?.since) params.set("since", filters.since);
  const qs = params.toString();
  return fetchJSON<ActivityResponse>(
    `${BROKER_URL}/api/teams/${teamId}/activity${qs ? `?${qs}` : ""}`
  );
}

// ─── File Conflicts ────────────────────────────────────────────────────────

export async function checkConflicts(filePath?: string): Promise<ConflictsResponse> {
  const params = filePath ? `?file_path=${encodeURIComponent(filePath)}` : "";
  return fetchJSON<ConflictsResponse>(
    `${BROKER_URL}/api/check_conflicts${params}`
  );
}

// ─── Manifests ─────────────────────────────────────────────────────────────

export async function applyManifest(manifestYaml: string): Promise<unknown> {
  return postJSON(`${BROKER_URL}/api/teams/apply`, { manifest_yaml: manifestYaml });
}

// ─── History (will be wired after history tables are implemented) ──────────

export async function getTeamHistory(): Promise<HistoryTeam[]> {
  return fetchJSON<HistoryTeam[]>(`${BROKER_URL}/api/history/teams`);
}

export async function getSessionHistory(): Promise<HistorySession[]> {
  return fetchJSON<HistorySession[]>(`${BROKER_URL}/api/history/sessions`);
}

// ─── Utilities ─────────────────────────────────────────────────────────────

export function getHeartbeatStatus(lastHeartbeat: string): "healthy" | "warning" | "stale" {
  const lastBeat = new Date(lastHeartbeat).getTime();
  const now = Date.now();
  const diffSeconds = (now - lastBeat) / 1000;

  if (diffSeconds < 30) return "healthy";
  if (diffSeconds < 60) return "warning";
  return "stale";
}
