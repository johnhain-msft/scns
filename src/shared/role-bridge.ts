/**
 * Role bridge — normalizes brain-namespace agent roles to their canonical
 * broker spawn-role so a single "role intent" resolves consistently across the
 * two role namespaces that otherwise have no mapping.
 *
 * Two namespaces exist:
 *   - brain roles (src/brain/task-types.ts: researcher|implementer|reviewer|
 *     tester|planner) — emitted by assignRole, the planner, and templateEngine.
 *   - broker task-spawn roles (scns-manager|scns-dev|scns-qa|scns-researcher) —
 *     the capability that buildResearcherPrompt + isAnalysisCompletion key on.
 *
 * Without a bridge, a brain `researcher` gets an IMPLEMENTER prompt
 * (buildTeamMemberPrompt maps only `scns-*` roles) and its no-diff findings hit
 * the QG no-diff auto-FAIL (isAnalysisCompletion keys on `scns-researcher`).
 * `normalizeAgentRole` closes that fracture at the resolution boundaries
 * (prompt selection, recorded team-member role, QG analysis recognition).
 *
 * Scope: currently researcher-only — the first-class, on-demand RESEARCHER
 * capability. Every other brain role passes through unchanged so existing
 * implementer/tester spawns keep their recorded role + telemetry. The map below
 * is the single extension point if more roles are bridged later.
 */

/** Canonical broker task-spawn role for the RESEARCHER capability. */
export const RESEARCHER_ROLE = 'scns-researcher'

/**
 * brain-role → canonical broker spawn-role. Intentionally researcher-only; add
 * entries here (never a second lookup) to bridge more roles.
 */
const BRAIN_TO_BROKER_ROLE: Readonly<Record<string, string>> = {
  researcher: RESEARCHER_ROLE,
}

/**
 * Canonicalize an agent role to its broker spawn-role. Broker roles and
 * unmapped brain roles are returned unchanged (idempotent).
 */
export function normalizeAgentRole(role: string): string {
  return BRAIN_TO_BROKER_ROLE[role] ?? role
}

/**
 * True when a role denotes the RESEARCHER capability in either namespace
 * (brain `researcher` or broker `scns-researcher`).
 */
export function isResearcherRole(role: string): boolean {
  return normalizeAgentRole(role) === RESEARCHER_ROLE
}
