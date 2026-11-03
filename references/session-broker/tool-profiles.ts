/**
 * Tool profiles define which MCP tools are visible to each agent role.
 *
 * Profiles are additive: each level includes all tools from the previous level.
 * The hierarchy is: bootstrap → worker → lead → orchestrator → admin.
 *
 * Currently all agents default to 'admin' (full access). The infrastructure
 * is in place so role-based filtering can be enabled per-profile by changing
 * the default in registerTools().
 */

export type ToolProfile = 'bootstrap' | 'worker' | 'lead' | 'orchestrator' | 'admin'

export const TOOL_PROFILE_HIERARCHY: readonly ToolProfile[] = [
  'bootstrap',
  'worker',
  'lead',
  'orchestrator',
  'admin',
] as const

/**
 * Tools added at each profile level. Each profile inherits all tools
 * from lower levels in the hierarchy.
 */
const PROFILE_ADDITIONS: Record<ToolProfile, readonly string[]> = {
  // Bootstrap: minimal set for unjoined agents to register and find a team
  bootstrap: [
    'register_session',
    'broker_info',
    'list_sessions',
    'list_teams',
    'join_team',
    'create_team',
    'heartbeat',
  ],

  // Worker: tools needed by dev/qa agents to do individual work
  worker: [
    'deregister_session',
    'get_messages',
    'send_message',
    'declare_intent',
    'release_intent',
    'check_conflicts',
    'get_state',
    'set_state',
    'get_task',
    'list_tasks',
    'update_task',
    'read_scratchpad',
    'write_scratchpad',
    'declare_capabilities',
    'list_capabilities',
    'search',
    'wait_for_event',
    'transition_session',
    'get_session_lifecycle',
    'record_usage',
    'index_session',
    'get_index_stats',
    'leave_team',
  ],

  // Lead: team management, monitoring, and cross-team coordination
  lead: [
    'create_task',
    'list_team_members',
    'get_team_status',
    'get_team_activity',
    'get_member_stats',
    'find_capable_agents',
    'find_agents_by_repo',
    'broadcast_to_repo',
    'report_team_results',
    'get_usage',
    'get_policy',
    'list_respawn_history',
    'get_team_template',
    'delete_scratchpad',
    'query_history',
    'detect_zombies',
  ],

  // Orchestrator: plan creation, team lifecycle, spawning, destructive ops
  orchestrator: [
    'create_orchestration_plan',
    'request_sub_team',
    'get_orchestration_info',
    'transition_orchestration_phase',
    'set_task_phase',
    'spawn_agent',
    'branch_session',
    'apply_manifest',
    'set_policy',
    'disband_team',
    'purge_team',
    'clear_context',
    'cleanup_zombies',
    'gc_disbanded_teams',
    'compact_team_messages',
  ],

  // Admin: no additional tools — admin sees everything
  admin: [],
}

/**
 * Returns the set of tool names visible to a given profile.
 * Tools are accumulated from bootstrap up to the specified profile level.
 */
export function getToolsForProfile(profile: ToolProfile): ReadonlySet<string> {
  const tools = new Set<string>()
  for (const level of TOOL_PROFILE_HIERARCHY) {
    for (const tool of PROFILE_ADDITIONS[level]) {
      tools.add(tool)
    }
    if (level === profile) break
  }
  return tools
}

/**
 * Returns the estimated token count for a profile's tool set.
 * Based on ~250 tokens per tool schema (description + inputSchema).
 */
export function estimateProfileTokens(profile: ToolProfile): number {
  const TOKENS_PER_TOOL = 250
  return getToolsForProfile(profile).size * TOKENS_PER_TOOL
}

/**
 * Maps a team role string to the appropriate tool profile.
 * Used when an agent joins a team to determine their tool visibility.
 */
export function roleToProfile(role?: string): ToolProfile {
  switch (role) {
    case 'dev':
    case 'qa':
    case 'reviewer':
    case 'researcher':
      return 'worker'
    case 'lead':
    case 'manager':
    case 'pm':
    case 'scrum-master':
      return 'lead'
    case 'orchestrator':
      return 'orchestrator'
    case 'admin':
      return 'admin'
    default:
      // All agents get admin for now — change to 'worker' for least-privilege
      return 'admin'
  }
}

/** Returns all defined profiles with their tool counts and estimated tokens. */
export function listProfiles(): ReadonlyArray<{
  readonly profile: ToolProfile
  readonly toolCount: number
  readonly estimatedTokens: number
}> {
  return TOOL_PROFILE_HIERARCHY.map((profile) => {
    const tools = getToolsForProfile(profile)
    return {
      profile,
      toolCount: tools.size,
      estimatedTokens: tools.size * 250,
    }
  })
}
