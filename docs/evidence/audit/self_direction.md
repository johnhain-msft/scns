# Audit — self_direction (T014)

**Capability**: autonomous self-direction + machine-aware scheduling ("point it at a new app → decide what
to improve + when + schedule to machine limits + go") · **State**: `built` (largest capability gap)

**Justification**: there is deterministic ideation/decision code, but no live end-to-end evidence of SCNS
being "pointed at a new app" and self-directing/scheduling to machine limits. `src/autonomy/` is a single
thin file (`index.ts` only — independently confirmed), a load-bearing "nascent" signal per research R5.

**Backing subsystems**: `src/autonomy/*` (1 file), `src/brain/*`, `src/suggest/*`, `src/ideate/*`,
`src/selfopt/*`, `src/observe/*`, `src/meta-broker/*`.

**What exists (read-only findings)**
- **Decide WHAT to improve** — heuristic/menu-driven: 3 hardcoded self-improvement seeds
  (`src/suggest/extractors/self-improvement-extractor.ts:31-74`), a pure if/else decision tree
  (`src/brain/decision-tree.ts:218-303`); it selects from fixed actions, not autonomous target invention.
- **WHEN / machine-aware scheduling** — none found: scaling policy chooses `solo|team` from history/hint
  (`src/brain/scaling-policy.ts:118-150`); the only "when" signal is context-usage threshold rotation
  (`src/brain/decision-tree.ts:67-69`). No CPU/context/quiet-hours machine scheduler.
- **Point at a NEW app and go** — none: self-improvement is gated on the SCNS repo itself
  (`SCNS_REPO_RE`, `src/suggest/extractors/self-improvement-extractor.ts:17-18,82-109`); ideation reads
  `src/` modules (`src/ideate/signals.ts:128-141`), not arbitrary app targets.
- **autonomy/ thinness**: `ls src/autonomy` → `index.ts` (1 file); it is a barrel/permission wrapper, no
  self-direction loop.

**Evidence rows**
- claim: hardcoded self-improvement menu · quoted: `export const SCNS_SELF_IMPROVEMENT_SEEDS...` · ref: `src/suggest/extractors/self-improvement-extractor.ts:31-74`
- claim: self-improvement only triggers on SCNS repo activity · quoted: `const SCNS_REPO_RE = /(^|[/\\])scns$/i` · ref: `src/suggest/extractors/self-improvement-extractor.ts:17-18`
- claim: brain is a deterministic decision tree · quoted: `Pure decision engine... No side effects, no I/O, no async.` · ref: `src/brain/decision-tree.ts:1-5`
- claim: scheduling is threshold rotation, not machine limits · quoted: `return state.contextUsagePercent >= state.contextRotationThreshold` · ref: `src/brain/decision-tree.ts:67-69`
- claim: autonomy/ is a single thin file · quoted: `ls src/autonomy → index.ts` · ref: `src/autonomy/index.ts`

**Controls**: n/a — BLOCKED (no mechanism to probe).

**Gap** (largest missing pieces): (1) autonomous target discovery across an arbitrary new app (not SCNS-
scoped seed menus); (2) a machine-aware scheduler (times work to CPU/context/quiet-hour limits); (3) a live
"observe → decide what/when → schedule → act" loop with end-to-end evidence.

**Blocked**: `{ missing_precondition: "no self-direction mechanism exists to point at a new arbitrary app; a live probe cannot show the effect", could_setup_show_win: false }` (Validity-of-Null — the capability is nascent enough that no current setup could demonstrate it).

**Distance to north-star**: far. There is scaffolding for observation, suggestion, and task selection, but
the behavior is bounded, SCNS-centric, and rule-based — not autonomous "what/when" planning across a new app
with machine-aware scheduling. This is a downstream moonshot the audit sizes, not a bug this effort fixes.
