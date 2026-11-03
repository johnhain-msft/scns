/**
 * Phase 13.13.x — WS F: Pure orchestration helper for broker-mechanical
 * dispatch.
 *
 * When a task is spawned with role=scns-manager, the broker auto-spawns one
 * scns-dev and one scns-qa for that task on the same team. This module is
 * the pure planning layer:
 *
 *   - {@link planAutoDispatch} computes the two SpawnRequest descriptors
 *     (roles, names, prompts, working_dir, dispatch_id) for the dev + qa
 *     spawns. No I/O, no DB, no spawn calls.
 *   - {@link synthesizeReadbackBody} formats a Dispatch Readback block whose
 *     shape is the same one parsed by {@link parseManagerReadback}, so the
 *     existing WS C manager-exit-monitor sees a complete dispatch and does
 *     NOT emit `manager_dispatch_incomplete` in the success case.
 *
 * The actual spawn calls and message inserts live in agent-spawner.ts.
 */
import { randomUUID } from 'node:crypto'
import { buildTaskSpawnPrompt } from './task-spawn-prompt.js'

export interface AutoDispatchTask {
  readonly id: number
  readonly subject: string
  readonly description?: string | null
}

export interface AutoDispatchTeam {
  readonly id: string
  readonly name?: string | null
}

export interface AutoDispatchManagerSession {
  readonly sessionId: string
}

export interface AutoDispatchSpawnRequest {
  readonly team_id: string
  readonly name: string
  readonly role: 'scns-dev' | 'scns-qa'
  readonly working_dir: string
  readonly prompt: string
  readonly extra_context: string
  readonly dispatch_id: string
}

export interface AutoDispatchPlan {
  readonly dev: AutoDispatchSpawnRequest
  readonly qa: AutoDispatchSpawnRequest
}

export interface PlanAutoDispatchInput {
  readonly task: AutoDispatchTask
  readonly managerSession: AutoDispatchManagerSession
  readonly team: AutoDispatchTeam
  readonly workingDir: string
  /** Test seam — defaults to crypto.randomUUID. */
  readonly uuid?: () => string
}

export type AutoDispatchOutcome =
  | { readonly kind: 'spawned'; readonly sessionId: string }
  | { readonly kind: 'existing_owner'; readonly existingOwner: string }

export interface SynthesizeReadbackInput {
  readonly devOutcome: AutoDispatchOutcome
  readonly qaOutcome: AutoDispatchOutcome
  readonly notes: string
}

/**
 * WS M (Phase 13.13.x) — Strict dispatch_id attribution.
 *
 * Payload of the `dispatch_started` event emitted once per auto-dispatch.
 * Binds each spawned dev/qa session_id to the uuid dispatch_id assigned
 * by {@link planAutoDispatch}, plus the wall-clock dispatch start time.
 * Downstream consumers (dev-productivity-monitor, task-completion-gate)
 * use this to attribute work strictly to the originating dispatch
 * instead of free-floating mtimes / total staged-numstat heuristics.
 *
 * For existing-owner outcomes, session_id is recorded as `409:<owner>`
 * to match how {@link synthesizeReadbackBody} encodes the same case.
 */
export interface DispatchStartedRoleEntry {
  readonly session_id: string
  readonly dispatch_id: string
}

export interface DispatchStartedPayload {
  readonly task_id: number
  readonly team_id: string
  readonly manager_session_id: string
  readonly started_at: string
  readonly dev: DispatchStartedRoleEntry
  readonly qa: DispatchStartedRoleEntry
}

export interface BuildDispatchStartedInput {
  readonly plan: AutoDispatchPlan
  readonly devOutcome: AutoDispatchOutcome
  readonly qaOutcome: AutoDispatchOutcome
  readonly task: { readonly id: number }
  readonly teamId: string
  readonly managerSessionId: string
  readonly startedAt: Date
}

export function planAutoDispatch(input: PlanAutoDispatchInput): AutoDispatchPlan {
  const { task, managerSession, team, workingDir } = input
  const uuid = input.uuid ?? randomUUID

  const devDispatchId = uuid()
  const qaDispatchId = uuid()

  const devExtra = buildExtraContext({
    role: 'scns-dev',
    taskId: task.id,
    managerSessionId: managerSession.sessionId,
    dispatchId: devDispatchId,
  })
  const qaExtra = buildExtraContext({
    role: 'scns-qa',
    taskId: task.id,
    managerSessionId: managerSession.sessionId,
    dispatchId: qaDispatchId,
  })

  const devPrompt = buildTaskSpawnPrompt({
    role: 'scns-dev',
    team: { id: team.id, name: team.name ?? null },
    task: { id: task.id, subject: task.subject, description: task.description ?? null },
    projectRoot: workingDir,
    extraContext: devExtra,
  })
  const qaPrompt = buildTaskSpawnPrompt({
    role: 'scns-qa',
    team: { id: team.id, name: team.name ?? null },
    task: { id: task.id, subject: task.subject, description: task.description ?? null },
    projectRoot: workingDir,
    extraContext: qaExtra,
  })

  return {
    dev: {
      team_id: team.id,
      name: `task-${task.id}-scns-dev-${devDispatchId.slice(0, 8)}`,
      role: 'scns-dev',
      working_dir: workingDir,
      prompt: devPrompt,
      extra_context: devExtra,
      dispatch_id: devDispatchId,
    },
    qa: {
      team_id: team.id,
      name: `task-${task.id}-scns-qa-${qaDispatchId.slice(0, 8)}`,
      role: 'scns-qa',
      working_dir: workingDir,
      prompt: qaPrompt,
      extra_context: qaExtra,
      dispatch_id: qaDispatchId,
    },
  }
}

function buildExtraContext(opts: {
  role: 'scns-dev' | 'scns-qa'
  taskId: number
  managerSessionId: string
  dispatchId: string
}): string {
  return [
    `## Broker Auto-Dispatch`,
    `task_id: ${opts.taskId}`,
    `manager_session_id: ${opts.managerSessionId}`,
    `dispatch_id: ${opts.dispatchId}`,
    `role: ${opts.role}`,
    ``,
    `You were spawned automatically by the broker against the manager's team.`,
    `Attribute any output (messages, diffs, completion calls) to the dispatch_id above.`,
  ].join('\n')
}

/**
 * Render an outcome as the `<id>` token used inside the Dispatch Readback
 * block. Existing-owner collisions are encoded as `409:<existingOwner>` so
 * the broadcast records the conflict instead of silently dropping it.
 */
function renderOutcome(outcome: AutoDispatchOutcome): string {
  if (outcome.kind === 'spawned') return outcome.sessionId
  return `409:${outcome.existingOwner}`
}

export function synthesizeReadbackBody(input: SynthesizeReadbackInput): string {
  const dev = renderOutcome(input.devOutcome)
  const qa = renderOutcome(input.qaOutcome)
  const notes = input.notes.replace(/\n/g, ' ').trim() || 'broker auto-dispatch'
  return [
    `Dispatch Readback:`,
    `  dev_session_id: ${dev}`,
    `  qa_session_id: ${qa}`,
    `  notes: ${notes}`,
  ].join('\n')
}

/**
 * WS M (Phase 13.13.x) — pure builder for the `dispatch_started` event
 * payload. Kept separate from the I/O-bound emission in agent-spawner so
 * the shape is unit-testable and stable.
 */
export function buildDispatchStartedPayload(
  input: BuildDispatchStartedInput,
): DispatchStartedPayload {
  return {
    task_id: input.task.id,
    team_id: input.teamId,
    manager_session_id: input.managerSessionId,
    started_at: input.startedAt.toISOString(),
    dev: {
      session_id: renderOutcome(input.devOutcome),
      dispatch_id: input.plan.dev.dispatch_id,
    },
    qa: {
      session_id: renderOutcome(input.qaOutcome),
      dispatch_id: input.plan.qa.dispatch_id,
    },
  }
}
