/**
 * QG-MISLABEL REPAIR — the write side the census deliberately lacked.
 *
 * `qg-mislabel-census.ts` is read-only by construction, which was right for measuring the damage
 * and wrong as a place to stop: the damage it measures is LIVE. `dedup-policy.ts` treats `rejected`
 * as a PERMANENT block with no time window, so every row the quality gate mislabelled goes on
 * vetoing its whole proposal family forever — on the strength of a build failure, not a decision.
 * Fixing the mechanism (FR-050c / FR-056) stopped new damage; it did not undo the rows already on
 * disk. This module undoes them.
 *
 * TWO SHAPES, TWO DIFFERENT REPAIRS, because they have two different standards of proof:
 *
 * 1. `restore-approval` — his verdict is still provable. The row carries a `human:` reason whose
 *    code is an APPROVE code, so we know what he decided even though `verdictContradictsStatus`
 *    erased the `reviewVerdict` field. The row goes back to `approved` with the verdict restored.
 *
 *    ⚠ The census cannot be trusted to select these on its own. Its `verdict-erased` arm only
 *    tests `isHumanReason`, which is equally true of "human:wrong-target: it targets the wrong
 *    file" — a genuine REFUSAL. Promoting that to `approved` would put words in his mouth and then
 *    train on them. So the code class is re-derived here and a reject/explain code is SKIPPED.
 *
 * 2. `demote-to-needs-human` — his verdict is NOT provable. The older damage shape overwrote the
 *    human's `reviewReason` field with the gate's own `qg-fail:*` string, so whatever he said is
 *    gone. Asserting he approved would be the unbacked verdict this whole phase exists to stop.
 *    But leaving it as `rejected` keeps a machine's build failure wearing the human-refusal label
 *    and vetoing the family. It moves to `needs-human` / `gate-exhausted` — which says exactly
 *    what is true: the IDEA was never judged, only the build failed.
 *
 * PROVENANCE. A repair is not a review. `reviewedAt` and `createdAt` are left untouched so history
 * stays honest, and `repairedAt` / `repairNote` are stamped so a later reader can tell a corrected
 * row from one John touched himself.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  parseFrontmatter,
  sanitizeFrontmatterText,
  serializeFrontmatter,
} from './suggestion-file.js'
import { APPROVE_REASON_CODES, parseReviewReason } from './review-reason.js'
import { QG_FAIL_PREFIX } from './escalation.js'
import { lspServerForTags } from './lsp-servers.js'
import { homedir } from 'node:os'
import { lspConfigPath, suggestedInstructionsPath } from './artifact-targets.js'

/** What the repair decided to do with one row. */
export type RepairAction = 'restore-approval' | 'demote-to-needs-human' | 'retype-lsp' | 'skip'

export interface RepairPlanItem {
  readonly id: string
  readonly path: string
  readonly action: RepairAction
  readonly fromStatus: string
  readonly toStatus: string
  /** Why this action, in a sentence — printed by the CLI so the operator can audit the plan. */
  readonly why: string
}

export interface RepairReport {
  readonly scanned: number
  readonly items: readonly RepairPlanItem[]
  readonly applied: number
  readonly dryRun: boolean
}

const HUMAN_REFUSAL_STATUS = 'rejected'

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Is this stored reason a human APPROVAL (as opposed to a refusal or a request to explain)? */
export function isHumanApproval(stored: string | null | undefined): boolean {
  if (stored == null) return false
  const parsed = parseReviewReason(stored)
  if (!parsed?.code) return false
  return Object.prototype.hasOwnProperty.call(APPROVE_REASON_CODES, parsed.code)
}

/**
 * Decide what to do with one `rejected` row, from its frontmatter alone.
 * Returns `null` when the row is not damaged and must be left exactly as it is.
 */
function classify(
  frontmatter: Record<string, unknown>,
): { action: Exclude<RepairAction, 'skip'>; toStatus: string; why: string } | null {
  const status = readString(frontmatter['status']) ?? ''

  // Type mislabel — orthogonal to status, so it is checked first and at ANY status. Proposals
  // written before `lsp` became executable shipped as `type: instruction`, which routes them to
  // "append a sentence to a markdown file" instead of registering a language server. The tags are
  // the evidence: only the LSP extractor stamps `lsp` alongside a language tag.
  if (readString(frontmatter['type']) === 'instruction') {
    const tags = Array.isArray(frontmatter['tags'])
      ? (frontmatter['tags'] as unknown[]).map((t) => String(t).toLowerCase())
      : []
    if (tags.includes('lsp') && lspServerForTags(tags)) {
      return {
        action: 'retype-lsp',
        toStatus: status,
        why: 'tagged lsp but typed instruction — approving it would have appended prose instead of registering a language server',
      }
    }
  }

  if (status !== HUMAN_REFUSAL_STATUS) return null

  const machineReason = readString(frontmatter['machineReason'])
  const reviewReason = readString(frontmatter['reviewReason'])
  const reviewVerdict = readString(frontmatter['reviewVerdict'])

  // Shape 2 — the gate's string sitting in the human's field, with no machine field at all.
  if (!machineReason && reviewReason?.startsWith(QG_FAIL_PREFIX)) {
    return {
      action: 'demote-to-needs-human',
      toStatus: 'needs-human',
      why: `quality gate wrote "${reviewReason}" into the human reason field; his decision is unrecoverable, so the row cannot stay a human refusal`,
    }
  }

  if (!machineReason?.startsWith(QG_FAIL_PREFIX)) return null

  // Shape 1 — a gate failure on a row that still proves he approved.
  if (reviewVerdict === 'approve' || (reviewVerdict === null && isHumanApproval(reviewReason))) {
    return {
      action: 'restore-approval',
      toStatus: 'approved',
      why: `he approved this ("${reviewReason}") and the gate failed with "${machineReason}" — a build failure is not a refusal`,
    }
  }

  return null
}

/** Build the repair plan without touching anything. */
export function planQgMislabelRepair(suggestionsDir: string): RepairPlanItem[] {
  return scanForRepairs(suggestionsDir).items
}

/**
 * `<id>.critique.md` sidecars live in the same status directories as the rows they describe, but
 * they are NOT suggestion rows: they carry no `status` frontmatter at all. Reading one as a row is
 * how an empty `toStatus` gets into a plan, so they are excluded before anything else looks at them.
 */
const CRITIQUE_SUFFIX = '.critique.md'

/**
 * Walk the store once, returning both the plan and an honest count of what was looked at.
 *
 * `scanned` means "suggestion rows inspected", counted BEFORE parsing so unreadable rows are
 * included — a row that cannot be parsed was still examined and still needs to show up in an audit.
 * It deliberately EXCLUDES `*.critique.md` sidecars, so it will read lower than the census's
 * `scanned` on the same directory; the census counts every `.md` file, sidecars included.
 */
function scanForRepairs(suggestionsDir: string): {
  items: RepairPlanItem[]
  scanned: number
} {
  const items: RepairPlanItem[] = []
  let scanned = 0
  if (!existsSync(suggestionsDir)) return { items, scanned }

  for (const entry of readdirSync(suggestionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(suggestionsDir, entry.name)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      if (file.endsWith(CRITIQUE_SUFFIX)) continue
      scanned++
      const path = join(dir, file)
      let frontmatter: Record<string, unknown>
      try {
        frontmatter = parseFrontmatter(readFileSync(path, 'utf-8')).frontmatter
      } catch {
        continue
      }
      const decision = classify(frontmatter)
      if (!decision) continue
      items.push({
        id: readString(frontmatter['id']) ?? file.replace(/\.md$/, ''),
        path,
        action: decision.action,
        fromStatus: readString(frontmatter['status']) ?? entry.name,
        // `retype-lsp` runs at ANY status and echoes the row's own status back, which is empty
        // when the row has no `status` field. Left empty it would reach `join(suggestionsDir, '')`
        // in apply — moving the row into the store ROOT, where the directory-only walk above can
        // never see it again. The containing directory is the store's own record of the status.
        toStatus: decision.toStatus || entry.name,
        why: decision.why,
      })
    }
  }
  return { items, scanned }
}

/**
 * Apply the plan. Rewrites frontmatter in place and moves each file into its corrected status
 * directory. `dryRun` reports what would happen and writes nothing.
 */
export function applyQgMislabelRepair(
  suggestionsDir: string,
  options: { readonly dryRun?: boolean } = {},
): RepairReport {
  const dryRun = options.dryRun ?? true
  const { items, scanned } = scanForRepairs(suggestionsDir)
  let applied = 0

  if (!dryRun) {
    const repairedAt = new Date().toISOString()
    for (const item of items) {
      const raw = readFileSync(item.path, 'utf-8')
      const { frontmatter, body } = parseFrontmatter(raw)
      const next: Record<string, unknown> = { ...frontmatter, status: item.toStatus }

      if (item.action === 'restore-approval') {
        // The verdict `verdictContradictsStatus` erased when the machine wrote `rejected`.
        next['reviewVerdict'] = 'approve'
        delete next['escalation']
      } else if (item.action === 'retype-lsp') {
        next['type'] = 'lsp'
      } else {
        // Move the gate's words out of the human's field, where they were never his.
        next['machineReason'] = frontmatter['reviewReason']
        delete next['reviewReason']
        next['escalation'] = 'gate-exhausted'
        next['reviewVerdict'] = undefined
        delete next['reviewVerdict']
      }

      next['updatedAt'] = repairedAt
      next['repairedAt'] = repairedAt
      // This serializer double-quotes values without escaping them, so an unescaped `"` inside the
      // note would truncate the field on the next read. `why` quotes the human's own words.
      next['repairNote'] = sanitizeFrontmatterText(item.why)

      const targetDir = join(suggestionsDir, item.toStatus)
      mkdirSync(targetDir, { recursive: true })
      const targetPath = join(targetDir, `${item.id}.md`)
      writeFileSync(item.path, serializeFrontmatter(next, body), 'utf-8')
      if (targetPath !== item.path) renameSync(item.path, targetPath)
      applied++
    }
  }

  return { scanned, items, applied, dryRun }
}

/**
 * Rewrite the stored "If you approve" destination sentence on rows written before the artifact
 * location map was corrected.
 *
 * Fixing the generator does not fix proposals already on disk. Those rows keep the sentence John
 * actually read — "files would be written under <repo>/.github/instructions" — which is the exact
 * artifact he reported. Worse, a reviewing critic compares the approved text against what the code
 * does, sees them disagree, and fails the suggestion for a defect that has already been fixed.
 */
export interface DestinationTextRepairItem {
  readonly id: string
  readonly path: string
  readonly from: string
  readonly to: string
}

const STALE_DESTINATION_RE =
  /(files would be written under|the file written would be) (\S+?)\.(?=\s|$)/

export function planDestinationTextRepair(rootDir: string): readonly DestinationTextRepairItem[] {
  const items: DestinationTextRepairItem[] = []
  if (!existsSync(rootDir)) return items

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(rootDir, entry.name)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md') || file.endsWith('.critique.md')) continue
      const path = join(dir, file)
      const raw = readFileSync(path, 'utf-8')
      const { frontmatter } = parseFrontmatter(raw)
      const type = readString(frontmatter['type'])
      if (type !== 'instruction' && type !== 'lsp') continue

      const truth = type === 'lsp' ? lspConfigPath(homedir()) : suggestedInstructionsPath(homedir())
      const match = STALE_DESTINATION_RE.exec(raw)
      if (!match || match[2] === truth) continue

      items.push({
        id: readString(frontmatter['id']) ?? file.replace(/\.md$/, ''),
        path,
        from: match[2]!,
        to: truth,
      })
    }
  }
  return items
}

export function applyDestinationTextRepair(
  rootDir: string,
  opts: { readonly dryRun?: boolean } = {},
): { readonly items: readonly DestinationTextRepairItem[]; readonly applied: boolean } {
  const items = planDestinationTextRepair(rootDir)
  const dryRun = opts.dryRun ?? true
  if (dryRun) return { items, applied: false }

  for (const item of items) {
    const raw = readFileSync(item.path, 'utf-8')
    const next = raw.replace(
      new RegExp(STALE_DESTINATION_RE.source, 'g'),
      `the file written would be ${item.to}.`,
    )
    writeFileSync(item.path, next, 'utf-8')
  }
  return { items, applied: true }
}
