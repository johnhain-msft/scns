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
  setGlobalTargets,
  getGlobalTargets,
  GLOBAL_BROKER_ID,
} from './registry.js'
export type {
  ProjectRow,
  RegisterProjectInput,
  ProjectChildState,
  ProjectStatus,
  GlobalTargets,
} from './registry.js'

export { allocatePort, DEFAULT_PORT_POOL_START, DEFAULT_PORT_POOL_SIZE } from './port-allocator.js'
export type { AllocatePortInput } from './port-allocator.js'

export { shouldRestart } from './restart-policy.js'
export type { RestartDecisionInput, RestartDecision } from './restart-policy.js'

export { planTick } from './supervisor-tick.js'
export type { TickAction, TickPlan, TickPolicy, PlanTickInput } from './supervisor-tick.js'

export { createMetaSupervisor } from './meta-supervisor.js'
export type { MetaSupervisor, MetaSupervisorConfig } from './meta-supervisor.js'
