/**
 * D1c — derive OPEN GAPS from negative-memory THEMES + failed outcomes (default-OFF).
 *
 * The synth backend (src/ideate/synth.ts) invents proposals from a signal bundle,
 * and its richest, most concrete novelty source is `openGaps`. In D1 that slot was
 * a single hardcoded gap, so synth always re-proposed the same fix. This module
 * REPLACES the static seed with gaps DERIVED from the real corpus:
 *   - recurring negative-memory THEMES (clustered "don't do this" rules), and
 *   - failed suggestion outcomes (goals that reached status=failed).
 * Each gap cites the exact count/source it came from (evidence-first), so synth
 * closes real, recurring problems instead of one fixed limitation. The static
 * seeds are always kept as a base, so gaps never go empty. Pure + deterministic:
 * same memories/failures → same gaps → unit-testable, CI-safe, no network.
 *
 * DEFAULT-OFF: callers only feed these gaps in when `SCNS_IDEATE_MEMGAPS=1`.
 */

import type { GapSignal } from './types.js'

/** Eligibility mirrors the negative-memory applicator: drop suppressed/low-conf, keep pinned. */
export interface NegMemThemeInput {
  readonly dontRule: string
  readonly category: string
  readonly confidence: number
  readonly pinned?: boolean
  readonly criticStatus?: 'keep' | 'suppress' | 'revise' | null
}

export interface DeriveOpenGapsInput {
  readonly negativeMemories: readonly NegMemThemeInput[]
  /** Titles of suggestions that reached status=failed. */
  readonly failed: readonly string[]
  /** Static seeds kept as a base so gaps are never empty. */
  readonly seeds: readonly GapSignal[]
  /** Memories below this confidence are dropped unless pinned. Default 0.6. */
  readonly minConfidence?: number
  /** A category must recur at least this many times to become a theme gap. Default 2. */
  readonly minThemeSize?: number
  /** Cap on total gaps returned. Default 12. */
  readonly max?: number
}

/** Collapse digits/whitespace so near-duplicate gap details share a family key. */
function family(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b\d+\b/g, '<n>')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Truncate to a clause for compact, readable gap details. */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…'
}

/** Keep pinned, drop low-confidence + critic-suppressed (matches the applicator filter). */
function eligible(m: NegMemThemeInput, minConfidence: number): boolean {
  if (m.pinned) return true
  if (m.confidence < minConfidence) return false
  return m.criticStatus !== 'suppress'
}

/**
 * Derive evidence-first open gaps from recurring negmem themes + failed outcomes,
 * with the static seeds as a base. Deterministic: themes (busiest first) → failures
 * → seeds, de-duplicated by family and capped at `max`.
 */
export function deriveOpenGaps(input: DeriveOpenGapsInput): GapSignal[] {
  const minConfidence = input.minConfidence ?? 0.6
  const minThemeSize = input.minThemeSize ?? 2
  const max = input.max ?? 12

  // ── Cluster eligible negmems by category → recurring "theme" gaps. ──
  const byCategory = new Map<string, NegMemThemeInput[]>()
  for (const m of input.negativeMemories) {
    if (!eligible(m, minConfidence)) continue
    const cat = m.category.trim() || 'general'
    const bucket = byCategory.get(cat) ?? []
    bucket.push(m)
    byCategory.set(cat, bucket)
  }

  const themes = [...byCategory.entries()]
    .filter(([, ms]) => ms.length >= minThemeSize)
    // Busiest theme first; ties broken by category for stable output.
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([cat, ms]): GapSignal => {
      // Representative rule = highest confidence, lexicographic tie-break.
      const rep = [...ms].sort(
        (x, y) => y.confidence - x.confidence || x.dontRule.localeCompare(y.dontRule),
      )[0]!
      return {
        source: `negmem-theme:${cat}`,
        detail: `Recurring "${cat}" failure (×${ms.length}) the system keeps repeating: ${clip(rep.dontRule, 90)}`,
      }
    })

  const failures: GapSignal[] = input.failed.map((t) => ({
    source: 'failed-outcome',
    detail: `Prior initiative reached status=failed: ${clip(t, 90)}`,
  }))

  // Themes (most evidence) → failures → seeds (base, never empty). Dedup + cap.
  const out: GapSignal[] = []
  const seen = new Set<string>()
  for (const g of [...themes, ...failures, ...input.seeds]) {
    const fam = family(g.detail)
    if (seen.has(fam)) continue
    seen.add(fam)
    out.push(g)
    if (out.length >= max) break
  }
  return out
}
