/**
 * Zod schemas for REST endpoint request validation.
 *
 * These are kept separate from the domain types in types.ts so they
 * can be reused across REST routes, MCP tools, and tests without
 * pulling in storage-layer concerns.
 */

import { z } from 'zod'
import { SessionStatus, IntentType, TaskStatus } from './types.js'

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
})

/** POST /api/teams/:id/tasks */
export const CreateTaskSchema = z.object({
  subject: z.string().min(1, 'subject is required'),
  team_id: z.string().optional(),           // often supplied via path param
  description: z.string().nullable().optional(),
  active_form: z.string().nullable().optional(),
})

/** PATCH /api/tasks/:id */
export const UpdateTaskSchema = z.object({
  status: z.enum(TaskStatus).optional(),
  owner: z.string().nullable().optional(),
  subject: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  active_form: z.string().nullable().optional(),
  add_blocks: z.array(z.number()).optional(),
  add_blocked_by: z.array(z.number()).optional(),
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

/** POST /api/search_sessions */
export const SearchSchema = z.object({
  query: z.string().min(1, 'query is required'),
  top_k: z.number().int().positive().max(100).optional(),
  min_similarity: z.number().min(0).max(1).optional(),
})

/** POST /api/teams/:id/members */
export const JoinTeamSchema = z.object({
  session_id: z.string().min(1, 'session_id is required'),
  name: z.string().min(1, 'name is required'),
  role: z.string().optional(),
  agent_type: z.string().nullable().optional(),
})

// ── Param schemas ─────────────────────────────────────────────────────────

/** Path param: { id: string } */
export const TeamIdParam = z.object({
  id: z.string().min(1, 'id is required'),
})

/** Path param for tasks: { id: string (numeric) } */
export const TaskIdParam = z.object({
  id: z.string().min(1, 'id is required'),
})

// ── Query schemas ─────────────────────────────────────────────────────────

/** GET /api/list_sessions?status=... */
export const SessionStatusQuery = z.object({
  status: z.enum(SessionStatus).optional(),
  include_archived: z.string().optional(),
})

// ── Agent Hooks schemas ───────────────────────────────────────────────────

/** POST /api/messages/mark-read */
export const MarkMessagesReadSchema = z.object({
  message_ids: z.array(z.string().min(1)).min(1),
})

/** POST /api/index/task-completion */
export const IndexTaskCompletionSchema = z.object({
  task_id: z.number(),
  team_id: z.string().min(1),
  subject: z.string().min(1),
  result: z.string().min(1),
})

/** POST /api/teams/:id/scratchpad */
export const WriteScratchpadSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  session_id: z.string().optional(),
})
