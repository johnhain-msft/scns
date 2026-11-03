import type { AgentRole, TaskComplexity } from './task-types.js'

export const PARALLEL_KEYWORDS = [
  'and',
  'also',
  'simultaneously',
  'independent',
  'independently',
  'each',
  'all',
]
export const SEQUENTIAL_KEYWORDS = [
  'then',
  'after',
  'before',
  'depends on',
  'requires',
  'first',
  'step 1',
  'step 2',
  'step 3',
  'step 4',
]
export const COMPLEXITY_KEYWORDS = [
  'integrate',
  'refactor',
  'architect',
  'design',
  'migrate',
  'multiple',
  'across',
  'entire',
  'architecture',
]
export const IO_OVERLAP_KEYWORDS = ['same file', 'shared', 'database', 'state', 'mutex', 'lock']
export const HYBRID_KEYWORDS = ['simultaneously']

export function countKeywordMatches(text: string, keywords: readonly string[]): readonly string[] {
  const lower = text.toLowerCase()
  return keywords.filter((kw) => lower.includes(kw))
}

export function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length
}

function detectNumericHint(text: string): number {
  const match = text.match(
    /(\d+)\s+(?:services?|modules?|components?|packages?|endpoints?|pages?|files?)/i,
  )
  return match ? parseInt(match[1]!, 10) : 0
}

export function estimateSubtaskCountFromStructure(text: string): number {
  const bulletMatches = text.match(/^[\s]*[-*•]/gm)
  if (bulletMatches && bulletMatches.length >= 2) return bulletMatches.length

  const numberedMatches = text.match(/(?:^|\s)(?:\d+[.):]|step\s+\d+)/gim)
  if (numberedMatches && numberedMatches.length >= 2) return numberedMatches.length

  const numericHint = detectNumericHint(text)
  if (numericHint >= 2) return numericHint

  const commaMatches = text.match(/,/g)
  if (commaMatches && commaMatches.length >= 1) return commaMatches.length + 1

  const andParts = text.split(/\band\b/i)
  if (andParts.length >= 2) return andParts.length

  return 1
}

export function assignRole(description: string): AgentRole {
  const lower = description.toLowerCase()
  if (/\bresearch\b/.test(lower) || /\bgather\b/.test(lower) || /\binvestigat/.test(lower))
    return 'researcher'
  if (/\btest\b/.test(lower) || /\bverif/.test(lower) || /\bvalidat/.test(lower)) return 'tester'
  if (/\breview\b/.test(lower) || /\bcheck\b/.test(lower) || /\baudit\b/.test(lower))
    return 'reviewer'
  if (/\bplan\b/.test(lower) || /\bdesign\b/.test(lower) || /\brequirement/.test(lower))
    return 'planner'
  return 'implementer'
}

export function splitByParallel(description: string): readonly string[] {
  if (description.includes(',')) {
    const parts = description
      .split(/,\s*(?:and\s+)?|\band\b/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (parts.length >= 2) return parts
  }

  const parts = description
    .split(/\band\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (parts.length >= 2) return parts

  return [description]
}

export function splitBySequential(description: string): readonly string[] {
  const stepPattern = /(?:step\s+\d+[.:]\s*)/gi
  const stepParts = description
    .split(stepPattern)
    .map((s) =>
      s
        .trim()
        .replace(/^[.,;]\s*/, '')
        .trim(),
    )
    .filter((s) => s.length > 0)
  if (stepParts.length >= 2) return stepParts

  const thenParts = description
    .split(/[,.]?\s*then\s+/i)
    .map((s) =>
      s
        .trim()
        .replace(/^first\s+/i, '')
        .replace(/^,\s*/, ''),
    )
    .filter((s) => s.length > 0)
  if (thenParts.length >= 2) return thenParts

  const afterParts = description
    .split(/[,.]?\s*after\s+(?:that\s+)?/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (afterParts.length >= 2) return afterParts

  return [description]
}

export function splitHybrid(description: string): readonly { phase: readonly string[] }[] {
  const phases = splitBySequential(description)
  return phases.map((phase) => {
    const parallelParts = splitByParallel(phase)
    return { phase: parallelParts.length >= 2 ? parallelParts : [phase] }
  })
}

export function estimateMinutesForComplexity(
  complexity: TaskComplexity,
  subtaskCount: number,
): number {
  const totalByComplexity: Record<string, number> = {
    trivial: 5,
    simple: 20,
    moderate: 90,
    complex: 180,
  }
  const total = totalByComplexity[complexity] ?? 30
  return Math.max(1, Math.round(total / Math.max(1, subtaskCount)))
}
