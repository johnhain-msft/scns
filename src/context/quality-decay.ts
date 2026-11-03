/**
 * Quality decay calculations.
 * Pure functions — no side effects, no state mutation.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface QualityState {
  readonly sessionId: string
  readonly startedAt: string
  readonly lastActivityAt: string
  readonly initialQuality: number
  readonly compactionPenalty: number
  readonly errorPenalty: number
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createInitialQualityState(sessionId: string): QualityState {
  const now = new Date().toISOString()
  return {
    sessionId,
    startedAt: now,
    lastActivityAt: now,
    initialQuality: 100,
    compactionPenalty: 0,
    errorPenalty: 0,
  }
}

// ── Core calculation ────────────────────────────────────────────────────────

export function calculateQualityScore(state: QualityState, decayRate: number, now?: Date): number {
  const currentTime = now ?? new Date()
  const elapsedMs = currentTime.getTime() - new Date(state.startedAt).getTime()
  const elapsedHours = Math.max(0, elapsedMs / (1000 * 60 * 60))
  const timePenalty = elapsedHours * decayRate

  const raw = state.initialQuality - timePenalty - state.compactionPenalty - state.errorPenalty
  return Math.max(0, Math.min(100, Math.round(raw)))
}

// ── Penalty application (immutable) ─────────────────────────────────────────

export function applyCompactionPenalty(
  state: QualityState,
  penaltyPerCompaction = 5,
): QualityState {
  return {
    ...state,
    compactionPenalty: state.compactionPenalty + penaltyPerCompaction,
  }
}

export function applyErrorPenalty(state: QualityState, penaltyPerError = 2): QualityState {
  return {
    ...state,
    errorPenalty: state.errorPenalty + penaltyPerError,
  }
}
