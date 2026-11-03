# T030 Increment 2 — ordering + scrambled controls: WIRING + DETERMINISTIC-VERIFY + JUDGED n=90 (RAW)

**Date:** 2026-07-07/08 · **Branch:** `feature/fable-5-implementation` (local-only, NO push) · **Model:** Opus 4.8, Copilot CLI
**Frame:** T030 = FIDELITY-REPRODUCTION (does our magma reproduce the paper's OWN LoCoMo number on a faithful
setup), NOT hybrid-vs-magma. Metric = App-C.3 LLM-Judge ANSWER accuracy + tokens; retrieval recall is NEVER the
verdict. This doc records the WIRING of the two Increment-2 controls, the DETERMINISTIC-VERIFY probe (no ACP),
and the **JUDGED n=90 run (§5)** that measured all three arms. **VERDICT: NOT_REPRODUCED** (temporal category +
scrambled_control both fail) — an honest, expected result; all legs measured.

---

## 1. What was wired (spec-faithful, committed locally)
- `scoreItem` arm `Pick` extended with `returnBudget | maxChars`; retrieve uses `maxChars: arm.maxChars ?? RETRIEVAL_MAX_CHARS` (byte-identical for all existing callers).
- `planEdgeScramble(edges, rng)` (pure, in `locomo-judge-lib.ts`): permutes `dst_chunk` WITHIN each `edge_type` — preserves per-type edge count, src out-degree, dst multiset (in-degree); FK-safe; deterministic. **7 TDD unit tests** (red→green).
- `scrambleSnapshotGraph()` (harness): copies conv DBs to an isolated dir, applies `planEdgeScramble` over all chunk→chunk (temporal+causal+semantic) `dst_chunk` edges. **Never mutates the snapshot.**
- `runReproAccuracy` now scores THREE arms over the SAME 90 items and emits the full verdict:
  - **magma** — `{traverse, synthesize:true, maxTokens:3400}` (Eq-7 ordered + salience-token-budgeted).
  - **full-context (ordering +control)** — `{traverse, synthesize:false, returnBudget:200, maxChars:200000}` — SAME retrieved subgraph, PLAIN unordered text (no Eq-7).
  - **scrambled (−control)** — magma config over the scrambled copies.
  - `verdict = reproductionVerdict({bandPass, categoryPatternPass, orderingPass, scrambledPass, substratePass:true})`; `ordering_pass`/`scrambled_control`/`full_context_overall` now MEASURED (no longer `null`).

**Gates:** `npm run typecheck` exit 0 · project `npm run lint` (src/+test/) **0 errors** · `npm run build` exit 0 · `npm run test:unit` **6053 passed** (6046 baseline + 7 new). Guards held (vault `mtime=1783256409 size=232488960` unchanged; broker :3456 pid 3539 untouched; scramble on copies only; snapshot mtimes unchanged).

---

## 2. DETERMINISTIC-VERIFY probe (no ACP, real BGE embeddings, snapshot conv-48/49/50)

> **Category map (`LOCOMO_CAT`, locomo-judge-lib.ts:46):** cat1=**multi-hop**, cat2=**temporal**, cat3=**open-domain**, cat4=**single-hop**, cat5=**adversarial**. (The 12-item verify/diag probes below sorted `cat4`-first — those are **single-hop** items, NOT multi-hop; multi-hop is cat1. The full-90 table reports all five under the correct names.)

### (a) Ordering arm — SAME subgraph, DIFFERENT text ✓ ; but magma has MORE tokens (Eq-7 does NOT compress on LoCoMo)
Every one of 12 probed items (4/conv × 3 convs, cat4 = single-hop): `sameSubgraph=true` (magma & full-context return the IDENTICAL chunk set — `returnBudget=200` forces serialize-all-visited), `textDiff=true`. Representative quoted rows:
```
[conv-48] cat4(single-hop) magmaTok=2884 fullTok=1385 sameSubgraph=true textDiff=true   (60 chunks)
[conv-48] cat4 magmaTok=2551 fullTok=1051 sameSubgraph=true textDiff=true   (60 chunks)
[conv-49] cat4 magmaTok=3926 fullTok=2408 sameSubgraph=true textDiff=true   (60 chunks)
[conv-50] cat4 magmaTok=3789 fullTok=2252 sameSubgraph=true textDiff=true   (60 chunks)
SUMMARY (a): 12/12 SAME subgraph + different text; magmaTok > fullTok in 12/12.
```
**Finding:** the ordering arm correctly injects the SAME subgraph as plain text. BUT magma is LARGER, not smaller, than the plain dump (synthesis adds provenance/connective scaffolding; the ~1.0–2.4k-tok subgraph is well UNDER magma's 3400-tok budget, so Eq-7 compression never fires). MAGMA's token-EFFICIENCY claim is **moot on tiny-context LoCoMo** (AGENTS.md #10 Validity-of-Null names this exact case). The ordering ACCURACY comparison (plain vs Eq-7-synthesized) is still judged-measurable, but "far fewer tokens" cannot manifest here.

### (b) Scrambled arm — on single-hop (cat4) items the chunk→chunk scramble is ~inert (see the full-90 correction for the real per-category picture)
Re-pairing **99.6%** of chunk→chunk `dst_chunk` endpoints (temporal+causal+**semantic**; conv-48 3457/3470, conv-49 3686/3700, conv-50 5125/5142) changed magma's retrieved chunk set for **1 of 12 single-hop (cat4) items** probed here:
```
[conv-49] cat4 magmaChunks(60) vs scrambledChunks(60): degraded=true    ← the ONLY cat4 item that changed
[conv-48/49/50] 11/12 other cat4 items: scrambled chunkIds == magma chunkIds  (degraded=false, byte-identical)
SUMMARY (b, cat4-only): 1/12 items degraded; 11/12 IDENTICAL.  ← NOT representative — §"FULL-90" below corrects this
```

### Edge-type isolation diagnostic (which typed edge drives magma's +55-chunk augmentation?)
`J = Jaccard(real magma set, scrambled magma set)`; `1.000` = identical retrieval. `CT`=all chunk→chunk `dst_chunk` (temporal+causal+**semantic**), `E`=entity `dst_entity`, `ALL`=both.
```
[conv-48 cat4] magma=60 anchors(hyb5)=5 anchorsInMagma=5 | J(real,CT)=1.000 J(real,E)=0.875 J(real,ALL)=0.967
[conv-48 cat4] magma=60 anchors=5 anchorsInMagma=5        | J(real,CT)=1.000 J(real,E)=0.846 J(real,ALL)=0.846
[conv-49 cat4] magma=60 anchors=5 anchorsInMagma=5        | J(real,CT)=0.364 J(real,E)=1.000 J(real,ALL)=0.333
[conv-49 cat4] magma=60 anchors=5 anchorsInMagma=5        | J(real,CT)=1.000 J(real,E)=0.967 J(real,ALL)=0.967
[conv-50 cat4] magma=60 anchors=5 anchorsInMagma=5        | J(real,CT)=1.000 J(real,E)=0.935 J(real,ALL)=0.967
... (12/12 cat4 rows: J(real,CT)=1.000 in 11/12; J(real,E) in [0.846, 1.000]) ...
snapshot mtimes unchanged: true
```
**Finding (mechanism, high confidence):**
- magma **augments** (5 hybrid anchors → 60 chunks; anchors 5/5 retained — the T027 fix holds).
- On WHY/causal (cat4) items the +55 augmentation is **ENTITY-co-occurrence-driven**: scrambling entity `dst_entity` changes 3–15% of the set; scrambling the chunk→chunk tiers (`dst_chunk`) changes **nothing** for 11/12 of these cat4 items.
- Why: the beam is question-conditioned — it scores neighbors by `cos(query, v)` (Eq.5) with a relative DropThreshold prune. Scrambled chunk→chunk edges point the beam at RANDOM low-cosine chunks that are PRUNED, so the high-cosine visited set is unchanged. The **causal** graph contributes ~nothing to what magma RETRIEVES on the WHY/causal items.

> ⚠️ **CORRECTION (post independent-grade).** The probe's `CT` label = **temporal + causal + semantic** (the SQL is `WHERE dst_chunk IS NOT NULL`, which includes the semantic KNN tier — 1458–2460 edges/conv — not just temporal+causal). Entity edges use `dst_entity` and are NOT scrambled. And the 12-item cat4-only probe above was NOT representative — see the full-90 result next.

### FULL-90 scramble inertia (exact judged item set, all 5 categories) — the scramble is NOT uniformly inert
Replicating `bindArmFrontierItems` exactly (`pickPerCategory`, `ARM_N_PER_CAT=6`) over the identical 90 judged items, and the harness's shared-rng scramble of ALL `dst_chunk` edges (temporal+causal+semantic), comparing magma's injected TEXT real-vs-scrambled:
```
cat1 (multi-hop):  byte-identical text=16/18   (2 changed)
cat2 (temporal):   byte-identical text= 6/18   (12 CHANGED — 67%)
cat3 (open-domain):byte-identical text=16/18   (2 changed)
cat4 (single-hop): byte-identical text=16/18   (2 changed)
cat5 (adversarial):byte-identical text=15/18   (3 changed)
TOTAL: n=90  byte-identical text=69/90 (76.7%)  identical set=69/90   snapshot mtimes unchanged: true
```
**Corrected consequence:** the scramble changes magma's retrieval for **21/90 (23%) items — concentrated in TEMPORAL (cat2, 12/18)**, exactly the tier temporal edges serve (WHEN intent weights temporal 4.0). Multi-hop (cat1) is 16/18 unchanged — the **causal** graph is ~inert for multi-hop retrieval too. So the scrambled arm's answers are byte-identical to magma for 69/90 items, but genuinely DIFFERENT for 21 — the scrambled_control is **NOT deterministically ≈0** (my earlier cat4-only "11/12 inert ⇒ ≈0" was an over-extrapolation — AND cat4 is single-hop, not multi-hop — both flagged by the independent grader). The judged scramble arm WILL produce real, temporal-concentrated signal; whether the aggregate Δ clears σ=0.0267 is genuinely unknown without the run.

---

## 3. Honest consequence for the reproduction verdict

`reproductionVerdict` legs (from committed T027 evidence + this deterministic probe):
| leg | value | basis |
|---|---|---|
| `band_pass` | **true** | committed T027: magma overall 0.7828 ≥ 0.60 (n=90 held-out) |
| `category_pattern_pass` | **false** | committed T027: temporal cat2 = **0.5889 < 0.650** (target-based, G1) |
| `ordering_pass` | (likely true — judged) | SAME subgraph ⇒ plain vs Eq-7 accuracy ~equal; can't change the verdict |
| `scrambled_control` | **unknown — needs the judged run** | scramble changes retrieval for 21/90 (temporal 12/18); NOT deterministically ≈0 |
| `substrate_pass` | **true** | [32,84,100] causal edges, preCheckOk |

⇒ **`reproductionVerdict = NOT_REPRODUCED`** regardless of the two control legs, because `category_pattern_pass` is already FALSE (temporal 0.5889 < 0.650, committed) and REPRODUCED requires ALL legs. The controls can refine ordering/scrambled but cannot flip NOT_REPRODUCED.

**Gate re-assessed (corrected):** (a) ordering manifests; (b) scramble PARTIALLY manifests (23% of items change; temporal 67%) — it is NOT the inert/can't-win control the cat4-only probe suggested. So the step-4 gate is satisfied and the ~3-6h judged run is warranted to MEASURE the two control legs honestly (the task's goal: *all legs measured + honest verdict*), even though the verdict is already NOT_REPRODUCED.

**Deeper honest finding (unchanged):** LoCoMo is a poor corpus to certify MAGMA's efficiency (Eq-7 never compresses — magma is LARGER than the plain dump) and the CAUSAL substrate's retrieval contribution (inert on cat4). But the TEMPORAL tier does drive temporal-question retrieval, so the scramble is a live control there. Entity co-occurrence dominates the augmentation.

---

## 5. JUDGED RUN (n=90, real ACP, all three arms) — the definitive measurement

Run: `SCNS_JUDGE_MODE=repro-accuracy` over the held-out snapshot (conv-48/49/50), isolated `SCNS_HOME`,
`ARM_N_PER_CAT=6` ⇒ **90 items × 3 arms = 270 judged**; 536 ACP spawns / **0 alive** (0-leak); ISO cleaned;
live vault `mtime=1783256409 size=232488960` unchanged; `snapshot_unchanged=true`. Raw JSON:
`docs/evidence/reproduction-gate-increment2-n90.RESULTS.json`.

```
MAGMA reproduction: overall=0.7683 ± 0.0794 (95% CI) n=90 dropped=0
full-context(ordering)=0.6528 → ordering_pass=true   (magma ≥ full − 0.05)
scrambled(negative)   =0.7611 → Δ=0.0072 vs σ=0.0267 → scrambled_control=FALSE
band_pass=true; category_pattern_pass=false; substrate_pass=true; snapshot_unchanged=true
⇒ VERDICT = NOT_REPRODUCED
```
Per-category answer accuracy (n=18/cat except full-context temporal n=17 — 1 judge-null dropped; cat1=multi-hop, cat2=temporal, cat3=open-domain, cat4=single-hop, cat5=adversarial):
| cat | magma | full-context (plain) | scrambled |
|---|---|---|---|
| 1 multi-hop | 0.8028 | 0.7389 | 0.8000 |
| 2 **temporal** | **0.5556** (< 0.650 target) | **0.0588** (n=17) | 0.5444 |
| 3 open-domain | 0.7611 | 0.7167 | 0.7056 |
| 4 single-hop | 0.7778 | 0.7167 | 0.8111 |
| 5 adversarial | 0.9444 | 1.0000 | 0.9444 |

### Reproduction legs (definitive)
| leg | value | basis |
|---|---|---|
| `band_pass` | **true** | magma 0.7683 ≥ 0.60 (and > paper 0.700 — the reproduction NUMBER holds, matching committed T027 0.7828) |
| `category_pattern_pass` | **false** | temporal cat2 = 0.5556 < 0.650 target (G1) |
| `ordering_pass` | **true** | magma 0.7683 ≥ full-context 0.6528 − 0.05. NOTE: Eq-7 synthesis is not merely "free" — it BEATS the plain unordered dump by +0.115, almost entirely on **temporal** (plain 0.0588 → magma 0.5556): topo-ordering/provenance surfaces temporal facts the plain join buries. |
| `scrambled_control` | **FALSE** | destroying 99.6% of chunk→chunk topology (temporal+causal+semantic) costs only **Δ=0.0072** answer accuracy (< σ=0.0267); even temporal moves just 0.5556→0.5444. |
| `substrate_pass` | **true** | [32,84,100] causal edges, preCheckOk |

⇒ **VERDICT = NOT_REPRODUCED** — two independent legs fail: category_pattern (temporal) AND scrambled_control.

### The scientifically important honest finding (scrambled_control = FALSE at robust n)
The deterministic probe showed the scramble changes RETRIEVAL for 21/90 items (temporal-concentrated). But at the
judged ANSWER-ACCURACY level (n=18/cat), that retrieval change does **not** translate into degradation: scrambling
essentially ALL chunk→chunk typed-edge topology costs **0.0072** overall. **The typed-edge graph topology is not
load-bearing for MAGMA's answer accuracy on LoCoMo** — the always-retained hybrid anchors + the topical
neighbourhood carry the accuracy; the specific graph WIRING does not. This corroborates the long-standing
"magma ≈ hybrid on LoCoMo" reality at the answer level, and means **LoCoMo QA cannot certify the graph substrate's
value** — consistent with the frame that MAGMA's worth for SCNS is the substrate for *self-learning* (path/context-
conditioned reinforcement), which a LoCoMo answer-accuracy race does not exercise.

> **Why the full n=90 mattered:** the n=15 smoke reported `scrambled_control=TRUE` (Δ=0.1167, temporal 0.5→0.2) —
> that was NOISE from 3 temporal items. At n=18/cat the temporal drop is 0.5556→0.5444. Had we trusted the smoke we
> would have falsely certified the control. (Anti-mistesting: robust n + honest σ.)

---

## 6. Status + verdict
- ✅ Controls WIRED + committed (spec-faithful; scramble covers all chunk→chunk `dst_chunk` tiers: temporal+causal+semantic). Labels corrected post independent-grade.
- ✅ Deterministic-verify RAN (no ACP): ordering manifests; scramble changes 23% of judged retrieval (temporal-concentrated).
- ✅ **JUDGED n=90 RAN**: magma reproduces its band (0.7683 > 0.700); `ordering_pass=true`; **`scrambled_control=FALSE`**; `category_pattern_pass=false` (temporal). **All legs MEASURED. VERDICT = NOT_REPRODUCED** — honest, expected (temporal + inert graph topology for QA accuracy).
- ➡️ **No T033** (comparative gate) — requires REPRODUCED. The remaining gaps are (i) temporal answer accuracy (per t027-temporal-diagnostic.md a reasoning/judge issue, not a retrieval bug) and (ii) the graph topology not being load-bearing for LoCoMo QA accuracy — neither is a retrieval "fix"; both argue that MAGMA's value for SCNS is the self-learning substrate, not a LoCoMo QA win. Recommend pivoting to the north-star.
- **G2 (design, AWAITING JOHN, OPTIONAL):** whether to also scramble entity `dst_entity` (the dominant augmentation driver) — would test "does the entity graph matter" but cannot change the NOT_REPRODUCED verdict.

**Guards (whole run):** isolated SCNS_HOME; live vault READ-ONLY `mtime=1783256409 size=232488960` (before+after every run); broker :3456 pid 3539 untouched; scramble on copies only; snapshot mtimes unchanged; 536 ACP spawned / 0 alive; NO push; no prod default-flip.

### Independent grade (producer ≠ grader; fresh-context sub-agent, AGENTS.md #12)
Verdict: **"YES — this is honest, complete Increment-2 work with an honest `NOT_REPRODUCED`."** The grader
verified: verdict honest (two legs fail); the "graph topology not load-bearing for LoCoMo QA" interpretation is
supported when scoped to LoCoMo/chunk→chunk topology (21/90 retrieval changes but answer accuracy did not move);
`ordering_pass=TRUE` honestly reported incl. the Eq-7-helps-temporal nuance; guards clean. It also caught two
issues during grading that were corrected: (1) the scramble covers temporal+causal+**semantic** (not just
temporal+causal — labels fixed), (2) the earlier "deterministically inert" claim was an over-extrapolation from a
mislabeled cat4-only probe (cat4 = single-hop, not multi-hop). Recommendation: **pivot to the self-learning
north-star; don't chase retrieval fixes or G2.**
