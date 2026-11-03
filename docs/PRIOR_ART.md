# PRIOR_ART — annotated bibliography for the routing / reward / recall design

> Constitution V (Prior-Art-First Research), FR-010, SC-007: search existing solutions FIRST, map each
> technique → the capability ("lego") it provides → an explicit **adopt-vs-build** decision, BEFORE
> writing design code. This is the in-repo citation target for `src/memory/arm-router.ts`,
> `src/memory/explore-router.ts`, `src/reward/kto-learner.ts`, and `src/reward/dr-estimator.ts`.
> The authoritative spec-side copy is `specs/001-learning-memory-loop/research.md` Part C.

## §C.1 — Adaptive RAG: when/what to retrieve (per-prompt strategy selection)

| # | Work (verified) | Lego it provides | Adopt / Build |
|---|---|---|---|
| 1 | **Self-RAG** — Asai et al., ICLR 2024, arXiv:2310.11511 | Reflection tokens: the model decides *whether* to retrieve + self-critiques relevance/support | **Adopt idea, not weights** — the conceptual basis for `shouldSkipRetrieval` (arm-router SKR-lite gate); we route among *retrievers*, not a single retrieve/skip gate. |
| 2 | **Adaptive-RAG** — Jeong et al., NAACL 2024, arXiv:2403.14403 | Query-complexity classifier picks no-retrieval / single-step / multi-step per question | **Adopt directly** — the model for the deterministic `arm-router.ts` policy; the incumbent policy family. |
| 3 | **FLARE** — Jiang et al., EMNLP 2023, arXiv:2305.06983 | Active/iterative retrieval triggered by low-confidence spans; zero-gain stop | **Adopt (already partly built)** — grounds the `multihop-iterative.ts` zero-gain stop; the beyond-paper extension. |

## §C.2 — Router-over-retrievers (hybrid ⊕ graph selection)

| # | Work (verified) | Lego it provides | Adopt / Build |
|---|---|---|---|
| 4 | **RouterRetriever** — arXiv:2409.02685 | A lightweight learned router picks the best expert retriever per query | **Adopt pattern** — routing hybrid-vs-graph is a first-class component, not a toggle. |
| 5 | **Self-Route** — Li et al. 2024, arXiv:2407.16833 | Route by *cost/efficiency*, not only accuracy | **Adopt framing** — the router's λ token knob; "route by cost" is a valid win (MAGMA's real efficiency claim). |
| 6 | **Mixture-of-Experts gating** — Shazeer et al. 2017, arXiv:1701.06538 | Gating-network abstraction (soft/hard arm selection) | **Adopt concept** — arm-selection abstraction only; trained via bandit/off-policy, not MoE end-to-end. |

## §C.3 — Bandits + off-policy evaluation (learn a policy from logged retrieval feedback)

| # | Work (verified) | Lego it provides | Adopt / Build |
|---|---|---|---|
| 7 | **LinUCB / contextual bandits** — Li, Chu, Langford, Schapire, WWW 2010, arXiv:1003.0146 | Contextual explore-vs-exploit with per-arm confidence | **Adopt structure** — `explore-router.ts` ε-greedy is the cold-start form; upgrade toward contextual/UCB as data accrues. |
| 8 | **Thompson Sampling** — Chapelle & Li, NeurIPS 2011 | Posterior-sampling exploration | **Consider (build later)** — candidate to replace ε-greedy once priors are stable. |
| 9 | **Doubly-Robust policy evaluation** — Dudík, Langford, Li, ICML 2011, arXiv:1103.4601 | DR = reward model + IPS correction; low-variance, unbiased if either part is right | **BUILD** — `src/reward/dr-estimator.ts` (the one true algorithmic gap; clipped IPS pre-exists in `kto-learner.ts`). |
| 10 | **Counterfactual LTR / IPS** — Joachims et al., WSDM 2017, arXiv:1608.04468; **CRM/POEM** — Swaminathan & Joachims, ICML 2015, arXiv:1502.02362 | Unbiased learning from biased logged feedback; variance control | **Adopt (already built)** — clipped-IPS in `kto-learner.ts`; DR (#9) is the low-variance upgrade. |
| 11 | **HCOPE** — Thomas et al., AAAI 2015 | High-confidence lower bound on a new policy's value | **Adopt (already built)** — `hcopeLowerBound` (locomo-judge-lib); the promotion gate's statistical spine. |

## §C.4 — Preference-optimization from a binary human signal (accept vs waste)

| # | Work (verified) | Lego it provides | Adopt / Build |
|---|---|---|---|
| 12 | **KTO** — Ethayarajh et al., ICML 2024, arXiv:2402.01306 | Alignment from a per-output desirable/undesirable (unpaired) signal | **Adopt (already built)** — `kto-learner.ts`; exactly the accept-vs-waste shape. |
| 13 | **DPO** — Rafailov et al., NeurIPS 2023, arXiv:2305.18290 | Paired-preference baseline | **Reference only** — our signal is per-attempt binary, not pairs. |
| 14 | **IPO / ΨPO** — Azar et al., AISTATS 2024, arXiv:2310.12036 | Shrinkage-to-prior against overfitting sparse preferences | **Adopt (already built)** — the `kto-learner.ts` shrinkage `(nEff·raw + k·prior)/(nEff+k)`. |
| 15 | **Reward tampering / agent incentives** — Everitt et al. 2019, arXiv:1908.04734 | A reward-optimizing loop must not edit its own reward/guardrails | **Adopt (structurally enforced)** — SELECT-only isolation in `src/reward/`; the guardrail-immutability invariant. |

## §C.5 — Episodic / case-based reuse ("been here before")

| # | Work (verified) | Lego it provides | Adopt / Build |
|---|---|---|---|
| 16 | **Case-Based Reasoning** — Aamodt & Plaza, 1994 | Retrieve/Reuse/Revise/Retain cycle | **Adopt cycle** — the `(intent,target)`-keyed reuse/avoid logic for `similar-episode.ts`. |
| 17 | **Generative Agents** — Park et al., UIST 2023, arXiv:2304.03442 | Memory stream retrieval by recency × importance × relevance | **Adopt scoring idea** — episode salience/recency weighting for the reuse index. |
| 18 | **MemGPT** — Packer et al. 2023, arXiv:2310.08560 | Tiered memory + self-managed recall over a vector store | **Reference** — confirms vec0-over-`query_embedding` recall as the substrate. |

## Adopt-vs-build conclusion

The incumbent routing policy is **Adopt Adaptive-RAG** (#2) as the deterministic classifier +
**RouterRetriever** (#4) framing; exploration is **Adopt ε-greedy → consider Thompson/LinUCB** (#7, #8);
off-policy training is **Adopt clipped-IPS/HCOPE** (#10, #11) and **BUILD the doubly-robust estimator**
(#9 — the one true algorithmic gap); the human-signal learner is **Adopt KTO + IPO** (#12, #14) under
**Everitt isolation** (#15); been-here-before is **Adopt the CBR cycle + Generative-Agents scoring**
(#16, #17, #18) over a vec0 `(intent,target)` index. The router is a HARD, unfinished problem requiring
substantial implementation — not a toggle — and its design must cite this catalogue (SC-007).

### §C.6 — T030 MAGMA causal admission return ranking (2026-07-07)

| Work (verified) | Lego it provides | Adopt / Build |
|---|---|---|
| **MAGMA Algorithm 1 lines 22-23** (`Csorted ← TopologicalSort(Visited,Tq); return Serialize(Csorted)`) + **Eq. 5** (`exp(λ1·φ(type(eij),Tq)+λ2·sim(nj,q))`) + **Stage-4 Eq. 7 salience budgeting** | Return all visited graph nodes to narrative linearization, and let the same question-conditioned typed-edge salience used for traversal inform context budgeting. | **Adopt mechanism; build SCNS boundary adapter.** SCNS still exposes `SearchResult topK` before Stage 4, so `adaptiveTraversalSearch` now keeps a minimum hybrid-anchor floor, then fills remaining slots by Eq.5 log-salience (`λ1·φ + λ2·sim`). Rejected pure query-cosine return (T030 bug: causal nodes walked by Eq.5 are evicted, magma≡hybrid) and pure cumulative beam return (old T024/T021 bug: anchors are structurally wiped out). The T021 test semantics are intentionally changed from "anchors always consume tight topK" to paper-grounded "augment, don't replace": anchors survive as a floor while typed-edge nodes can enter final context. |

### §C.7 — T027 MAGMA briefing budget: serialize-all-visited → Eq-7 TOKEN budget (2026-07-07)

| Work (verified) | Lego it provides | Adopt / Build |
|---|---|---|
| **MAGMA Algorithm 1 lines 22-23** (`return Serialize(Csorted)` over the WHOLE Visited set) + **Eq. 7 / Table 3** (salience budgeting to ≈3.37k tok/query) | The retrieved subgraph flows to narrative synthesis IN FULL; efficiency comes from a TOKEN-denominated salience budget at Stage 4, not from a pre-Stage-4 chunk cap. | **Adopt the paper contract; build the SCNS boundary + anchor-retention adapter.** The `0e4302e` causal-admission fix was necessary-not-sufficient: `RETRIEVAL_TOPK=5` still forced a 1-for-1 SWAP (magma ≈ 275 tok vs paper ~3k). Added `TraversalOptions.returnBudget` (default `topK`, back-compat) so the MAGMA/Stage-4 path serializes ALL Visited (`returnBudget = beam budget`), and a `maxTokens` Stage-4 budget (`estimateTokens ≤ maxTokens`, default `SCNS_MAGMA_MAX_TOKENS=3400`). Because a Stage-1 anchor's cumulative beam score is far below a φ-lifted reached node's, a naïve salience budget would elide anchors FIRST — the opposite of the T030 bug — so anchors carry `SearchResult.isAnchor` and Stage-4 protects them unconditionally (`AnchorRetention=1.0`), filling the remaining token budget by Eq-5 salience among non-anchors and eliding the low-salience non-anchor tail into Eq-7 brevity codes. Rejected: (a) keeping the topK cap (inert swap); (b) budgeting on raw beam score with no anchor protection (anchor eviction); (c) a char-only cap (not the paper's token denomination). Wiring is gated on `synthesize && maxTokens && (traverse‖multiHop)` so every legacy path stays byte-identical. |

---

## §M — MAGMA reference implementation (feature 002, research R1 · adopt-vs-build ledger)

> Prior-art-first (Constitution V), seeded by task **T003** from `specs/002-north-star-audit-remediation/research.md`
> R1. Oracle: the MAGMA paper (`../magma.pdf`) + the reference implementation
> `github.com/FredJiang0324/MAGMA` (consulted live 2026-07-06; the fable5 audit could not reach it). This is
> the durable adopt-vs-build record for the US2 Algorithm-1 return-contract + Algorithm-3 consolidation fixes
> (`src/memory/adaptive-traversal.ts`, `src/memory/causal-provider.ts`, `scripts/locomo-judge-harness.ts`).
> All fixes ship behind existing default-OFF levers; no production default is flipped by this effort.

### §M.1 — Algorithm-1 return contract (anchor eviction bug)

The reference does **not** evict hybrid anchors. It builds `all_candidates` = vector/RRF anchors ⊕ deduped
traversed nodes (`query_engine.py:816–848`), reranks the union by **keyword+similarity relevance**
(`_rerank_and_filter`, `:1282`, `:1606–1618` — `similarity_score * 10.0 * weights`), then trims *after* the
rerank (`if len(top_nodes) > top_k: top_nodes = top_nodes[:top_k]`, `:847–848`). SCNS instead seeds anchors at
φ=0 → `exp(λ2·rel)` (ceiling ≈1.65) while reached nodes score `exp(λ1·φ+λ2·sv)` ≥ 2.52×, then returns
`[...visited].sort(by cumulative beam score).slice(0, topK=5)` — so the highest-relevance anchors are
out-ranked by cumulatively-inflated distant nodes and dropped (the "wholesale replacement, not augmentation"
AGENTS.md #7 forbids).

| Parameter | Reference value | Paper | SCNS today | Decision |
|---|---|---|---|---|
| Return budget `top_k` | 15 (`query_engine.py:682`) | serialize-all + Stage-4 | 5 (harness) | **adopt ≥15**, env-overridable |
| Anchor pool | vector+keyword fusion | Vector Top-K **20** (Table 6) | 8 | **adopt 20** |
| Relative drop θ | 0.15 (`:809`) | Table 6 | 0.15 | **keep** (already faithful) |
| Max depth | 5 (3–12 by type) (`:722`) | 5 (Table 6) | 5 | **keep** |
| Max nodes (Budget) | 800 (`:806` region) | Budget 200 | 200 | **keep** paper's 200 (report sensitivity) |
| Return ranking | query-relevance rerank (`:1282/:1606`) | Alg-1 L22–23 | cumulative beam slice | **fix** → relevance rerank of `anchors ∪ traversed` |

**Two candidate fixes to A/B inside the harness (US2/T024 — not assumed here):**
(a) *paper-literal* — serialize all Visited (≤ Budget 200) topologically sorted, let Stage-4 salience budgeting
compress to the token budget; (b) *reference-style* — `union(anchors, traversed)`, rerank by query relevance,
trim to `top_k` (=15). Both **preserve anchors**; the A/B measures which reproduces the paper band better under
the pinned judge. Rejected: "keep topK=5 slice, just boost anchor scores" (still a pre-Stage-4 slice, brittle to
the λ constants); "anchors-verbatim fallback" as the primary fix (only fires on an empty graph, which never
happens on the dense cert snapshot ≥424 neighbors/chunk).

### §M.2 — Algorithm-3 consolidation (starved causal substrate)

The reference builds causal links **generously and rule-based**: `create_causal_links` emits a `RESPONSE_TO`
CAUSAL edge between adjacent different-participant turns with structural `confidence` 0.7–1.0
(`memory_builder.py:670–840`), yielding many edges/conv. SCNS's cap-20 + 0.7-LLM-omit gate collapsed 122–142
candidates → ~1 persisted relation/conv (fable5). A `>0` existence check cannot detect that starvation.

| Mechanism | Reference | SCNS today | Decision |
|---|---|---|---|
| Causal linking | rule-based `RESPONSE_TO`, confidence 0.7–1.0, generous | LLM judge, cap-20 + 0.7 omit (85% discard) | **fix** — judge **all** candidates in ≤20-pair chunks, sweep `minConfidence ∈ {0.5,0.6,0.7}`, and/or adopt rule-based RESPONSE_TO |
| Substrate pre-check | many edges/conv | `preCheckOk = totalMaterialized > 0` (vacuous) | **fix** (US3/T028) — hard **density floor** ≥8/conv ∧ ≥0.5/WHY-item ∧ per-conv-min |
| Semantic edges (E_sem) | present | not built in cert ingest | **build** (US2/T026) — Table-6 sim threshold |

**Downstream placement (for /speckit sequencing):** these are **US2** implementation tasks (T024/T025/T026),
gated by the **US1 readiness audit** prioritization and preceded by red-first locks (T021/T023). This ledger is
the FR-007 adopt-vs-build record; the concrete A/B outcome is recorded by US2, not here.
