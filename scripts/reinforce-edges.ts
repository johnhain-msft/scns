/**
 * Phase D — OFFLINE edge-reinforcement apply (the reinforcement writer's only wiring).
 *
 * Reads SETTLED magma-family rows from an experience store (READ-ONLY handle) and applies bounded
 * path-conditioned weight updates to a TARGET vault's `memory_edges` (src/memory/edge-reinforcement.ts),
 * idempotently (vault-side log), then one freshness-decay pass toward neutral.
 *
 * GUARDS: REFUSES the live vault (`~/.scns/memory/vault.db`) outright — reinforce a COPY, measure it on
 * the judged gate (the `useEdgeWeights` beam lever stays default-OFF), and only John promotes anything.
 * The experience store is opened {readonly, fileMustExist} — this process cannot write it.
 *
 * USAGE:
 *   npx tsx scripts/reinforce-edges.ts <target-vault.db> <experience.db> [--no-decay]
 */
import Database from 'better-sqlite3'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  applyExperienceReinforcement,
  decayEdgeWeightsTowardNeutral,
} from '../src/memory/edge-reinforcement.js'

const LIVE_VAULT = join(homedir(), '.scns', 'memory', 'vault.db')

function main(): void {
  const [vaultPath, storePath] = process.argv.slice(2)
  if (!vaultPath || !storePath) {
    console.error(
      'usage: npx tsx scripts/reinforce-edges.ts <target-vault.db> <experience.db> [--no-decay]',
    )
    process.exit(1)
  }
  if (!existsSync(vaultPath) || !existsSync(storePath)) {
    console.error(`missing file: ${!existsSync(vaultPath) ? vaultPath : storePath}`)
    process.exit(1)
  }
  // ABSOLUTE guard: never the live vault (resolve symlinks before comparing).
  const target = realpathSync(resolve(vaultPath))
  const live = existsSync(LIVE_VAULT) ? realpathSync(LIVE_VAULT) : LIVE_VAULT
  if (target === live) {
    console.error(
      `REFUSED: ${vaultPath} is the LIVE vault — reinforce a copy, certify on the judged gate, and let John promote`,
    )
    process.exit(2)
  }

  const vaultDb = new Database(target)
  const storeDb = new Database(storePath, { readonly: true, fileMustExist: true })
  try {
    const applied = applyExperienceReinforcement(vaultDb, {
      db: storeDb,
      close: () => storeDb.close(),
    })
    const decay = process.argv.includes('--no-decay')
      ? { edgesTouched: 0 }
      : decayEdgeWeightsTowardNeutral(vaultDb)
    console.log(
      `RESULTS_JSON: ${JSON.stringify({
        mode: 'reinforce-edges',
        vault: target,
        store: storePath,
        rowsApplied: applied.rowsApplied,
        edgesTouched: applied.edgesTouched,
        decayTouched: decay.edgesTouched,
        note: 'weights alter retrieval ONLY via the default-OFF useEdgeWeights beam lever — certification-gated (AWAITING-JOHN)',
      })}`,
    )
  } finally {
    storeDb.close()
    vaultDb.close()
  }
}

main()
