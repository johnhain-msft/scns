/**
 * Tool Definitions — SCNS custom tools for the Copilot CLI extension.
 *
 * Each tool calls the SCNS broker over HTTP. 500ms timeouts, never throws.
 */

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: 'object'
    readonly properties: Record<string, { readonly type: string; readonly description: string }>
    readonly required?: readonly string[]
  }
}

export interface ToolHandler {
  (args: Record<string, unknown>): Promise<string>
}

export interface ToolWithHandler {
  readonly definition: ToolDefinition
  readonly handler: ToolHandler
}

/** Tool schemas for SCNS custom tools */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'scns_memory_search',
    description: 'Search SCNS memory vault for relevant context, facts, and past observations.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for memory vault' },
        top_k: { type: 'number', description: 'Maximum results to return (default: 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'scns_memory_store',
    description: 'Store a new fact or observation in SCNS memory for future reference.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'A descriptive key for this memory' },
        value: { type: 'string', description: 'The content to store' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'scns_memory_delete',
    description:
      'Retract a memory from the SCNS vault: removes the source file, every index representation ' +
      'and its managed instruction bullet. Previews by default — pass apply=true to execute. ' +
      'Retirement is recoverable; hard=true is not.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Vault-relative path of the memory, e.g. negative/<id>.md',
        },
        apply: {
          type: 'boolean',
          description: 'Execute the deletion. Omit or false to preview what would change.',
        },
        hard: {
          type: 'boolean',
          description: 'Delete without a recovery record (unrecoverable). Default: retire.',
        },
        allow_pinned: {
          type: 'boolean',
          description: 'Also remove a pinned memory. Pinned memories are protected by default.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'scns_suggestions',
    description:
      'List pending SCNS suggestions for improvements, automations, or workflow changes.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: pending, approved, rejected (default: pending)',
        },
      },
    },
  },
  {
    name: 'scns_status',
    description: 'Show SCNS system health, observer status, autonomy level, and pattern counts.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'scns_report_negative_feedback',
    description:
      'Report negative user feedback, frustration, or corrections to SCNS memory. ' +
      'Call this when the user expresses dissatisfaction, says "don\'t do X", corrects your behavior, ' +
      'or shows frustration with something you did. This helps SCNS learn what NOT to do.',
    parameters: {
      type: 'object',
      properties: {
        feedback: { type: 'string', description: "What the user said or the 'don't do this' rule" },
        context: {
          type: 'string',
          description: 'What was happening when the user gave this feedback',
        },
        category: {
          type: 'string',
          description:
            'Category: frustration, correction, prohibition, quality-complaint, behavior-complaint',
        },
        target: {
          type: 'string',
          description: 'Where to apply: agent-profile, skill, instructions, extension, general',
        },
        severity: { type: 'string', description: 'Severity: low, medium, high, critical' },
      },
      required: ['feedback'],
    },
  },
  // ── Team communication tools ──────────────────────────────
  {
    name: 'scns_send_message',
    description:
      'Send a message to any agent (same team or different team) by session ID. Omit receiver_id to broadcast globally. A successful send means the broker ACCEPTED the message — not that it was delivered or acknowledged.',
    parameters: {
      type: 'object',
      properties: {
        sender_id: { type: 'string', description: 'Your session ID' },
        receiver_id: { type: 'string', description: 'Target session ID (omit to broadcast)' },
        content: { type: 'string', description: 'Message content' },
        client_message_id: {
          type: 'string',
          description:
            'Stable id for safe retries: resending with the same id and payload lands as one logical message',
        },
      },
      required: ['sender_id', 'content'],
    },
  },
  {
    name: 'scns_read_messages',
    description: 'Read messages sent to a specific agent, optionally filtering to unread only.',
    parameters: {
      type: 'object',
      properties: {
        receiver_id: { type: 'string', description: 'Your session ID to read messages for' },
        unread_only: {
          type: 'boolean',
          description: 'Only return unread messages (default: false)',
        },
      },
      required: ['receiver_id'],
    },
  },
  {
    name: 'scns_ack_message',
    description:
      'Record your explicit disposition (accepted/rejected/deferred) for a message you received. Senders must not treat their send response as an acknowledgement — this is the acknowledgement.',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'ID of the message being acknowledged' },
        disposition: {
          type: 'string',
          description: "Your verdict: 'accepted', 'rejected', or 'deferred'",
        },
        note: { type: 'string', description: 'Optional rationale recorded with the disposition' },
      },
      required: ['message_id', 'disposition'],
    },
  },
  {
    name: 'scns_team_status',
    description: 'Get the status of a team including its members and their current states.',
    parameters: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: 'Team identifier' },
      },
      required: ['team_id'],
    },
  },
  {
    name: 'scns_declare_intent',
    description: 'Declare intent to work on a file, preventing conflicts with other agents.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Your session ID' },
        file: { type: 'string', description: 'File path to declare intent for' },
        operation: { type: 'string', description: 'Operation type (e.g. edit, read)' },
      },
      required: ['session_id', 'file'],
    },
  },
  {
    name: 'scns_release_intent',
    description: 'Release a previously declared intent on a file.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Your session ID' },
        file: { type: 'string', description: 'File path to release intent for' },
      },
      required: ['session_id', 'file'],
    },
  },
  {
    name: 'scns_set_state',
    description: 'Set a shared key-value state entry in the broker.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'State key' },
        value: { type: 'string', description: 'State value' },
        session_id: { type: 'string', description: 'Optional session ID to scope the state' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'scns_get_state',
    description: 'Get a shared key-value state entry from the broker.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'State key to retrieve' },
      },
      required: ['key'],
    },
  },
  {
    name: 'scns_report_progress',
    description: 'Send a progress update to your team members (team-scoped, not global broadcast).',
    parameters: {
      type: 'object',
      properties: {
        sender_id: { type: 'string', description: 'Your session ID' },
        progress: { type: 'string', description: 'Progress description' },
      },
      required: ['sender_id', 'progress'],
    },
  },
  {
    name: 'scns_heartbeat',
    description: 'Send a heartbeat to the broker to indicate this session is alive.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Your session ID' },
      },
      required: ['session_id'],
    },
  },
  // ── Cross-team discovery tools ─────────────────────────────
  {
    name: 'scns_list_teams',
    description:
      'List all active teams and their members. Use this to discover other teams for cross-team collaboration.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: active, archived (default: active)',
        },
      },
    },
  },
  {
    name: 'scns_list_intents',
    description:
      'List all active file intents across all agents. Use to check which files are claimed before editing.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Optional: filter by specific file path' },
        session_id: { type: 'string', description: 'Optional: filter by session ID' },
      },
    },
  },
  // ── Task management tools ──────────────────────────────────
  {
    name: 'scns_create_task',
    description: 'Create a new task assigned to a team. Returns the created task with its ID.',
    parameters: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: 'Team to assign the task to' },
        subject: { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'Detailed task description' },
      },
      required: ['team_id', 'subject'],
    },
  },
  {
    name: 'scns_list_tasks',
    description: 'List tasks for a team, optionally filtered by status.',
    parameters: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: 'Team ID to list tasks for' },
        status: {
          type: 'string',
          description: 'Filter by status: pending, in_progress, completed, failed (optional)',
        },
      },
      required: ['team_id'],
    },
  },
  {
    name: 'scns_update_task',
    description: 'Update a task status or description.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID to update' },
        status: {
          type: 'string',
          description: 'New status: pending, in_progress, completed, failed',
        },
        description: { type: 'string', description: 'Updated description (optional)' },
      },
      required: ['task_id'],
    },
  },
] as const

/** Create tool handlers bound to a broker URL */
export function createToolHandlers(brokerUrl: string, timeoutMs = 500): readonly ToolWithHandler[] {
  async function fetchBroker(path: string, init?: RequestInit): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(`${brokerUrl}${path}`, {
        ...init,
        signal: controller.signal,
      })
      if (!response.ok) {
        return JSON.stringify({ error: `HTTP ${response.status}`, available: false })
      }
      const data = await response.json()
      return JSON.stringify(data)
    } catch {
      return JSON.stringify({ error: 'SCNS broker unavailable', available: false })
    } finally {
      clearTimeout(timer)
    }
  }

  return TOOL_DEFINITIONS.map((definition) => {
    let handler: ToolHandler

    switch (definition.name) {
      case 'scns_memory_search':
        handler = async (args) => {
          const query = encodeURIComponent(String(args['query'] ?? ''))
          const topK = Number(args['top_k']) || 5
          return fetchBroker(`/api/memory/search?q=${query}&top_k=${topK}`)
        }
        break

      case 'scns_memory_store':
        handler = async (args) => {
          return fetchBroker('/api/memory/store', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              key: String(args['key'] ?? ''),
              value: String(args['value'] ?? ''),
            }),
          })
        }
        break

      case 'scns_memory_delete':
        handler = async (args) => {
          return fetchBroker('/api/memory/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              path: String(args['path'] ?? ''),
              apply: args['apply'] === true,
              hard: args['hard'] === true,
              allow_pinned: args['allow_pinned'] === true,
            }),
          })
        }
        break

      case 'scns_suggestions':
        handler = async (args) => {
          const status = String(args['status'] ?? 'pending')
          return fetchBroker(`/api/suggestions?status=${encodeURIComponent(status)}`)
        }
        break

      case 'scns_status':
        handler = async () => {
          const [observersStr, autonomyStr] = await Promise.all([
            fetchBroker('/api/observers'),
            fetchBroker('/api/autonomy'),
          ])
          try {
            return JSON.stringify({
              observers: JSON.parse(observersStr),
              autonomy: JSON.parse(autonomyStr),
            })
          } catch {
            return JSON.stringify({
              observers: { error: 'parse error', raw: observersStr },
              autonomy: { error: 'parse error', raw: autonomyStr },
            })
          }
        }
        break

      case 'scns_report_negative_feedback':
        handler = async (args) => {
          return fetchBroker('/api/memory/negative', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              feedback: String(args['feedback'] ?? ''),
              context: args['context'] ? String(args['context']) : undefined,
              category: args['category'] ? String(args['category']) : undefined,
              target: args['target'] ? String(args['target']) : undefined,
              severity: args['severity'] ? String(args['severity']) : undefined,
            }),
          })
        }
        break

      // ── Team communication handlers ──────────────────────────

      case 'scns_send_message':
        handler = async (args) => {
          return fetchBroker('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sender_id: String(args['sender_id'] ?? ''),
              content: String(args['content'] ?? ''),
              ...(args['receiver_id'] ? { receiver_id: String(args['receiver_id']) } : {}),
              ...(args['client_message_id']
                ? { client_message_id: String(args['client_message_id']) }
                : {}),
            }),
          })
        }
        break

      case 'scns_read_messages':
        handler = async (args) => {
          const receiverId = encodeURIComponent(String(args['receiver_id'] ?? ''))
          const unreadOnly = args['unread_only'] === true ? '?unread_only=true' : ''
          return fetchBroker(`/api/messages/${receiverId}${unreadOnly}`)
        }
        break

      case 'scns_ack_message':
        handler = async (args) => {
          return fetchBroker('/api/messages/ack', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message_id: String(args['message_id'] ?? ''),
              disposition: String(args['disposition'] ?? ''),
              ...(args['note'] ? { note: String(args['note']) } : {}),
            }),
          })
        }
        break

      case 'scns_team_status':
        handler = async (args) => {
          const teamId = encodeURIComponent(String(args['team_id'] ?? ''))
          return fetchBroker(`/api/teams/${teamId}`)
        }
        break

      case 'scns_declare_intent':
        handler = async (args) => {
          return fetchBroker('/api/declare_intent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session_id: String(args['session_id'] ?? ''),
              file: String(args['file'] ?? ''),
              ...(args['operation'] ? { operation: String(args['operation']) } : {}),
            }),
          })
        }
        break

      case 'scns_release_intent':
        handler = async (args) => {
          return fetchBroker('/api/release_intent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session_id: String(args['session_id'] ?? ''),
              file: String(args['file'] ?? ''),
            }),
          })
        }
        break

      case 'scns_set_state':
        handler = async (args) => {
          return fetchBroker('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              key: String(args['key'] ?? ''),
              value: String(args['value'] ?? ''),
              ...(args['session_id'] ? { session_id: String(args['session_id']) } : {}),
            }),
          })
        }
        break

      case 'scns_get_state':
        handler = async (args) => {
          const key = encodeURIComponent(String(args['key'] ?? ''))
          return fetchBroker(`/api/state/${key}`)
        }
        break

      case 'scns_report_progress':
        handler = async (args) => {
          const senderId = String(args['sender_id'] ?? '')
          const content = `PROGRESS: ${String(args['progress'] ?? '')}`
          // Team-scoped broadcast: look up sender's team, send direct to each member
          const teamsStr = await fetchBroker('/api/teams?status=active')
          try {
            const teamsData = JSON.parse(teamsStr)
            const teams = teamsData?.teams ?? []
            let senderTeamId: string | null = null
            for (const team of teams) {
              const memberData = JSON.parse(
                await fetchBroker(`/api/teams/${encodeURIComponent(team.id)}`),
              )
              const members = memberData?.members ?? []
              if (members.some((m: { session_id: string }) => m.session_id === senderId)) {
                senderTeamId = team.id
                // Send direct to each teammate (not self)
                for (const member of members) {
                  if (member.session_id !== senderId) {
                    await fetchBroker('/api/messages', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        sender_id: senderId,
                        receiver_id: member.session_id,
                        content,
                      }),
                    })
                  }
                }
                break
              }
            }
            if (!senderTeamId) {
              // Fallback: global broadcast if not in a team
              return fetchBroker('/api/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sender_id: senderId, content }),
              })
            }
            return JSON.stringify({ sent: true, team_id: senderTeamId })
          } catch {
            // Fallback: global broadcast
            return fetchBroker('/api/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sender_id: senderId, content }),
            })
          }
        }
        break

      case 'scns_heartbeat':
        handler = async (args) => {
          return fetchBroker('/api/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session_id: String(args['session_id'] ?? ''),
            }),
          })
        }
        break

      // ── Cross-team discovery handlers ────────────────────────

      case 'scns_list_teams':
        handler = async (args) => {
          const status = String(args['status'] ?? 'active')
          return fetchBroker(`/api/teams?status=${encodeURIComponent(status)}`)
        }
        break

      case 'scns_list_intents':
        handler = async (args) => {
          const params = new URLSearchParams()
          if (args['file']) params.set('file', String(args['file']))
          if (args['session_id']) params.set('session_id', String(args['session_id']))
          const qs = params.toString()
          return fetchBroker(`/api/intents${qs ? `?${qs}` : ''}`)
        }
        break

      // ── Task management handlers ─────────────────────────────

      case 'scns_create_task':
        handler = async (args) => {
          return fetchBroker('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              team_id: String(args['team_id'] ?? ''),
              subject: String(args['subject'] ?? ''),
              ...(args['description'] ? { description: String(args['description']) } : {}),
            }),
          })
        }
        break

      case 'scns_list_tasks':
        handler = async (args) => {
          const teamId = encodeURIComponent(String(args['team_id'] ?? ''))
          const status = args['status']
            ? `&status=${encodeURIComponent(String(args['status']))}`
            : ''
          return fetchBroker(`/api/tasks?team_id=${teamId}${status}`)
        }
        break

      case 'scns_update_task':
        handler = async (args) => {
          const taskId = Number(args['task_id'])
          const body: Record<string, unknown> = {}
          if (args['status']) body['status'] = String(args['status'])
          if (args['description']) body['description'] = String(args['description'])
          return fetchBroker(`/api/tasks/${taskId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        }
        break

      default:
        handler = async () => JSON.stringify({ error: `Unknown tool: ${definition.name}` })
    }

    return { definition, handler }
  })
}

/** Format tool definitions for the Copilot SDK joinSession() tools array */
export function toSdkTools(
  brokerUrl: string,
  timeoutMs = 500,
): readonly {
  name: string
  description: string
  parameters: ToolDefinition['parameters']
  handler: ToolHandler
}[] {
  return createToolHandlers(brokerUrl, timeoutMs).map(({ definition, handler }) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    handler,
  }))
}
