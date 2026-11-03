/**
 * T143 / T148 — run the SC-029 + SC-031 census over a live corpus, read-only.
 *
 * Usage:
 *   npx tsx scripts/qg-mislabel-census.ts [scnsHome]
 *
 * Defaults to `~/.scns`. Opens the suggestion files for READ only and the vault with
 * `readonly: true`, so it is safe to point at the live instance while the broker runs.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { censusQgMislabels, censusFamilySuppression } from '../src/suggest/qg-mislabel-census.js'
import { DEFAULT_MAX_FAMILY_FAILURES } from '../src/suggest/memory-self-improvement.js'

const scnsHome = process.argv[2] ?? join(homedir(), '.scns')
const suggestionsDir = join(scnsHome, 'suggestions')
const vaultPath = join(scnsHome, 'memory', 'vault.db')

const files = censusQgMislabels(suggestionsDir)

console.log(`# SC-029 census — ${suggestionsDir}`)
console.log(`scanned:                     ${files.scanned}`)
console.log(`unreadable:                  ${files.unreadable}`)
console.log(`VIOLATIONS (SC-029):         ${files.violations.length}`)
console.log(`  verdict intact:            ${files.violationsWithVerdictIntact}`)
console.log(`  verdict erased:            ${files.violationsWithVerdictErased}`)
console.log(`  terminal on attempt 1:     ${files.violationsWithZeroAttempts}`)
for (const v of files.violations) {
  console.log(
    `  - ${v.id} status=${v.status} evidence=${v.evidence} attemptCount=${v.attemptCount} machineReason=${v.machineReason} reviewReason=${v.reviewReason ?? '(none)'}`,
  )
}

// Deliberately reported SEPARATELY from `violations` so SC-029's number is not inflated: on these
// the gate overwrote the human's own reason field, so the human's intent is unrecoverable rather
// than merely mislabelled. Printing them is not optional — they are the population a census keyed
// on `machineReason` alone cannot see, and silence here reads as "clean".
console.log(`MACHINE-WRITTEN REFUSALS:    ${files.machineWrittenRefusals.length}`)
for (const m of files.machineWrittenRefusals) {
  console.log(`  - ${m.id} status=${m.status} reviewReason=${m.reviewReason}`)
}

if (!existsSync(vaultPath)) {
  console.log(`\n# SC-031 census — SKIPPED, no vault at ${vaultPath}`)
  process.exit(0)
}

const db = new Database(vaultPath, { readonly: true, fileMustExist: true })
try {
  const fams = censusFamilySuppression(db, DEFAULT_MAX_FAMILY_FAILURES)
  console.log(`\n# SC-031 census — ${vaultPath} (readonly)`)
  console.log(`proposal_outcomes rows:      ${fams.totalOutcomeRows}`)
  console.log(`suppression threshold:       ${DEFAULT_MAX_FAMILY_FAILURES}`)
  console.log(`suppressed families:         ${fams.suppressed.length}`)
  console.log(`  suppressed SOLELY by \`failed\`: ${fams.suppressedSolelyByFailedVerdict.length}`)
  for (const f of fams.suppressed) {
    console.log(
      `  - ${f.entity}/${f.family} failed=${f.failedCount} ofWhichFailedVerdict=${f.failedVerdictCount}`,
    )
  }
} finally {
  db.close()
}
