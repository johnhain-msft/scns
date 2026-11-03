/**
 * P7 — Meta-broker module barrel.
 */
export {
  applyMetaSchema,
  registerProject,
  listProjects,
  getProject,
  getProjectByRoot,
  removeProject,
  updateChildState,
  recordHealthFailure,
  resetHealthFailures,
  resetProject,
  wakeIdleProject,
  recordProjectResolved,
} from './registry.js'
export type {
  ProjectRow,
  RegisterProjectInput,
  ProjectChildState,
  ProjectStatus,
  StoppedReason,
} from './registry.js'

export { allocatePort, DEFAULT_PORT_POOL_START, DEFAULT_PORT_POOL_SIZE } from './port-allocator.js'
export type { AllocatePortInput } from './port-allocator.js'

export { shouldRestart } from './restart-policy.js'
export type { RestartDecisionInput, RestartDecision } from './restart-policy.js'

export { planTick, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_REAP_COOLDOWN_MS } from './supervisor-tick.js'
export type { TickAction, TickPlan, TickPolicy, PlanTickInput } from './supervisor-tick.js'

export { createMetaSupervisor } from './meta-supervisor.js'
export type { MetaSupervisor, MetaSupervisorConfig, ChildProbeResult } from './meta-supervisor.js'
