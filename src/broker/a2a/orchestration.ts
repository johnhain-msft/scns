import type { TeamManifest, ReconcileAction, TeamState } from './team-manifest.js'

// ---------------------------------------------------------------------------
// Orchestration Phase constants
// ---------------------------------------------------------------------------

export const OrchestrationPhase = {
  Research: 'research',
  Synthesis: 'synthesis',
  Planning: 'planning',
  Implementation: 'implementation',
  Review: 'review',
  Verification: 'verification',
} as const

export type OrchestrationPhase = (typeof OrchestrationPhase)[keyof typeof OrchestrationPhase]

// ---------------------------------------------------------------------------
// Phase & orchestration state types
// ---------------------------------------------------------------------------

export interface PhaseStatus {
  readonly phase: string
  readonly status: 'pending' | 'active' | 'gated' | 'complete'
  readonly tasks: readonly { readonly taskId: string; readonly status: string }[]
  readonly gateCondition: string
  readonly gateMet: boolean
}

export interface OrchestrationState {
  readonly teamId: string
  readonly manifestId: string
  readonly currentPhase: string | null
  readonly phases: readonly PhaseStatus[]
  readonly overallStatus: 'pending' | 'running' | 'completed' | 'failed'
}

// ---------------------------------------------------------------------------
// Gate-checking helpers
// ---------------------------------------------------------------------------

function checkAllComplete(tasks: readonly { readonly status: string }[]): boolean {
  return tasks.length > 0 && tasks.every((t) => t.status === 'completed')
}

function checkAnyComplete(tasks: readonly { readonly status: string }[]): boolean {
  return tasks.some((t) => t.status === 'completed')
}

function checkMajorityComplete(tasks: readonly { readonly status: string }[]): boolean {
  if (tasks.length === 0) return false
  const completed = tasks.filter((t) => t.status === 'completed').length
  return completed > tasks.length / 2
}

function allTasksFailed(tasks: readonly { readonly status: string }[]): boolean {
  return tasks.length > 0 && tasks.every((t) => t.status === 'failed')
}

// ---------------------------------------------------------------------------
// Task ID generation
// ---------------------------------------------------------------------------

let taskCounter = 0

function nextTaskId(phaseName: string): string {
  taskCounter += 1
  return `${phaseName}-task-${taskCounter}`
}

// ---------------------------------------------------------------------------
// Orchestration Engine
// ---------------------------------------------------------------------------

export function createOrchestrationEngine() {
  return {
    initialize(manifest: TeamManifest, teamId: string): OrchestrationState {
      const phases: PhaseStatus[] = (manifest.phases ?? []).map((p, idx) => {
        // Count how many tasks this phase needs based on the role counts
        const taskCount = manifest.roles
          .filter((r) => p.roles.includes(r.role))
          .reduce((sum, r) => sum + r.count, 0)

        const tasks = Array.from({ length: taskCount }, () => ({
          taskId: nextTaskId(p.name),
          status: 'pending' as const,
        }))

        return {
          phase: p.name,
          status: idx === 0 ? ('active' as const) : ('pending' as const),
          tasks,
          gateCondition: p.gateCondition,
          gateMet: false,
        }
      })

      return {
        teamId,
        manifestId: manifest.id,
        currentPhase: phases[0]?.phase ?? null,
        phases,
        overallStatus: 'running',
      }
    },

    advance(state: OrchestrationState): OrchestrationState {
      const activeIdx = state.phases.findIndex((p) => p.status === 'active')
      if (activeIdx === -1) return state

      const activePhase = state.phases[activeIdx]!

      // Check if all tasks failed
      if (allTasksFailed(activePhase.tasks)) {
        return {
          ...state,
          currentPhase: null,
          phases: state.phases.map((p, i) =>
            i === activeIdx ? { ...p, status: 'complete' as const, gateMet: false } : p,
          ),
          overallStatus: 'failed',
        }
      }

      // Check gate
      if (!this.checkGate(activePhase)) return state

      // Mark current phase complete
      const newPhases = state.phases.map((p, i) => {
        if (i === activeIdx) return { ...p, status: 'complete' as const, gateMet: true }
        if (i === activeIdx + 1) return { ...p, status: 'active' as const }
        return p
      })

      const nextPhase = newPhases[activeIdx + 1]
      const allComplete = newPhases.every((p) => p.status === 'complete')

      return {
        ...state,
        currentPhase: nextPhase?.phase ?? null,
        phases: newPhases,
        overallStatus: allComplete ? 'completed' : state.overallStatus,
      }
    },

    updateTask(state: OrchestrationState, taskId: string, status: string): OrchestrationState {
      let found = false
      const newPhases = state.phases.map((p) => {
        const taskIdx = p.tasks.findIndex((t) => t.taskId === taskId)
        if (taskIdx === -1) return p
        found = true
        const newTasks = p.tasks.map((t, i) => (i === taskIdx ? { ...t, status } : t))
        return { ...p, tasks: newTasks }
      })

      if (!found) return state
      return { ...state, phases: newPhases }
    },

    checkGate(phase: PhaseStatus): boolean {
      switch (phase.gateCondition) {
        case 'all-complete':
          return checkAllComplete(phase.tasks)
        case 'any-complete':
          return checkAnyComplete(phase.tasks)
        case 'majority-complete':
          return checkMajorityComplete(phase.tasks)
        default:
          return false
      }
    },

    getCurrentPhase(state: OrchestrationState): PhaseStatus | null {
      return state.phases.find((p) => p.status === 'active') ?? null
    },

    isComplete(state: OrchestrationState): boolean {
      return state.overallStatus === 'completed' || state.overallStatus === 'failed'
    },

    reconcile(manifest: TeamManifest, actual: TeamState): readonly ReconcileAction[] {
      const actions: ReconcileAction[] = []

      for (const slot of manifest.roles) {
        const actualCount = actual.members.filter((m) => m.role === slot.role).length
        const desired = slot.count

        if (desired > actualCount) {
          actions.push({
            type: 'spawn',
            role: slot.role,
            count: desired - actualCount,
            reason: `Need ${desired - actualCount} more ${slot.role}(s)`,
          })
        } else if (desired < actualCount) {
          actions.push({
            type: 'kill',
            role: slot.role,
            count: actualCount - desired,
            reason: `Excess ${actualCount - desired} ${slot.role}(s)`,
          })
        } else {
          actions.push({
            type: 'noop',
            role: slot.role,
            count: 0,
            reason: `${slot.role} count matches`,
          })
        }
      }

      return actions
    },
  }
}
