/**
 * Progressive Autonomy — L0-L3 level enforcement and guardrails.
 *
 * Re-exports base autonomy state management from shared/autonomy.ts
 * and adds action-level guardrail enforcement.
 *
 * Levels:
 *   L0 — Observer: can only observe and log. No actions.
 *   L1 — Advisor: can suggest but not execute. Read-only operations allowed.
 *   L2 — Assistant: can execute pre-approved/low-risk actions.
 *   L3 — Autonomous: full autonomy within guardrails.
 */

// Re-export base autonomy management
export {
  loadAutonomy,
  saveAutonomy,
  seedAutonomyIfAbsent,
  promote,
  demote,
  getAutonomyDescription,
  type AutonomyState,
} from '../shared/autonomy.js'

// ── Action types ─────────────────────────────────────────────

export const AutonomyAction = {
  // Read-only
  Observe: 'observe',
  Search: 'search',
  ReadMemory: 'read-memory',
  ListSessions: 'list-sessions',

  // Advisory
  GenerateSuggestion: 'generate-suggestion',
  AnalyzePattern: 'analyze-pattern',
  Consolidate: 'consolidate',

  // Write / execute
  SpawnAgent: 'spawn-agent',
  ExecuteSuggestion: 'execute-suggestion',
  RotateContext: 'rotate-context',
  ModifyMemory: 'modify-memory',

  // Destructive
  KillSession: 'kill-session',
  RestartBroker: 'restart-broker',
  PromoteAutonomy: 'promote-autonomy',
} as const
export type AutonomyAction = (typeof AutonomyAction)[keyof typeof AutonomyAction]

// ── Permission matrix ────────────────────────────────────────

/** Actions allowed at each autonomy level */
const LEVEL_PERMISSIONS: Record<number, ReadonlySet<AutonomyAction>> = {
  0: new Set([
    AutonomyAction.Observe,
    AutonomyAction.Search,
    AutonomyAction.ReadMemory,
    AutonomyAction.ListSessions,
  ]),
  1: new Set([
    AutonomyAction.Observe,
    AutonomyAction.Search,
    AutonomyAction.ReadMemory,
    AutonomyAction.ListSessions,
    AutonomyAction.GenerateSuggestion,
    AutonomyAction.AnalyzePattern,
    AutonomyAction.Consolidate,
  ]),
  2: new Set([
    AutonomyAction.Observe,
    AutonomyAction.Search,
    AutonomyAction.ReadMemory,
    AutonomyAction.ListSessions,
    AutonomyAction.GenerateSuggestion,
    AutonomyAction.AnalyzePattern,
    AutonomyAction.Consolidate,
    AutonomyAction.SpawnAgent,
    AutonomyAction.ExecuteSuggestion,
    AutonomyAction.RotateContext,
    AutonomyAction.ModifyMemory,
  ]),
  3: new Set([
    AutonomyAction.Observe,
    AutonomyAction.Search,
    AutonomyAction.ReadMemory,
    AutonomyAction.ListSessions,
    AutonomyAction.GenerateSuggestion,
    AutonomyAction.AnalyzePattern,
    AutonomyAction.Consolidate,
    AutonomyAction.SpawnAgent,
    AutonomyAction.ExecuteSuggestion,
    AutonomyAction.RotateContext,
    AutonomyAction.ModifyMemory,
    AutonomyAction.KillSession,
    AutonomyAction.RestartBroker,
    AutonomyAction.PromoteAutonomy,
  ]),
}

// ── Guardrails ───────────────────────────────────────────────

export interface GuardrailCheck {
  readonly allowed: boolean
  readonly reason: string
  readonly level: number
  readonly action: AutonomyAction
}

/** Check if an action is permitted at the given autonomy level. */
export function checkAutonomy(level: number, action: AutonomyAction): GuardrailCheck {
  const clampedLevel = Math.max(0, Math.min(3, level))
  const permissions = LEVEL_PERMISSIONS[clampedLevel] ?? LEVEL_PERMISSIONS[0]!
  const allowed = permissions.has(action)

  return {
    allowed,
    reason: allowed
      ? `Action '${action}' permitted at L${clampedLevel}`
      : `Action '${action}' requires higher autonomy (current: L${clampedLevel})`,
    level: clampedLevel,
    action,
  }
}

/** Get all actions allowed at a given level. */
export function getAllowedActions(level: number): readonly AutonomyAction[] {
  const clampedLevel = Math.max(0, Math.min(3, level))
  const permissions = LEVEL_PERMISSIONS[clampedLevel] ?? LEVEL_PERMISSIONS[0]!
  return [...permissions]
}

/** Get the minimum level required for an action. */
export function getRequiredLevel(action: AutonomyAction): number {
  for (let level = 0; level <= 3; level++) {
    if (LEVEL_PERMISSIONS[level]?.has(action)) return level
  }
  return 4 // impossible — action not in any level
}
