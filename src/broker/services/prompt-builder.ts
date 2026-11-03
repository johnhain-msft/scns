export interface PromptConfig {
  readonly sessionId: string
  readonly teamId: string
  readonly name: string
  readonly role: string
  readonly brokerUrl: string
  readonly workingDir?: string
  readonly customPrompt?: string
  /**
   * Phase 13.12.17 — keys (never values) of secrets available in the SCNS
   * credential vault. When non-empty, the agent prompt advertises them and
   * tells the agent how to fetch them via the internal HTTP route.
   */
  readonly availableSecretKeys?: readonly string[]
  /**
   * Phase 13.12.18 — skills discoverable to the agent. Each entry is a
   * `{name, description}` pair; the prompt emits a concise block so the
   * agent knows which bundled skills it can delegate to. Empty → no block.
   */
  readonly availableSkills?: readonly { readonly name: string; readonly description: string }[]
}

export function buildAgentPrompt(config: PromptConfig): string {
  const {
    sessionId,
    teamId,
    name,
    role,
    brokerUrl,
    workingDir,
    customPrompt,
    availableSecretKeys,
    availableSkills,
  } = config
  const taskSection = customPrompt ?? 'Use scns_read_messages to check for assigned work.'
  const workingDirLine = workingDir ? `\n- Working Directory: ${workingDir}` : ''

  const secretsSection =
    availableSecretKeys && availableSecretKeys.length > 0
      ? `\n\n## Available secrets\nKeys only — values are NEVER printed here:\n${availableSecretKeys
          .map((k) => `- ${k}`)
          .join('\n')}\n\nFetch via: POST ${brokerUrl}/api/secrets/<key>/fetch with header \`X-SCNS-Internal-Token: $SCNS_INTERNAL_TOKEN\`.\nOnly fetch when the task genuinely requires the secret. NEVER log, echo, or write fetched values to disk, messages, commit diffs, or chat output.`
      : ''

  const skillsSection =
    availableSkills && availableSkills.length > 0
      ? `\n\n## Available skills\n${availableSkills
          .map((s) => `- **${s.name}** — ${s.description}`)
          .join('\n')}\n\nInvoke a skill by running its bundled runner (see \`~/.copilot/skills/<name>/\`). Artifacts stay inside the skill's declared output directory.`
      : ''

  return `You are ${name}, a ${role} agent on team ${teamId}.

SESSION DETAILS:
- Session ID: ${sessionId}
- Team ID: ${teamId}
- Role: ${role}
- Broker URL: ${brokerUrl}${workingDirLine}

CRITICAL: Do NOT call register_session. You are ALREADY registered as session ${sessionId}.
Use this exact session ID for ALL tool calls. Do not generate your own session ID.
The extension handles team join, heartbeat, and cleanup automatically.

STARTUP:
1. Send a ready message: scns_send_message with sender_id="${sessionId}"
2. Check for work: scns_read_messages with receiver_id="${sessionId}"
3. Review the TASK section below.

TASK:
${taskSection}

AVAILABLE SCNS TOOLS:
- scns_send_message: Send to any agent (same or different team) by session ID
- scns_read_messages: Check for messages (do this regularly)
- scns_list_teams: Discover all teams and their members
- scns_team_status: Get a specific team's members and session IDs
- scns_create_task: Create a task for your team
- scns_list_tasks: List team tasks with optional status filter
- scns_update_task: Update task status (in_progress, completed, failed)
- scns_declare_intent: Claim a file before editing (prevents conflicts)
- scns_release_intent: Release a file claim when done
- scns_list_intents: Check which files are claimed by whom
- scns_set_state / scns_get_state: Shared key-value state
- scns_report_progress: Team-scoped progress broadcast
- scns_heartbeat: Manual heartbeat (auto-sent by extension)${secretsSection}${skillsSection}`
}
