/**
 * On-demand RESEARCHER dispatch (human-CLI + CLI-agent invocation surface).
 *
 * Closes the "I have a question, not a task id" gap: `scns research "<q>"`
 * scaffolds a fresh team + task and spawns a first-class investigate-only
 * researcher against it. The same helper serves the human (who runs the
 * command) and the CLI agent (which can shell out to it in its own workflow),
 * so a researcher can be invoked by a manager, a human, or an agent alike.
 *
 * The HTTP client is injected so the orchestration (team → task → spawn) is
 * unit-testable without a live broker.
 */

import { randomUUID } from 'node:crypto'
import { RESEARCHER_ROLE } from '../shared/role-bridge.js'

export interface HttpResponseLike {
  readonly status: number
  text(): Promise<string>
}

/** Structural subset of the global `fetch` used by the dispatcher. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<HttpResponseLike>

export interface DispatchResearchOptions {
  readonly question: string
  readonly brokerUrl: string
  readonly workingDir?: string
  readonly extraContext?: string
  readonly launchMethod?: string
}

export interface DispatchResearchDeps {
  readonly fetch: FetchLike
  /** Short id generator (injectable for deterministic tests). */
  readonly genId?: () => string
}

export interface DispatchResearchResult {
  readonly teamId: string
  readonly taskId: number
  readonly sessionId: string
}

async function postJson(
  fetchFn: FetchLike,
  url: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`POST ${url} failed (HTTP ${res.status}): ${text}`)
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`POST ${url} returned non-JSON body: ${text}`)
  }
}

/**
 * Dispatch an on-demand researcher: create a team, create a task carrying the
 * question, and spawn a `scns-researcher` against it. Returns the created
 * team/task ids and the researcher's session id.
 */
export async function dispatchResearch(
  opts: DispatchResearchOptions,
  deps: DispatchResearchDeps,
): Promise<DispatchResearchResult> {
  const question = opts.question.trim()
  if (!question) throw new Error('research: question must not be empty')

  const shortId = (deps.genId ?? (() => randomUUID().slice(0, 8)))()
  const base = opts.brokerUrl.replace(/\/+$/, '')

  const team = await postJson(deps.fetch, `${base}/api/teams`, {
    name: `research-${shortId}`,
    description: `On-demand research: ${question}`,
  })
  const teamId = team['id']
  if (typeof teamId !== 'string') {
    throw new Error(`research: team create returned no id: ${JSON.stringify(team)}`)
  }

  const task = await postJson(deps.fetch, `${base}/api/tasks`, {
    team_id: teamId,
    subject: question,
    ...(opts.extraContext ? { description: opts.extraContext } : {}),
  })
  const taskId = task['id']
  if (typeof taskId !== 'number') {
    throw new Error(`research: task create returned no numeric id: ${JSON.stringify(task)}`)
  }

  const spawn = await postJson(deps.fetch, `${base}/api/tasks/${taskId}/spawn`, {
    role: RESEARCHER_ROLE,
    launch_method: opts.launchMethod ?? 'acp',
    ...(opts.workingDir ? { working_dir: opts.workingDir } : {}),
  })
  const sessionId = spawn['session_id']
  if (typeof sessionId !== 'string') {
    throw new Error(`research: spawn returned no session_id: ${JSON.stringify(spawn)}`)
  }

  return { teamId, taskId, sessionId }
}
