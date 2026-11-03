import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'
import {
  createOrchestrationPlan,
  requestSubTeam,
  reportTeamResults,
  checkOrchestrationComplete,
  aggregateTreeResults,
  transitionOrchestrationPhase,
  getOrchestrationPhase,
  setTaskPhase,
  type OrchestrationPhaseType,
  OrchestrationPhase,
} from '../orchestration.js'

// ─── MCP Tool Handlers ───────────────────────────────────────────────────

interface CreatePlanToolInput {
  readonly orchestrator_session_id: string
  readonly team_name: string
  readonly tasks: ReadonlyArray<{ readonly description: string; readonly repo_context?: string }>
}

export function handleCreateOrchestrationPlan(
  db: Database.Database,
  eventLog: EventLog,
  input: CreatePlanToolInput,
): ToolResult {
  try {
    const plan = createOrchestrationPlan(db, eventLog, {
      orchestratorSessionId: input.orchestrator_session_id,
      teamName: input.team_name,
      tasks: input.tasks.map((t) => ({
        description: t.description,
        repoContext: t.repo_context,
      })),
    })
    return textResult(plan)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to create orchestration plan: ${message}`)
  }
}

interface RequestSubTeamToolInput {
  readonly parent_team_id: string
  readonly name: string
  readonly repo_context: string
  readonly tasks: ReadonlyArray<{ readonly description: string }>
}

export function handleRequestSubTeam(
  db: Database.Database,
  eventLog: EventLog,
  input: RequestSubTeamToolInput,
): ToolResult {
  try {
    const result = requestSubTeam(db, eventLog, {
      parentTeamId: input.parent_team_id,
      name: input.name,
      repoContext: input.repo_context,
      tasks: input.tasks,
    })
    return textResult(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to request sub-team: ${message}`)
  }
}

interface ReportResultsToolInput {
  readonly team_id: string
  readonly results: ReadonlyArray<{
    readonly task_id: string
    readonly status: 'completed' | 'failed'
    readonly result: string
  }>
}

export function handleReportTeamResults(
  db: Database.Database,
  eventLog: EventLog,
  input: ReportResultsToolInput,
): ToolResult {
  try {
    reportTeamResults(db, eventLog, {
      teamId: input.team_id,
      results: input.results.map((r) => ({
        taskId: r.task_id,
        status: r.status,
        result: r.result,
      })),
    })
    return textResult({ reported: true, team_id: input.team_id })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to report results: ${message}`)
  }
}

interface CheckStatusToolInput {
  readonly root_team_id: string
}

export function handleCheckOrchestrationStatus(
  db: Database.Database,
  input: CheckStatusToolInput,
): ToolResult {
  try {
    const status = checkOrchestrationComplete(db, input.root_team_id)
    return textResult(status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to check orchestration status: ${message}`)
  }
}

interface AggregateResultsToolInput {
  readonly root_team_id: string
}

export function handleAggregateResults(
  db: Database.Database,
  input: AggregateResultsToolInput,
): ToolResult {
  try {
    const results = aggregateTreeResults(db, input.root_team_id)
    return textResult({ root_team_id: input.root_team_id, results })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to aggregate results: ${message}`)
  }
}

// ─── Phase Transition ─────────────────────────────────────────────────────

interface TransitionPhaseToolInput {
  readonly root_team_id: string
  readonly target_phase: string
}

export function handleTransitionOrchestrationPhase(
  db: Database.Database,
  eventLog: EventLog,
  input: TransitionPhaseToolInput,
): ToolResult {
  try {
    if (!(OrchestrationPhase as readonly string[]).includes(input.target_phase)) {
      return errorResult(`Invalid phase: '${input.target_phase}'. Valid phases: ${OrchestrationPhase.join(', ')}`)
    }
    const result = transitionOrchestrationPhase(
      db,
      eventLog,
      input.root_team_id,
      input.target_phase as OrchestrationPhaseType,
    )
    return textResult(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to transition phase: ${message}`)
  }
}

interface GetPhaseToolInput {
  readonly root_team_id: string
}

export function handleGetOrchestrationPhase(
  db: Database.Database,
  input: GetPhaseToolInput,
): ToolResult {
  try {
    const phase = getOrchestrationPhase(db, input.root_team_id)
    return textResult({ root_team_id: input.root_team_id, phase })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to get orchestration phase: ${message}`)
  }
}

// ─── Task Phase Tagging ──────────────────────────────────────────────────

interface SetTaskPhaseToolInput {
  readonly root_team_id: string
  readonly task_id: string
  readonly phase: string
}

export function handleSetTaskPhase(
  db: Database.Database,
  input: SetTaskPhaseToolInput,
): ToolResult {
  if (!input.root_team_id) {
    return errorResult('root_team_id is required')
  }
  if (!input.task_id) {
    return errorResult('task_id is required')
  }
  if (!input.phase) {
    return errorResult('phase is required')
  }

  const validPhases = OrchestrationPhase as readonly string[]
  if (!validPhases.includes(input.phase)) {
    return errorResult(`Invalid phase '${input.phase}'. Must be one of: ${OrchestrationPhase.join(', ')}`)
  }

  try {
    setTaskPhase(db, input.root_team_id, input.task_id, input.phase as OrchestrationPhaseType)
    return textResult({
      root_team_id: input.root_team_id,
      task_id: input.task_id,
      phase: input.phase,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to set task phase: ${message}`)
  }
}
