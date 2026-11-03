import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { EventLog } from './services/event-log.js'
import { createTeam, findTeamById, getTeamTree } from './storage/repositories/team-repository.js'
import { createTask, findTasksByTeam, updateTask } from './storage/repositories/task-repository.js'
import { getState, setState } from './storage/repositories/state-repository.js'
import { ConflictError, ValidationError } from './errors.js'

// ─── Phase Types ──────────────────────────────────────────────────────────

export const OrchestrationPhase = ['research', 'synthesis', 'implementation', 'verification'] as const
export type OrchestrationPhaseType = (typeof OrchestrationPhase)[number]

/** Valid forward-only transitions between phases. */
const ALLOWED_TRANSITIONS: Readonly<Record<OrchestrationPhaseType, OrchestrationPhaseType | null>> = {
  research: 'synthesis',
  synthesis: 'implementation',
  implementation: 'verification',
  verification: null,
}

/** Phases that require all tagged tasks to be completed before transition. */
const TASK_GATE_PHASES: ReadonlySet<OrchestrationPhaseType> = new Set(['research', 'implementation'])

interface PhaseTransitionResult {
  readonly phase: OrchestrationPhaseType
  readonly previous_phase: OrchestrationPhaseType
  readonly transitioned_at: string
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface OrchestrationTask {
  readonly taskId: string
  readonly teamId: string
  readonly repoContext?: string
  readonly description: string
  readonly status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed'
  readonly result?: string
}

export interface OrchestrationPlan {
  readonly rootTeamId: string
  readonly tasks: readonly OrchestrationTask[]
  readonly status: 'planning' | 'executing' | 'collecting' | 'completed' | 'failed'
  readonly phase: OrchestrationPhaseType
}

export interface OrchestrationStatus {
  readonly complete: boolean
  readonly summary: {
    readonly total: number
    readonly completed: number
    readonly failed: number
    readonly pending: number
  }
  readonly results: ReadonlyArray<{
    readonly taskId: string
    readonly teamId: string
    readonly status: string
    readonly result?: string
  }>
}

interface CreatePlanInput {
  readonly orchestratorSessionId: string
  readonly teamName: string
  readonly tasks: ReadonlyArray<{ readonly description: string; readonly repoContext?: string }>
}

interface RequestSubTeamInput {
  readonly parentTeamId: string
  readonly name: string
  readonly repoContext: string
  readonly tasks: ReadonlyArray<{ readonly description: string }>
}

interface ReportResultsInput {
  readonly teamId: string
  readonly results: ReadonlyArray<{
    readonly taskId: string
    readonly status: 'completed' | 'failed'
    readonly result: string
  }>
}

// ─── Implementation ───────────────────────────────────────────────────────

export function createOrchestrationPlan(
  db: Database.Database,
  eventLog: EventLog,
  input: CreatePlanInput,
): OrchestrationPlan {
  const teamId = randomUUID()
  createTeam(db, { id: teamId, name: input.teamName })

  eventLog.teamCreated(input.orchestratorSessionId, {
    team_id: teamId,
    name: input.teamName,
    orchestration: true,
  })

  const tasks = input.tasks.map((t) => createOrchestrationTask(db, eventLog, teamId, t))

  // Initialize phase to 'research' in shared_state
  setPhaseState(db, teamId, 'research')

  return { rootTeamId: teamId, tasks, status: 'planning', phase: 'research' }
}

function createOrchestrationTask(
  db: Database.Database,
  eventLog: EventLog,
  teamId: string,
  input: { readonly description: string; readonly repoContext?: string },
): OrchestrationTask {
  const task = createTask(db, { team_id: teamId, subject: input.description })

  eventLog.taskCreated(null, {
    task_id: task.id,
    team_id: teamId,
    subject: input.description,
    orchestration: true,
  })

  return {
    taskId: String(task.id),
    teamId,
    description: input.description,
    status: 'pending',
    ...(input.repoContext ? { repoContext: input.repoContext } : {}),
  }
}

export function requestSubTeam(
  db: Database.Database,
  eventLog: EventLog,
  input: RequestSubTeamInput,
): { readonly teamId: string; readonly taskIds: readonly string[] } {
  const parent = findTeamById(db, input.parentTeamId)
  if (!parent) {
    throw new Error(`Parent team '${input.parentTeamId}' not found`)
  }

  const teamId = randomUUID()
  createTeam(db, { id: teamId, name: input.name, parent_team_id: input.parentTeamId })

  eventLog.teamCreated(null, {
    team_id: teamId,
    name: input.name,
    parent_team_id: input.parentTeamId,
    repo_context: input.repoContext,
    orchestration: true,
  })

  const taskIds = input.tasks.map((t) => {
    const task = createTask(db, { team_id: teamId, subject: t.description })
    eventLog.taskCreated(null, {
      task_id: task.id,
      team_id: teamId,
      subject: t.description,
      orchestration: true,
    })
    return String(task.id)
  })

  return { teamId, taskIds }
}

export function reportTeamResults(
  db: Database.Database,
  eventLog: EventLog,
  input: ReportResultsInput,
): void {
  for (const result of input.results) {
    const taskId = Number(result.taskId)
    const dbStatus = result.status === 'failed' ? 'failed' : 'completed'
    updateTask(db, taskId, { status: dbStatus, active_form: result.result })

    const eventFn = result.status === 'completed'
      ? eventLog.taskCompleted
      : eventLog.taskUpdated

    eventFn(null, {
      task_id: taskId,
      team_id: input.teamId,
      status: result.status,
      result: result.result,
      orchestration: true,
    })
  }
}

export function checkOrchestrationComplete(
  db: Database.Database,
  rootTeamId: string,
): OrchestrationStatus {
  const tree = getTeamTree(db, rootTeamId)
  const allTasks = collectTreeTasks(db, tree.map((t) => t.id))

  const completed = allTasks.filter((t) => t.status === 'completed').length
  const failed = allTasks.filter((t) => t.status === 'failed').length
  const pending = allTasks.length - completed - failed

  return {
    complete: pending === 0,
    summary: { total: allTasks.length, completed, failed, pending },
    results: allTasks.map((t) => ({
      taskId: String(t.id),
      teamId: t.team_id,
      status: t.status === 'failed' ? 'failed' : t.status,
      ...(t.active_form ? { result: t.active_form } : {}),
    })),
  }
}

function collectAllTasksForTeam(
  db: Database.Database,
  teamId: string,
): ReadonlyArray<{ readonly id: number; readonly team_id: string; readonly subject: string; readonly status: string; readonly active_form: string | null }> {
  // findTasksByTeam without status excludes 'deleted'; include them separately
  const activeTasks = findTasksByTeam(db, teamId)
  const deletedTasks = findTasksByTeam(db, teamId, 'deleted')
  return [...activeTasks, ...deletedTasks].map((t) => ({
    id: t.id,
    team_id: t.team_id,
    subject: t.subject,
    status: t.status,
    active_form: t.active_form ?? null,
  }))
}

function collectTreeTasks(
  db: Database.Database,
  teamIds: readonly string[],
): ReadonlyArray<{ readonly id: number; readonly team_id: string; readonly subject: string; readonly status: string; readonly active_form: string | null }> {
  return teamIds.flatMap((teamId) => collectAllTasksForTeam(db, teamId))
}

export function aggregateTreeResults(
  db: Database.Database,
  rootTeamId: string,
): string {
  const tree = getTeamTree(db, rootTeamId)
  const sections: string[] = []

  for (const team of tree) {
    const allTasks = collectAllTasksForTeam(db, team.id)
    const taskLines = buildTaskLines(allTasks)

    if (taskLines.length > 0) {
      sections.push(`## ${team.name}\n${taskLines.join('\n')}`)
    }
  }

  return sections.join('\n\n')
}

function buildTaskLines(
  tasks: ReadonlyArray<{ readonly subject: string; readonly status: string; readonly active_form?: string | null }>,
): readonly string[] {
  return tasks.map((t) => {
    const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '⏳'
    const result = t.active_form ? `: ${t.active_form}` : ''
    return `- ${icon} ${t.subject}${result}`
  })
}

// ─── Phase Management ─────────────────────────────────────────────────────

function phaseStateKey(rootTeamId: string): string {
  return `orchestration:${rootTeamId}:phase`
}

function taskPhasesKey(rootTeamId: string): string {
  return `orchestration:${rootTeamId}:task_phases`
}

function isValidPhase(phase: string): phase is OrchestrationPhaseType {
  return (OrchestrationPhase as readonly string[]).includes(phase)
}

function setPhaseState(db: Database.Database, rootTeamId: string, phase: OrchestrationPhaseType): void {
  setState(db, {
    key: phaseStateKey(rootTeamId),
    value: JSON.stringify({ phase, transitioned_at: new Date().toISOString() }),
    story_id: null,
    session_id: null,
  })
}

/** Get the current orchestration phase for a plan. Defaults to 'research'. */
export function getOrchestrationPhase(db: Database.Database, rootTeamId: string): OrchestrationPhaseType {
  const entry = getState(db, phaseStateKey(rootTeamId))
  if (!entry) return 'research'
  try {
    const parsed: unknown = JSON.parse(entry.value)
    if (typeof parsed === 'object' && parsed !== null && 'phase' in parsed) {
      const candidate = (parsed as { phase: string }).phase
      return isValidPhase(candidate) ? candidate : 'research'
    }
    return 'research'
  } catch {
    return 'research'
  }
}

/** Set the phase tag for a specific task within an orchestration plan. */
export function setTaskPhase(
  db: Database.Database,
  rootTeamId: string,
  taskId: string,
  phase: OrchestrationPhaseType,
): void {
  const existing = getTaskPhases(db, rootTeamId)
  const updated = { ...existing, [taskId]: phase }
  setState(db, {
    key: taskPhasesKey(rootTeamId),
    value: JSON.stringify(updated),
    story_id: null,
    session_id: null,
  })
}

/** Get all task-to-phase mappings for an orchestration plan. */
export function getTaskPhases(
  db: Database.Database,
  rootTeamId: string,
): Readonly<Record<string, OrchestrationPhaseType>> {
  const entry = getState(db, taskPhasesKey(rootTeamId))
  if (!entry) return {}
  try {
    const parsed: unknown = JSON.parse(entry.value)
    if (typeof parsed !== 'object' || parsed === null) return {}

    const result: Record<string, OrchestrationPhaseType> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && isValidPhase(value)) {
        result[key] = value
      }
    }
    return result
  } catch {
    return {}
  }
}

function validateTaskGate(
  db: Database.Database,
  eventLog: EventLog,
  rootTeamId: string,
  currentPhase: OrchestrationPhaseType,
): void {
  if (!TASK_GATE_PHASES.has(currentPhase)) return

  const taskPhaseMap = getTaskPhases(db, rootTeamId)
  const tree = getTeamTree(db, rootTeamId)
  const allTasks = tree.flatMap((team) => {
    const active = findTasksByTeam(db, team.id)
    const deleted = findTasksByTeam(db, team.id, 'deleted')
    return [...active, ...deleted]
  })

  const tasksForPhase = allTasks.filter((t) => taskPhaseMap[String(t.id)] === currentPhase)
  if (tasksForPhase.length === 0) {
    // Gate is vacuously satisfied — no tasks tagged for this phase.
    // Emit warning so orchestrator can detect unintentional skips.
    eventLog.orchestrationPhaseTransitioned(null, {
      root_team_id: rootTeamId,
      from_phase: currentPhase,
      to_phase: currentPhase,
      warning: `No tasks tagged for '${currentPhase}' phase — gate passed vacuously. Use set_task_phase to tag tasks.`,
    })
    return
  }

  const incomplete = tasksForPhase.filter((t) => t.status !== 'completed' && t.status !== 'deleted' && t.status !== 'failed')
  if (incomplete.length > 0) {
    throw new ConflictError(
      `Cannot transition from '${currentPhase}': ${incomplete.length} ${currentPhase} task(s) not completed`,
    )
  }
}

/** Transition the orchestration plan to a new phase with validation. */
export function transitionOrchestrationPhase(
  db: Database.Database,
  eventLog: EventLog,
  rootTeamId: string,
  targetPhase: OrchestrationPhaseType,
): PhaseTransitionResult {
  if (!isValidPhase(targetPhase)) {
    throw new ValidationError(`Invalid phase: '${targetPhase}'`, { target_phase: 'must be a valid orchestration phase' })
  }

  const currentPhase = getOrchestrationPhase(db, rootTeamId)

  if (currentPhase === targetPhase) {
    throw new ConflictError(`Orchestration is already in '${currentPhase}' phase`)
  }

  const allowedNext = ALLOWED_TRANSITIONS[currentPhase]
  if (allowedNext !== targetPhase) {
    throw new ConflictError(
      `Invalid transition from '${currentPhase}' to '${targetPhase}'. ` +
      (allowedNext ? `Allowed: '${currentPhase}' → '${allowedNext}'` : `No transitions allowed from '${currentPhase}'`),
    )
  }

  // Validate task completion gates
  validateTaskGate(db, eventLog, rootTeamId, currentPhase)

  const transitionedAt = new Date().toISOString()
  setPhaseState(db, rootTeamId, targetPhase)

  eventLog.orchestrationPhaseTransitioned(null, {
    root_team_id: rootTeamId,
    from_phase: currentPhase,
    to_phase: targetPhase,
    transitioned_at: transitionedAt,
  })

  return { phase: targetPhase, previous_phase: currentPhase, transitioned_at: transitionedAt }
}
