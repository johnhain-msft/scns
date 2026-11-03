/**
 * Triage pass over the pending queue.
 *
 * Runs BEFORE a human ever sees the packet, and does the two things John asked for:
 *
 *   1. a proposal that duplicates capability which already exists is rejected BY MACHINE, with a
 *      machine reason, so it stops resurfacing;
 *   2. a proposal that survives gets a spec — what it is, what approving writes, who does the work,
 *      what "no" means — because the live review proved a pattern-observation is not reviewable.
 *
 * The ordering is load-bearing. Uniqueness is DETERMINED first and prose is generated second, so
 * the model is never asked to justify a conclusion nobody established.
 */
import type { createSuggestionStore } from './suggestion-store.js'
import {
  scanExistingCapabilities,
  capabilitiesFromImplementedSuggestions,
  lspCapabilitiesFromConfig,
} from './capability-overlap.js'
import { lspConfigPath } from './artifact-targets.js'
import { triageProposal, type NeutralOverlapChecker } from './proposal-triage.js'
import {
  buildProposalSpec,
  renderProposalSpec,
  capabilityScanSpecs,
  type ArtifactRoots,
} from './proposal-spec.js'
import { subsumes } from './title-similarity.js'
import type { Suggestion } from './types.js'

export const SIBLING_REASON_PREFIX = 'duplicate-proposal:'

/** Higher is the one worth showing: confidence, then more evidence, then the older claim. */
function strongerOf(a: Suggestion, b: Suggestion): Suggestion {
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b
  const ae = a.evidence?.length ?? 0
  const be = b.evidence?.length ?? 0
  if (ae !== be) return ae > be ? a : b
  return a.createdAt <= b.createdAt ? a : b
}

type Store = ReturnType<typeof createSuggestionStore>

/** Writes the prose paragraph for a proposal already established as non-duplicate. */
export type ElaborationWriter = (suggestion: Suggestion) => Promise<string>

export interface TriageRunOptions {
  readonly store: Store
  readonly roots: ArtifactRoots
  readonly askNeutral?: NeutralOverlapChecker
  readonly elaborate?: ElaborationWriter
  /** Cap the pass so a large backlog cannot stall the scheduler tick. */
  readonly limit?: number
}

export interface TriageRunResult {
  readonly rejected: number
  readonly specced: number
  readonly unverified: number
}

export async function triagePendingProposals(options: TriageRunOptions): Promise<TriageRunResult> {
  const { store, roots, askNeutral, elaborate, limit = 25 } = options

  const pending = store.list('pending').filter((s) => !s.implementationPlan)
  if (pending.length === 0) return { rejected: 0, specced: 0, unverified: 0 }

  // Three capability sources, all deterministic:
  //   1. artifact directories on disk (the original scan);
  //   2. the store's own `implemented/` record — a twin of something already built must
  //      never reach John again (lsp ca64e7a1 duplicated 73e80eb6, implemented 04-17);
  //   3. server entries inside lsp-config.json, invisible to a directory scan.
  const existing = [
    ...scanExistingCapabilities(capabilityScanSpecs(roots)),
    ...capabilitiesFromImplementedSuggestions(store.list('implemented')),
    ...lspCapabilitiesFromConfig(lspConfigPath(roots.home)),
  ]

  // Collapse near-duplicate SIBLINGS first. The overlap gate only ever compared a proposal against
  // artifacts that already EXIST, so two proposals for the same unbuilt thing both reached John.
  const superseded = new Map<string, Suggestion>()
  for (let i = 0; i < pending.length; i++) {
    for (let j = i + 1; j < pending.length; j++) {
      const a = pending[i]!
      const b = pending[j]!
      if (a.type !== b.type) continue
      if (superseded.has(a.id) || superseded.has(b.id)) continue
      if (!subsumes(a.title, b.title)) continue
      const keep = strongerOf(a, b)
      const drop = keep === a ? b : a
      superseded.set(drop.id, keep)
    }
  }

  let rejected = 0
  let specced = 0
  let unverified = 0

  for (const suggestion of pending.slice(0, limit)) {
    const winner = superseded.get(suggestion.id)
    if (winner) {
      // FR-050c: automated triage is a MACHINE writer — it must not clear a standing human
      // verdict on its way to deduplicating a queue.
      store.updateStatus(
        suggestion.id,
        'rejected',
        `${SIBLING_REASON_PREFIX} the same proposal is already queued as "${winner.title}"`,
        undefined,
        { author: 'machine' },
      )
      rejected += 1
      continue
    }

    const triage = await triageProposal(suggestion, existing, askNeutral)

    if (triage.outcome === 'duplicate') {
      // Machine reason, no `human:` prefix — this must never be mistaken for John's judgement.
      store.updateStatus(suggestion.id, 'rejected', triage.machineReason ?? '', undefined, {
        author: 'machine',
      })
      rejected += 1
      continue
    }

    let elaboration: string | undefined
    if (elaborate) {
      try {
        elaboration = await elaborate(suggestion)
      } catch {
        elaboration = undefined
      }
    }

    const spec = buildProposalSpec(suggestion, triage, roots, elaboration)
    store.save({
      ...suggestion,
      implementationPlan: renderProposalSpec(spec),
      updatedAt: new Date().toISOString(),
    })
    specced += 1
    if (triage.outcome === 'unverified') unverified += 1
  }

  return { rejected, specced, unverified }
}
