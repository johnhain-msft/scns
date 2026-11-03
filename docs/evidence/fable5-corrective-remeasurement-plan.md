# Corrective re-measurement plan — hybrid vs faithful MAGMA (design only; NO execution in this session)

**Companion to**: `docs/evidence/fable5-audit-findings.md` (2026-07-06 audit @ 487b39b). **Status: DESIGN.
Nothing here has been run. No code has been changed. Requires John's approval before any step executes.**

**Why re-measure**: the T020 "MEASURED NULL — hybrid stands" is valid only as an arm-vs-arm A/B at a fixed
5-chunk budget. As a verdict on the paper's MAGMA it is mistested on four independent grounds (findings §2/§8):
an anchor-evicting return contract (Alg-1 infidelity), a self-starved causal substrate (Alg-3 infidelity:
cap-20 + 0.7 gate discarded 85% of candidates un-judged), a 12× context compression the paper never evaluated,
and a corpus+axis where MAGMA's efficiency win structurally cannot fire. The corrective design must make a
**faithful, healthy** MAGMA measurable *before* any hybrid-vs-magma verdict is trusted again.

**Corpus decision (driven by the findings)**: **both corpora, in sequence, for different claims.**
- **LoCoMo** stays as the *reproduction/health* corpus — it is the only corpus with a published MAGMA target
  (Table 1 p.7: overall 0.700, per-category pattern) and it is where our substrate/ingest defects were proven,
  so it is where their fixes must be demonstrated. LoCoMo can also bound "accuracy-not-sacrificed" for the
  arms. It can NEVER carry the efficiency claim (blocks are 3-7× below the compression trigger — structural).
- **LongMemEval (judged)** becomes the *comparative/efficiency* corpus — long haystacks (~101K-token
  full-context analog; Table 2 p.8: MAGMA 61.2% avg at 0.7k–4.2k tok/query = the >95% reduction headline) are
  the only place Eq-7 budgeting and SC-004's denominator can both manifest. The audit found the built LME
  harness is **single-arm** (no magma/multihop dispatch, no ACP causal ingest), so Phase L includes closing
  that gap — "run LME judged" was never one command away and must not be claimed as such.

---

## Phase 0 — Fidelity fixes (code, TDD-locked; prerequisites for every gate below)

Nothing downstream is trustworthy until these land. Each fix cites the paper clause it restores and gets a
red-first test lock. **All fixes are behind the existing default-OFF levers/harness modes — no production
default changes.**

- **F0.1 — Alg-1 return contract (the primary cause).** Replace the `slice(0, topK)` score-slice return
  (`adaptive-traversal.ts:233`) with the paper's contract: **anchors are never evicted** (Alg-1 L3/L18/L22-23:
  Visited includes S_anchor; ALL of Visited is serialized). Design options, to be A/B'd inside the harness
  (not assumed): (a) *paper-literal*: return all Visited (≤ budget 200) topo-sorted, let Stage-4 salience
  budgeting compress to the token budget (brevity codes for low-S(n_j|n_i,q) nodes — Stage 4 p.5-6); (b)
  *anchor-preserving merge*: guarantee the top-K contains the anchor set ∪ best-scored reached nodes (union,
  not competition). Lock: a unit test where anchors + ≥K reachable higher-φ neighbors exist MUST return every
  anchor (this exact case is today's failure, provable red-first).
- **F0.2 — Anchor pool to Table 6.** `anchorPool` 8 → **Vector Top-K 20** (Table 6 p.13), env-overridable in
  the harness for sensitivity sweeps.
- **F0.3 — Alg-3 consolidation (the starvation cause).** Replace the ONE batched 20-pair-capped call/conv with
  the paper's per-node loop semantics (Alg-3 p.6: one consolidation pass per enqueued node over its 2-hop
  neighborhood): judge **all** candidates in chunked batches (≤20 pairs per ACP call to respect the wall —
  keep the deny-all/isolated spawn discipline), i.e. ~7 calls for 122–142 candidates, not 1. Sweep
  `minConfidence ∈ {0.5, 0.6, 0.7}` (the paper's δ is unpublished; Table 6 lists no causal-confidence
  parameter). **Before building: check the MAGMA OSS repo (github.com/FredJiang0324/MAGMA) for the real δ,
  consolidation prompt, BeamWidth, and γ** — prior-art-first (AGENTS.md #8); adopt over reinvent.
- **F0.4 — Semantic edge graph.** Cert ingest never builds E_sem (`buildSemantic` not passed; Table 6 "Sim.
  Threshold 0.10–0.30", p.4). Enable it in the cert-ingest path so the graph has all three paper edge types.
- **F0.5 — Token-denominated Stage-4 budget.** The Eq-7 salience budget is char-based (4000 chars); at LME
  scale the compression trigger must be token-based and per-arm-configurable, or the efficiency axis stays
  unmeasurable even there.
- **F0.6 — Evidence-capture hygiene** (cheap, prevents §6-ledger recurrences): archive FULL stdout per mode
  (fix the head-truncation that destroyed ~178/180 per-item rows); persist per-item rows (arm, cat, score,
  tokens, generated answer) as a JSONL artifact; emit per-arm **per-category** accuracy+token rows in
  RESULTS_JSON (closes T020/SC-002's "by category" gap); archive the σ variance-mode raw log and any smoke
  rows quoted by future DoDs.

## Phase 1 — Substrate gate: reinstate the HARD PRE-CHECK STOP (kill the vacuous OK)

The audit refuted "STOP was softened to WEAK" (the judged gate's machine gate is real) but confirmed the
threshold is vacuous: `preCheckOk = totalMaterialized > 0`, so 1 relation/conv printed "OK ✓". Redesign:

- **Density floor, not existence.** The pre-check and `thinProbe` gain hard criteria (values tunable, gated
  red-first):
  - per-conv materialized causal edges ≥ **8** (i.e. ≥4 logical relations/conv — enough for ≥1 multi-edge
    chain), AND
  - materialized causal edges per judged WHY/multi-hop item ≥ **0.5**, AND
  - per-conv minimum (not sum — keep the existing "a sum would MASK a per-conv 0" check at :2233-2245).
- **STOP semantics everywhere.** Below the floor: cert-ingest prints `STOP — substrate below density floor;
  any graph-arm Δ is a NULL, not a MAGMA verdict` (same hard wording as :1084/:1634 — delete the ":1683 WEAK"
  branch), `preCheckOk:false`, and the judged gate **refuses to run the graph arms** (hard exit, not a label).
  The CONFIRMATORY-ONLY stamp remains for the power/held-out legs only.
- **The label must survive summarization.** RESULTS_JSON carries `substrate: {materializedPerConv, floor,
  pass}`, and the DoD template quotes it un-elided (the audit found `[2,2]/[1,1]` hidden behind "..." while
  `preCheckOk:true` was kept).

## Phase 2 — MAGMA reproduction/health gate (LoCoMo; BEFORE any hybrid-vs-magma verdict is trusted)

**Purpose**: prove SCNS-magma is *the paper's method, healthy* — not to beat hybrid. Hybrid does not run here.

- **Setup**: post-F0 code; faithful ingest (F0.3/F0.4) of a LoCoMo slice sized by power (n ≥ 60 items,
  cat-stratified per Table 7 proportions; held-out from any tuning); magma at the **paper's operating point**:
  20 anchors (F0.2), serialize-all + Stage-4 budgeting (F0.1), depth 5 / budget 200 / dropθ 0.15 (already
  faithful); pinned judge with **σ re-measured under it** (artifact archived, F0.6); paper C.3 rubric (already
  matches); pos/neg controls (existing paper-axis sets); det×2.
- **Acceptance criteria — pattern + ordering, with an absolute band** (exact-number parity with Table 1 is not
  expected under a different generator/judge than gpt-4o-mini; the paper's *shape* is the reproduction target):
  1. **Ordering (hard)**: magma overall **> its own Full-Context arm** run on the same slice/judge (the
     paper's decisive ordering: 0.700 > 0.481). Full-Context here doubles as the SC-004 denominator (Phase 4).
  2. **Band (hard)**: magma overall ≥ **0.60** under the pinned judge (paper: 0.700; w/o-Causal floor 0.644;
     all single-graph ablations < 0.60 — Table 4/5). Below 0.60 = not reproduced; investigate before anything
     comparative.
  3. **Category pattern (hard)**: adversarial and single-hop are magma's best categories; multi-hop its worst
     (Table 1 row shape). An inverted shape = wrong mechanism, regardless of the mean.
  4. **Substrate (hard)**: Phase-1 density floor passes; report per-conv edge counts + the candidate→persisted
     cascade (the audit's `eventCand=122 → candidateCount:20 → persisted:1` cascade must be gone).
  5. **Diagnostics (report-only)**: % of judged items whose traversal touched ≥1 causal edge; anchor-retention
     rate in the returned context (must be 100% post-F0.1); mean tokens/query (expect ~3k, cf. Table 3's
     3.37k — if it stays ~281, F0.1 didn't land).
- **Controls**: existing pos/neg controls PLUS a **scrambled-graph negative control** (paper-health-specific):
  magma on a graph with randomly rewired causal edges must score materially below magma on the real graph
  (Δ > σ). If it doesn't, the graph isn't contributing and a "healthy" score is a false positive.
- **Outcome handling**: PASS ⇒ Phase 3/L. FAIL after F0 fixes ⇒ the honest conclusion is "MAGMA-as-published
  does not reproduce in the SCNS substrate at this operating point"; document per-criterion, check the OSS
  repo deltas (F0.3 note), and STOP — no comparative verdict may cite the paper as the bar until this passes.

## Phase 3 — Corrected comparative gate (LoCoMo; accuracy-not-sacrificed only)

Only after Phase 2 passes. Same held-out discipline (fresh conv IDs, never conv-26/30/44/47), n per power
calc, blind pinned judge, det×2, λ-sweep with the existing gateVerdict (LB>0 + clean neg controls).

- **Claim scope (pre-registered)**: this gate answers *"does faithful magma beat hybrid on ANSWER accuracy at
  LoCoMo scale, and does it not regress multi-hop?"* — it does NOT carry the efficiency claim (structurally
  impossible here) and must be labeled `token-axis: not-applicable-on-this-corpus` in RESULTS_JSON and the DoD.
- **Budget parity redefined**: arms are compared at **equal token budget**, not equal topK — hybrid at
  topK=5/4000 chars vs magma serialize-all compressed by Stage-4 to the SAME token budget. That is the
  paper-faithful comparison (Stage-4 budgeting IS the mechanism; slicing magma to 5 chunks pre-Stage-4 is what
  made T020's magma a "5-chunk beam re-ranker"). A secondary un-capped magma arm (~3k tok) is reported for
  diagnosis, clearly labeled not-cost-comparable.
- **Expected honest outcomes**: hybrid may still win here (the paper's LoCoMo margin over strong flat
  baselines is modest and our generator differs) — that would now be a *valid* NULL, because the setup could
  have shown a faithful magma winning. Report per-category rows (T020's unmet letter).

## Phase L — LongMemEval judged (the efficiency + long-haystack gate; the go-live gate per T019)

- **L.1 Harness completion (build, TDD)**: add to `longmemeval-judge-harness.ts` what the audit proved absent:
  multi-arm dispatch mirroring `FRONTIER_ARMS` (hybrid / magma / multihop-iter), an ACP event+causal ingest
  mode (cert-ingest equivalent with the Phase-1 density gate), a **full-context arm** (the ~101K haystack
  un-managed — the SC-004 and paper-Table-2 comparator), per-arm per-type rows, and the same spawn/vault
  guards. Use `_s`/`_m` haystacks (oracle split's contexts are too small to exercise compression).
- **L.2 Prerequisite**: the judge↔human calibration slice (R2, AWAITING-JOHN per `log:249`) is completed
  before any LME verdict is trusted (judge validity currently rests on pos/neg separation alone).
- **L.3 Measurement**: σ re-measured on LME under the pinned judge; magma at the paper operating point;
  n by power calc per question type; pos/neg controls from LME types (paper Table 2: MAGMA wins avg 61.2% but
  LOSES ssa/knowledge-update/ssu to Nemori — build the control axis from the paper's actual wins/concessions,
  as was correctly done for LoCoMo).
- **L.4 Claims it can carry**: (a) SC-004 at scale (briefing ≪ full-context, target "a small fraction");
  (b) the MAGMA efficiency story (tokens/query vs full-context at maintained accuracy — the >95% headline's
  home turf); (c) the hybrid-vs-magma long-haystack comparison — the graph arms' best remaining case per
  FABLE5_STATUS's own "Exact next step".
- **L.5 Flip rule (unchanged posture)**: any default flip still requires the arbiter's certified win (LB>0,
  clean neg controls, ≤ cost, det×2 — machine-verified, closing the audit's det×2-attestation nit) AND the
  Phase-2 health gate already passed. Levers stay default-OFF until then.

## Phase 4 — Separate the two token claims permanently (SC-004 ≠ arm-vs-arm cost)

- **SC-004 (briefing vs FULL memory-as-context)**: measured ONLY against an explicit full-context arm on the
  same slice — LoCoMo held-out (Phase 2's Full-Context arm; the audit found no held-out denominator was ever
  measured — only the DEV note "~1-2% of full-context (13869 tok)") and LME (Phase L, the ~101K analog).
  Reported as `sc004: {briefingTok, fullContextTok, fraction}`.
- **Arm-vs-arm tokens (hybrid vs magma)**: reported as `armCost` in the comparative gates, feeding the λ-sweep
  value function only. DoD/status templates must never render armCost in an SC-004 sentence; the two claims
  get separate labeled rows (the audit found the T020 sentence true-but-adjacent; this makes the separation
  structural).

## Cross-cutting measurement standards (all phases)

Blind pinned judge (three-field prompt, unchanged); σ re-measured per corpus×judge with archived raw artifact;
positive AND negative controls on every judged run (paper-axis sets + the Phase-2 scrambled-graph control);
det×2 machine-verified (hash-compare two runs' RESULTS_JSON, not an env attestation); powered n from
`nToResolveDelta` per corpus; held-out discipline (no conv reuse across tuning/cert; conv-44/47 are now
burned for tuning-adjacent decisions since this audit studied them); full-stdout + per-item JSONL artifacts;
per-category rows in every DoD table; every guard from the T020 run retained (isolated `SCNS_HOME`, mkdtemp
vaults, live vault never opened + mtime/size asserted, deny-all bounded spawns killed by exact PID, no push,
levers default-OFF, kernel/allowlist untouched).

## Execution order and decision tree

```
F0 fixes (TDD) ─► Phase 1 substrate gate red-first tests
      │
      ▼
Phase 2 LoCoMo reproduction/health gate
      ├─ FAIL ► document per-criterion; consult OSS repo; STOP (no comparative claims)
      └─ PASS ▼
Phase 3 LoCoMo comparative (accuracy leg only; token axis labeled N/A)
      │            (hybrid may honestly win here — now a VALID null)
      ▼
Phase L LongMemEval: L.1 harness build ► L.2 judge-human calibration ► L.3 judged gate
      ├─ magma wins acc at ≤ cost (det×2, controls) ► arbiter certifies ► flip decision (John's λ)
      └─ NULL ► hybrid stands — now on a setup that could have shown the win; close T020 for real
```

## Non-goals / guards for this plan itself

- **No execution now**: this document is the design; every phase requires John's approval to run.
- **No git push; no default lever flips; no production behavior change** anywhere in Phases 0–L (all fixes
  live behind existing default-OFF levers and harness modes; the F0 code changes ship dark until Phase-L
  certification).
- **Guardrail files untouched**: the safety kernel, `config/safety-allowlist.json`, and broker :3456 are out
  of scope for every phase; the arbiter's authority boundaries (FR-027) are unchanged.
- **The live vault `~/.scns/memory/vault.db` is never opened** by any phase (mkdtemp vaults + snapshot dirs
  only, mtime/size asserted before/after every run).
- Rough cost note for planning: Phase 2 ≈ 1 judged run (n≈60×2 arms×det2) + ingest (~14 ACP calls/conv under
  F0.3); Phase 3 ≈ T020-scale ×2 (det×2); Phase L ingest is the expensive step (long haystacks) — budget it
  after L.1 lands.
