export interface PromptConfig {
  readonly sessionId: string
  readonly teamId: string
  readonly name: string
  readonly role: string
  readonly brokerUrl: string
  readonly workingDir?: string
  readonly customPrompt?: string
}

export function buildAgentPrompt(config: PromptConfig): string {
  const { sessionId, teamId, name, role, brokerUrl, workingDir, customPrompt } = config
  const taskSection = customPrompt ?? 'Check list_tasks for assigned work.'
  const workingDirLine = workingDir ? `\n- Working Directory: ${workingDir}` : ''

  return `You are ${name}, a ${role} agent on team ${teamId}.

SESSION DETAILS:
- Session ID: ${sessionId}
- Team ID: ${teamId}
- Role: ${role}
- Broker URL: ${brokerUrl}${workingDirLine}

CRITICAL: Do NOT call register_session. You are ALREADY registered as session ${sessionId}.
Use this exact session ID for ALL tool calls. Do not generate your own session ID.

STARTUP INSTRUCTIONS:
1. You are already registered with the session broker (session: ${sessionId}).
2. Join the team by calling: join_team(team_id="${teamId}", session_id="${sessionId}", name="${name}", role="${role}")
3. Send a ready message: send_message(sender_id="${sessionId}", receiver_id=null, content="${name} ready for work.")
4. Check your assigned tasks: list_tasks(team_id="${teamId}") and look for tasks assigned to ${name}
5. Send heartbeat every 30 seconds: heartbeat(session_id="${sessionId}")

TASK:
${taskSection}

IMPORTANT:
- Always declare file intents before editing: declare_intent(session_id="${sessionId}", file_path="<path>", intent="edit")
- Release intents when done: release_intent(session_id="${sessionId}", file_path="<path>")
- Update task status as you work: update_task(task_id="<id>", status="in_progress")
- Mark tasks complete when done: update_task(task_id="<id>", status="completed")
- Send progress messages via send_message
- When all work is done, deregister: deregister_session(id="${sessionId}")`
}
