// Confidence scoring engine for the suggestion system

// ── Public interfaces ────────────────────────────────────────────────

export interface ConfidenceScores {
  readonly frequency: number
  readonly consistency: number
  readonly impact: number
  readonly composite: number
}

export interface ConfidenceOptions {
  readonly frequencyWeight?: number
  readonly consistencyWeight?: number
  readonly impactWeight?: number
  readonly minimumObservations?: number
}

export interface ConfidenceInput {
  readonly type: string
  readonly observationCount: number
  readonly windowDays: number
  readonly dailyCounts?: readonly number[]
  readonly metadata?: Record<string, unknown>
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_FREQUENCY_WEIGHT = 0.4
const DEFAULT_CONSISTENCY_WEIGHT = 0.3
const DEFAULT_IMPACT_WEIGHT = 0.3
const DEFAULT_MINIMUM_PER_DAY = 1

const IMPACT_BY_TYPE: Record<string, number> = {
  skill: 0.7,
  agent: 0.8,
  mcp: 0.6,
  automation: 0.9,
  workflow: 0.5,
  prompt: 0.6,
  extension: 0.7,
  lsp: 0.5,
  'github-action': 0.8,
  'agentic-workflow': 0.85,
  instruction: 0.55,
}

const DEFAULT_IMPACT = 0.5

// ── Helpers ──────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function stddev(values: readonly number[]): number {
  const n = values.length
  if (n === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n
  return Math.sqrt(variance)
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

// ── Factory ──────────────────────────────────────────────────────────

export function createConfidenceScorer(options?: ConfidenceOptions) {
  const freqWeight = options?.frequencyWeight ?? DEFAULT_FREQUENCY_WEIGHT
  const consWeight = options?.consistencyWeight ?? DEFAULT_CONSISTENCY_WEIGHT
  const impWeight = options?.impactWeight ?? DEFAULT_IMPACT_WEIGHT

  function scoreFrequency(
    observationCount: number,
    windowDays: number,
    minimumPerDay: number = DEFAULT_MINIMUM_PER_DAY,
  ): number {
    if (observationCount <= 0 || windowDays <= 0) return 0
    const raw = observationCount / windowDays
    const min = minimumPerDay
    if (raw >= min * 3) return 1.0
    if (raw >= min) return 0.5 + (0.5 * (raw - min)) / (min * 2)
    return (0.5 * raw) / min
  }

  function scoreConsistency(dailyCounts: readonly number[]): number {
    if (dailyCounts.length <= 1) return 0.5
    const m = mean(dailyCounts)
    if (m === 0) return 0.1
    const cv = stddev(dailyCounts) / m
    return clamp(1 - Math.min(cv, 1.5) / 1.5, 0, 1)
  }

  function scoreImpact(type: string, metadata?: Record<string, unknown>): number {
    let base = IMPACT_BY_TYPE[type] ?? DEFAULT_IMPACT
    if (metadata?.timesSaved != null) {
      const saved = Number(metadata.timesSaved)
      if (saved > 0) {
        // Boost: up to +0.15 for high timesSaved (diminishing returns)
        base = Math.min(1.0, base + 0.15 * (1 - 1 / (1 + saved / 50)))
      }
    }
    return base
  }

  function score(input: ConfidenceInput): ConfidenceScores {
    const frequency = scoreFrequency(input.observationCount, input.windowDays)
    const consistency = input.dailyCounts ? scoreConsistency(input.dailyCounts) : 0.5
    const impact = scoreImpact(input.type, input.metadata)

    const totalWeight = freqWeight + consWeight + impWeight
    const raw =
      totalWeight > 0
        ? (freqWeight * frequency + consWeight * consistency + impWeight * impact) / totalWeight
        : 0

    return {
      frequency,
      consistency,
      impact,
      composite: clamp(raw, 0, 1),
    }
  }

  return { score, scoreFrequency, scoreConsistency, scoreImpact }
}
