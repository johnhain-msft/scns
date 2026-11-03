/**
 * Team composition validation for the scrum team model.
 *
 * Validates that a team has the required roles before allowing
 * phase transitions (e.g. planning → implementation).
 */

export interface CompositionRequirement {
  readonly role: string
  readonly minCount: number
}

/** Default scrum team requirements: ≥1 manager + ≥1 dev + ≥1 qa. */
export const SCRUM_TEAM_REQUIREMENTS: readonly CompositionRequirement[] = [
  { role: 'manager', minCount: 1 },
  { role: 'dev', minCount: 1 },
  { role: 'qa', minCount: 1 },
] as const

export interface CompositionResult {
  readonly valid: boolean
  readonly missing: readonly string[]
  readonly members: readonly { readonly role: string; readonly session_id: string }[]
}

/**
 * Maps requirement role names to the concrete team roles that satisfy them.
 * For example, 'manager' requirement can be satisfied by 'manager', 'lead', 'pm', or 'scrum-master'.
 */
const ROLE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  manager: ['manager', 'lead', 'pm', 'scrum-master'],
  dev: ['dev'],
  qa: ['qa'],
}

/**
 * Validates that a team's members satisfy composition requirements.
 *
 * @param members — Current team members with their roles
 * @param requirements — Defaults to SCRUM_TEAM_REQUIREMENTS
 * @returns Validation result with missing roles if invalid
 */
export function validateTeamComposition(
  members: readonly { readonly role: string; readonly session_id: string }[],
  requirements: readonly CompositionRequirement[] = SCRUM_TEAM_REQUIREMENTS,
): CompositionResult {
  const missing: string[] = []

  for (const req of requirements) {
    const acceptedRoles = ROLE_GROUPS[req.role] ?? [req.role]
    const count = members.filter((m) => acceptedRoles.includes(m.role)).length
    if (count < req.minCount) {
      missing.push(req.role)
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    members,
  }
}
