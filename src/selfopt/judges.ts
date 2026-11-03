/**
 * SCNS selfopt — Phase 0 judges (the optimizer never grades itself).
 *
 * SCNS-native port of the MIT SkillOpt rule judges (`skillopt_sleep/judges.py`),
 * which implement gbrain-evals' programmatic check operators so a candidate's
 * output can be scored locally with NO judge API call:
 *
 *   - section_present <name> — a markdown heading / bold / label line for <name>
 *   - regex <pattern>        — the pattern matches the response
 *   - max_chars <n>          — response length <= n
 *   - min_chars <n>          — response length >= n
 *   - contains <text>        — substring present (case-insensitive)
 *   - tool_called <name>     — a tool named <name> was invoked (or a single-shot
 *                              "TOOL_CALL: <name>" marker is present)
 *
 * A rule judge passes (hard = 1.0) iff ALL checks pass; soft = fraction passed.
 *
 * Plus a SCNS-native `recordedJudge` (rule/rubric-kind 'recorded'): scores a task
 * directly from its historical quality-gate score — the loss signal mined from
 * real broker outcomes. This is what makes the baseline reproducible offline.
 */
import type { RuleJudge, RuleCheck } from './types.js'

export interface JudgeScore {
  readonly hard: number
  readonly soft: number
  readonly rationale: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sectionPresent(response: string, name: string): boolean {
  const r = response || ''
  const esc = escapeRegExp(name)
  // a markdown heading line (#, ##, ...) or a bold line containing `name`
  const heading = new RegExp(
    `^\\s{0,3}(#{1,6}\\s*.*${esc}|\\*\\*.*${esc}.*\\*\\*\\s*:?)\\s*$`,
    'im',
  )
  if (heading.test(r)) return true
  // also accept a "Name:" style label at line start
  const label = new RegExp(`^\\s*${esc}\\s*:`, 'im')
  return label.test(r)
}

function check(op: string, arg: string | number | undefined, response: string, toolsCalled: readonly string[]): boolean {
  const r = response || ''
  switch (op) {
    case 'section_present':
      return sectionPresent(r, String(arg))
    case 'regex':
      try {
        return new RegExp(String(arg)).test(r)
      } catch {
        return false
      }
    case 'max_chars':
      return r.length <= Number(arg)
    case 'min_chars':
      return r.length >= Number(arg)
    case 'contains':
      return r.toLowerCase().includes(String(arg).toLowerCase())
    case 'tool_called': {
      const name = String(arg).toLowerCase()
      if (toolsCalled.some((t) => t.toLowerCase() === name)) return true
      // single-shot approximation: the agent emits an explicit marker
      const marker = new RegExp(`\\btool_call\\s*:\\s*${escapeRegExp(name)}\\b`, 'i')
      return marker.test(r)
    }
    default:
      // unknown op: do not block
      return true
  }
}

/** Return the (hard, soft, rationale) for a gbrain-style rule judge. */
export function scoreRuleJudge(
  judge: RuleJudge | null,
  response: string,
  toolsCalled: readonly string[] = [],
): JudgeScore {
  const checks: readonly RuleCheck[] = judge?.checks ?? []
  if (checks.length === 0) {
    return { hard: 0, soft: 0, rationale: 'no checks' }
  }
  let passed = 0
  const failedDesc: string[] = []
  for (const c of checks) {
    const ok = check(c.op, c.arg, response, toolsCalled)
    if (ok) passed++
    else failedDesc.push(`${c.op}=${c.arg ?? ''}`)
  }
  const soft = passed / checks.length
  const hard = passed === checks.length ? 1 : 0
  const rationale = hard ? 'all checks passed' : `failed: ${failedDesc.join(', ')}`
  return { hard, soft, rationale }
}

/** Tool names a rule judge requires (op === 'tool_called'). */
export function requiredTools(judge: RuleJudge | null): readonly string[] {
  if (!judge) return []
  const tools: string[] = []
  for (const c of judge.checks) {
    if (c.op === 'tool_called' && c.arg !== undefined) tools.push(String(c.arg))
  }
  return tools
}

/**
 * Score a task directly from its recorded historical quality-gate score.
 *
 * `referenceKind === 'recorded'` tasks carry the QG arbiter's own grade in
 * [0,1]; the recorded judge surfaces it as both the hard and soft signal so the
 * held-out baseline equals the system's measured historical performance.
 */
export function recordedJudge(recordedScore: number | null): JudgeScore {
  if (recordedScore === null || !Number.isFinite(recordedScore)) {
    return { hard: 0, soft: 0, rationale: 'no recorded score' }
  }
  const clamped = Math.max(0, Math.min(1, recordedScore))
  return { hard: clamped, soft: clamped, rationale: `recorded score ${clamped}` }
}
