/**
 * Tool risk classification registry.
 *
 * Classifies every MCP tool by risk level (low / medium / high) following
 * the Claude Code permission model.  High-risk tools require elevated
 * team roles (lead, manager, or general for backward compatibility).
 */

import type { ToolRiskLevelType } from './types.js'

// ── Types ─────────────────────────────────────────────────────────────────

export interface ToolRiskEntry {
  readonly toolName: string
  readonly riskLevel: ToolRiskLevelType
  readonly requiresRole?: readonly string[]
}

export interface ToolAccessResult {
  readonly allowed: boolean
  readonly reason?: string
}

// ── Constants ─────────────────────────────────────────────────────────────

/** Roles permitted to invoke high-risk tools. */
const HIGH_RISK_ROLES: readonly string[] = ['lead', 'manager', 'general', 'orchestrator', 'admin'] as const

// ── Registry builder ──────────────────────────────────────────────────────

function entry(toolName: string, riskLevel: ToolRiskLevelType): ToolRiskEntry {
  const base: ToolRiskEntry = { toolName, riskLevel }
  if (riskLevel === 'high') {
    return { ...base, requiresRole: HIGH_RISK_ROLES }
  }
  return base
}

// ── Tool Risk Registry ────────────────────────────────────────────────────

export const TOOL_RISK_REGISTRY: Readonly<Record<string, ToolRiskEntry>> = Object.freeze({
  // Low-risk: read-only, no state changes
  get_messages:               entry('get_messages', 'low'),
  heartbeat:                  entry('heartbeat', 'low'),
  list_sessions:              entry('list_sessions', 'low'),
  check_conflicts:            entry('check_conflicts', 'low'),
  search:                     entry('search', 'low'),
  broker_info:                entry('broker_info', 'low'),
  get_state:                  entry('get_state', 'low'),
  get_task:                   entry('get_task', 'low'),
  list_tasks:                 entry('list_tasks', 'low'),
  get_member_stats:           entry('get_member_stats', 'low'),
  get_team_activity:          entry('get_team_activity', 'low'),
  wait_for_event:             entry('wait_for_event', 'low'),
  get_session_lifecycle:      entry('get_session_lifecycle', 'low'),
  get_orchestration_info:     entry('get_orchestration_info', 'low'),
  query_history:              entry('query_history', 'low'),
  find_agents_by_repo:        entry('find_agents_by_repo', 'low'),
  index_session:              entry('index_session', 'low'),
  get_index_stats:            entry('get_index_stats', 'low'),
  detect_zombies:             entry('detect_zombies', 'low'),
  list_teams:                 entry('list_teams', 'low'),
  list_team_members:          entry('list_team_members', 'low'),
  get_team_status:            entry('get_team_status', 'low'),
  get_team_template:          entry('get_team_template', 'low'),
  list_capabilities:          entry('list_capabilities', 'low'),
  find_capable_agents:        entry('find_capable_agents', 'low'),
  get_policy:                 entry('get_policy', 'low'),
  list_respawn_history:       entry('list_respawn_history', 'low'),
  get_usage:                  entry('get_usage', 'low'),
  read_scratchpad:            entry('read_scratchpad', 'low'),

  // Medium-risk: creates/modifies data but recoverable
  send_message:               entry('send_message', 'medium'),
  create_task:                entry('create_task', 'medium'),
  update_task:                entry('update_task', 'medium'),
  set_state:                  entry('set_state', 'medium'),
  register_session:           entry('register_session', 'medium'),
  declare_intent:             entry('declare_intent', 'medium'),
  release_intent:             entry('release_intent', 'medium'),
  join_team:                  entry('join_team', 'medium'),
  leave_team:                 entry('leave_team', 'medium'),
  create_team:                entry('create_team', 'medium'),
  declare_capabilities:       entry('declare_capabilities', 'medium'),
  record_usage:               entry('record_usage', 'medium'),
  transition_session_status:  entry('transition_session_status', 'medium'),
  transition_session:         entry('transition_session', 'medium'),
  report_team_results:        entry('report_team_results', 'medium'),
  request_sub_team:           entry('request_sub_team', 'medium'),
  create_orchestration_plan:  entry('create_orchestration_plan', 'medium'),
  transition_orchestration_phase: entry('transition_orchestration_phase', 'medium'),
  cleanup_zombies:            entry('cleanup_zombies', 'medium'),
  write_scratchpad:           entry('write_scratchpad', 'medium'),
  delete_scratchpad:          entry('delete_scratchpad', 'medium'),
  branch_session:             entry('branch_session', 'medium'),
  set_task_phase:             entry('set_task_phase', 'medium'),

  // High-risk: destructive or spawns processes
  disband_team:               entry('disband_team', 'high'),
  purge_team:                 entry('purge_team', 'high'),
  clear_context:              entry('clear_context', 'high'),
  spawn_agent:                entry('spawn_agent', 'high'),
  gc_disbanded_teams:         entry('gc_disbanded_teams', 'high'),
  compact_team_messages:      entry('compact_team_messages', 'high'),
  deregister_session:         entry('deregister_session', 'high'),
  apply_manifest:             entry('apply_manifest', 'high'),
  set_policy:                 entry('set_policy', 'high'),
  broadcast_to_repo:          entry('broadcast_to_repo', 'high'),
})

// ── Public API ────────────────────────────────────────────────────────────

/** Returns the risk level for a tool. Defaults to 'medium' for unknown tools. */
export function getToolRisk(toolName: string): ToolRiskLevelType {
  const entry = TOOL_RISK_REGISTRY[toolName]
  return entry?.riskLevel ?? 'medium'
}

/** Convenience check: is the tool classified as high-risk? */
export function isHighRisk(toolName: string): boolean {
  return getToolRisk(toolName) === 'high'
}

/**
 * Checks whether a caller role is permitted to invoke a tool.
 *
 * - Low/medium tools: always allowed.
 * - High-risk tools: require lead, manager, or general role.
 * - When callerRole is undefined (no team context), the operation is allowed
 *   for backward compatibility.
 */
export function checkToolAccess(
  toolName: string,
  callerRole?: string,
): ToolAccessResult {
  const risk = getToolRisk(toolName)

  if (risk !== 'high') {
    return { allowed: true }
  }

  // Backward compat: no role info means we can't enforce → allow
  if (callerRole === undefined) {
    return { allowed: true }
  }

  const registryEntry = TOOL_RISK_REGISTRY[toolName]
  const allowedRoles = registryEntry?.requiresRole ?? HIGH_RISK_ROLES

  if (allowedRoles.includes(callerRole)) {
    return { allowed: true }
  }

  return {
    allowed: false,
    reason: `Tool '${toolName}' is high-risk and requires one of [${allowedRoles.join(', ')}] role. Current role: '${callerRole}'.`,
  }
}

/** Returns all tool names at a given risk level. */
export function getToolsByRiskLevel(level: ToolRiskLevelType): readonly string[] {
  return Object.values(TOOL_RISK_REGISTRY)
    .filter((e) => e.riskLevel === level)
    .map((e) => e.toolName)
}
