/**
 * P7 — Port allocator for child brokers.
 *
 * Per rubber-duck (2026-06-03): stable registry-assigned ports preferred
 * (so direct clients don't break on restart), but ALWAYS probe before
 * assigning — never blindly trust `desired = base + n`.
 *
 * Strategy (WI-6 revision, after the allocator handed out a LIVE port):
 *   1. If `desired` is provided AND free, return it — in-pool or not. An
 *      explicitly registered port (`meta-broker register --port N`) is
 *      operator intent; silently reassigning it broke routing and, worse,
 *      colliding allocations let listen-retry's killStale murder the
 *      broker that legitimately held the port.
 *   2. Otherwise, scan the pool oldest-port-first, returning the first
 *      slot that is neither registered (`taken`) nor in-use (`isPortInUse`).
 *   3. If the pool is exhausted, throw — operator must widen the pool.
 *
 * The in-use probe is ASYNC: net.Server reports EADDRINUSE on a later tick,
 * so any synchronous "probe" answers before the error can arrive and always
 * says free (the exact bug that allocated a production child's port).
 *
 * Pool default: 3500..3599 (100 slots). Picked to sit above the singleton
 * broker's default 3456 and well below ephemeral-port range (49152+).
 */

export const DEFAULT_PORT_POOL_START = 3500
export const DEFAULT_PORT_POOL_SIZE = 100

export interface AllocatePortInput {
  /** Preferred port (e.g. from registry). Honored when free, even out-of-pool. */
  readonly desired?: number
  /** Ports already assigned to other registered projects. */
  readonly taken: ReadonlySet<number>
  /** Live OS probe — resolves true iff the port is currently bound. */
  readonly isPortInUse: (port: number) => boolean | Promise<boolean>
  readonly poolStart?: number
  readonly poolSize?: number
}

export async function allocatePort(input: AllocatePortInput): Promise<number> {
  const poolStart = input.poolStart ?? DEFAULT_PORT_POOL_START
  const poolSize = input.poolSize ?? DEFAULT_PORT_POOL_SIZE
  const poolEnd = poolStart + poolSize

  const isFree = async (p: number): Promise<boolean> =>
    !input.taken.has(p) && !(await input.isPortInUse(p))

  if (input.desired !== undefined && (await isFree(input.desired))) {
    return input.desired
  }

  for (let p = poolStart; p < poolEnd; p++) {
    if (await isFree(p)) return p
  }

  throw new Error(
    `allocatePort: port pool exhausted (range ${poolStart}..${poolEnd - 1}, all in use or registered)`,
  )
}
