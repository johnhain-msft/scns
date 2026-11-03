/**
 * ε-exploration ROUTER POLICY — the single exploration policy for BOTH retrieval paths.
 *
 * A pure, deterministic-under-injected-RNG bandit policy that routes a bounded slice of retrievals
 * through ONE challenger arm and OTHERWISE EXPLOITS the incumbent. It records the chosen arm + its
 * selection PROPENSITY so a later off-policy estimator (IPS / DR / HCOPE — the PRIOR_ART cross-phase
 * spine) can correct for the logging policy.
 *
 * LIVE as of 2026-07-27 (`SCNS_EXPLORE_ROUTING=1` on the broker). It is NO LONGER offline-only and the
 * live prompt path is NO LONGER exploit-only — this header used to claim both and was stale:
 *  - `search:` (`cli.ts`) calls {@link selectExplorationArm} directly; its incumbent is `hybrid`.
 *  - `briefing:` (`cli.ts`, which carries essentially all real human traffic) calls
 *    {@link selectBriefingArm}, a PURE COMPOSITION over the same {@link selectExplorationArm} — not a
 *    second policy and not a parallel lane. Its incumbent is `magma`
 *    (`SCNS_LIVE_MEMORY_BRIEFING ?? 'magma'`) and its challenger set is {@link BRIEFING_CHALLENGER_ARMS}.
 * Exploration is LIVE-ANSWER: the human is served the sampled arm's output, so the existing settle
 * machinery attributes their real accept/waste verdict to the arm that produced what they saw.
 *
 * This module never changes which tool is the default. Under the purpose frame (NORTH_STAR, 2026-08-14)
 * there is nothing to promote: the tools are purpose-routed, and the future live cutover
 * (classify-then-route on `memory/hop-shape.ts`) is John's decision, gated on measured agreement.
 *
 * BOUND: never explore beyond `maxExplorations24h` (counted from the experience store) OR a per-process
 * cap ⇒ a burst can flood neither live traffic nor the store. PURE: the caller supplies the RNG, the 24h
 * count, and the per-process count (all injected + unit-testable).
 */

/**
 * The variant arms (names match the harness FRONTIER_ARMS). Hybrid is the exploit. DE-STRAWMANNED
 * (2026-07-04): the old {entity, causal-beam, synthesis} set mixed one faithful path with two
 * non-MAGMA strawmen; exploration now covers only the FAITHFUL arms — `magma` (Alg-1 adaptive
 * traversal + Stage-4 synthesis) and `multihop-iter` (the C2 beyond-MAGMA iterative arm).
 */
export const EXPLORE_ARMS = ['magma', 'multihop-iter'] as const
export type ExploreArm = (typeof EXPLORE_ARMS)[number]

/** DEFAULT-OFF gate. Exploration runs only when this is exactly '1'. */
export const EXPLORE_ROUTING_ENV = 'SCNS_EXPLORE_ROUTING'
export const DEFAULT_EPSILON = 0.1
export const DEFAULT_MAX_EXPLORATIONS_24H = 20
export const DEFAULT_MAX_EXPLORATIONS_PER_PROCESS = 20

/** DEFAULT-OFF: exploration only runs when SCNS_EXPLORE_ROUTING === '1'. Any other value ⇒ off. */
export function isExploreRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EXPLORE_ROUTING_ENV] === '1'
}

export interface ExploreDecision {
  /** True ⇒ route this retrieval through {@link arm}; false ⇒ exploit hybrid. */
  readonly explore: boolean
  /** The sampled variant arm (present iff `explore`). */
  readonly arm?: ExploreArm
  /** P(taken action | logging policy): ε/|arms| for an explored arm; 1−ε on a normal exploit; 1 when a bound forced exploit. */
  readonly propensity: number
  /** True when a bound (24h store cap OR per-process cap) forced the exploit. */
  readonly boundHit: boolean
}

export interface SelectExplorationArmOptions {
  /** Injected [0,1) source (a seeded PRNG in the harness; scripted in tests) — keeps the policy pure. */
  readonly rng: () => number
  readonly epsilon?: number
  readonly arms?: readonly ExploreArm[]
  /** Explorations already logged in the trailing 24h (from `countExplorations24h`). */
  readonly explorations24h?: number
  readonly maxExplorations24h?: number
  /** Explorations already taken by THIS process. */
  readonly processCount?: number
  readonly maxPerProcess?: number
}

/**
 * Decide explore-vs-exploit for ONE retrieval. Deterministic given `rng`. Enforces BOTH the 24h store
 * bound and the per-process cap (either forces exploit). On explore: draws the arm UNIFORMLY from `arms`
 * with propensity ε/|arms|; on exploit: propensity 1−ε (or 1 when a bound forced it). ε≤0 or no arms ⇒ exploit.
 */
export function selectExplorationArm(opts: SelectExplorationArmOptions): ExploreDecision {
  const epsilon = opts.epsilon ?? DEFAULT_EPSILON
  const arms = opts.arms ?? EXPLORE_ARMS
  const max24h = opts.maxExplorations24h ?? DEFAULT_MAX_EXPLORATIONS_24H
  const maxProc = opts.maxPerProcess ?? DEFAULT_MAX_EXPLORATIONS_PER_PROCESS

  const boundHit = (opts.explorations24h ?? 0) >= max24h || (opts.processCount ?? 0) >= maxProc
  if (boundHit || arms.length === 0 || epsilon <= 0) {
    return { explore: false, propensity: 1, boundHit }
  }
  if (opts.rng() >= epsilon) {
    return { explore: false, propensity: 1 - epsilon, boundHit: false }
  }
  const idx = Math.min(arms.length - 1, Math.max(0, Math.floor(opts.rng() * arms.length)))
  return { explore: true, arm: arms[idx]!, propensity: epsilon / arms.length, boundHit: false }
}

/**
 * ── BRIEFING-PATH EXPLORATION (2026-07-27) ────────────────────────────────────────────────────────
 *
 * The policy above was only ever CALLED from the `search:` handler, while the `briefing:` handler
 * (`/api/extension/context`) carried 85 of 87 recent live rows. `SCNS_EXPLORE_ROUTING=1` was set on the
 * live broker for days and produced ZERO challenger rows as a result. The functions below are the thin,
 * PURE composition the briefing handler calls — they add no second policy: arm sampling, the ε bound and
 * the propensity all still come from {@link selectExplorationArm}.
 */

/**
 * ── PURPOSE-FRAME VOCABULARY (Step 2, 2026-08-15) ─────────────────────────────────────────────────
 *
 * NORTH_STAR "Retrieval design intent" (John, 2026-08-14): `magma` and `multihop-iter` are
 * PURPOSE-ROUTED tools — magma for single-hop retrieval, multihop-iter for multi-hop — not an
 * incumbent and a challenger. The ε-greedy machinery below is retained ONLY as balanced evidence
 * collection while no routing classifier is live (`SCNS_EXPLORE_EPSILON=0.5`); it is not an
 * experiment. The names below are the ones new code uses. The drift-era exports
 * (`BRIEFING_CHALLENGER_ARMS`, `resolveLiveIncumbent`) are kept as ALIASES of the same values so the
 * live briefing handler and the stored `explore_arm` strings stay byte-identical — rows are history.
 */

/**
 * The tools the briefing path samples when it is NOT serving its default. The default (magma unless
 * `SCNS_LIVE_MEMORY_BRIEFING` says otherwise) is excluded so balanced assignment does not spend half
 * its draws re-sampling the tool already being served. John's decision (2026-07-27): `multihop-iter`.
 */
export const BRIEFING_ALTERNATE_TOOLS = ['multihop-iter'] as const satisfies readonly ExploreArm[]

/**
 * @deprecated drift-era name for {@link BRIEFING_ALTERNATE_TOOLS} — same array object, kept so the
 * live briefing handler is unchanged. Under purpose routing there is no challenger.
 */
export const BRIEFING_CHALLENGER_ARMS = BRIEFING_ALTERNATE_TOOLS

/**
 * The tool the briefing serves when it is not exploring. Mirrors the `magmaOn` decision in the
 * briefing closure (`SCNS_LIVE_MEMORY_BRIEFING ?? 'magma'`), so every report names what the human was
 * actually served. `hybrid` is the pre-MAGMA fallback and is otherwise unmeasurable.
 */
export function resolveBriefingDefaultTool(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SCNS_LIVE_MEMORY_BRIEFING ?? 'magma').toLowerCase() === 'magma' ? 'magma' : 'hybrid'
}

/** Every tool the briefing path can serve today: the default first, then the alternates. */
export function resolveBriefingTools(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const dflt = resolveBriefingDefaultTool(env)
  return [dflt, ...BRIEFING_ALTERNATE_TOOLS.filter((t) => t !== dflt)]
}

/**
 * Cold-start assignment probability. ε=0.1 was measured to be ~200 days from `minN=10` on a challenger
 * at live traffic rates (~6 human rows/day at a 3–8% settle rate), i.e. the wrong bootstrap constant.
 * John approved balanced assignment during bootstrap (2026-07-27), decaying to {@link STEADY_EPSILON}
 * once every arm has cleared `minN`. Surfaced as an explicit threshold decision, never softened silently.
 */
export const BOOTSTRAP_EPSILON = 0.5
/** The post-bootstrap steady-state ε (the original constant), used once every arm has cleared minN. */
export const STEADY_EPSILON = 0.1

export interface ResolveBootstrapEpsilonOptions {
  /** Every arm that must clear `minN` before ε decays — the incumbent AND the challengers. */
  readonly arms: readonly string[]
  /** The learner's per-arm minimum (mirrors `kto-learner.ts` `minN`, default 10). */
  readonly minN?: number
  /** An explicit operator override (`SCNS_EXPLORE_EPSILON`) — always wins when finite and > 0. */
  readonly override?: number | undefined
  readonly bootstrapEpsilon?: number
  readonly steadyEpsilon?: number
}

/**
 * Resolve the assignment probability for THIS decision: balanced while any arm is still under `minN`
 * settled rows, decaying to the steady ε once every arm has cleared it. Pure — the caller supplies the
 * per-arm settled counts (from `countSettledByArm`).
 */
export function resolveBootstrapEpsilon(
  settledByArm: ReadonlyMap<string, number>,
  opts: ResolveBootstrapEpsilonOptions,
): number {
  const override = opts.override
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override
  const minN = opts.minN ?? 10
  const bootstrap = opts.bootstrapEpsilon ?? BOOTSTRAP_EPSILON
  const steady = opts.steadyEpsilon ?? STEADY_EPSILON
  const allClear = opts.arms.every((arm) => (settledByArm.get(arm) ?? 0) >= minN)
  return allClear ? steady : bootstrap
}

export interface SelectBriefingArmOptions {
  /** `SCNS_EXPLORE_ROUTING === '1'`. OFF ⇒ byte-identical to pre-change behavior. */
  readonly enabled: boolean
  /**
   * Whether this prompt is human-attributable (`classifyPromptAuthorship`). A machine-authored briefing
   * (a sub-agent brief, a scheduled job) can NEVER settle — no human is there to accept or re-ask — so
   * exploring it burns challenger exposure for a label that will never arrive. This decides only WHERE
   * exploration budget is spent; it never touches label validity.
   */
  readonly humanAuthored: boolean
  /** The arm served when not exploring (`magma`, or `hybrid` when the briefing is flipped back). */
  readonly incumbent: string
  readonly rng: () => number
  readonly epsilon?: number
  readonly challengers?: readonly ExploreArm[]
  readonly explorations24h?: number
  readonly maxExplorations24h?: number
  readonly processCount?: number
  readonly maxPerProcess?: number
}

export interface BriefingArmDecision {
  /** The arm whose retrieval config the briefing should actually run. */
  readonly servedArm: string
  /** True ⇒ a challenger was sampled and is being SERVED (live-answer exploration, John-approved). */
  readonly explore: boolean
  /**
   * Whether to persist `explore_arm`/`epsilon`/`propensity` on the row. FALSE when the policy did not
   * act (lever off, or a machine-authored prompt) — those rows must stay NULL rather than be recorded
   * as μ=1 draws they never were.
   */
  readonly record: boolean
  /** P(taken action | logging policy): ε/|challengers| when exploring, 1−ε on an exploit draw. */
  readonly propensity?: number
  readonly epsilon?: number
  readonly boundHit: boolean
}

/**
 * Decide which arm the briefing serves for ONE request. Deterministic given `rng`; fail-safe (any
 * throw degrades to the incumbent). Live-answer exploration: when a challenger is sampled, the briefing
 * the human receives IS that arm's output, so the existing settle machinery attributes the human's real
 * accept/waste verdict to the arm that produced what they actually saw. (Shadow logging was rejected
 * 2026-07-27: both settle producers scan `ORDER BY id DESC` matching on `query_text`, so a shadow row —
 * same query, higher id — would be settled INSTEAD of the served row, attaching the verdict to an
 * answer the human never received.)
 */
export function selectBriefingArm(opts: SelectBriefingArmOptions): BriefingArmDecision {
  const exploit = (boundHit: boolean): BriefingArmDecision => ({
    servedArm: opts.incumbent,
    explore: false,
    record: false,
    boundHit,
  })
  if (!opts.enabled || !opts.humanAuthored) return exploit(false)
  try {
    const challengers = opts.challengers ?? BRIEFING_CHALLENGER_ARMS
    const epsilon = opts.epsilon ?? DEFAULT_EPSILON
    const decision = selectExplorationArm({
      rng: opts.rng,
      epsilon,
      arms: challengers,
      ...(opts.explorations24h !== undefined ? { explorations24h: opts.explorations24h } : {}),
      ...(opts.maxExplorations24h !== undefined
        ? { maxExplorations24h: opts.maxExplorations24h }
        : {}),
      ...(opts.processCount !== undefined ? { processCount: opts.processCount } : {}),
      ...(opts.maxPerProcess !== undefined ? { maxPerProcess: opts.maxPerProcess } : {}),
    })
    if (decision.explore && decision.arm) {
      return {
        servedArm: decision.arm,
        explore: true,
        record: true,
        propensity: decision.propensity,
        epsilon,
        boundHit: false,
      }
    }
    return {
      servedArm: opts.incumbent,
      explore: false,
      record: true,
      propensity: decision.propensity,
      epsilon,
      boundHit: decision.boundHit,
    }
  } catch {
    // Exploration must NEVER break a briefing.
    return exploit(false)
  }
}

/**
 * Deterministic 32-bit PRNG (mulberry32) → () => [0,1). Used for reproducible det×2 harness exploration
 * and for scripted-sequence unit tests. NOT cryptographic.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
