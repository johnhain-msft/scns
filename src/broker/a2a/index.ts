// A2A Protocol Primitives — Phase 7 Wave 1

// Agent Card
export { AgentCardSchema, createAgentCardRegistry } from './agent-card.js'
export type { AgentCard, AgentCardRegistry } from './agent-card.js'

// JSON-RPC 2.0
export {
  JsonRpcVersion,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  JsonRpcErrorSchema,
  JsonRpcNotificationSchema,
  JsonRpcErrorCode,
  createRequest,
  createResponse,
  createError,
  createNotification,
  isRequest,
  isResponse,
  isError,
  isNotification,
} from './jsonrpc.js'
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcNotification,
} from './jsonrpc.js'

// Task State Machine
export { A2ATaskStatus, VALID_TRANSITIONS, createA2ATaskStateMachine } from './task-state.js'
export type { A2ATask, TaskTransition, A2ATaskStateMachine } from './task-state.js'

// Auto-scaler
export { createAutoScaler } from './auto-scaler.js'
export type {
  AutoScalerOptions,
  ScalerDeps,
  ScaleDecision,
  ScaleResult,
  ScalerStatus,
} from './auto-scaler.js'

// Respawn Controller
export { createRespawnController } from './respawn-controller.js'
export type {
  RespawnControllerOptions,
  RespawnDeps,
  DeadAgent,
  RespawnResult,
  RespawnStats,
} from './respawn-controller.js'

// Team Manifest
export { TeamManifestSchema, RoleSlotSchema } from './team-manifest.js'
export type { TeamManifest, RoleSlot, ReconcileAction, TeamState } from './team-manifest.js'

// Team Templates
export { getTeamTemplate, listTeamTemplates } from './templates.js'

// Orchestration
export { OrchestrationPhase, createOrchestrationEngine } from './orchestration.js'
export type { PhaseStatus, OrchestrationState } from './orchestration.js'

// Team Orchestrator
export { createTeamOrchestrator } from './team-orchestrator.js'
export type {
  TeamOrchestrator,
  TeamOrchestratorDeps,
  TeamOrchestratorStatus,
} from './team-orchestrator.js'
