# Audit — trustworthy_recall (T012)

**Capability**: trustworthy memory recall (answer quality + token efficiency) · **State**: `built`

**Justification**: the MAGMA/graph recall code exists and is reachable from the CLI, but the live query
path defaults to plain hybrid; the faithful path is default-OFF and the only archived live evidence is a
measured NULL (incumbent hybrid stands). No live end-to-end positive+negative control for faithful-recall
answer-quality exists. Per research R5 this capability is "built but mis-applied; measured-with-controls is
the gap" (this effort's US2).

**Backing subsystems**: `src/memory/adaptive-traversal.ts`, `src/memory/intent-search.ts`,
`src/memory/retrieval-context.ts`, `src/cli.ts`, `src/memory/arm-router.ts`.

**Reachability**
- `adaptiveTraversalSearch` IS wired into `intentAwareSearch` (`src/memory/intent-search.ts:598-605`), which
  is called from the live CLI retrieval path.
- But it is **default-OFF**: traverse routing is `SCNS_TRAVERSE_ROUTING === '1'` (`src/cli.ts:919-921`) and
  intent routing is `SCNS_INTENT_ROUTING === '1'` (`src/cli.ts:949-951`); the production default is
  hybrid/keyword (`src/memory/retrieval-context.ts:48-53`).

**Evidence rows**
- claim: live default retrieval is plain hybrid, not magma · quoted: `enabled: process.env.SCNS_INTENT_ROUTING === '1',` · ref: `src/cli.ts:949-951`
- claim: traverse/magma is opt-in default-off · quoted: `const traverseOn = process.env.SCNS_TRAVERSE_ROUTING === '1' || (process.env.SCNS_TRAVERSE_ROUTING === undefined && committedRoutingArm === 'magma')` · ref: `src/cli.ts:919-921`
- claim: adaptive traversal reachable from intent-aware search · quoted: `if (traverse) { return adaptiveTraversalSearch(db, query, topK, baseSearch, {` · ref: `src/memory/intent-search.ts:598-605`
- claim: the only archived live evidence is a measured NULL · quoted: `VERDICT: no candidate arm certifies a win vs the incumbent at any swept λ ⇒ measured NULL (incumbent hybrid stands)` · ref: `docs/evidence/us1-cert-run-2026-07-06.log:45-53`

**Controls**: n/a — graded ≤ built; no live-e2e faithful-path answer-quality proof exists.

**Gap**: a live, faithful MAGMA run measured on the answer-quality + token axis under pos/neg controls
(this is US2 — the anchor-eviction + starved-substrate fixes + the reproduction gate). Not more code; a
measured proof on the faithful path.

**Blocked**: null (not Validity-of-Null — US2 can show the win once the fixes land; today it is simply unmeasured on the faithful path).

**Distance to usable**: the graph-recall code is present and reachable, but the live system routes to hybrid
by default and has never shown a faithful-path win on the required answer axis. The missing piece is a live
end-to-end, controlled proof on the faithful path — exactly what US2 is scoped to produce.
