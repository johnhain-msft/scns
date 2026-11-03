/**
 * WS-1 event/outcome substrate — deterministic event SEGMENTER (dream slow-path; DEFAULT-OFF).
 *
 * Turns STRUCTURED sources into clean, narratable decision→action→outcome EVENT nodes with a real
 * per-node event-time τ, instead of the ~400-token size-window chunks that make the live vault
 * ~94% telemetry (the "node quality is the gating variable" bottleneck). This module is PURE +
 * LLM-free: it only READS the injected DBs and returns {@link EventNodeRecord}s; persistence (as
 * facts-as-chunks + the `event_nodes` sidecar) lives in `../memory/event-nodes.ts`.
 *
 * FIRST CUT = the two genuinely STRUCTURED sources (per WS-1 §6, prove node quality on clean
 * sources before the messier session telemetry):
 *   1. broker `events` — a small allowlist of DECISION event types, τ = `created_at`.
 *   2. `proposal_outcomes` — the self-improvement loop's decision→result memory, τ = `created_at`.
 * Session-episode segmentation is a deliberate WS-1 FOLLOW-UP (not implemented here).
 *
 * Determinism: no `Date.now()`, no randomness; τ is copied from the source row and output is a
 * stable-sorted, deduped set — two runs over the same DBs yield an identical `eventKey` set.
 */

import type Database from 'better-sqlite3'
import { causalKey, isLowSignalContent } from '../memory/causal-edges.js'
import { matchEntities, SCNS_GAZETTEER, type GazetteerEntry } from '../memory/entities/gazetteer.js'
import type { EventNodeRecord, EventNodeKind } from '../memory/event-nodes.js'

// The persisted event-node shape is owned by the storage layer (memory/event-nodes.ts); re-export
// so consumers can import the producer's DTO from either module.
export type { EventNodeRecord, EventNodeKind }

export interface SegmentOptions {
  readonly gazetteer?: readonly GazetteerEntry[]
  /** Cap on emitted nodes (defensive bound). Default {@link DEFAULT_MAX_EVENT_NODES}. */
  readonly maxNodes?: number
  /** Broker `events.event_type`s treated as decisions. Default {@link DECISION_EVENT_TYPES}. */
  readonly brokerEventTypes?: readonly string[]
}

export const DEFAULT_MAX_EVENT_NODES = 5000

/** Minimum narratable length — shorter assembled content is dropped as non-narratable. */
const MIN_CONTENT_LENGTH = 24

/**
 * Broker `events` types that are genuine DECISIONS with a narratable decision→outcome shape
 * (verified against the real emitters in event-log.ts / quality-gate-arbiter.ts / auto-merger.ts /
 * startup.ts). Everything else (telemetry/heartbeat/lifecycle churn) is skipped — do-no-harm.
 */
export const DECISION_EVENT_TYPES: readonly string[] = [
  'quality_gate_verdict',
  'auto_merged',
  'auto_merge_rejected',
  'team_completed',
  'suggestion_spawned_team',
  'kernel.decision',
]

// ── small pure helpers ─────────────────────────────────────────────

/** True iff a table exists (keeps readers side-effect-free on partial/legacy DBs). */
function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
  )
}

/**
 * Normalise a SQLite `datetime('now')` timestamp ('YYYY-MM-DD HH:MM:SS', UTC) to strict ISO-8601.
 * Deterministic string transform (no Date parsing / TZ math). Already-ISO or unrecognised values
 * pass through unchanged so τ is always the source event time, never fabricated.
 */
export function normalizeTau(raw: string): string {
  const t = raw.trim()
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)) return `${t.replace(' ', 'T')}Z`
  return t
}

/** First gazetteer canonical mentioned in `text`, else null. */
function canonicalizeEntity(text: string, gazetteer: readonly GazetteerEntry[]): string | null {
  const matches = matchEntities(text, gazetteer)
  return matches.length > 0 ? matches[0]!.canonical : null
}

function asRecord(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === 'object' ? (x as Record<string, unknown>) : {}
}
function getStr(o: Record<string, unknown>, k: string): string | null {
  const v = o[k]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}
function getNum(o: Record<string, unknown>, k: string): number | null {
  const v = o[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function safeParse(payload: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(payload))
  } catch {
    return {}
  }
}

/** Build the durable event key from provenance + content (stable across re-runs). */
function makeEventKey(sourceRef: string, content: string): string {
  return causalKey(`${sourceRef}\u0000${content}`)
}

// ── proposal_outcomes → event nodes ────────────────────────────────

interface OutcomeRow {
  id: number
  entity: string
  family: string
  title: string
  verdict: string
  rationale: string | null
  created_at: string
}

/**
 * One event node per `proposal_outcomes` row — the self-improvement loop's decision→result record,
 * which already carries entity + a discrete verdict (the loop consumes it; now the retrieval +
 * causal layers do too). τ = row.created_at.
 */
export function segmentProposalOutcomes(
  vaultDb: Database.Database,
  _options: SegmentOptions = {},
): EventNodeRecord[] {
  if (!tableExists(vaultDb, 'proposal_outcomes')) return []
  const rows = vaultDb
    .prepare(
      `SELECT id, entity, family, title, verdict, rationale, created_at
         FROM proposal_outcomes
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as OutcomeRow[]

  const out: EventNodeRecord[] = []
  for (const r of rows) {
    const tau = normalizeTau(r.created_at)
    const decision = `self-improvement proposal "${r.title}" [${r.family}]`
    const outcome = `verdict: ${r.verdict}`
    const rationale = r.rationale && r.rationale.trim() !== '' ? ` (${r.rationale.trim()})` : ''
    const content = `On ${tau}, ${decision} targeting ${r.entity} — ${outcome}${rationale}.`
    const sourceRef = `proposal_outcomes#${r.id}`
    out.push({
      eventKey: makeEventKey(sourceRef, content),
      tau,
      entity: r.entity,
      kind: 'proposal-outcome',
      decision,
      action: null,
      outcome,
      content,
      sourceRef,
    })
  }
  return out
}

// ── broker events → event nodes ────────────────────────────────────

interface BrokerEventRow {
  id: number
  event_type: string
  session_id: string | null
  payload: string
  created_at: string
}

interface BrokerMapping {
  readonly decision: string
  readonly action: string | null
  readonly outcome: string
  /** Free-text hint the entity canonicalizer scans (branch/tool/gate/etc.). */
  readonly entityHint: string
}

/** Map an allowlisted broker event to a decision→action→outcome, using ONLY real payload keys. */
function mapBrokerEvent(eventType: string, p: Record<string, unknown>): BrokerMapping | null {
  switch (eventType) {
    case 'quality_gate_verdict': {
      const passed = p['passed'] === true
      const reason = getStr(p, 'reason')
      const score = getNum(p, 'score')
      const branch = getStr(p, 'branch')
      return {
        decision: 'quality-gate review',
        action: branch ? `branch ${branch}` : null,
        outcome: `${passed ? 'passed' : 'failed'}${reason ? ` (${reason})` : ''}${
          score !== null ? `, score ${score}` : ''
        }`,
        entityHint: [branch, reason, getStr(p, 'sourceSuggestionId')].filter(Boolean).join(' '),
      }
    }
    case 'auto_merged': {
      const branch = getStr(p, 'branch')
      const sha = getStr(p, 'merge_sha')
      return {
        decision: 'auto-merge',
        action: branch ? `branch ${branch}` : null,
        outcome: `merged${sha ? ` (${sha.slice(0, 8)})` : ''}`,
        entityHint: [branch, getStr(p, 'source_suggestion_id')].filter(Boolean).join(' '),
      }
    }
    case 'auto_merge_rejected': {
      const branch = getStr(p, 'branch')
      const gates = Array.isArray(p['failedGates']) ? (p['failedGates'] as unknown[]) : []
      const firstGate = gates.length > 0 ? getStr(asRecord(gates[0]), 'gate') : null
      return {
        decision: 'auto-merge',
        action: branch ? `branch ${branch}` : null,
        outcome: `rejected${firstGate ? ` (failed gate: ${firstGate})` : ''}`,
        entityHint: [branch, firstGate, getStr(p, 'source_suggestion_id')].filter(Boolean).join(' '),
      }
    }
    case 'team_completed': {
      const outcome = getStr(p, 'aggregateOutcome') ?? 'completed'
      const teamId = getStr(p, 'team_id') ?? getStr(p, 'teamId')
      return {
        decision: 'team run',
        action: teamId ? `team ${teamId}` : null,
        outcome,
        entityHint: [teamId, getStr(p, 'title')].filter(Boolean).join(' '),
      }
    }
    case 'suggestion_spawned_team': {
      const title = getStr(p, 'title') ?? getStr(p, 'suggestion_title')
      return {
        decision: 'act on self-improvement suggestion',
        action: title ? `"${title}"` : null,
        outcome: 'spawned team',
        entityHint: [title, getStr(p, 'family')].filter(Boolean).join(' '),
      }
    }
    case 'kernel.decision': {
      const allow = p['allow'] === true
      const gate = getStr(p, 'gate')
      const tool = getStr(p, 'tool')
      const reason = getStr(p, 'reason')
      return {
        decision: 'safety-kernel gate',
        action: tool ? `tool ${tool}` : gate ? `gate ${gate}` : null,
        outcome: `${allow ? 'allowed' : 'denied'}${gate ? ` by ${gate}` : ''}${
          reason ? ` (${reason})` : ''
        }`,
        entityHint: [gate, tool].filter(Boolean).join(' '),
      }
    }
    default:
      return null
  }
}

/**
 * One event node per allowlisted broker `events` row (decision events only). τ = created_at; the
 * decision→action→outcome is assembled from REAL payload keys (see {@link mapBrokerEvent}).
 */
export function segmentBrokerDecisions(
  brokerDb: Database.Database,
  options: SegmentOptions = {},
): EventNodeRecord[] {
  if (!tableExists(brokerDb, 'events')) return []
  const gazetteer = options.gazetteer ?? SCNS_GAZETTEER
  const types = options.brokerEventTypes ?? DECISION_EVENT_TYPES
  if (types.length === 0) return []

  const placeholders = types.map(() => '?').join(', ')
  const rows = brokerDb
    .prepare(
      `SELECT id, event_type, session_id, payload, created_at
         FROM events
        WHERE event_type IN (${placeholders})
        ORDER BY created_at ASC, id ASC`,
    )
    .all(...types) as BrokerEventRow[]

  const out: EventNodeRecord[] = []
  for (const r of rows) {
    const mapping = mapBrokerEvent(r.event_type, safeParse(r.payload))
    if (!mapping) continue
    const tau = normalizeTau(r.created_at)
    const actionText = mapping.action ? `${mapping.action}: ` : ''
    const content = `On ${tau}, the broker ${mapping.decision} — ${actionText}${mapping.outcome}.`
    const sourceRef = `events#${r.id}`
    const entity =
      canonicalizeEntity(mapping.entityHint, gazetteer) ?? canonicalizeEntity(content, gazetteer)
    out.push({
      eventKey: makeEventKey(sourceRef, content),
      tau,
      entity,
      kind: 'broker-decision',
      decision: mapping.decision,
      action: mapping.action,
      outcome: mapping.outcome,
      content,
      sourceRef,
    })
  }
  return out
}

// ── combined entry point ───────────────────────────────────────────

export interface SegmentSources {
  /** Vault memory DB (holds `proposal_outcomes`). Required. */
  readonly vaultDb: Database.Database
  /** Broker DB (holds `events`). Optional — omit to segment outcomes only. */
  readonly brokerDb?: Database.Database
}

/**
 * Segment all structured sources into a deterministic, deduped, low-signal-filtered set of event
 * nodes. Stable-sorted by τ (insertion order breaks ties), so two runs over the same DBs return an
 * identical ordered set — the property the persistence layer relies on for idempotent chunk_index
 * assignment.
 */
export function segmentStructuredEvents(
  sources: SegmentSources,
  options: SegmentOptions = {},
): EventNodeRecord[] {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_EVENT_NODES
  const raw: EventNodeRecord[] = [
    ...segmentProposalOutcomes(sources.vaultDb, options),
    ...(sources.brokerDb ? segmentBrokerDecisions(sources.brokerDb, options) : []),
  ]

  const seen = new Set<string>()
  const kept: EventNodeRecord[] = []
  for (const r of raw) {
    if (r.content.length < MIN_CONTENT_LENGTH) continue
    if (isLowSignalContent(r.content)) continue
    if (seen.has(r.eventKey)) continue
    seen.add(r.eventKey)
    kept.push(r)
  }

  // Stable sort by τ only — Array.prototype.sort is stable, so equal-τ rows keep source order
  // (outcomes-by-id, then broker-by-id). Deterministic and re-chunk-proof.
  kept.sort((a, b) => (a.tau < b.tau ? -1 : a.tau > b.tau ? 1 : 0))
  return kept.slice(0, maxNodes)
}
