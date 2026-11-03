import { z } from 'zod'

export const SessionStatus = [
  'registered',
  'active',
  'working',
  'reporting',
  'idle',
  'paused',
  'completed',
  'zombie',
  // Issue #70: execution lease lapsed (heartbeat past grace) but the
  // participant identity and its correspondence remain addressable. An
  // expired session revives on register/heartbeat/session-start; it is
  // settled to history only by explicit termination or TTL GC.
  'expired',
] as const
export const IntentType = ['edit', 'read', 'create', 'delete'] as const

export const SessionSchema = z.object({
  id: z.string(),
  purpose: z.string(),
  working_dir: z.string(),
  worktree: z.string().nullable().optional().default(null),
  repo_context: z.string().nullable().optional().default(null),
  parent_session_id: z.string().nullable().optional().default(null),
  branch_point_message_id: z.string().nullable().optional().default(null),
  status: z.enum(SessionStatus).default('active'),
  project_id: z.string().nullable().optional().default(null),
  last_heartbeat: z.string().optional(),
  created_at: z.string().optional(),
})

export type Session = z.infer<typeof SessionSchema>

export const MessageSchema = z.object({
  id: z.string(),
  sender_id: z.string(),
  receiver_id: z.string().nullable().default(null),
  content: z.string(),
  story_id: z.string().nullable().optional().default(null),
  reply_to: z.string().nullable().optional().default(null),
  team_id: z.string().nullable().optional().default(null),
  seq: z.number().nullable().optional().default(null),
  to_role: z.string().nullable().optional().default(null),
  to_team: z.string().nullable().optional().default(null),
  client_message_id: z.string().nullable().optional().default(null),
  created_at: z.string().optional(),
  delivered_at: z.string().nullable().optional().default(null),
  read_at: z.string().nullable().optional().default(null),
  disposition: z.enum(['accepted', 'rejected', 'deferred']).nullable().optional().default(null),
  disposition_at: z.string().nullable().optional().default(null),
  disposition_note: z.string().nullable().optional().default(null),
})

export type Message = z.infer<typeof MessageSchema>

export const FileIntentSchema = z.object({
  file_path: z.string(),
  session_id: z.string(),
  intent: z.enum(IntentType).default('edit'),
  declared_at: z.string().optional(),
})

export type FileIntent = z.infer<typeof FileIntentSchema>

export const SharedStateEntrySchema = z.object({
  key: z.string(),
  value: z.string(),
  story_id: z.string().nullable().optional().default(null),
  session_id: z.string().nullable().optional().default(null),
  updated_at: z.string().optional(),
})

export type SharedStateEntry = z.infer<typeof SharedStateEntrySchema>

export const EventSchema = z.object({
  id: z.number(),
  event_type: z.string(),
  session_id: z.string().nullable().default(null),
  payload: z.string(),
  created_at: z.string().optional(),
})

export type Event = z.infer<typeof EventSchema>

export const SessionEmbeddingSchema = z.object({
  session_id: z.string(),
  purpose_text: z.string(),
  embedding: z.instanceof(Buffer),
  model: z.string(),
  dimensions: z.number(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})

export type SessionEmbedding = z.infer<typeof SessionEmbeddingSchema>

export interface SessionSearchResult {
  readonly session_id: string
  readonly purpose: string
  readonly working_dir: string
  readonly status: string
  readonly similarity: number
}

export interface MessageSearchResult {
  readonly message_id: string
  readonly sender_id: string
  readonly receiver_id: string | null
  readonly content: string
  readonly similarity: number
  readonly created_at?: string
}

// Phase 1: Agent Teams

export const TeamStatus = ['active', 'paused', 'disbanded'] as const
export const TeamRole = [
  'lead',
  'dev',
  'qa',
  'reviewer',
  'general',
  'manager',
  'pm',
  'scrum-master',
  'orchestrator',
  'admin',
] as const
export const MemberStatus = ['idle', 'working', 'shutdown'] as const
export const TaskStatus = ['pending', 'in_progress', 'completed', 'deleted', 'failed'] as const

export const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional().default(null),
  parent_team_id: z.string().nullable().optional().default(null),
  status: z.enum(TeamStatus).default('active'),
  /**
   * Task 34 (neuron fan-out): per-team isolated git working tree. When
   * non-null, every agent spawned for this team is forced into this
   * directory regardless of what the caller passes. NULL = legacy
   * behaviour (fall back to broker cwd / caller-supplied working_dir).
   */
  working_dir: z.string().nullable().optional().default(null),
  /**
   * Multi-project foundation (P3): the project this team belongs to. NULL =
   * legacy/unmigrated (excluded from autonomous project-scoped reads).
   */
  project_id: z.string().nullable().optional().default(null),
  created_at: z.string().optional(),
})

export type Team = z.infer<typeof TeamSchema>

export const TeamMemberSchema = z.object({
  team_id: z.string(),
  session_id: z.string(),
  name: z.string(),
  role: z.enum(TeamRole).default('general'),
  agent_type: z.string().nullable().optional().default(null),
  status: z.enum(MemberStatus).default('idle'),
  joined_at: z.string().optional(),
})

export type TeamMember = z.infer<typeof TeamMemberSchema>

export const TaskSchema = z.object({
  id: z.number(),
  team_id: z.string(),
  seq: z.number(),
  subject: z.string(),
  description: z.string().nullable().optional().default(null),
  status: z.enum(TaskStatus).default('pending'),
  owner: z.string().nullable().optional().default(null),
  active_form: z.string().nullable().optional().default(null),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})

export type Task = z.infer<typeof TaskSchema>

export interface TaskWithDeps extends Task {
  readonly blocked_by: ReadonlyArray<number>
  readonly blocks: ReadonlyArray<number>
}

// Stream 12: Agent Capabilities

export const AgentCapabilitySchema = z.object({
  session_id: z.string(),
  capability: z.string(),
  created_at: z.string().optional(),
})

export type AgentCapability = z.infer<typeof AgentCapabilitySchema>

// Stream 10: Self-Healing & Auto-Respawn

export const RespawnStatus = ['pending', 'spawned', 'failed', 'abandoned'] as const

export const RespawnPolicySchema = z.object({
  id: z.number(),
  team_id: z.string(),
  role: z.string(),
  min_count: z.number().default(1),
  max_retries: z.number().default(3),
  backoff_base_ms: z.number().default(5000),
  enabled: z.number().default(1),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})

export type RespawnPolicy = z.infer<typeof RespawnPolicySchema>

export const RespawnHistorySchema = z.object({
  id: z.number(),
  team_id: z.string(),
  original_session_id: z.string(),
  new_session_id: z.string().nullable().optional().default(null),
  role: z.string(),
  name: z.string(),
  agent_type: z.string().nullable().optional().default(null),
  attempt: z.number().default(1),
  status: z.enum(RespawnStatus).default('pending'),
  error_message: z.string().nullable().optional().default(null),
  created_at: z.string().optional(),
})

export type RespawnHistory = z.infer<typeof RespawnHistorySchema>

// Auto-Scaling Policies

export const ScalingPolicySchema = z.object({
  id: z.number(),
  team_id: z.string(),
  role: z.string(),
  min_count: z.number().default(1),
  max_count: z.number().default(5),
  scale_up_threshold: z.number().default(3),
  scale_down_threshold: z.number().default(0),
  cooldown_ms: z.number().default(60000),
  enabled: z.number().default(1),
  last_scale_action_at: z.string().nullable().optional().default(null),
})

export type ScalingPolicy = z.infer<typeof ScalingPolicySchema>

// Token/Cost Tracking

export const UsageRecordSchema = z.object({
  id: z.number(),
  session_id: z.string(),
  team_id: z.string().nullable().optional().default(null),
  task_id: z.number().nullable().optional().default(null),
  tokens_in: z.number().default(0),
  tokens_out: z.number().default(0),
  model: z.string().nullable().optional().default(null),
  cost_usd: z.number().default(0),
  recorded_at: z.string().optional(),
})

export type UsageRecord = z.infer<typeof UsageRecordSchema>

// Git-Level Conflict Detection

export const BranchIntentSchema = z.object({
  id: z.number(),
  session_id: z.string(),
  branch: z.string(),
  file_path: z.string(),
  commit_sha: z.string().nullable().optional().default(null),
  declared_at: z.string().optional(),
})

export type BranchIntent = z.infer<typeof BranchIntentSchema>

// Background Tasks (Three-Gate Pattern)

export const BackgroundTaskSchema = z.object({
  task_name: z.string(),
  last_run_at: z.string().nullable().default(null),
  run_count: z.number().default(0),
  lock_holder: z.string().nullable().default(null),
  locked_at: z.string().nullable().default(null),
  interval_ms: z.number().default(300000),
  enabled: z
    .union([z.number(), z.boolean()])
    .transform((v) => (typeof v === 'boolean' ? v : v === 1))
    .pipe(z.boolean()),
})

export type BackgroundTask = z.infer<typeof BackgroundTaskSchema>

export const GateFailureReason = ['disabled', 'lock', 'time', 'count'] as const

export interface GateResult {
  readonly passed: boolean
  readonly gate_failed?: (typeof GateFailureReason)[number]
}

export interface GateCheckResult {
  readonly canRun: boolean
  readonly failedGate?: (typeof GateFailureReason)[number]
}

// ── ACP (Agent Client Protocol) ───────────────────────────────────────────

export const AcpSessionState = ['initializing', 'ready', 'prompting', 'closed', 'failed'] as const

export type AcpSessionStateType = (typeof AcpSessionState)[number]

export const LaunchMethod = ['tmux', 'detached', 'acp'] as const
export type LaunchMethodType = (typeof LaunchMethod)[number]

export interface AcpSessionMapping {
  readonly brokerSessionId: string
  readonly acpSessionId: string
  readonly state: AcpSessionStateType
  readonly startedAt: string
}

export interface TaskGateConfig {
  readonly taskName: string
  readonly intervalMs: number
  readonly countCheck?: () => boolean
  readonly lockHolder?: string
  readonly staleLockMs?: number
}

// Phase 12.4: Quality Gate + Session Handoff

export const QualityCheckResultStatus = ['passed', 'failed'] as const

export const QualityCheckSchema = z.object({
  id: z.string(),
  session_id: z.string().nullable().optional().default(null),
  task_type: z.string().default('implementation'),
  output: z.string(),
  passed: z
    .union([z.number(), z.boolean()])
    .transform((v) => (typeof v === 'boolean' ? v : v === 1))
    .pipe(z.boolean()),
  score: z.number().min(0).max(1),
  findings: z.string().default('[]'),
  created_at: z.string().optional(),
})

export type QualityCheck = z.infer<typeof QualityCheckSchema>

export const HandoffLifecycleStatus = ['ready', 'claimed', 'consumed', 'expired'] as const

export const SessionHandoffSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  status: z.enum(HandoffLifecycleStatus).default('ready'),
  progress: z.string(),
  files_modified: z.string().default('[]'),
  tests_status: z.string().nullable().optional().default(null),
  remaining_work: z.string().nullable().optional().default(null),
  context: z.string().nullable().optional().default(null),
  handoff_payload: z.string().nullable().optional().default(null),
  claimed_by: z.string().nullable().optional().default(null),
  claimed_at: z.string().nullable().optional().default(null),
  consumed_at: z.string().nullable().optional().default(null),
  created_at: z.string().optional(),
})

export type SessionHandoff = z.infer<typeof SessionHandoffSchema>
