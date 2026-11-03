# Causal admission root cause — MAGMA faithful path

Date: 2026-07-07  
Scope: investigation only; no production fix implemented.

## Verdict

**Hypothesis (a), R1 re-rank eviction, is confirmed.** The traversal can walk causal edges and add causal nodes to `visited`, but the final return path re-sorts `anchors ∪ traversed` by **pure query cosine** and slices to `topK`, so causal neighbors with strong Eq. 5 beam scores but lower lexical/semantic query similarity are evicted before `retrieveContext`/Stage-4 can serialize them.

This is **reachable-but-evicted**, not missing causal materialization and not a `maxChars`/synthesis filter.

## Exact root cause

Root cause: `src/memory/adaptive-traversal.ts:245-247`.

```ts
245	  const top = [...visited]
246	    .sort((a, b) => (relevance.get(b) ?? 0) - (relevance.get(a) ?? 0))
247	    .slice(0, topK)
```

The traversal itself includes causal edges and scores them with Eq. 5:

```ts
197	      for (const type of EDGE_TYPES) {
198	        const phi = w[type]
199	        if (phi <= 0) continue
200	        for (const { v, w: wEdge } of neighbors(db, u, type)) {
...
221	      if (su - sv > dropThreshold) continue // relative per-hop cosine-drop prune (Table 6)
222	      const phiEff = useEdgeWeights ? phi * wEdge : phi
223	      const suv = Math.exp(lambda1 * phiEff + lambda2 * sv) // Eq. 5 / Alg. 1 line 11 (+ Phase-D w_edge)
224	      const cand = (score.get(u) ?? 0) * decay + suv // Alg. 1 line 12
```

But the final `topK` ignores the Eq. 5/cumulative traversal score and ignores edge type. It keeps the highest query-cosine chunks, which are the direct hybrid anchors.

Reachability from `retrieveContext` is live:

```ts
600	  if (traverse) {
601	    return adaptiveTraversalSearch(db, query, topK, baseSearch, {
602	      gazetteer,
603	      semanticRelevance: options.semanticRelevance,
604	      ...(options.traversalOptions ?? {}),
605	    })
606	  }
```

## Probe

Probe file: `.copilot-scratch/causal-admission-probe.ts` (throwaway, clearly named).  
Snapshot: `.copilot-scratch/t030-20260706-203640/frontier/snap/conv-2.db`, opened read-only.

Command:

```sh
SCNS_HOME="$PWD/.copilot-scratch/scns-home" \
SCNS_EMBED_WORKER_PATH="$PWD/dist/memory/embedding-worker.js" \
npx tsx .copilot-scratch/causal-admission-probe.ts \
  .copilot-scratch/t030-20260706-203640/frontier/snap/conv-2.db
```

Materialization sanity:

```text
conv-0|causal|32
conv-1|causal|84
conv-2|causal|100
```

`conv-2` full edge counts:

```text
edge-counts=[{"edge_type":"causal","n":100},{"edge_type":"entity","n":2654},{"edge_type":"semantic","n":2460},{"edge_type":"temporal","n":2582}]
```

### Evidence row: causal is walked, then evicted

Query:

```text
Why was Calvin inspired to start his journey to Japan?
```

Probe output:

```text
depth 1: pending=11225 causal_pending=4 admitted=430 causal_admitted=4 pruned=5727 frontier=8 causal_frontier=4 visited=28
depth 2: pending=4341 causal_pending=1 admitted=601 causal_admitted=1 pruned=597 frontier=8 causal_frontier=1 visited=36
depth 3: pending=4528 causal_pending=1 admitted=452 causal_admitted=1 pruned=1052 frontier=8 causal_frontier=1 visited=44
depth 4: pending=4208 causal_pending=1 admitted=491 causal_admitted=1 pruned=639 frontier=8 causal_frontier=1 visited=52
depth 5: pending=4519 causal_pending=0 admitted=465 causal_admitted=0 pruned=885 frontier=8 causal_frontier=0 visited=60

intent=WHY topK=5 anchorPool=20
anchor ids: 647,623,590,16,571 (top5 == hybrid top5)
reachable causal edges touching anchor pool: 578->579 579->578 571->572 572->571 16->17 17->16 639->640 640->639 15->16 16->15 616->619 619->616
visited=60; causal-reached=7
first causal reached:
  578{rel=0.6573,score=206.88} ... via causal 579->578 depth=1 beamScore=206.88
  622{rel=0.6196,score=203.02} ... via causal 621->622 depth=1 beamScore=203.02
  639{rel=0.5906,score=200.10} ... via causal 640->639 depth=1 beamScore=200.10
  619{rel=0.5755,score=198.60} ... via causal 616->619 depth=1 beamScore=198.60
final by src/memory/adaptive-traversal.ts:245-247 relevance-rerank: 647,623,590,16,571
  final 647{rel=0.8209,score=1.51} ... via=anchor
  final 623{rel=0.7722,score=1.47} ... via=anchor
  final 590{rel=0.7713,score=1.47} ... via=anchor
  final 16{rel=0.7595,score=1.46} ... via=anchor
  final 571{rel=0.7546,score=1.46} ... via=anchor
retrieveContext chunkIds: 647,623,590,16,571
causal in final: 0
```

Interpretation:

- Causal materialization exists (`causal=100` in `conv-2`; snapshot total = 216).
- Causal edges are reachable from the anchor pool.
- The beam admits causal candidates and even selects causal nodes into the frontier.
- Those causal nodes have large Eq. 5/beam scores (`~198–275`) but lower query cosine (`0.55–0.66`) than anchors (`0.75–0.82`).
- Final line `245-247` selects only anchors by query cosine; `retrieveContext chunkIds` matches that final set exactly.

### Negative cross-check: not `maxChars`/Stage-4

The causal nodes are absent from `retrieveContext chunkIds` before text formatting:

```text
retrieveContext chunkIds: 647,623,590,16,571
causal in final: 0
```

So `RETRIEVAL_MAX_CHARS=4000` and synthesis are not the dropping point.

### Edge-type/weighting hypothesis check

Not (b) as the primary root cause:

- The code iterates `EDGE_TYPES = ['entity', 'semantic', 'temporal', 'causal']`.
- For WHY intent, causal has the highest structural weight: `WHY: { causal: 5.0, entity: 3.0, semantic: 3.0, temporal: 1.0 }`.
- Probe shows `causal_admitted=4` and `causal_frontier=4` at depth 1 for the WHY query.

There is a secondary observation: for a DEFAULT-intent "What inspired..." phrasing, causal edges touched the anchor pool but were not admitted into the frontier:

```text
QUERY: What inspired Calvin to start his journey to Japan?
intent=DEFAULT
reachable causal edges touching anchor pool: 578->579 ... 16->15
visited=60; causal-reached=0
```

That is classifier/beam sensitivity, but it is not the newly pinpointed "traversal visits ~60 / causal final 0" failure. The WHY query proves causal traversal works and is then lost at return slicing.

## Fidelity note vs MAGMA

MAGMA Eq. 5 says transition scoring fuses structural alignment and semantic affinity:

```text
S(nj |ni , q) = exp(λ1 · φ(type(eij), Tq) + λ2 · sim(nj, q))
```

The paper explains `φ` "dynamically rewards edge types based on the detected query intent" and gives high causal weights for "Why" queries. It also says traversal is guided by the dual signal: logical structure via `φ` and contextual focus via `sim`.

AGENTS.md #7 says faithful MAGMA is "question-conditioned + relevance-ranked by intent-weighted edge-type × query-sim ... + multi-hop graph traversal that augments a hybrid-anchor-seeded subgraph."

The current return ranking contradicts that: it uses **only** `sim(node, query)` at `adaptive-traversal.ts:245-247`, so the graph does not augment the final context when causal nodes are lower-cosine than direct anchors.

The current T021 test/comment enshrines the problematic behavior:

```ts
512 // ── T021 — Anchor retention ...
543 // topK=4 < |anchors ∪ traversed|=5 ⇒ the return MUST drop the least-relevant node (b2), never an anchor.
551 expect(retention).toBe(1)
552 expect(ids).toContain(b1)
553 expect(ids).not.toContain(b2)
```

This protects anchor retention but has no red test for causal admission under tight `topK`.

## Fix sizing proposal — do not implement in this investigation

Adopt-vs-build: **adopt MAGMA Eq. 5/Stage-4 salience semantics; build a small SCNS admission policy.**

Recommended approach:

1. Preserve anchor retention as a guardrail, but reserve/guarantee a small causal admission path for WHY queries when causal nodes were reached above threshold.
2. Rank candidates with a final admission score that includes Eq. 5/intent edge-type signal, not pure query cosine. A conservative version:
   - keep top N anchors required for anchor retention,
   - admit top causal reached node(s) by cumulative Eq. 5 score for WHY when `causal_reached > 0`,
   - fill remaining slots by query relevance.
3. Add instrumentation/test-only metadata or helper structure so tests can assert "reached via causal" without parsing content.
4. Update T021 so "augment, don't replace" means "anchors are not structurally wiped out", not "anchors always consume all tight `topK` slots."

Estimated LOC:

- Production: ~60–100 LOC in `src/memory/adaptive-traversal.ts` (track reached edge type + final admission policy).
- Tests: ~80–140 LOC in `test/unit/memory/adaptive-traversal.test.ts` for red-first causal admission, anchor-retention regression, and negative controls.
- Docs/comments: ~10–25 LOC.

Risk to the 6026-test suite: **medium**.

- Likely failures: tests or harnesses assuming returned IDs equal pure hybrid anchors for `traverse:true`.
- Existing T021 expectations will need a semantics-preserving rewrite.
- Production default remains safe if `traverse` is still opt-in, but MAGMA-arm benchmark outputs will intentionally change.

Red-first test plan:

1. Add a failing unit test:
   - anchors: 5 high-cosine hybrid anchors,
   - one causal neighbor reached from an anchor with lower query cosine but high WHY/Eq. 5 score,
   - `topK=5`,
   - assert final IDs include at least one causal-reached chunk and do not collapse to the hybrid top 5.
2. Negative control:
   - same graph with causal edge removed or intent weights causal=0,
   - assert no causal chunk appears.
3. Anchor-retention control:
   - enough `topK` headroom or a minimum-anchor quota,
   - assert anchors are not wholly evicted by structurally high-score nodes.
4. Integration check:
   - `retrieveContext(... traverse:true, synthesize:true, topK:5)` returns chunk IDs that include a causal-reached node before formatting.

## Guards

- Live vault before: `mtime=1783256409 size=232488960`.
- Live vault after: `mtime=1783256409 size=232488960`.
- Snapshot DBs were opened read-only by the probe.
- ACP was not invoked.
- Broker `:3456` was not touched.
- No push performed.
- `SCNS_HOME` was isolated under `.copilot-scratch/scns-home` instead of `mktemp` because this runtime forbids `/tmp`/`mktemp` file operations.
