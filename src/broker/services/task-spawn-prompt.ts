/**
 * Build a role-aware prompt for an agent spawned against a stored task.
 *
 * Pure function. Reuses role copy from src/cli/team-member-prompts.ts so
 * task-driven and suggestion-driven spawns produce consistent agent framing.
 */

import {
  buildImplementerPrompt,
  buildManagerPrompt,
  buildQaPrompt,
  buildResearcherPrompt,
  type TeamMemberPromptContext,
} from '../../cli/team-member-prompts.js'

export interface TaskSpawnPromptTeam {
  readonly id: string
  readonly name?: string | null
}

export interface TaskSpawnPromptTask {
  readonly id: number
  readonly subject: string
  readonly description?: string | null
}

export interface BuildTaskSpawnPromptInput {
  readonly role: string
  readonly team: TaskSpawnPromptTeam
  readonly task: TaskSpawnPromptTask
  readonly projectRoot: string
  readonly extraContext?: string
}

/**
 * Roles that have a bespoke task-spawn prompt strategy and can therefore be
 * auto-spawned for a task. Distinct from "registered roles" (agent_roles): a
 * novel role can be a team member without yet being task-spawnable. Exported so
 * routes/validation share one source of truth instead of duplicating the list.
 */
export const SUPPORTED_TASK_SPAWN_ROLES: readonly string[] = [
  'scns-manager',
  'scns-dev',
  'scns-qa',
  'scns-researcher',
]

export function isTaskSpawnRoleSupported(role: string): boolean {
  return SUPPORTED_TASK_SPAWN_ROLES.includes(role)
}

const SUPPORTED_ROLES = new Set(SUPPORTED_TASK_SPAWN_ROLES)
const MAX_DESCRIPTION_CHARS = 6000
const TRUNCATION_MARKER = '\n[…description truncated for prompt budget…]'

export function buildTaskSpawnPrompt(input: BuildTaskSpawnPromptInput): string {
  const { role, team, task, projectRoot, extraContext } = input
  if (!SUPPORTED_ROLES.has(role)) {
    throw new Error(
      `Unsupported role for task spawn: ${role}. Expected one of: ${SUPPORTED_TASK_SPAWN_ROLES.join(', ')}`,
    )
  }

  const description = truncateDescription(task.description ?? null)
  const augmentedDescription = buildAugmentedDescription({
    taskId: task.id,
    teamName: team.name ?? null,
    description,
    extraContext,
  })

  const ctx: TeamMemberPromptContext = {
    role,
    teamId: team.id,
    goal: task.subject,
    description: augmentedDescription,
    projectRoot,
  }

  if (role === 'scns-manager') return buildManagerPrompt(ctx)
  if (role === 'scns-qa') return buildQaPrompt(ctx)
  if (role === 'scns-researcher') return buildResearcherPrompt(ctx)
  return buildImplementerPrompt(ctx)
}

function truncateDescription(description: string | null): string | null {
  if (description == null) return null
  if (description.length <= MAX_DESCRIPTION_CHARS) return description
  return description.slice(0, MAX_DESCRIPTION_CHARS) + TRUNCATION_MARKER
}

function buildAugmentedDescription(opts: {
  taskId: number
  teamName: string | null
  description: string | null
  extraContext: string | undefined
}): string {
  const lines: string[] = []
  lines.push(`Task ID: ${opts.taskId}`)
  if (opts.teamName) lines.push(`Team: ${opts.teamName}`)
  if (opts.description) {
    lines.push('')
    lines.push(opts.description)
  }
  if (opts.extraContext) {
    lines.push('')
    lines.push('## Additional Context')
    lines.push(opts.extraContext)
  }
  return lines.join('\n')
}
