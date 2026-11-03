/**
 * M1.3 L2 causal go-live wiring (design-m1.md §5) — the cli ⇄ dream-daemon seam.
 *
 * DEFAULT-OFF. {@link buildCausalDreamConfig} returns the dream-daemon config fragment
 * that enables the causal-edge phase:
 *   - `SCNS_DREAM_CAUSAL=1` turns the phase ON (absent ⇒ off ⇒ inert / today's behavior).
 *   - Even ON, the phase stays on the NULL provider (0 edges, 0 writes) UNLESS
 *     `SCNS_DREAM_CAUSAL_ACP=1` is ALSO set — the runner then calls the returned
 *     `makeCausalAcpProvider`, a HARD-STOP `copilot --acp` spawn.
 *
 * The real provider lazily creates a throwaway DETACHED git worktree (NEVER the live
 * checkout), runs ONE deny-all/bounded ACP causal session, and ALWAYS tears the worktree
 * down — including when there are no candidates (then it never even creates one). It
 * writes ONLY to `memory_causal` — never guardrail files (issue-#5 precedent).
 *
 * Every collaborator is injectable so unit tests assert default-OFF + lifecycle without
 * a real git worktree or a real `copilot --acp` spawn.
 */

import type Database from 'better-sqlite3'
import type { CausalProvider, CausalInferRequest, CausalEdge } from './causal-provider.js'

/** Env opt-in (default-OFF) that turns the dream causal-edge phase ON. */
export const CAUSAL_PHASE_ENV = 'SCNS_DREAM_CAUSAL'

export interface IsolatedWorktreeHandle {
  readonly cwd: string
  readonly cleanup: () => void
}

export interface CausalWiringDeps {
  /** Environment to read the phase opt-in from. Default `process.env`. */
  readonly env?: Record<string, string | undefined>
  /** Create the isolated detached worktree. Default: real git worktree off HEAD. */
  readonly makeWorktree?: (projectRoot: string) => IsolatedWorktreeHandle
  /** Build the real ACP causal provider for a cwd. Default: `createAcpCausalProvider`. */
  readonly makeProvider?: (cwd: string) => CausalProvider
}

export interface CausalDreamConfig {
  readonly memoryDb: Database.Database
  readonly causalEdgeInference: boolean
  readonly makeCausalAcpProvider: () => CausalProvider
}

export function buildCausalDreamConfig(
  memoryDb: Database.Database,
  projectRoot: string,
  deps: CausalWiringDeps = {},
): CausalDreamConfig {
  const env = deps.env ?? process.env
  return {
    memoryDb,
    causalEdgeInference: env[CAUSAL_PHASE_ENV] === '1',
    makeCausalAcpProvider: () => ({
      async infer(req: CausalInferRequest): Promise<readonly CausalEdge[]> {
        // No candidates ⇒ no worktree, no spawn (do-no-harm fast path).
        if (req.candidates.length === 0) return []
        const wt = deps.makeWorktree
          ? deps.makeWorktree(projectRoot)
          : await (async (): Promise<IsolatedWorktreeHandle> => {
              const { createDetachedWorktree } = await import('../selfopt/shadow-eval-runner.js')
              return createDetachedWorktree(projectRoot, process.env)
            })()
        try {
          const provider = deps.makeProvider
            ? deps.makeProvider(wt.cwd)
            : await (async (): Promise<CausalProvider> => {
                const { createAcpCausalProvider } = await import('./causal-runner.js')
                return createAcpCausalProvider({ cwd: wt.cwd })
              })()
          return await provider.infer(req)
        } finally {
          wt.cleanup()
        }
      },
    }),
  }
}
