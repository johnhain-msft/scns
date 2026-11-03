/**
 * Wiring for the triage pass: resolves the real artifact roots, spins ONE isolated ACP session dir,
 * runs the pass, and cleans up. Kept separate from `proposal-triage-run.ts` so that module stays
 * pure and testable with no filesystem or transport assumptions.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../shared/logger.js'
import { triagePendingProposals, type TriageRunResult } from './proposal-triage-run.js'
import { createAcpOverlapChecker, createAcpElaborationWriter } from './proposal-triage-acp.js'
import type { createSuggestionStore } from './suggestion-store.js'
import type { ArtifactRoots } from './proposal-spec.js'

const log = logger.child({ module: 'triage-wiring' })

export interface TriageWiringOptions {
  readonly store: ReturnType<typeof createSuggestionStore>
  readonly scnsHome: string
  readonly repoRoot?: string
  /** Skip the model entirely (offline / dry runs). Duplicates still caught by the disk scan. */
  readonly offline?: boolean
  readonly limit?: number
}

export function artifactRootsFor(scnsHome: string, repoRoot?: string): ArtifactRoots {
  return {
    home: scnsHome,
    config: join(scnsHome, '.copilot'),
    scns: join(scnsHome, '.scns'),
    repo: repoRoot ?? process.cwd(),
  }
}

/**
 * Triage everything pending: auto-reject what already exists, spec what survives.
 * Never throws — a triage failure must not stop the review from happening.
 */
export async function runProposalTriage(
  options: TriageWiringOptions,
): Promise<TriageRunResult> {
  const roots = artifactRootsFor(options.scnsHome ?? homedir(), options.repoRoot)
  let iso: string | undefined
  try {
    const extras: Parameters<typeof triagePendingProposals>[0] = options.offline
      ? { store: options.store, roots, ...(options.limit ? { limit: options.limit } : {}) }
      : (() => {
          iso = mkdtempSync(join(tmpdir(), 'scns-triage-acp-'))
          return {
            store: options.store,
            roots,
            askNeutral: createAcpOverlapChecker({ cwd: iso }),
            elaborate: createAcpElaborationWriter({ cwd: iso }),
            ...(options.limit ? { limit: options.limit } : {}),
          }
        })()
    return await triagePendingProposals(extras)
  } catch (err) {
    log.warn({ err: String(err) }, 'proposal triage failed; review proceeds with what is on disk')
    return { rejected: 0, specced: 0, unverified: 0 }
  } finally {
    if (iso) rmSync(iso, { recursive: true, force: true })
  }
}
