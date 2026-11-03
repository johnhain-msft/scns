import type {
  TaskInput,
  TaskFeatures,
  ClassificationResult,
  SubtaskPlan,
  ExecutionStrategy,
  TaskComplexity,
} from './task-types.js'
import {
  PARALLEL_KEYWORDS,
  SEQUENTIAL_KEYWORDS,
  COMPLEXITY_KEYWORDS,
  IO_OVERLAP_KEYWORDS,
  HYBRID_KEYWORDS,
  countKeywordMatches,
  wordCount,
  estimateSubtaskCountFromStructure,
  assignRole,
  splitByParallel,
  splitBySequential,
  splitHybrid,
  estimateMinutesForComplexity,
} from './classifier-utils.js'

export interface ClassifierOptions {
  readonly confidenceThreshold?: number
}

export function createTaskClassifier(options?: ClassifierOptions) {
  const _confidenceThreshold = options?.confidenceThreshold ?? 0.6
  void _confidenceThreshold

  function extractFeatures(input: TaskInput): TaskFeatures {
    const text = input.description
    const parallelMatches = countKeywordMatches(text, PARALLEL_KEYWORDS)
    const sequentialMatches = countKeywordMatches(text, SEQUENTIAL_KEYWORDS)
    const ioMatches = countKeywordMatches(text, IO_OVERLAP_KEYWORDS)
    const hybridMatches = countKeywordMatches(text, HYBRID_KEYWORDS)

    const hasParallelOpportunity = parallelMatches.length >= 1
    const hasDependencyChain = sequentialMatches.length >= 1 || hybridMatches.length >= 1
    const hasIOOverlap = ioMatches.length >= 1

    const structuralCount = estimateSubtaskCountFromStructure(text)
    const subtaskCount = input.estimatedSubtasks ?? structuralCount

    const complexityMatches = countKeywordMatches(text, COMPLEXITY_KEYWORDS)
    const constraintWeight = (input.constraints?.length ?? 0) * 5
    const depWeight = (input.dependencies?.length ?? 0) * 5

    let estimatedTotalMinutes: number
    if (subtaskCount <= 1 && complexityMatches.length === 0) {
      estimatedTotalMinutes = 5 + constraintWeight + depWeight
    } else if (subtaskCount <= 3) {
      estimatedTotalMinutes =
        subtaskCount * 15 + complexityMatches.length * 10 + constraintWeight + depWeight
    } else if (subtaskCount <= 6) {
      estimatedTotalMinutes =
        subtaskCount * 15 + complexityMatches.length * 15 + constraintWeight + depWeight
    } else {
      estimatedTotalMinutes =
        subtaskCount * 20 + complexityMatches.length * 20 + constraintWeight + depWeight
    }

    const keywordSignals = [
      ...parallelMatches,
      ...sequentialMatches,
      ...complexityMatches,
      ...ioMatches,
    ]

    return {
      subtaskCount,
      hasDependencyChain,
      hasParallelOpportunity,
      hasIOOverlap,
      keywordSignals,
      estimatedTotalMinutes,
    }
  }

  function determineComplexity(feat: TaskFeatures, input: TaskInput): TaskComplexity {
    const complexityKws = countKeywordMatches(feat.keywordSignals.join(' '), COMPLEXITY_KEYWORDS)
    const hasExtraContext =
      (input.constraints?.length ?? 0) > 0 || (input.dependencies?.length ?? 0) > 0
    const words = wordCount(input.description)

    if (feat.subtaskCount <= 1 && complexityKws.length === 0 && !hasExtraContext && words <= 6)
      return 'trivial'
    if (feat.subtaskCount > 6 || complexityKws.length >= 2 || feat.estimatedTotalMinutes > 120)
      return 'complex'
    if (feat.subtaskCount >= 4 && feat.hasDependencyChain) return 'complex'
    if (feat.hasParallelOpportunity && feat.hasDependencyChain && complexityKws.length >= 1)
      return 'complex'
    if (feat.hasParallelOpportunity && feat.hasDependencyChain) return 'moderate'
    if (
      feat.subtaskCount <= 2 &&
      complexityKws.length === 0 &&
      feat.estimatedTotalMinutes <= 30 &&
      !hasExtraContext
    )
      return 'simple'
    const hasExplicitIndependence = /\bindependent(?:ly)?\b/i.test(input.description)
    if (
      feat.subtaskCount === 3 &&
      complexityKws.length === 0 &&
      !feat.hasDependencyChain &&
      !hasExtraContext &&
      (feat.estimatedTotalMinutes <= 30 || hasExplicitIndependence)
    )
      return 'simple'
    return 'moderate'
  }

  function determineStrategy(feat: TaskFeatures, complexity: TaskComplexity): ExecutionStrategy {
    if (complexity === 'trivial' || feat.subtaskCount <= 1) return 'solo'
    if (feat.hasParallelOpportunity && feat.hasDependencyChain) return 'hybrid'
    if (feat.hasDependencyChain) return 'sequential'
    if (feat.subtaskCount >= 2) return 'parallel'
    return 'solo'
  }

  function computeConfidence(feat: TaskFeatures, input: TaskInput): number {
    let confidence = 0.85
    if (feat.hasParallelOpportunity && feat.hasDependencyChain) confidence -= 0.1
    if (feat.keywordSignals.length === 0) confidence -= 0.15
    if (!input.context && !input.constraints && !input.dependencies) confidence -= 0.05
    if (input.estimatedSubtasks !== undefined) confidence += 0.1
    return Math.max(0, Math.min(1, confidence))
  }

  function decompose(input: TaskInput, feat: TaskFeatures): readonly SubtaskPlan[] {
    const complexity = determineComplexity(feat, input)
    const strategy = determineStrategy(feat, complexity)
    const minutesPerSubtask = estimateMinutesForComplexity(complexity, feat.subtaskCount)

    if (strategy === 'solo') {
      return [
        {
          id: 'subtask-1',
          description: input.description,
          dependencies: [] as string[],
          estimatedMinutes: feat.estimatedTotalMinutes,
          role: assignRole(input.description),
        },
      ]
    }
    if (strategy === 'parallel') {
      return splitByParallel(input.description).map((part, i) => ({
        id: `subtask-${i + 1}`,
        description: part,
        dependencies: [] as string[],
        estimatedMinutes: minutesPerSubtask,
        role: assignRole(part),
      }))
    }
    if (strategy === 'sequential') {
      return splitBySequential(input.description).map((part, i) => ({
        id: `subtask-${i + 1}`,
        description: part,
        dependencies: i === 0 ? ([] as string[]) : [`subtask-${i}`],
        estimatedMinutes: minutesPerSubtask,
        role: assignRole(part),
      }))
    }

    const hybridPhases = splitHybrid(input.description)
    const subtasks: SubtaskPlan[] = []
    let idx = 1
    let prevPhaseIds: string[] = []
    for (const phaseGroup of hybridPhases) {
      const currentPhaseIds: string[] = []
      for (const part of phaseGroup.phase) {
        const id = `subtask-${idx}`
        currentPhaseIds.push(id)
        subtasks.push({
          id,
          description: part,
          dependencies: [...prevPhaseIds],
          estimatedMinutes: minutesPerSubtask,
          role: assignRole(part),
        })
        idx++
      }
      prevPhaseIds = currentPhaseIds
    }
    return subtasks
  }

  function classify(input: TaskInput): ClassificationResult {
    const feat = extractFeatures(input)
    const complexity = determineComplexity(feat, input)
    const strategy = determineStrategy(feat, complexity)
    const confidence = computeConfidence(feat, input)
    const subtasks = decompose(input, feat)
    const subtaskTotal = subtasks.reduce((sum, s) => sum + s.estimatedMinutes, 0)
    const reconciledFeatures: TaskFeatures = { ...feat, estimatedTotalMinutes: subtaskTotal }
    const reasoning = buildReasoning(strategy, complexity, confidence, reconciledFeatures)
    return { strategy, complexity, confidence, subtasks, reasoning, features: reconciledFeatures }
  }

  return { classify, extractFeatures, decompose }
}

function buildReasoning(
  strategy: ExecutionStrategy,
  complexity: TaskComplexity,
  confidence: number,
  features: TaskFeatures,
): string {
  const parts: string[] = []
  parts.push(
    `Strategy: ${strategy} (${complexity} complexity, ${(confidence * 100).toFixed(0)}% confidence).`,
  )
  parts.push(
    `Detected ${features.subtaskCount} subtask(s), ~${features.estimatedTotalMinutes} min total.`,
  )
  if (features.keywordSignals.length > 0)
    parts.push(`Keyword signals: ${features.keywordSignals.join(', ')}.`)
  if (features.hasDependencyChain) parts.push('Tasks have ordering dependencies.')
  if (features.hasParallelOpportunity) parts.push('Parallel execution possible.')
  if (features.hasIOOverlap) parts.push('Shared I/O resources detected.')
  return parts.join(' ')
}
