# T030 reproduction/health gate — FINAL independent graded verdict

## Verdict

**BLOCKED**

The substrate leg passes, but the judged `overall=0.5911` null is **not informative** under Constitution Principle I / Validity-of-Null. The final MAGMA context does not show the faithful causal mechanism under test manifesting: deterministic probes found the magma arm returns the same chunk IDs as hybrid for 5/5 sampled items and admits zero causal-edge nodes despite a materialized causal substrate. This is a structurally-can't-win setup for a MAGMA reproduction verdict, so the correct final verdict is `BLOCKED`, not `NOT_REPRODUCED`.

## Per-leg assessment

| Leg / criterion | Assessment | Evidence-backed notes |
|---|---:|---|
| `substrate_pass` | **PASS** | Held-out cert ingest reports `preCheckOk=true`, materialized `[32,84,100]`, `perConvMin=32 >= 8`, `perWhyItem=2.4 >= 0.5`. |
| `band_pass` | **FAIL measured, verdict INCONCLUSIVE** | Judged band row reports `overall=0.5911 ± 0.0949`, below `0.60`; however this null is invalid for a final `NOT_REPRODUCED` verdict because MAGMA's causal contribution is not present in final context. |
| `category_pattern_pass` | **FAIL measured, verdict INCONCLUSIVE** | Row reports `category_pattern_pass=false`; single-hop is worst (`cat4=0.3944`), not a MAGMA-paper-like pattern. Same Validity-of-Null caveat applies. |
| `ordering_pass` | **not-measured** | `full_context_overall=null`, `ordering_pass=null`. |
| `scrambled_control` | **not-measured** | `scrambled_control=null`. |
| `diagnostics.anchor_retention` | **PASS as reported** | `anchor_retention=1`, source `T021 unit-test-proven`; deterministic probes also show hybrid top-5 retained `5/5`. |
| `diagnostics.mean_tokens_per_query` | **INVESTIGATE / DO-NOT-PROCEED signal** | Judged run reports `mean_tokens_per_query=272`, near the contract rule #2 warning threshold (`≈281`), so R1/return-contract health is not established enough to proceed. |
| causal mechanism manifestation | **MISSING PRECONDITION** | Faithfulness probe reports materialized causal edges exist, but causal-edge admission is zero on probed live native-QA items and final chunk sets are identical to hybrid. |
| guards | **PASS** | Live vault `mtime=1783256409 size=232488960` before/after in all relevant artifacts; ACP leak counts end at zero. |
| held-out freshness | **PASS** | Held-out ids are `conv-48,conv-49,conv-50`; they are not `conv-26/30/41/42/43/44/47` and satisfy the contract's fresh-id exclusion (`conv-26/30/44/47`). |

## Named missing precondition

**Missing precondition:** the MAGMA arm must demonstrate faithful Algorithm-1 traversal contribution in the final injected retrieval context over the materialized causal substrate — specifically, causal-edge nodes must be admitted into the serialized MAGMA context, or the final retrieval chunk set must otherwise differ from hybrid due to the graph traversal while retaining anchors. Current evidence shows hybrid top-5 plus Stage-4 provenance scaffolding, not causal-substrate use.

## Explicit consequence

Because the final verdict is **BLOCKED**:

- **Do NOT proceed to the T033 hybrid-vs-MAGMA comparison.**
- **Do NOT cite the MAGMA paper number as the comparison bar for this implementation.**
- Treat the `0.5911` score as an inconclusive health-gate null, not as a valid `NOT_REPRODUCED` result.
- The next producer task should repair/prove causal traversal manifestation in final context, then re-run the reproduction/health gate with ordering and scrambled controls measured.

## Producer vs grader context note (for T042)

Producer context produced the cert-ingest, band, and faithfulness artifacts and proposed `NOT_REPRODUCED` after the band run. This document is the independent grader context: producer ≠ grader. The independent grading decision rejects the producer's `NOT_REPRODUCED` proposal as invalid under Validity-of-Null and stamps final `BLOCKED`.

## Quoted evidence rows

### Contract / constitutional rule basis

Contract acceptance rules:

```text
1. `verdict = REPRODUCED` **iff** `ordering_pass && band_pass && category_pattern_pass && substrate_pass && scrambled_control.pass` (all hard). Only then may a comparative gate run (FR-011, SC-005).
2. `diagnostics.anchor_retention` MUST equal 1.0 (post-R1). If `mean_tokens_per_query` stays ≈281, R1 did not land ⇒ investigate, do not proceed (research R1/R2).
3. `substrate_pass=false` ⇒ `verdict = BLOCKED` (the density-floor STOP fired) — never REPRODUCED/NOT_REPRODUCED.
4. `verdict = NOT_REPRODUCED` ⇒ record honest per-criterion failure; do **not** mark the task done and do **not** cite the paper as the comparison bar (FR-013). Hybrid never runs in this mode.
```

Constitution Validity-of-Null:

```text
A null, miss, or regression is an INFORMATIVE result only if the setup could have produced the opposite: the mechanism under test was faithful and reachable, its required inputs were actually present (e.g., the substrate / edges / graph it needs was materialized above a stated threshold), and the corpus/workload could exhibit the effect. A null produced by a setup that STRUCTURALLY cannot show the effect is INCONCLUSIVE — it MUST be reported as BLOCKED with the missing precondition named, and the task MUST NOT be marked done on its basis.
```

### Substrate / held-out / guard evidence

From `docs/evidence/reproduction-gate-run.RAW.md`:

```text
- `conv-48,conv-49,conv-50`
- Freshness justification: these held-out ids are not any of the disallowed/tuning cert ids `conv-26/30/41/42/43/44/47`.
```

```text
mtime=1783256409 size=232488960
```

```text
  [conv-48] segmented=136 dated=30 eventCand=134 chunkCand=200 persisted=16 materialized=32
  [conv-49] segmented=114 dated=25 eventCand=112 chunkCand=200 persisted=42 materialized=84
  [conv-50] segmented=127 dated=30 eventCand=125 chunkCand=200 persisted=50 materialized=100
```

```text
  materialized chunk→chunk causal memory_edges = 216 (persisted memory_causal = 108); perConv=[32,84,100] min=32 perWhyItem=2.40 floor={perConv:8,perWhyItem:0.5} ⇒ OK — the beam has a dense-enough causal substrate to walk ✓
```

```text
RESULTS_JSON: {"mode":"cert-ingest","heldOut":true,"snapshot":"$HOME/Coding_Projects/scns_root/scns/.copilot-scratch/t030-20260706-203640/frontier/snap","dev":3,"nItems":90,"byCategory":"cat1=18 cat2=18 cat3=18 cat4=18 cat5=18","sampleIds":["conv-48","conv-49","conv-50"],"materialized":[32,84,100],"persisted":[16,42,50],"totalMaterialized":216,"totalPersisted":108,"maxCandidates":200,"causalAttemptMs":300000,"preCheckOk":true,"substrate":{"perConv":[32,84,100],"perConvMin":32,"meanPerConv":72,"perWhyItem":2.4,"floor":{"perConv":8,"perWhyItem":0.5},"preCheckOk":true}}
```

```text
mtime=1783256409 size=232488960
```

```text
ACP client initialized/spawned count observed in log: `115`
ACP process exited count observed in log: `115`
Alive-after ACP/copilot processes attributable to this run after completion: `0`
ACP leak count: `spawned=115, alive-after=0`
```

### Band/category evidence

From `docs/evidence/reproduction-gate-band.RAW.md`:

```text
BEFORE:
mtime=1783256409 size=232488960
node    64889 <user>     22u  IPv6 0x96b40449b36095b1      0t0  TCP *:3456 (LISTEN)
```

```text
AFTER:
mtime=1783256409 size=232488960
node    64889 <user>     22u  IPv6 0x96b40449b36095b1      0t0  TCP *:3456 (LISTEN)
```

```text
cat1: n=18 meanScore=0.5611
cat2: n=18 meanScore=0.4444
cat3: n=18 meanScore=0.5556
cat4: n=18 meanScore=0.3944
cat5: n=18 meanScore=1
MAGMA reproduction: overall=0.5911 ± 0.0949 (95% CI) n=90 dropped=0; band_pass=false; category_pattern_pass=false; verdict=NOT_REPRODUCED
```

```json
{"overall":0.5911,"overall_ci95":0.0949,"full_context_overall":null,"perCategory":{"cat1":{"n":18,"accuracy":0.5611},"cat2":{"n":18,"accuracy":0.4444},"cat3":{"n":18,"accuracy":0.5556},"cat4":{"n":18,"accuracy":0.3944},"cat5":{"n":18,"accuracy":1}},"band_pass":false,"category_pattern_pass":false,"ordering_pass":null,"substrate_pass":true,"scrambled_control":null,"diagnostics":{"anchor_retention":1,"anchor_retention_source":"T021 unit-test-proven","mean_tokens_per_query":272},"verdict":"NOT_REPRODUCED"}
```

```text
spawn guard: 180 ephemeral ACP process(es) spawned; still-alive 0; strays killed-by-pid 0; exit-signalled 180
ACP leak count: spawned=180, alive-after=0
```

From `docs/evidence/reproduction-gate-band.log`:

```text
RESULTS_JSON: {"mode":"repro-accuracy","snapshot":"$HOME/Coding_Projects/scns_root/scns/.copilot-scratch/t030-20260706-203640/frontier/snap","sampleIds":["conv-48","conv-49","conv-50"],"nItems":90,"byCategory":"cat1=18 cat2=18 cat3=18 cat4=18 cat5=18","reproduction":{"overall":0.5911,"overall_ci95":0.0949,"full_context_overall":null,"perCategory":{"cat1":{"n":18,"accuracy":0.5611},"cat2":{"n":18,"accuracy":0.4444},"cat3":{"n":18,"accuracy":0.5556},"cat4":{"n":18,"accuracy":0.3944},"cat5":{"n":18,"accuracy":1}},"band_pass":false,"category_pattern_pass":false,"ordering_pass":null,"substrate_pass":true,"scrambled_control":null,"diagnostics":{"anchor_retention":1,"anchor_retention_source":"T021 unit-test-proven","mean_tokens_per_query":272},"verdict":"NOT_REPRODUCED"}}
```

### Faithfulness / causal manifestation evidence

From `docs/evidence/reproduction-gate-faithfulness.md`:

```text
- Snapshot reopened, not re-ingested: `.copilot-scratch/t030-20260706-203640/frontier/snap`. Manifest rows: conv-48 materialized=32 persisted=16; conv-49 materialized=84 persisted=42; conv-50 materialized=100 persisted=50.
- Deterministic/no-generation modes only. Token mode reported: `spawn guard: 0 ephemeral ACP process(es) spawned; still-alive 0; strays killed-by-pid 0; exit-signalled 0`; `ISO cleaned (zero-pollution): YES`; `live vault mtime unchanged: YES`.
- Live-vault guard before/after: `mtime=1783256409 size=232488960` before; after investigation stat is `mtime=1783256409 size=232488960`.
```

```text
bound 90 probe items across 3 conv(s) (cat1=18 cat2=18 cat3=18 cat4=18 cat5=18)
PRE-CHECK causal materialized=216 persisted=108 ⇒ beam has causal chains on ≥1 conv
hybrid       mean 147 tok  (Δ vs incumbent +0)
magma        mean 272 tok  (Δ vs incumbent +126)
multihop-iter mean 147 tok  (Δ vs incumbent +0)
RESULTS_JSON: {"mode":"arm-frontier-tokens","preCheck":{"materialized":216,"persisted":108},"nItems":90,"byCategory":"cat1=18 cat2=18 cat3=18 cat4=18 cat5=18","arms":[{"name":"hybrid","meanTokO200k":147,"deltaVsIncumbent":0},{"name":"magma","meanTokO200k":272,"deltaVsIncumbent":126},{"name":"multihop-iter","meanTokO200k":147,"deltaVsIncumbent":0}],"incumbent":"hybrid"}
```

```text
- Magma and hybrid contexts differ textually on every probed item, but only because magma uses Stage-4 serialization (`[<t:...> ... <ref:id>]`). The returned chunk IDs are identical for all 5/5 probed items.
- Magma does not include causal-neighbor chunks absent from hybrid in the final injected context for these items. The debug traversal reaches 40 non-anchor nodes per item (60 visited = 20 anchors + 40 traversed), but `magmaTopVisited` equals the hybrid top-5 each time, so traversed nodes are discarded before context injection.
- Causal edges exist in the snapshot and are connected to the anchor pools, but were not actually admitted by the beam on these live native-QA probes: causalAll/causalFromAnchorTop20/reachedByType were: conv-48 cat4 32/1/{entity:40,semantic:0,temporal:0,causal:0}; conv-49 cat4 84/3/{entity:0,semantic:0,temporal:40,causal:0}; conv-50 cat4 100/7/{entity:40,semantic:0,temporal:0,causal:0}; conv-48 cat1 32/5/{entity:40,semantic:0,temporal:0,causal:0}; conv-49 cat1 84/3/{entity:40,semantic:0,temporal:0,causal:0}.
- Runtime anchor retention is verified on these items: hybrid top-1 retained 5/5; hybrid top-5 retained 5/5. The single-hop gold answer was present in magma for 2/3 single-hop probes and absent in both hybrid and magma for the Jolene/pets item; I did not observe a case where hybrid contained the direct single-hop gold but magma displaced it.
```

```text
Faithful MAGMA retrieval is **not fully manifesting in the magma arm output**. The production path is reachable (`traverse:true` enters `adaptiveTraversalSearch`) and the debug loop visits non-anchor nodes, so this is not a total pass-through. However, the final injected magma contexts for the sampled native QA items have exactly the same chunk IDs as hybrid; the extra 126 mean tokens/query are Stage-4 timestamp/ref scaffolding over the same anchors, not added causal-neighbor evidence. More importantly for the T030 reproduction premise, the beam admitted zero causal-edge nodes in these probes despite materialized causal edges in the snapshot and some causal edges from the anchor pools.
```

```text
**BLOCKED.** The 0.5911 null should be treated as **INCONCLUSIVE**, not a valid `NOT_REPRODUCED` verdict. Missing precondition: the magma arm must demonstrate that Algorithm-1 traversal over the materialized causal substrate changes the injected retrieval context (or at least admits causal-edge nodes into the serialized context) while retaining anchors. Current runtime evidence shows anchor retention and Stage-4 formatting, but no causal-edge contribution to the final magma context; the judged run is effectively hybrid top-5 plus provenance scaffolding.
```
