/**
 * D1b — deterministic, evidence-first ideation SYNTHESIS (no LLM, no network).
 *
 * The D1 wedge can invent novel proposals, but only through `createDefaultIdeationBackend`,
 * which spawns a real Copilot ACP session (a network/agent dependency). This module is a
 * SECOND backend: it DERIVES novel proposals directly from the same real signal bundle
 * (gaps, failures, telemetry, codebase) so ideation produces fresh, grounded ideas with
 * zero spawn. It is NOT a fixed catalog — every proposal's headline/body is composed from
 * live signal VALUES (a gap detail, a failed title, the busiest tool, a module name), so
 * the output tracks the corpus instead of re-emitting the static seed menu.
 *
 * Evidence-first: each proposal cites the exact signal it came from in its `rationale`.
 * Novel: candidates whose family already appears in recent outcomes are dropped, so we
 * never re-propose something implemented / rejected / failed. Deterministic + pure: same
 * signals → same proposals → unit-testable and CI-safe. Advisory-only (the runner writes
 * to the review inbox; nothing is auto-spawned).
 */

import type { IdeationBackend } from './backend.js'
import type { IdeationProposal, IdeationSignals } from './types.js'

/** Collapse digits/times/whitespace so near-duplicate titles share a family key. */
function family(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b\d{1,2}:\d{2}\b/g, '<t>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Truncate to a clause for compact, readable headlines. */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1).trimEnd() + '…'
}

/** Recent-outcome titles whose families must NOT be re-proposed (novelty guard). */
function seenFamilies(signals: IdeationSignals): Set<string> {
  const seen = new Set<string>()
  const { implemented, rejected, failed } = signals.recentOutcomes
  for (const t of [...implemented, ...rejected, ...failed]) seen.add(family(t))
  for (const p of signals.priorProposalOutcomes) seen.add(family(p.title))
  return seen
}

/** Candidate generators, most-concrete-evidence first. Each is grounded in a live value. */
function* candidates(signals: IdeationSignals): Generator<IdeationProposal> {
  // 1) Open gaps — the most concrete, citeable novelty source: close each one.
  for (const g of signals.openGaps) {
    const what = clip(g.detail, 80)
    yield {
      title: `Close gap: ${what}`,
      rationale: `Open gap [${g.source}]: ${g.detail}`,
      expectedValue: 'Removes a known limitation, reducing recurring failure/operator toil.',
      implementationSketch: `Trace the code path implicated by [${g.source}], add the missing guard/behaviour, and lock it with a regression test.`,
      testableSuccessCriterion: `A test reproduces the [${g.source}] gap, fails before the fix, and passes after.`,
    }
  }

  // 2) Failed initiatives — recover with a DIFFERENT approach (not re-proposing the title).
  for (const t of signals.recentOutcomes.failed) {
    yield {
      title: `Find a smaller-scope path to: ${clip(t, 60)}`,
      rationale: `Prior suggestion "${t}" reached status=failed; the goal is unmet but the approach didn't land.`,
      expectedValue: 'Captures the value of a failed initiative via a smaller, test-coverable slice.',
      implementationSketch: 'Split the original goal into the smallest independently shippable behaviour with its own test, deferring the rest.',
      testableSuccessCriterion: 'The reduced slice ships with a passing test and an open follow-up note for the remainder.',
    }
  }

  // 3) Hottest tool — instrument the dominant tool so heavy use becomes measurable.
  const tool = signals.telemetry?.topTools[0]
  if (tool && tool.uses > 0) {
    yield {
      title: `Add per-call metrics for the busiest tool: ${tool.tool}`,
      rationale: `Telemetry: ${tool.tool} is the most-used tool (${tool.uses} uses in ~${signals.telemetry?.windowDays}d) yet has no per-call success/latency metric.`,
      expectedValue: `Makes the dominant tool's cost/failure rate observable, the prerequisite for optimising it.`,
      implementationSketch: `Emit a structured ${tool.tool}_call event (duration + ok/err) behind the existing event sink.`,
      testableSuccessCriterion: `A unit test asserts a ${tool.tool}_call event fires with duration+status on success and failure.`,
    }
  }

  // 4) Module under active development with no obvious coverage anchor — propose one.
  const mod = signals.codebase.modules[0]
  if (mod) {
    yield {
      title: `Add an integration smoke test for the ${mod} module`,
      rationale: `Codebase signal: ${mod} is a top-level src/ module; an evidence-first guard prevents silent regressions.`,
      expectedValue: 'Cheap end-to-end confidence that the module wires up and runs.',
      implementationSketch: `Add one integration test exercising the ${mod} public entrypoint end-to-end.`,
      testableSuccessCriterion: `The new ${mod} smoke test passes in CI and fails if the entrypoint throws.`,
    }
  }
}

export interface SynthesizeOptions {
  /** Cap on proposals returned. */
  readonly k: number
}

/**
 * Synthesize up to `k` NOVEL, evidence-grounded proposals from the real signal bundle.
 * Drops candidates whose family already appears in recent/prior outcomes (no re-proposing)
 * and de-duplicates within the batch. Returns FEWER than `k` (honestly) when signals are thin.
 */
export function synthesizeProposals(
  signals: IdeationSignals,
  opts: SynthesizeOptions,
): IdeationProposal[] {
  if (!Number.isInteger(opts.k) || opts.k <= 0) return []
  const seen = seenFamilies(signals)
  const out: IdeationProposal[] = []
  for (const c of candidates(signals)) {
    const fam = family(c.title)
    if (seen.has(fam)) continue
    seen.add(fam)
    out.push(c)
    if (out.length >= opts.k) break
  }
  return out
}

/**
 * Backend adapter — same {@link IdeationBackend} interface as the ACP backend, but the
 * proposals are synthesised from `signals` (the prompt is ignored). Drop-in for the runner,
 * so gather→parse→inbox is reused unchanged and proposals are tagged `synth-ideation`.
 */
export function createSynthIdeationBackend(
  signals: IdeationSignals,
  opts: SynthesizeOptions,
): IdeationBackend {
  return {
    async ideate(_prompt: string): Promise<string> {
      return JSON.stringify(synthesizeProposals(signals, opts))
    },
  }
}
