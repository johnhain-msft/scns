/**
 * Readiness Map schema + validator (feature 002, task T009 — implements
 * `contracts/readiness-map.schema.md` + data-model §1). This is the structural tripwire that makes an
 * over-claimed north-star audit un-shippable: it rejects a `usable` state without a live-evidence row +
 * passing pos/neg controls, rejects a self-signed verdict (producer == grader), requires all four
 * capabilities exactly once, and refuses an inflated "yes". T018 validates the assembled map against it.
 *
 * `validateReadinessMap` returns the list of problems (empty ⇒ valid) so a caller can print every
 * violation at once rather than failing on the first.
 */

/** The four north-star capabilities the audit MUST cover exactly once (SC-001). */
export const CAPABILITY_IDS = [
  'trustworthy_recall',
  'self_learning',
  'self_direction',
  'safe_outward',
] as const
export type CapabilityId = (typeof CAPABILITY_IDS)[number]

/** The monotonic capability lifecycle (data-model State Transitions). `usable` is the only pass leaf. */
export const READINESS_STATES = [
  'specified',
  'built',
  'wired_live',
  'measured_with_controls',
  'usable',
] as const
export type ReadinessState = (typeof READINESS_STATES)[number]

/** A quoted live-output row substantiating a claim (never an exit code / HTTP 200). */
export interface EvidenceRow {
  readonly claim: string
  readonly quoted_output: string
  readonly artifact_ref: string
}

/** Paired proof a check fires when it should and stays silent when it should not. */
export interface ControlPair {
  readonly positive: boolean
  readonly negative: boolean
  readonly separation: number
}

/** Validity-of-Null: recorded INSTEAD of a pass/fail when the probe can't show the effect. */
export interface BlockedResult {
  readonly missing_precondition: string
  readonly could_setup_show_win: false
}

/** The audit's grade for one capability. */
export interface CapabilityAssessment {
  capability_id: string
  state: ReadinessState | string
  gap: string
  backing_subsystems: string[]
  evidence: EvidenceRow[]
  controls: ControlPair
  blocked: BlockedResult | null
}

export interface GapItem {
  readonly capability_id: string
  readonly priority: number
  readonly missing_pieces: string[]
  readonly blocks: string[]
}

export interface IndependentSignoff {
  producer_context_id: string
  grader_context_id: string
  agreed: boolean
}

/** The whole audit output (contracts/readiness-map.schema.md). */
export interface ReadinessMap {
  generated_in_context: string
  signoff: IndependentSignoff
  capabilities: CapabilityAssessment[]
  prioritized_gap_map: GapItem[]
  magma_placement: string
  distance_summary: string
}

function nonEmpty(s: unknown): boolean {
  return typeof s === 'string' && s.trim().length > 0
}

/** Does this assessment carry ≥1 live-e2e evidence row with a verbatim quoted_output + artifact_ref? */
function hasLiveEvidence(a: CapabilityAssessment): boolean {
  return (
    Array.isArray(a.evidence) &&
    a.evidence.some((e) => nonEmpty(e.quoted_output) && nonEmpty(e.artifact_ref))
  )
}

/** True iff every capability is graded `usable` — the only case a "yes" distance_summary is honest. */
export function isFullyUsable(map: ReadinessMap): boolean {
  return map.capabilities.length > 0 && map.capabilities.every((c) => c.state === 'usable')
}

/**
 * Validate a Readiness Map against the schema's MUST rules. Returns a (possibly empty) list of problems.
 * The rule numbering mirrors contracts/readiness-map.schema.md "Acceptance rules (MUST)".
 */
export function validateReadinessMap(map: ReadinessMap): string[] {
  const problems: string[] = []

  // Rule 1 — Coverage: exactly the 4 capability ids, once each.
  const seen = new Map<string, number>()
  for (const c of map.capabilities ?? []) {
    seen.set(c.capability_id, (seen.get(c.capability_id) ?? 0) + 1)
  }
  for (const id of CAPABILITY_IDS) {
    const n = seen.get(id) ?? 0
    if (n === 0) problems.push(`coverage: capability "${id}" is missing (all 4 required, SC-001)`)
    if (n > 1) problems.push(`coverage: capability "${id}" is duplicated (each must appear once)`)
  }
  for (const id of seen.keys()) {
    if (!(CAPABILITY_IDS as readonly string[]).includes(id)) {
      problems.push(
        `coverage: unknown capability id "${id}" (not one of the 4 north-star capabilities)`,
      )
    }
  }

  // Per-capability rules.
  for (const a of map.capabilities ?? []) {
    const who = a.capability_id
    if (!(READINESS_STATES as readonly string[]).includes(a.state)) {
      problems.push(`${who}: invalid state "${a.state}"`)
    }
    if (!nonEmpty(a.gap))
      problems.push(`${who}: gap must be a non-empty concrete distance to usable`)

    // Rule 2 — No unproven `usable`.
    if (a.state === 'usable') {
      if (!hasLiveEvidence(a)) {
        problems.push(
          `${who}: state=usable but has no live-e2e evidence row with a verbatim quoted_output + ` +
            `artifact_ref (code-complete is NOT usable, SC-002)`,
        )
      }
      if (!(a.controls && a.controls.positive === true && a.controls.negative === true)) {
        problems.push(
          `${who}: state=usable requires BOTH a positive AND a negative control passing (FR-002)`,
        )
      }
    }
    if (a.state === 'measured_with_controls') {
      if (!(a.controls && a.controls.positive === true && a.controls.negative === true)) {
        problems.push(`${who}: state=measured_with_controls requires both controls (FR-002)`)
      }
    }

    // Rule 3 — BLOCKED, not faked.
    if (a.blocked !== null && a.blocked !== undefined) {
      if (!nonEmpty(a.blocked.missing_precondition)) {
        problems.push(
          `${who}: blocked.missing_precondition must be named (Validity-of-Null, FR-003)`,
        )
      }
      if (a.blocked.could_setup_show_win !== false) {
        problems.push(`${who}: blocked.could_setup_show_win must be false`)
      }
      if (a.state === 'usable') {
        problems.push(
          `${who}: a BLOCKED capability cannot also be usable (state is not a pass leaf)`,
        )
      }
    }
  }

  // Rule 4 — Independent sign-off.
  const s = map.signoff
  if (!s) problems.push('signoff is required (independent sign-off, SC-003)')
  else {
    if (!nonEmpty(s.producer_context_id) || !nonEmpty(s.grader_context_id)) {
      problems.push('signoff requires both producer_context_id and grader_context_id')
    } else if (s.producer_context_id === s.grader_context_id) {
      problems.push(
        'signoff: producer == grader — a self-graded verdict is rejected (independent sign-off, SC-003)',
      )
    }
    if (s.agreed !== true)
      problems.push('signoff.agreed must be true (the grader must agree with the verdict)')
  }

  // Rule 5 — Actionable.
  if (!Array.isArray(map.prioritized_gap_map) || map.prioritized_gap_map.length === 0) {
    problems.push('prioritized_gap_map must be non-empty and ordered (FR-005, SC-012)')
  } else {
    const priorities = map.prioritized_gap_map.map((g) => g.priority)
    if (priorities.some((p) => !Number.isInteger(p)))
      problems.push('prioritized_gap_map priorities must be integers')
    if (new Set(priorities).size !== priorities.length)
      problems.push('prioritized_gap_map priorities must be unique')
  }
  if (!nonEmpty(map.magma_placement)) problems.push('magma_placement must be non-empty (FR-005)')
  if (!nonEmpty(map.distance_summary)) problems.push('distance_summary must be non-empty (FR-005)')

  // Rule 6 — Honesty: a bare "yes"/"reached" is only permitted when every capability is usable.
  if (nonEmpty(map.distance_summary) && !isFullyUsable(map)) {
    const ds = map.distance_summary.trim().toLowerCase()
    const inflated =
      /^yes\b/.test(ds) ||
      ds.includes('north star is reached') ||
      ds.includes('north star reached') ||
      ds.includes('fully usable') ||
      ds.includes('all capabilities are usable')
    if (inflated) {
      problems.push(
        'distance_summary reads as an inflated "yes" while not all capabilities are usable — state an ' +
          'honest distance (FR-005, SC-012)',
      )
    }
  }

  return problems
}
