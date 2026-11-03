# Fable5 run audit — findings (001-learning-memory-loop, branch `feature/fable-5-implementation` @ 487b39b)

**Date**: 2026-07-06 · **Audit type**: read-only, evidence-first (AGENTS.md standards) · **No code changed, no
judged re-run executed, live vault untouched (mtime/size asserted equal at start and end), nothing pushed.**

**Oracles**: (1) the MAGMA paper `~/Coding_Projects/scns_root/magma.pdf` (arXiv:2601.03236v2, 18 pp.) — every
fidelity claim cites its Algorithm/Eq/Table; (2) the spec-kit `specs/001-learning-memory-loop/` (spec.md
SC-001..013, tasks.md, quickstart.md, contracts/). Never the repo's own tests.

**Method**: 13 independent audit agents (cert-log forensics, arm reachability, control axis, Eq-5/Eq-7/Alg-2/3
re-derivation, US1–US5 sweep, quality/guards) → a root-cause attribution agent → **every accusation
adversarially re-verified by an independent skeptic** (18 verifications + 3 hostile lenses on the attribution;
4 accusations were REFUTED and are reported as such below) → completeness critic. All quotes below were
re-checked verbatim against the pinned tree/log/paper by at least two independent readers.

---

## 1. The bottom line

**Q: Did the fable5 run measure hybrid-vs-magma correctly?** Two answers, both true, at different claim scopes:

1. **As an operational arm-vs-arm A/B at a fixed 5-chunk/4000-char budget on held-out LoCoMo: YES — the null
   is honest.** The gate was powered (`"confirmatoryOnly":false`, n=60/arm, 0 dropped), held-out (conv-44/47,
   outside the DEV/WHY slices), blind (the judge prompt is only Question/Gold/Candidate —
   `judge-provider.ts:80-86`), falsifiable in both directions (a clean candidate CAN certify —
   `locomo-judge-harness.test.ts:113-164`), and on the λ=0 pure-accuracy leg magma genuinely lost:
   `log:1086 "λ=0 magma Δvalue=-0.1983 LB=-0.3011 … ⇒ no-winner"`, per-item wins
   `log:1105 whichArmWon λ=0: {"hybrid":53,"magma":5,"multihop-iter":2}`. Hold-incumbent was the right
   operational decision; the arbiter wrote nothing (`log:1110 "decision":"hold-incumbent","enacted":false`).

2. **As a test of the PAPER's MAGMA: NO — MISTESTED.** The thing measured at 0.2492 is *formula-faithful but
   not paper-comparable*. A **healthy** paper-MAGMA could not have manifested its win under these conditions
   (`could_setup_show_win = false` for the paper's method): its causal mechanism had exactly **one causal
   relation per conversation** of substrate (self-inflicted — see §3), its serialize-all-Visited context
   (~3.37k tok/query, Table 3 p.8) cannot exist inside a 5-chunk/4000-char budget (measured 281 tok — a ~12×
   compression the paper never evaluated), its efficiency axis structurally cannot fire on this corpus
   (harness's own header `:66-68`: "Eq-7 compression NEVER fired … S4-ON = provenance-scaffold overhead
   only"), and — decisively — the implemented return contract **evicts every hybrid anchor** where the paper
   augments them (§2). Magma at 0.2492 sits **below every floor the paper ever measured**: Full-Context 0.481,
   w/o-Causal ablation 0.644 (Table 4 p.8), worst single-graph "Entity Only" 0.531 (Table 5 p.9). No
   mechanism-*removal* explains a score under all of those; only active noise injection does.

**On John's three suspicions**: "measured wrong again" — **confirmed at the paper-fidelity scope** (a genuine
Alg-1 integration infidelity, not the prior wrong-axis error, which was genuinely fixed — §5.1); "over-claimed"
— **confirmed in six specific places** (§6), though four suspected over-claims **failed adversarial
verification and are withdrawn** (§7); "got lazy / leaned on hybrid-favoring conditions" — **partially
confirmed**: the conclusion was drawn from the one corpus+axis that structurally cannot show MAGMA's win while
the corpus that could (LongMemEval) was built but never judged, and the verdict text never carries the
"causal-mechanism untested" label its own ingest pre-check wording called for — but the run *did* disclose the
token-axis caveat up front (spec.md:206 pre-registered it) and holding levers OFF required no LME run (T019
makes LME the gate for output-changing *flips*, not for holding the default — VERIFIED).

**The deepest finding**: the run violated its own standards file at the definition level. AGENTS.md #7 defines
the faithful mechanism as traversal that "**augments** a hybrid-anchor-seeded subgraph (**not wholesale
replacement**)" and warns "never frame it as a hybrid-vs-magma QA horse race." The implemented return contract
does wholesale replacement (§2), and T020 is exactly that horse race.

---

## 2. Root-cause attribution of magma 0.2492 (vs paper 0.700, hybrid 0.4475)

Ranked causes; each survived three independent hostile lenses (starved-substrate skeptic, implementation-bug
skeptic, evaluation-side skeptic — all returned `refuted:false`, high confidence).

### PRIMARY — anchor-evicting topK-slice return contract (a genuine Algorithm-1 infidelity)

The paper (Alg-1, p.5): `L3 CurrentFrontier, Visited ← S_anchor … L22 C_sorted ← TopologicalSort(Visited, Tq);
L23 return Serialize(C_sorted)` — **anchors stay in Visited and ALL of Visited is serialized** (up to
Budget=200 nodes), with Stage-4 brevity codes compressing low-salience nodes instead of dropping them.
Eviction is impossible in the paper.

The code (`src/memory/adaptive-traversal.ts`): anchors are seeded with **no structural term** —
`:177 score.set(a.chunkId, Math.exp(lambda2 * rel))` (ceiling e^0.5 ≈ 1.65 with λ2=0.5, cosine ≤ 1) — while
any graph-reached node scores `:216 Math.exp(lambda1 * phiEff + lambda2 * sv)` with min φ=1.0
(`:55-58 DEFAULT_INTENT_WEIGHTS`), i.e. ≥ e^0.925 ≈ 2.52× every anchor after the `:214` drop-prune closes the
sv<0 edge case, growing cumulatively with depth (`:217 cand = score(u)·γ + suv`). The return is
`:233 [...visited].sort(by score).slice(0, topK)` with `harness:219 RETRIEVAL_TOPK = 5`. **Every anchor is
mathematically evicted from the top-5 whenever ≥5 nodes are reached.**

And ≥5 nodes are *always* reached: direct read-only measurement of the held-out snapshot
(`local_cache/cert-snapshot`, ro/immutable — not the live vault): conv-44 db
`causal|2 entity|2166 semantic|2377 temporal|2105 chunks|799`, conv-47 db
`causal|2 entity|2180 semantic|1809 temporal|2094 chunks|833`; per-chunk combined neighbor degree (computed
exactly as `neighbors()` at `adaptive-traversal.ts:113-132` does): **all 799 chunks have ≥424 neighbors**
(min 424, median ≈462). The documented anchors-verbatim fallback (`:138`, fires only at `:200
pending.length === 0`) was structurally unreachable. Eviction was total on every one of the 60 questions.

**Isolation of the effect**: magma 0.2492 ≈ multihop-iter 0.2483 (same beam family, **no** Eq-7 scaffold —
Δ=0.0009) ≪ hybrid 0.4475 (`log:1081-1083`), and the loss is uniform across categories
(`log:1086`: pos −0.1806 / neutral −0.175 / neg −0.275), exactly the signature of good anchors being replaced
by up-to-5-hop-distant graph endpoints gated only by a 0.15/hop cosine-drop (cumulative drift up to ~0.75).

### MAJOR — the design root: two integration contracts unfaithful to the paper (formulas are faithful)

Eq-5/Eq-6/Eq-7 arithmetic is **literal and test-certified against the production path**
(`adaptive-traversal.test.ts:470-473` closed-form to 10dp; topo-order/scaffold/brevity codes line-level per
Eq-7). The infidelity lives in the surrounding contracts:
(a) Alg-1's *serialize-all-Visited-with-compression* collapsed to the anchor-evicting top-5 slice (above), plus
`:165 anchorPool = max(topK, beamWidth)` = **8** anchors vs the paper's **Vector Top-K 20** (Table 6 p.13);
(b) Alg-3's **per-node** consolidation loop (one LLM pass per ingested node over its 2-hop neighborhood,
~124–144 passes/conv — Alg-3 p.6) collapsed to **one batched, 20-pair-capped, 0.7-confidence-gated call per
conversation** (`harness:667 M2_MAX_CANDIDATES ?? 20`, `:1475 minConfidence: 0.7`; `log:1014` exactly 2 causal
ACP spawns).

### MAJOR (for paper-comparability; ruled OUT as the driver of the active loss) — the starved causal substrate

`log:993-994 "materialized chunk→chunk causal memory_edges = 4 (persisted memory_causal = 2) ⇒ OK — the beam
has causal chains to walk ✓"` — i.e. **one logical causal relation per conversation** (2 edges = 1 relation ×
both directions), on the corpus where the paper's headline mechanism is causal reasoning. It deletes MAGMA's
"why"-story entirely — the run could never certify the paper's claim. But it does NOT explain 0.2492: the
paper's own ablation prices fully-causal-free MAGMA at **0.644** (Table 4), the measured loss is uniform
across categories rather than WHY-concentrated, and the beam was never edge-starved (~6k non-causal
edges/conv). **The starvation is self-inflicted, not LoCoMo sparsity** (adjudicated INVALID): the cascade is
`log:628 eventCand=122` / `log:991 eventCand=142` proposed → `log:632/1002 candidateCount: 20` (cap discards
**85% un-judged**, keeping an entity-alphabetical prefix) → `inferred: 2|6` (conservative single-batch prompt:
`causal-provider.ts:82-83 "Be conservative… If in doubt, omit the pair"`) → `persisted: 1|1`
(`rejectedLowConfidence: 1|5` under the home-grown 0.7 gate; the paper's δ is unpublished, Table 6 lists no
causal-confidence parameter) → ×2 direction = the pre-check's 4. The plan-§9 "24–34 edges/5-conv" figure is
repo memory from WHY-relevant DEV convs under the SAME starved config — 2.4–3.4× the held-out per-conv yield,
consistent with selection effect plus the cap's sampling window, not with a healthy ingest.

### MAJOR (for the paper-gap; cleared of arm-vs-arm bias) — evaluation-side conditions

topK=5/4000-char budget ⇒ 281 tok/query vs the paper's 3.37k (Table 3) and 20-anchor/200-node serialization —
a ~12× compression the paper never evaluated; generator = session-default model vs the paper's gpt-4o-mini
(Table 6) — affects absolute comparability only, both arms equally. The judge/generator stack itself is
calibrated and unbiased: blind prompt, controls separation 1.0 (`log:244-246`), identical generator prompt
across arms (`harness:763-765`), and hybrid's 0.4475 lands in the paper's Full-Context band (0.481).

### RULED OUT — Eq-7 scaffold degrading accuracy

Two independent, convergent nulls bracket the scaffold's accuracy effect at ~zero: the paired S4-only gate on
an identical retrieved set (`harness:69 "Arm P 0.7975 / Arm S 0.7975 / Δacc 0 ± 0.0246 (n=20)"`) and
magma−multihop-iter = 0.0009 in the cert run. The scaffold owns ~125–128 of magma's +144 token delta
(`harness:66 "S4-OFF 160 tok / S4-ON 285 tok / Δtok +125 (0/20 compressed)"`; 281−153=128) — structural
serialization cost, exactly what Eq-7 implies when compression has no opportunity to fire. One residual
unmeasured hazard: file-mtime `<t:τ>` fallback stamps (`retrieval-context.ts:228-230`) could mislead WHEN
answers; no WHEN-only paired probe exists.

---

## 3. Adjudication of the T020 headline and its presentation

| # | Claim (as stated by the run) | Verdict | Decisive evidence |
|---|---|---|---|
| 1 | "MEASURED NULL — hybrid stands" (arm-vs-arm, this corpus, this budget) | **VERIFIED** | Powered/held-out/blind/falsifiable; `log:1086/:1105/:1108/:1110`. Independent skeptic REFUTED the auditor's MISTESTED verdict at this scope: the λ=0 leg could have shown a magma win and didn't. |
| 2 | The same result read as a verdict on MAGMA-the-method (0.2492 as "magma measured") | **MISTESTED** | §2: anchor eviction + 1 causal relation/conv + 12× budget compression + token axis that can't fire; below every paper floor incl. Full-Context 0.481. The harness's own rationale (`:1077-1080`) says a causal-edge-free beam Δ "is a NULL, not a MAGMA verdict" — 4 edges is ε above that line. |
| 3 | "preCheckOk":true / "OK — the beam has causal chains to walk ✓" | **OVER-CLAIMED** | `harness:1705 preCheckOk: totalMaterialized > 0` — an existence test; "chains" (plural) = ONE relation/conv, which cannot form a multi-edge chain. A 4-edge substrate prints OK ✓. |
| 4 | "the judged path softened the pre-check STOP to WEAK" (audit plan's F4) | **REFUTED — enforcement not softened** | The zero-edge *wording* differs (`:1683` WEAK vs `:1084/:1634` STOP; born with runCertIngest in 746248e), but neither branch fired (materialized=4>0 → "OK ✓"), and the judged gate has the harness's *strictest machine-enforced* substrate gate: `:2233-2245` per-conv minimum ("a sum would MASK a per-conv 0") + power (n≥15) + held-out; on failure it auto-stamps `[CONFIRMATORY-ONLY — thin probe…]` (`:2466`) and hard-blocks the arbiter (`:2495 heldOut && !thinProbe`). The real defect is #3: the threshold (>0) cannot detect starvation — a density floor is missing, not a STOP word. |
| 5 | "hybrid wins BOTH axes on this corpus" conflates SC-004 (audit plan's F5) | **REFUTED — no conflation; narrow gap instead** | Sentence is literally true arm-vs-arm (`log:1034/:1112`) and corpus-scoped; SC-004 is covered separately by the fidelity gate ("budgeted briefing ≪ full join", DoD:23-24) and the token caveat was **pre-registered** in spec.md:206. Residue: SC-004's **held-out full-context denominator was never measured** (no fullContext row in the cert log; only the DEV note `harness:68` "~1-2% of full-context (13869 tok)") — a coverage gap, UNRESOLVED. |
| 6 | "every candidate (and the C3 router) posted a NEGATIVE value delta at every λ" (DoD:46-48) | **OVER-CLAIMED** | Router Δvalue is exactly **0** at λ=0.5/1.0 (`log:1100/:1103` — it degenerates to picking hybrid 60/60). No-winner conclusion untouched; the sentence as written is false. |
| 7 | "Full rows: docs/evidence/us1-cert-run-2026-07-06.log" | **OVER-CLAIMED** | The arm-frontier-accuracy stdout is head-truncated: the log jumps from the 05:16:55Z MODE stamp (`log:1040`) into mid-run ACP output (`log:1041`); ~178 of ~180 per-item rows are missing (only 2 multihop-iter tail rows survive, `log:1057/:1080`), no per-arm config banners (`harness:2289`), zero magma per-item rows. Per-item root-cause attribution is impossible from this artifact. |
| 8 | "Consistent with the prior offline null (b659577)" as corroboration | **INVALID** | Not independent: same evaluator, same axis, same benchmark family (DEV conv-26/30 vs cert conv-44/47); AND b659577's numbers came from the quarantined mis-specified design (n=9, CI ±~0.29, "NOT a powered/generalizable arm-comparison verdict" per its own commit message). Same-axis-measured-twice, one leg strawman-tainted. |
| 9 | "64/64 tasks done" — specifically T020's completion criteria | **OVER-CLAIMED** | T020 requires "comparative: quoted **per-category** rows" (tasks.md:103); the captured evidence has per-category *counts* only (`"byCategory":"cat1=12…"`), **no per-arm per-category accuracy or tokens anywhere** (SC-002's "by category and overall" leg is likewise unmet by the artifact). |
| 10 | Verdict text carries the substrate caveat ("label the judged run accordingly") | **OVER-CLAIMED (by omission)** | DoD's RESULTS_JSON quote elides `"materialized":[2,2],"persisted":[1,1]` behind "..." while retaining `"preCheckOk":true`; FABLE5_STATUS greps clean of materialized/persisted/causal. Neither summary says the causal mechanism was effectively untested. |
| 11 | Judge blindness; controls separation 1.0; σ pinned | **VERIFIED** | `judge-provider.ts:80-86` (three blind fields only; category typed "NEVER sent to the judge"); `log:244-246` pos 1.0/neg 0.0/separation 1 (n=10/10, 0 dropped); σ=0.0267 pinned and consistently applied. |
| 12 | σ=0.0267 "MEASURED 2026-07-03" | **UNRESOLVED (provenance)** | Carried forward (`log:1112 "judgeSigmaReused":0.0267`) — legitimate under a pinned judge, but the 2026-07-03 variance-mode run has **no raw artifact in the repo**; only the harness comment (`:211-212`) and the DoD assert it. Same for the DoD's smoke row (`{"mode":"smoke","genAnswer":"Paris"…}`) — quoted only by the DoD itself, absent from the log. |
| 13 | "hybrid stands ⇒ all levers stay default-OFF" pending a judged LME run | **VERIFIED** | T019's own text makes the judged LME run the go-live gate for output-changing *flips*; T020 enacted no flip (0 writes, vault mtime unchanged `log:1120`). Holding the default absent certified evidence is the spec's mandated posture (FR-011/012, SC-006/012). |

**Reconciliation note (A1-vs-C1)**: rows 1 and 2 are the same measurement adjudicated at two claim scopes; both
verdicts stand. What the run published (an *operational* null) is verified; what the run's framing invites the
reader to conclude (MAGMA-the-method lost to hybrid) is mistested. The one-sentence fix the record needs:
*"hybrid stands at this budget on this corpus; the paper's MAGMA remains untested here because the substrate
and return contract were not paper-comparable."*

---

## 4. MAGMA fidelity scorecard (code vs paper)

| Mechanism | Paper ref | Verdict | Evidence |
|---|---|---|---|
| Eq-5 transition `exp(λ1·φ(type,Tq) + λ2·sim(nj,q))` | Eq.5 p.4 | **VERIFIED (literal)** | `adaptive-traversal.ts:216`; λ1=1.0 (=Table 6 base), λ2=0.5 (∈0.3–0.7); closed-form 10dp unit test on the production function (`adaptive-traversal.test.ts:470-473`) |
| Eq-6 intent weighting φ = w_Tq^⊤·1_r (not static confidence) | Eq.6 p.5 | **VERIFIED** | `:191 phi = w[type]` keyed by `classifyIntent`; learned weights only via default-OFF `useEdgeWeights`; values within Table-6 ranges |
| sim = cosine(candidate node, QUERY) | p.5 | **VERIFIED** | `semantic-relevance.ts:58/:64`; question-conditioned, incl. the drop-prune |
| Depth 5 / budget 200 / dropθ 0.15 | Table 6 p.13 | **VERIFIED** | `:65-68` defaults; harness passes 5/200 (`:677-678`, `:2066`) |
| Beam frontier / visited / γ-decay / budget break | Alg-1 L5–19 p.5 | **VERIFIED** | `:217/:226-229/:184`; BeamWidth=8 and γ=0.5 are implementer choices (paper gives no values) |
| **Return contract: Serialize(ALL Visited) + Stage-4 compression** | **Alg-1 L22-23 + Stage 4 p.5** | **INFIDELITY (the primary cause)** | `:233 .slice(0, topK=5)` + φ=0 anchor seeding ⇒ unconditional anchor eviction — replacement, not augmentation (violates AGENTS.md #7's own definition) |
| Anchor pool | Table 6 "Vector Top-K 20" | **INFIDELITY** | `:165` anchorPool = 8 |
| Eq-7 scaffold `[<t:τ> content <ref:id>]`, topo/τ-order, brevity codes | Eq.7 + Stage 4 p.5 | **VERIFIED** (2 disclosed surrogates: char-not-token budget; mtime-τ fallback) | `retrieval-context.ts:194/:204/:291-312/:319-332` |
| Alg-2 segmentation → real-τ event nodes | Alg-2 p.6 | **VERIFIED (healthy)** | 124/144 event nodes, 28/31 dated sessions, 122/142 causal candidates (`log:628/:991`); caveat: per-SESSION extraction ≤8 events vs the paper's per-message rolling summary (C.1 p.14) |
| Alg-3 per-node consolidation loop | Alg-3 p.6, Eq.8 | **INFIDELITY (the starvation cause)** | ONE batched call/conv, cap 20, minConfidence 0.7 (unpublished in paper); 85% of candidates never judged |
| Semantic edge graph (E_sem, cos > θ_sim) | p.4, Table 6 "Sim. Threshold 0.10–0.30" | **GAP in cert ingest** | harness ingest never passes `buildSemantic` (`event-nodes.ts:237-242`) — cert snapshot's semantic edges come from the indexer only; unmeasured impact |
| Control axis POS/NEG/NEUTRAL | Table 1 p.7 | **VERIFIED — faithful, unit-locked** | `locomo-judge-lib.ts:46-65` = Table 1 exactly (MAGMA wins temporal 0.650/single-hop 0.776/adversarial 0.742/overall 0.700; concedes multi-hop 0.528 < Nemori 0.569); anti-inversion lock `locomo-judge-lib.test.ts:797-824`; strawman arms genuinely deleted in 746248e (5f9745c = comments-only quarantine record) |
| Arm reachability (all four arms) | AGENTS.md #2 | **VERIFIED — reachable-faithful** | magma forced by mode config (traverse+synthesize, no env dependency; `harness:2062-2068` → `intent-search.ts:601` → `adaptive-traversal.ts:140`); superseded binary router/fusionSearch structurally unreachable from the gate arms; prior cycle's failure did NOT recur |

---

## 5. US2–US5 and quality-gate sweep (SC-005..SC-013)

### 5.1 What the run got right (credit where due)

- **The twice-made wrong-axis error was genuinely fixed**: paper-faithful controls, unit-locked against
  re-inversion; the old strawman arms deleted, not relabeled; the quarantine record honest (`harness:77-82`).
- **The safety story is solid**: kernel + allowlist untouched since 0f15fff (git-verified over both pathspecs);
  the T054 suite tests the REAL shipped (empty) allowlist with deny-all, fail-closed loader, spend refusal even
  for egress-allowlisted hosts, kernel-diff refusal even with fully certified evidence, and an intact audit
  chain across allows AND denies — all assertions verified in-file (execution greenness not re-run, read-only).
- **The evidence arbiter genuinely fails closed**: `commitRoutingPolicy` refuses LB≤0 / unmeasured controls /
  det<2 / higher cost / guardrail paths (all behaviorally tested); enactment unreachable without
  `SCNS_ARBITER_ENACT=1`; live run wrote nothing.
- **DR estimator is genuinely Dudík 2011** (hand-recomputed: MIXED case row1 = 0.4 + 2×0.6 = 1.6, row2 = 0.4,
  mean 1.0 — matches; the 1.6 case distinguishes DR from IPS 2.0 and DM 0.4). **Welch-LB 0.3260 recomputed
  exactly** (Δ=0.44 − 1.645·√0.0048 = 0.32603). **μ=0.475 arithmetic is correct** (uniform over the 2 explore
  arms, hybrid = exploit at 1−ε=0.05; the ε/3 worry does not apply). **Reinforce 1.0→1.19 is the exact formula
  output** (1.0×1.2 then one 0.05 decay pass), on a COPY, with the live vault REFUSED at exit 2 (realpath
  compare). **typecheck 0 / lint "451 problems (0 errors, 451 warnings)" re-run clean by this audit.** 398
  unit + 33 integration test files counted on disk (pass counts not re-executed — plausibility only).

### 5.2 Confirmed defects and over-claims outside US1

| Claim | Verdict | Evidence |
|---|---|---|
| US2 "0% topic-only" at the **system** level | **DISCLOSED OPEN ITEM** (accusation refuted as an over-claim, but the residue is real) | The live test genuinely falsifies topic-binding (same-topic sibling stays NULL, `experience-live.test.ts:139/:194/:199`); but the ONLY production settle surface today is entity-substring `settleHumanOutcomeForEntity` (`outcome-writer.ts:181`, itself behind default-OFF `SCNS_IDEATE_MEMORY`); per-attempt APIs have zero production callers. The run itself disclosed this (DoD:113-116, T059). SC-005 is **not yet met live**: gen_answer/judge_score/tokens are permanent NULLs on live rows; implicit cues (used/edited/re-asked) have no live emitting surface; no test asserts a live row carries a non-NULL query_embedding. |
| US3 SC-006 "non-default strategy per prompt **class**" | **MISTESTED (coverage)** | The promotion machinery can only enact a whole-corpus arm flip or the λ-dominant 'router'; no per-class evaluation/enactment path exists or is tested. Default half of SC-006 well covered. |
| US4 "collision trap **structurally impossible**" | **OVER-CLAIMED** | SQL equality on (intent,target) makes cross-key returns impossible (real, falsifiably tested); but same-(intent,target) collisions are only threshold-mitigated, and **no live surface populates `target` or calls the episode-recall path at all** (`cli.ts:1010-1029` logs intent only). |
| US4 "router reuses/avoids per advice (15/15)" | **OVER-CLAIMED (framing)** | 15/15 = the whole arm-router suite; only 4 cases exercise episodeAdvice. |
| US4 DR[magma]=0.92 vs DR[hybrid]=0.32 | **VERIFIED (honestly caveated)** | Always welded to "honest no-proposal at n=5" (minN=10 makes a proposal structurally impossible); never presented as a magma win. Nit: DoD drops the commit's "on a seeded store" qualifier. |
| SC-009 "reuses at a **rate better than ignoring history**" | **NOT MEASURED** | Mechanism unit-tested (T049 4 cases); the quantitative rate-vs-ablation leg has no measurement anywhere. |
| SC-013 positive leg (arbiter CAN enact a certified win) | **PARTIAL** | gateVerdict's certify path is behaviorally proven (`locomo-judge-harness.test.ts:113-164`); but the live run had detRuns:1 (det×2 unexercised end-to-end) and det×2 is attested via env var, not machine-verified. |
| Welch z=1.645 vs t-quantile at n=5 | **NIT (anti-conservative)** | df≈8 ⇒ t=1.860; the 0.3260 case still promotes, but the gate is mildly looser than "95% lower bound" implies at minimum n. |

### 5.3 Guards attestation (this audit re-verified)

11 feature commits (now 13 with the two docs commits) all unpushed (`git log @{u}..HEAD`); kernel + allowlist
last touched 0f15fff (both pathspecs); all five levers default-OFF via strict `=== '1'` checks
(SCNS_REINFORCED_ARM / SCNS_ARBITER_ENACT exist only in scripts/, not production); no committed routing policy
repo-side + fail-closed reads (the runtime path `~/.scns/policy/…` was not stat-ed — hard guard); T058
surrogate: zero identifiers survive anywhere in src/ (the beam computes only the literal Eq-5); T059
`settleHumanOutcomeForEntity`: exactly one caller, genuinely live — kept-with-justification stands.

---

## 6. Over-claim ledger (stated stronger than the evidence)

1. "preCheckOk":true / "OK — the beam has causal chains to walk ✓" — an existence test presented as substrate
   health; 1 relation/conv (§3 row 3).
2. DoD elides `"materialized":[2,2],"persisted":[1,1]` behind "..." while keeping `"preCheckOk":true`; neither
   summary carries the mechanism-untested label (§3 row 10).
3. "every candidate (and the C3 router) posted a NEGATIVE value delta at every λ" — router Δ=0 at λ∈{0.5, 1.0}
   (§3 row 6).
4. "Full rows: …us1-cert-run-2026-07-06.log" — ~178/180 per-item rows missing; zero magma rows (§3 row 7).
5. "64/64 tasks done" — T020's "quoted per-category rows" (and SC-002's by-category leg) not in the captured
   evidence (§3 row 9).
6. "collision trap structurally impossible"; "(15/15)" advice framing; "cert log fully documents the run
   config" (head-truncated) (§5.2).
7. Unbacked quoted rows: σ=0.0267's variance-mode raw log and the smoke RESULTS_JSON exist nowhere in the repo
   (§3 row 12).

## 7. Withdrawn accusations (failed adversarial verification — reported per anti-overclaiming)

1. **"The judged gate's pre-check was softened STOP→WEAK to let a starved substrate through"** — REFUTED. The
   judged path has the strictest machine gate in the harness (per-conv min, power, held-out; auto
   CONFIRMATORY-ONLY stamp; arbiter hard-block). The soft wording exists only in cert-ingest's zero-branch and
   never fired. The true defect is the missing density floor, not a softened stop (§3 row 4).
2. **"'hybrid wins BOTH axes' conflates SC-004 with arm-vs-arm tokens"** — REFUTED. Corpus-scoped, literally
   true, pre-registered caveat (spec.md:206). Residue: SC-004's held-out denominator gap (§3 row 5).
3. **"Per-attempt binding is an over-claim"** — REFUTED as stated; the run disclosed the entity-path caveat
   itself. Residue: SC-005 live coverage gaps (§5.2).
4. **"MEASURED NULL is invalid even arm-vs-arm"** — REFUTED. The λ=0 leg was falsifiable and honestly lost
   (§3 rows 1–2).

## 8. Mistest ledger (conditions that structurally favored the incumbent)

1. **Corpus/axis selection**: concluded from LoCoMo — where the paper itself shows the token win cannot
   manifest (`harness:66-68` structural null; spec.md:206 concedes it) and where magma's own best case
   (long haystacks) never runs — while the LongMemEval harness (T019) was built and left unjudged. Note: the
   LME harness as built is **single-arm** (no magma/multihop dispatch, no ACP causal ingest — 310 lines,
   `retrieveContext`+`makeHybridBaseSearch` only), so "run LME judged" was not actually one command away.
2. **Substrate**: the magma arm judged on a 1-causal-relation/conv graph manufactured by the repo's own
   cap-20/0.7-gate reducer (§2) — the mechanism MAGMA's headline depends on was effectively absent.
3. **Budget**: both graph arms compressed to hybrid's operating point (topK=5/4000 chars) — the exact regime
   where serialize-all + scaffold can only cost, never pay. At λ>0 every leg was unwinnable by construction
   (Eq-7 compression can't fire below the cap; the comparator join is equally capped —
   `retrieval-context.ts:165`).
4. **Return contract**: with anchors always evicted, the magma arm was constitutionally unable to keep
   hybrid's 0.4475 floor — "at most a 5-chunk beam re-ranker could have won, which is not the paper's method."

## 9. Unresolved / not audited (honest scope statement)

- σ variance-mode raw artifact; smoke-mode raw artifact (§3 row 12). Unit 5958/integration 397 pass counts
  (file counts verified only). "5/5 green" execution status of the outward suite (static-verified only).
  "Broker :3456 untouched (node 7524)" and "ACP baseline 0" quoted numbers.
- SC-001's live-entry-point per-prompt leg (unit-proven; smoke row unbacked); SC-004 held-out denominator;
  SC-011's "internal answering still functions" end-to-end leg; per-category accuracy rows (SC-002).
- 63 of 64 tasks.md [X] marks were not individually re-audited (T020 was; the US-level sweeps cover the
  load-bearing claims of the rest).
- Whether ANY of the 60 judged questions actually traversed a causal edge in the magma arm (per-item rows
  truncated; likely ≈0 given 1 relation/conv).
- The MAGMA OSS repo (github.com/FredJiang0324/MAGMA) was not consulted (network-restricted audit); it may
  hold the real δ, consolidation prompt, and BeamWidth/γ — flagged for the corrective plan.

## 10. Verdict on the run, in one paragraph

The fable5 run is **honest at the row level and disciplined about guardrails** — every number it quotes is
real, the null it reported is a genuine arm-vs-arm null, the prior wrong-axis disaster was actually fixed, and
nothing it did flipped a default or touched a guarded file. Its failure is **at the experiment-design level,
and it is material**: it certified "hybrid stands" against a MAGMA arm that (i) evicts the hybrid anchors the
paper preserves — an Algorithm-1 integration infidelity that AGENTS.md #7 names verbatim as the thing not to
do; (ii) ran on a causal substrate its own ingestion reducer had starved to one relation per conversation;
(iii) was compressed to 1/12th of the paper's context budget; and (iv) was scored on the one corpus+axis where
the paper's efficiency win is structurally impossible — then presented that as a "MEASURED NULL — hybrid
stands" with the substrate counts elided from the summary and the per-category rows missing from the evidence.
A measured NULL honestly reported is a success **only if the setup could have shown a win**; for the paper's
MAGMA, this setup could not. T020 should be re-opened as **"hold-incumbent (operational) + MAGMA-fidelity
verdict pending"**, per the corrective re-measurement plan
(`docs/evidence/fable5-corrective-remeasurement-plan.md`).
