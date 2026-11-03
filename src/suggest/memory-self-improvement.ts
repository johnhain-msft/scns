/**
 * D2a — memory-derived self-improvement ideation (the READ half of the loop;
 * MAGMA Eq.1 `oₜ = LLM(qₜ, Retrieve(qₜ, Mₜ))`, design-m1.md §6).
 *
 * Today's `self-improvement-extractor.ts` re-emits a static 3-item menu with no
 * memory read and no feedback loop. This module replaces that static menu (when
 * enabled) with a SELECTION driven by the live memory graph + outcome history:
 *
 *   • READ  — for each entity-anchored candidate, pull its entity neighborhood
 *             (real M1.1 graph activity = "what's hot") and aggregate its
 *             `proposal_outcomes` (D2b = "what landed / what keeps failing").
 *   • DECIDE — prioritise candidates whose entity is active in memory; SUPPRESS
 *             families that already landed (don't redo) or repeatedly failed
 *             (don't repeat failure modes — the WHY-causal intent, approximated
 *             deterministically until causal edges populate).
 *
 * The proposal *catalog* is curated (concrete, test-coverable, each anchored to a
 * gazetteer canonical); what's memory-derived is WHICH proposals surface and their
 * PRIORITY. This is an honest deterministic read→decision loop — no LLM-invented
 * text — and it grounds the optional LLM ideate backend (wedge D1) with real signal.
 *
 * Pure: the core selector takes injected readers; `makeMemorySeedReaders` adapts a
 * memory DB handle. Default-OFF at the call site (generator gates on SCNS_IDEATE_MEMORY).
 */

import type Database from 'better-sqlite3'
import { entityNeighborhood, type NeighborhoodChunk } from '../memory/entities/neighborhood.js'
import {
  aggregateOutcomesByEntity,
  type EntityOutcomeAggregate,
} from '../memory/proposal-outcomes.js'
import { SCNS_GAZETTEER, type GazetteerEntry } from '../memory/entities/gazetteer.js'
import type { ScnsSelfImprovementSeed } from './extractors/self-improvement-extractor.js'

/** A self-improvement seed anchored on a gazetteer entity (the graph/outcome key). */
export interface EntityAnchoredSeed extends ScnsSelfImprovementSeed {
  /** Gazetteer canonical this proposal targets — drives the graph/outcome read. */
  readonly entity: string
  /** Stable family key for outcome aggregation + suppression (mirrors `tag`). */
  readonly family: string
}

/**
 * Curated catalog of concrete, naturally test-coverable improvements to SCNS itself,
 * each anchored on a real gazetteer entity so D2a can rank it by live graph activity
 * and outcome history. Keep entries small + high-signal (each satisfies the auto-merge
 * `has-test-coverage` gate). The SELECTION among these is what memory drives.
 */
export const ENTITY_ANCHORED_SEEDS: readonly EntityAnchoredSeed[] = [
  {
    entity: 'quality-gate',
    family: 'qg-verdict-event',
    tag: 'qg-verdict-event',
    title: 'Emit a structured event when the quality-gate arbiter finalizes a verdict',
    description:
      'src/broker/services/quality-gate-arbiter.ts should emit a structured event ' +
      '(e.g. quality_gate_verdict with score + pass/fail + reason) when a verdict is ' +
      'finalized, so operators can audit gate decisions. Add the emission behind the ' +
      'existing event sink and a unit test asserting it fires on PASS and FAIL.',
  },
  {
    entity: 'broker',
    family: 'broker-port-precedence',
    tag: 'broker-port-precedence',
    title: 'Document + test the broker port override precedence',
    description:
      'Document and add a unit test covering the broker port resolution precedence ' +
      '(-p/--port flag vs env vs the default 3456 in src/broker/config.ts) so the ' +
      'override order is discoverable and regression-locked.',
  },
  {
    entity: 'memory-search',
    family: 'memsearch-intent-metric',
    tag: 'memsearch-intent-metric',
    title: 'Tag memory-search results with the intent route taken',
    description:
      'The intent-aware memory-search path should record which route it took ' +
      '(ENTITY/WHEN/WHY/DEFAULT) as a structured field/metric, so retrieval-quality ' +
      'can be measured per intent class. Add the tag and a unit test asserting each ' +
      'query class is labelled correctly.',
  },
  {
    entity: 'dream-daemon',
    family: 'dream-phase-event',
    tag: 'dream-phase-event',
    title: 'Emit a structured event for each dream-daemon phase',
    description:
      'src/dream/dream-daemon.ts should emit a structured start/end event per phase ' +
      '(consolidation, tiered, causal, core-files) so the nightly slow path is ' +
      'auditable. Add the emissions behind the existing logger/event sink and a unit ' +
      'test asserting the phase events fire in order.',
  },
  {
    entity: 'autonomy',
    family: 'autonomy-transition-log',
    tag: 'autonomy-transition-log',
    title: 'Log a structured event on every autonomy-level transition',
    description:
      'Whenever the brain raises or lowers the autonomy level, emit a structured ' +
      'event capturing from→to + the triggering reason, so autonomy changes are ' +
      'auditable. Add the emission and a unit test asserting it fires on raise and lower.',
  },
  {
    entity: 'worktree',
    family: 'worktree-cleanup-metric',
    tag: 'worktree-cleanup-metric',
    title: 'Emit a structured event when a per-team worktree is reclaimed',
    description:
      'team-worktree-manager.removeWorktreeForTeam should emit a structured ' +
      'event (e.g. worktree_reclaimed) so operators can audit worktree ' +
      'lifecycle. Add the emission behind the existing eventLog sink and a ' +
      'unit test asserting it fires on cleanup.',
  },
  {
    entity: 'negative-memory',
    family: 'negmem-suppressor-coverage',
    tag: 'negmem-suppressor-coverage',
    title: 'Lock the agent-instruction suppressor against bootstrap/handoff prompts',
    description:
      'Add a regression test asserting the sentiment-analyzer agent-instruction ' +
      'suppressor (isAgentInstructionPrompt) keeps bootstrap/handoff prompts dense ' +
      'with "never…/ALWAYS…/HARD-STOP" from minting negative memories, so the issue-#5 ' +
      'family cannot regress.',
  },
]

/** Readers the selector depends on — injected so the core logic is pure/testable. */
export interface MemorySeedReaders {
  /** Entity neighborhood from the live M1.1 graph (activity signal). */
  readonly neighborhood: (entity: string) => readonly NeighborhoodChunk[]
  /** Aggregated proposal outcomes for an entity (the D2b "what landed" signal). */
  readonly outcomes: (entity: string) => EntityOutcomeAggregate
}

export interface SelectOptions {
  /** Catalog to select from. Default {@link ENTITY_ANCHORED_SEEDS}. */
  readonly seeds?: readonly EntityAnchoredSeed[]
  /** Max seeds to surface. Default 3. */
  readonly limit?: number
  /** Require the entity to have ≥N neighborhood chunks (real graph signal). Default 1. */
  readonly minActivity?: number
  /** Suppress a family once it has failed ≥N times for its entity. Default 2. */
  readonly maxFamilyFailures?: number
}

export interface MemorySeedSelection {
  readonly seed: EntityAnchoredSeed
  readonly entity: string
  /** Convenience mirror of `seed.family` — the suppression/outcome key. */
  readonly family: string
  /** Neighborhood size = live graph activity for this entity. */
  readonly activity: number
  /** Most-recent neighborhood mtime (recency tiebreak). */
  readonly latestMtimeMs: number
  readonly landed: number
  readonly failed: number
  /** Ranking score (activity-driven). */
  readonly score: number
  readonly suppressed: boolean
  readonly suppressReason?: 'already-landed' | 'repeated-failure'
}

const DEFAULT_LIMIT = 3
const DEFAULT_MIN_ACTIVITY = 1
/** Failures for one (entity, family) before the seed reader stops re-proposing it. */
export const DEFAULT_MAX_FAMILY_FAILURES = 2

/**
 * Select the memory-derived self-improvement seeds: rank entity-anchored candidates
 * by live graph activity, drop ones whose entity is inactive in memory, and suppress
 * families that already landed or keep failing. Returns the top {@link SelectOptions.limit}
 * surviving selections, highest-activity first. Returns [] when nothing is active
 * (the generator then falls back to the static hardcoded path).
 */
export function selectMemoryDerivedSeeds(
  readers: MemorySeedReaders,
  options: SelectOptions = {},
): MemorySeedSelection[] {
  const seeds = options.seeds ?? ENTITY_ANCHORED_SEEDS
  const limit = options.limit ?? DEFAULT_LIMIT
  const minActivity = options.minActivity ?? DEFAULT_MIN_ACTIVITY
  const maxFamilyFailures = options.maxFamilyFailures ?? DEFAULT_MAX_FAMILY_FAILURES

  const surviving: MemorySeedSelection[] = []

  for (const seed of seeds) {
    const hood = readers.neighborhood(seed.entity)
    const activity = hood.length
    if (activity < minActivity) continue // no real graph signal → not "hot", skip

    const agg = readers.outcomes(seed.entity)
    const fam = agg.families.get(seed.family)
    const familyLanded = fam?.landed ?? 0
    const familyFailed = fam?.failed ?? 0

    // Suppress: do not re-propose a family that already landed for this entity, and
    // do not repeat a family that keeps failing for it (avoid repeating failure modes).
    if (familyLanded > 0 || familyFailed >= maxFamilyFailures) continue

    const latestMtimeMs = hood.reduce((m, c) => Math.max(m, c.mtimeMs), 0)
    surviving.push({
      seed,
      entity: seed.entity,
      family: seed.family,
      activity,
      latestMtimeMs,
      landed: familyLanded,
      failed: familyFailed,
      score: activity,
      suppressed: false,
    })
  }

  surviving.sort((a, b) => b.score - a.score || b.latestMtimeMs - a.latestMtimeMs)
  return surviving.slice(0, limit)
}

/** Adapt a memory vault DB handle into the readers the selector needs. */
export function makeMemorySeedReaders(
  db: Database.Database,
  gazetteer: readonly GazetteerEntry[] = SCNS_GAZETTEER,
): MemorySeedReaders {
  return {
    neighborhood: (entity: string) => entityNeighborhood(db, entity, { gazetteer }),
    outcomes: (entity: string) => aggregateOutcomesByEntity(db, entity),
  }
}
