/**
 * Shared evidence-capture utility (feature 002, task T007) — the durable spine for every judged run's
 * evidence, implementing `specs/002-north-star-audit-remediation/contracts/evidence-results.schema.md`
 * (research R7). It exists to make the fable5 §6 over-claim failures STRUCTURALLY impossible:
 *
 *  1. **Full stdout, un-truncated** — {@link writeFullLog} archives the complete log (fable5 lost
 *     ~178/180 per-item rows to `head`-truncation).
 *  2. **Per-item JSONL** — {@link appendPerItem} appends one `{arm,category,score,tokens,generated_answer}`
 *     row per judged item.
 *  3. **RESULTS_JSON blocks** — {@link buildResultsJson}/{@link validateResultsJson} assemble + check the
 *     `perArmPerCategory` / `substrate` / `sc004` / `armCost` blocks with accuracy AND tokens per cell.
 *  4. **SC-008 structural separation** — {@link computeSc004} is the ONLY way to derive the briefing-vs-
 *     full-context fraction, and it takes an EXPLICIT full-context arm's tokens; there is NO code path
 *     that derives it from {@link ArmCost} (hybrid-vs-magma). The conflation fable5 made is unreachable.
 *  5. **det×2 machine-verified** — {@link resultsJsonHash}/{@link detHashMatch} compare two runs' hashes
 *     (not an env attestation).
 *
 * Pure + fs-only (no logger, no process state) so it is trivially unit-testable with pos/neg controls.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** The four judged arms (schema §2). `full-context` is the explicit SC-008 denominator arm. */
export type Arm = 'hybrid' | 'magma' | 'multihop-iter' | 'full-context'
/** The five LoCoMo/LME question categories (schema §2). */
export type Category = 'single_hop' | 'multi_hop' | 'temporal' | 'adversarial' | 'open_domain'

/** One judged item — the JSONL row (schema §2). */
export interface PerItemRow {
  readonly arm: Arm | string
  readonly category: Category | string
  readonly score: number
  readonly tokens: number
  readonly generated_answer: string
}

/** Per-arm × per-category aggregate (schema §3.1) — accuracy AND tokens, never counts-only. */
export interface PerArmPerCategory {
  readonly arm: Arm | string
  readonly category: Category | string
  readonly accuracy: number
  readonly tokens: number
}

/** Substrate density block (schema §3.2) — quoted un-elided in any DoD. */
export interface SubstrateBlock {
  readonly materializedPerConv: number
  readonly perWhyItem: number
  readonly perConvMin: number
  readonly floor: { readonly perConv: number; readonly perWhyItem: number }
  readonly preCheckOk: boolean
}

/** SC-008 briefing-vs-full-context block (schema §3.3) — derived only from an explicit full-context arm. */
export interface Sc004Block {
  readonly briefingTok: number
  readonly fullContextTok: number
  readonly fraction: number
}

/** Per-arm total token cost (schema §3.4) — an efficiency figure, NEVER an SC-008 denominator. */
export type ArmCost = Partial<Record<Arm, number>> & Record<string, number>

/** The machine summary a judged run emits (schema §3). */
export interface ResultsJson {
  readonly perArmPerCategory: PerArmPerCategory[]
  readonly substrate: SubstrateBlock
  readonly sc004: Sc004Block
  readonly armCost: ArmCost
  readonly judgeSigma: number
  readonly detRuns: number
  readonly detHashMatch: boolean
}

/** Ensure a file's parent directory exists before writing. */
function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

/**
 * Archive the COMPLETE stdout of a run, un-truncated. The whole string is written verbatim — this is the
 * anti-`head`-truncation guarantee (fable5 §6.1). Callers must pass the full captured output, not a slice.
 */
export function writeFullLog(logPath: string, fullStdout: string): void {
  ensureDir(logPath)
  writeFileSync(logPath, fullStdout, 'utf8')
}

/** Append one per-item JSONL row (schema §2). One line per judged item; the file is the row-of-record. */
export function appendPerItem(jsonlPath: string, row: PerItemRow): void {
  ensureDir(jsonlPath)
  appendFileSync(jsonlPath, JSON.stringify(row) + '\n', 'utf8')
}

/**
 * The ONLY sanctioned way to compute the SC-008 "briefing vs full-context" fraction (FR-018): it takes
 * the briefing tokens and an EXPLICIT full-context arm's tokens. There is deliberately no overload that
 * accepts {@link ArmCost} — arm-vs-arm cost can never flow into this number (structural separation).
 * Throws if `fullContextTok <= 0` (no full-context arm ⇒ the claim cannot be made, per the contract).
 */
export function computeSc004(briefingTok: number, fullContextTok: number): Sc004Block {
  if (!Number.isFinite(fullContextTok) || fullContextTok <= 0) {
    throw new Error(
      'computeSc004 requires an explicit full-context arm with tokens > 0 — the SC-008 fraction MUST NOT ' +
        'be rendered from arm-vs-arm cost (FR-018)',
    )
  }
  if (!Number.isFinite(briefingTok) || briefingTok < 0) {
    throw new Error(`computeSc004 requires briefingTok >= 0 (got ${briefingTok})`)
  }
  return { briefingTok, fullContextTok, fraction: briefingTok / fullContextTok }
}

/**
 * Acceptance rule 1 + the fable5 "byCategory: cat1=12…" defect: `perArmPerCategory` MUST cover every
 * `arm × category` cell, and each cell MUST carry a finite `accuracy` AND `tokens` (never counts-only).
 * Throws listing the first missing/invalid cell.
 */
export function assertPerArmPerCategoryComplete(
  rows: readonly PerArmPerCategory[],
  arms: readonly string[],
  categories: readonly string[],
): void {
  const index = new Map<string, PerArmPerCategory>()
  for (const r of rows) index.set(`${r.arm}\u0000${r.category}`, r)
  for (const arm of arms) {
    for (const category of categories) {
      const cell = index.get(`${arm}\u0000${category}`)
      if (!cell) {
        throw new Error(`perArmPerCategory missing the ${arm} × ${category} cell (SC-002 requires all cells)`)
      }
      if (!Number.isFinite(cell.accuracy) || !Number.isFinite(cell.tokens)) {
        throw new Error(
          `perArmPerCategory ${arm} × ${category} must carry finite accuracy AND tokens (counts-only is rejected)`,
        )
      }
    }
  }
}

/**
 * Validate a {@link ResultsJson} against the schema's structural rules. Returns the list of problems
 * (empty ⇒ valid). Checks: all blocks present; substrate un-elided (all numeric fields finite + floor);
 * sc004 present with a full-context denominator; perArmPerCategory non-empty with accuracy+tokens.
 */
export function validateResultsJson(r: ResultsJson): string[] {
  const problems: string[] = []
  if (!Array.isArray(r.perArmPerCategory) || r.perArmPerCategory.length === 0) {
    problems.push('perArmPerCategory is empty (SC-002 requires per-arm per-category rows)')
  } else {
    for (const c of r.perArmPerCategory) {
      if (!Number.isFinite(c.accuracy) || !Number.isFinite(c.tokens)) {
        problems.push(`perArmPerCategory ${c.arm}×${c.category} missing finite accuracy/tokens`)
      }
    }
  }
  const s = r.substrate
  if (!s) problems.push('substrate block absent (must be quoted un-elided in the DoD)')
  else {
    for (const [k, v] of [
      ['materializedPerConv', s.materializedPerConv],
      ['perWhyItem', s.perWhyItem],
      ['perConvMin', s.perConvMin],
    ] as const) {
      if (!Number.isFinite(v)) problems.push(`substrate.${k} is elided/non-finite`)
    }
    if (!s.floor || !Number.isFinite(s.floor.perConv) || !Number.isFinite(s.floor.perWhyItem)) {
      problems.push('substrate.floor absent/non-finite')
    }
  }
  if (!r.sc004) problems.push('sc004 block absent')
  else if (!Number.isFinite(r.sc004.fullContextTok) || r.sc004.fullContextTok <= 0) {
    problems.push('sc004.fullContextTok must be a positive explicit full-context arm (SC-008)')
  }
  if (!Number.isFinite(r.judgeSigma)) problems.push('judgeSigma is not a finite number')
  return problems
}

/** Deterministic JSON stringify (recursively sorted keys) so equivalent objects hash identically. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/**
 * Stable SHA-256 over a RESULTS_JSON body, EXCLUDING the `detHashMatch`/`detRuns` bookkeeping fields
 * (they describe the comparison, so including them would be circular). This is the det×2 fingerprint.
 */
export function resultsJsonHash(r: ResultsJson): string {
  const { detHashMatch: _hm, detRuns: _dr, ...body } = r
  void _hm
  void _dr
  return createHash('sha256').update(stableStringify(body)).digest('hex')
}

/** det×2: two runs reproduce iff their RESULTS_JSON hashes are byte-equal (machine-verified, rule 4). */
export function detHashMatch(runA: ResultsJson, runB: ResultsJson): boolean {
  return resultsJsonHash(runA) === resultsJsonHash(runB)
}
