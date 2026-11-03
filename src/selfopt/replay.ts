/**
 * SCNS selfopt — Phase 0 replay harness.
 *
 * SCNS-native port of the MIT SkillOpt replay stage (`skillopt_sleep/replay.py`).
 * Re-runs a mined `TaskRecord` against a candidate artifact (skill / prompt /
 * agent / memory) under a `ReplayBackend` and scores it, producing the
 * (hard, soft) signal the gate consumes.
 *
 * Two backends:
 *   - MockBackend — deterministic, CI-safe, NO agent spawn. Scores a task from
 *     its recorded historical label (referenceKind==='recorded') or its rule
 *     judge. This is what makes the held-out baseline reproducible offline and
 *     in CI.
 *   - AcpReplayBackend — the real target: runs the candidate through SCNS's
 *     isolated Copilot ACP spawn in a worktree (never the live checkout). A
 *     copilot ACP spawn needs the REAL HOME to authenticate, so this backend is
 *     wired in Phase 1+ behind an explicit opt-in; Phase 0 verifies with Mock.
 *
 * Phase 0 is read/measure only: replay computes scores, it never adopts an edit.
 */
import { recordedJudge, requiredTools, scoreRuleJudge } from './judges.js'
import type { ReplayResult, TaskRecord } from './types.js'

/** A frozen target the candidate artifact is evaluated against. */
export interface ReplayBackend {
  /** Produce a response for a task under the given candidate skill + memory. */
  attempt(task: TaskRecord, skill: string, memory: string): Promise<string> | string
  /** Optional tool-loop variant; backends that can't, fall back to attempt(). */
  attemptWithTools?(
    task: TaskRecord,
    skill: string,
    memory: string,
    tools: readonly string[],
  ): Promise<{ response: string; toolsCalled: string[] }> | { response: string; toolsCalled: string[] }
}

/**
 * Deterministic, offline backend. For `recorded` tasks it replays the historical
 * label verbatim (so a baseline over the val split reproduces SCNS's own
 * measured performance); for `rule` tasks it echoes a synthesized response the
 * candidate would emit so the rule judge can score it locally.
 */
export class MockBackend implements ReplayBackend {
  attempt(task: TaskRecord, skill: string, memory: string): string {
    // The mock "response" is deterministic: skill+memory+intent concatenation.
    // For recorded tasks the judge ignores the text and uses recordedScore, so
    // this only matters for rule-judged tasks (where it provides scoreable text).
    return `${skill}\n${memory}\n${task.intent}`.trim()
  }
}

export interface ReplayOneOptions {
  readonly skill?: string
  readonly memory?: string
}

/** Replay one task and score it. */
export async function replayOne(
  backend: ReplayBackend,
  task: TaskRecord,
  options: ReplayOneOptions = {},
): Promise<ReplayResult> {
  const skill = options.skill ?? ''
  const memory = options.memory ?? ''
  const tools = requiredTools(task.judge)

  const t0 = Date.now()
  let response: string
  let toolsCalled: string[] = []
  if (tools.length > 0 && backend.attemptWithTools) {
    const r = await backend.attemptWithTools(task, skill, memory, tools)
    response = r.response
    toolsCalled = r.toolsCalled
  } else {
    response = await backend.attempt(task, skill, memory)
  }
  const latencyMs = Date.now() - t0

  let hard: number
  let soft: number
  let rationale: string
  if (task.referenceKind === 'recorded') {
    const s = recordedJudge(task.recordedScore)
    hard = s.hard
    soft = s.soft
    rationale = s.rationale
  } else if (task.referenceKind === 'rule' && task.judge) {
    const s = scoreRuleJudge(task.judge, response, toolsCalled)
    hard = s.hard
    soft = s.soft
    rationale = s.rationale
  } else {
    hard = 0
    soft = 0
    rationale = 'no reference to score against'
  }

  // approximate token cost from text length when the backend doesn't track it
  const tokens = Math.floor((skill.length + memory.length + task.intent.length + response.length) / 4)

  return {
    id: task.id,
    hard,
    soft,
    response,
    failReason: hard >= 1 ? '' : rationale || 'below threshold',
    taskType: task.tags[0] ?? 'task',
    judgeRationale: rationale,
    toolsCalled,
    tokens,
    latencyMs,
  }
}

export interface ReplayPair {
  readonly task: TaskRecord
  readonly result: ReplayResult
}

/** Replay a batch of tasks against one candidate. */
export async function replayBatch(
  backend: ReplayBackend,
  tasks: ReadonlyArray<TaskRecord>,
  options: ReplayOneOptions = {},
): Promise<ReplayPair[]> {
  const pairs: ReplayPair[] = []
  for (const task of tasks) {
    pairs.push({ task, result: await replayOne(backend, task, options) })
  }
  return pairs
}

/** Mean (hard, soft) over a batch — the aggregate replay score. */
export function aggregateScores(pairs: ReadonlyArray<ReplayPair>): { hard: number; soft: number } {
  if (pairs.length === 0) return { hard: 0, soft: 0 }
  let hard = 0
  let soft = 0
  for (const p of pairs) {
    hard += p.result.hard
    soft += p.result.soft
  }
  return { hard: hard / pairs.length, soft: soft / pairs.length }
}

/** Mean (tokens, latencyMs) over a batch — the cost objectives. */
export function aggregateCost(pairs: ReadonlyArray<ReplayPair>): { tokens: number; latencyMs: number } {
  if (pairs.length === 0) return { tokens: 0, latencyMs: 0 }
  let tokens = 0
  let latencyMs = 0
  for (const p of pairs) {
    tokens += p.result.tokens
    latencyMs += p.result.latencyMs
  }
  return { tokens: tokens / pairs.length, latencyMs: latencyMs / pairs.length }
}
