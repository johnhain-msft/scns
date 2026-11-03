/**
 * Zod schemas for REST endpoint request validation.
 *
 * These are kept separate from the domain types in types.ts so they
 * can be reused across REST routes, MCP tools, and tests without
 * pulling in storage-layer concerns.
 */

import { z } from 'zod'
import { SessionStatus, IntentType } from './types.js'

// ── Body schemas ──────────────────────────────────────────────────────────

/** POST /api/register */
export const RegisterSessionSchema = z.object({
  id: z.string().min(1, 'id is required'),
  purpose: z.string().min(1, 'purpose is required'),
  working_dir: z.string().optional(),
  worktree: z.string().nullable().optional(),
})

/** POST /api/teams */
export const CreateTeamSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().nullable().optional(),
  parent_team_id: z.string().nullable().optional(),
})

/** POST /api/messages (send_message tool) */
export const SendMessageSchema = z.object({
  sender_id: z.string().min(1, 'sender_id is required'),
  receiver_id: z.string().nullable().optional(),
  content: z.string().min(1, 'content is required'),
  story_id: z.string().nullable().optional(),
  reply_to: z.string().nullable().optional(),
  /**
   * Issue #70: stable client-supplied id for safe send retries. Replaying the
   * same (sender_id, client_message_id) with an identical payload returns the
   * original message; conflicting reuse is rejected with 409.
   */
  client_message_id: z.string().min(1).max(256).nullable().optional(),
})

/** POST /api/messages/mark-delivered (issue #70 delivery receipts) */
export const MarkMessagesDeliveredSchema = z.object({
  message_ids: z.array(z.string().min(1)).min(1),
  receiver_id: z.string().min(1, 'receiver_id is required'),
})

/** POST /api/messages/ack (issue #70 explicit disposition) */
export const AckMessageSchema = z.object({
  message_id: z.string().min(1, 'message_id is required'),
  disposition: z.enum(['accepted', 'rejected', 'deferred']),
  note: z.string().max(4096).nullable().optional(),
})

/** POST /api/declare_intent */
export const DeclareIntentSchema = z.object({
  session_id: z.string().min(1, 'session_id is required'),
  file: z.string().min(1, 'file is required'),
  operation: z.enum(IntentType).optional(),
})

/** POST /api/heartbeat */
export const HeartbeatSchema = z.object({
  session_id: z.string().min(1, 'session_id is required'),
})

/** POST /api/teams/:id/members */
export const JoinTeamSchema = z.object({
  session_id: z.string().min(1, 'session_id is required'),
  name: z.string().min(1, 'name is required'),
  role: z.string().optional(),
  agent_type: z.string().nullable().optional(),
})

// ── Param schemas ─────────────────────────────────────────────────────────

// TeamIdParam and TaskIdParam removed — routes use the param() helper directly

// ── Query schemas ─────────────────────────────────────────────────────────

/** GET /api/list_sessions?status=... */
export const SessionStatusQuery = z.object({
  status: z.enum(SessionStatus).optional(),
  include_archived: z.string().optional(),
})

// ── Session Hook schemas ──────────────────────────────────────────────────

const SessionEventType = [
  'session-start',
  'session-end',
  'tool-use',
  'pre-compact',
  'user-prompt',
  'error',
  'pre-tool-use',
  'post-tool-use',
] as const

/** POST /api/hooks/:event */
export const SessionHookEventSchema = z.object({
  event: z.enum(SessionEventType),
  sessionId: z.string().max(256).optional(),
  tool: z.string().max(256).optional(),
  timestamp: z.string().min(1, 'timestamp is required').max(64),
  metadata: z.record(z.unknown()).optional(),
  model: z.string().max(128).optional(),
  toolArgs: z.string().max(65536).optional(),
  toolResult: z.string().max(65536).optional(),
  mcpServer: z.string().max(256).optional(),
  skillName: z.string().max(256).optional(),
  exitCode: z.number().int().optional(),
  errorMessage: z.string().max(4096).optional(),
  traceId: z.string().max(256).optional(),
  tokenUsage: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
    })
    .optional(),
})

// ── Agent Hooks schemas ───────────────────────────────────────────────────

/** POST /api/messages/mark-read */
export const MarkMessagesReadSchema = z.object({
  message_ids: z.array(z.string().min(1)).min(1),
})

/** POST /api/state */
export const SetStateSchema = z.object({
  key: z.string().min(1, 'key is required').max(256),
  value: z.string().max(65536),
  story_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
})

/** POST /api/rotate/:sessionId */
export const RotateSessionSchema = z
  .object({
    reason: z.string().max(1024).optional(),
    force: z.boolean().optional(),
  })
  .passthrough()

// ── Dashboard route schemas ───────────────────────────────────────────────

/** PATCH /api/scheduler/tasks/:id */
export const UpdateScheduledTaskSchema = z.object({
  enabled: z.boolean().optional(),
  cron_expression: z.string().max(100).optional(),
  config_json: z.string().max(65536).optional(),
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(1024).nullable().optional(),
})

/** GET /api/otel/traces */
export const OtelTracesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  start_after: z.string().optional(),
  start_before: z.string().optional(),
  name: z.string().optional(),
  status: z.enum(['OK', 'ERROR', 'UNSET']).optional(),
})

/** GET /api/otel/metrics/timeseries */
export const OtelTimeseriesQuerySchema = z.object({
  metric: z.string().min(1),
  since: z.string().optional(),
  interval: z.enum(['hour', 'day']).default('hour'),
})

// ── Extension API schemas ─────────────────────────────────────────────────

/** POST /api/extension/context */
export const ExtensionContextSchema = z.object({
  prompt: z.string().min(1).max(10_000),
  cwd: z.string().optional(),
  /** N1: the Copilot session key (invocation.sessionId) — scopes the re-ask credit assignment to one session. */
  sessionId: z.string().min(1).max(256).optional(),
  /**
   * The abort budget (ms) THIS client is enforcing on this request. The route logs an experience row
   * server-side even when the client aborts, so without this a slow briefing is indistinguishable from
   * a delivered one. Recorded per row so the delivery gate never has to infer it. Optional: older
   * extensions omit it and their rows keep the conservative default.
   */
  clientTimeoutMs: z.number().int().positive().max(600_000).optional(),
})

/** POST /api/memory/store */
export const MemoryStoreSchema = z.object({
  key: z.string().min(1).max(256),
  value: z.string().min(1).max(65536),
})

// ── Negative Memory schemas ───────────────────────────────────────────────

const SentimentCategory = [
  'frustration',
  'correction',
  'prohibition',
  'quality-complaint',
  'behavior-complaint',
] as const

const RecommendedTargetValues = [
  'custom-instruction',
  'agent-profile',
  'skill',
  'workflow',
  'general',
  'instructions',
  'extension',
] as const

const NegativeMemorySeverity = ['low', 'medium', 'high', 'critical'] as const

/** POST /api/memory/negative (from Copilot tool) */
export const CreateNegativeMemorySchema = z.object({
  feedback: z.string().min(1).max(2000),
  context: z.string().max(4000).optional(),
  category: z.enum(SentimentCategory).optional(),
  target: z.enum(RecommendedTargetValues).optional(),
  severity: z.enum(NegativeMemorySeverity).optional(),
  sessionId: z.string().max(256).optional(),
  transportOrigin: z.enum(['team-agent', 'interactive']).optional(),
})

/** POST /api/memory/negative/heuristic (from sentiment analyzer) */
export const HeuristicNegativeMemorySchema = z.object({
  originalText: z.string().min(1).max(2000),
  dontRule: z.string().min(1).max(500),
  category: z.enum(SentimentCategory),
  recommendedTarget: z.enum(RecommendedTargetValues),
  confidence: z.number().min(0).max(1),
  sessionId: z.string().max(256).optional(),
})

/** GET /api/memory/negative?target=...&limit=... */
export const NegativeMemoryQuerySchema = z.object({
  target: z.enum(RecommendedTargetValues).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

/** GET /api/memory/negative/search?q=...&limit=... */
export const NegativeMemorySearchSchema = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

// ── Spawn schemas ─────────────────────────────────────────────────

const SafeNamePattern = /^[A-Za-z0-9._-]+$/

/** POST /api/spawn */
export const SpawnAgentSchema = z.object({
  team_id: z.string().min(1, 'team_id is required').max(256),
  name: z
    .string()
    .min(1, 'name is required')
    .max(256)
    .regex(
      SafeNamePattern,
      'name must contain only alphanumeric, dot, dash, or underscore characters',
    ),
  role: z.string().max(256).optional(),
  working_dir: z.string().max(4096).optional(),
  prompt: z.string().max(65536).optional(),
  agent: z.string().max(256).optional(),
  permissions: z.enum(['none', 'default', 'all']).optional(),
  launch_method: z.enum(['tmux', 'detached', 'acp']).optional(),
})

/** POST /api/agents/:sessionId/message */
export const AgentMessageSchema = z.object({
  message: z.string().min(1, 'message is required').max(65536),
})

/** POST /api/tasks/:id/spawn */
export const SpawnForTaskSchema = z.object({
  // P4 (de-hardcode roles): accept any role string at the schema layer; the
  // route enforces task-spawnability via isTaskSpawnRoleSupported and returns a
  // 400 with the supported set, instead of a static enum that couples the API
  // contract to a hardcoded role list.
  role: z.string().trim().min(1, 'role is required').max(256),
  launch_method: z.enum(['acp', 'detached', 'tmux']).optional(),
  working_dir: z.string().max(4096).optional(),
  extra_context: z.string().max(8192).optional(),
})

// ── Task schemas ──────────────────────────────────────────────────────────

/** POST /api/tasks */
export const CreateTaskSchema = z.object({
  team_id: z.string().min(1, 'team_id is required'),
  subject: z.string().min(1, 'subject is required').max(1024),
  description: z.string().max(4096).nullable().optional(),
  active_form: z.string().max(256).nullable().optional(),
})

/** PATCH /api/tasks/:id */
export const UpdateTaskSchema = z.object({
  status: z.string().max(64).optional(),
  owner: z.string().max(256).nullable().optional(),
  subject: z.string().min(1).max(1024).optional(),
  description: z.string().max(4096).nullable().optional(),
  active_form: z.string().max(256).nullable().optional(),
})

// ── Quality Gate + Session Handoff schemas (Phase 12.4) ───────────────────

/** POST /api/quality-check */
export const QualityCheckRequestSchema = z.object({
  sessionId: z.string().max(256).optional(),
  output: z.string().min(1).max(65536),
  taskType: z.string().max(128).default('implementation'),
})

/** POST /api/sessions/:id/handoff */
export const CreateHandoffSchema = z.object({
  progress: z.string().min(1).max(65536),
  filesModified: z.array(z.string().max(1024)).default([]),
  testsStatus: z.string().max(4096).nullable().optional(),
  remainingWork: z.string().max(65536).nullable().optional(),
  context: z.string().max(65536).nullable().optional(),
})

/** POST /api/handoffs/:id/consume */
export const ConsumeHandoffSchema = z.object({
  consumedBy: z.string().min(1).max(256),
})
