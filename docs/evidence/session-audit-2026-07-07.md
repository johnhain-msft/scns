# Independent audit — T027 briefing-budget fix + judged reproduction (2026-07-07)

**Role:** independent auditor establishing GROUND TRUTH (separate fresh context; NOT the implementer session).
**Scope:** READ-ONLY. No code changes, no commits, no push. Ran only the deterministic no-ACP token probe +
`npm run test:unit`; did NOT run the expensive ACP judged harness; did not mutate the live vault.
**Repo:** `$HOME/Coding_Projects/scns_root/scns` · branch `feature/fable-5-implementation` · HEAD `eab1b72`.
**Frame held (per handoff correction):** MAGMA does NOT win multi-hop QA (paper concession 0.528). T030 is a
FIDELITY-REPRODUCTION check (does our magma reproduce the paper's OWN LoCoMo number on a faithful setup), NOT a
hybrid-vs-magma QA race. Metric = App-C.3 LLM-Judge ANSWER accuracy + tokens; retrieval recall is NEVER the verdict.

## Guards honored by THIS audit
```
live vault ~/.scns/memory/vault.db  BEFORE: mtime=1783256409 size=232488960
live vault ~/.scns/memory/vault.db  AFTER : mtime=1783256409 size=232488960   (UNCHANGED ✓)
token probe: 0 ephemeral ACP spawned / 0 alive; isolated SCNS_HOME (mktemp) cleaned; snapshot read via harness (copies)
broker :3456 untouched; kill-by-PID only; NO edits, NO commits, NO push.
```

## Commits audited (`git --no-pager log --oneline b21cdec..HEAD`)
```
eab1b72 docs(evidence): mark AWAITING-JOHN #1 (git_push) executed — John-approved
9b56b63 docs(evidence): T027 temporal(cat2) diagnostic — not a memory-layer bug
b2e2672 docs(evidence): T027 briefing-budget — manifestation, judged RAW, independent grade
a3a1879 feat(harness): budget magma Stage-4 to ~3.37k tokens (serialize-all-visited augment)
91de730 feat(memory): serialize all Visited -> Eq-7 token budget with anchor retention (T027)
```
The two feature commits (`91de730`, `a3a1879`) are the fix; the rest are evidence/docs.

---

## Claim 1 — THE FIX IS FAITHFUL (not a hack; no gate-softening)

**Verdict: CONFIRMED.** Confidence: **high**.

`adaptive-traversal.ts` (`91de730`) adds an additive, back-compatible boundary; the beam/score is untouched:
```ts
// src/memory/adaptive-traversal.ts (TraversalOptions)
readonly returnBudget?: number   // Alg 1 L22-23 "return Serialize(Csorted)"; default = topK (byte-identical legacy)
// admission:
const returnCap = Math.max(topK, options.returnBudget ?? topK)   // only ever RAISES the boundary
// anchor provenance:
out.push(anchorSet.has(id) ? { ...base, isAnchor: true } : base) // SearchResult.isAnchor (search.ts, optional)
```
The pure-cosine slice that made the arm inert is gone; the min-anchor-floor + Eq-5 (`φ×sim`) salience admission
(landed in `0e4302e`) now operates over `returnCap`. `search.ts` only adds an **optional** `isAnchor?: boolean`
(absent ⇒ undefined on every non-traversal path).

`retrieval-context.ts` Stage-4 is a faithful Eq-7 salience TOKEN budget with anchor protection:
```ts
const cost = (s) => useTokens ? estimateTokens(s) : s.length + 1     // Eq-7 token denomination when maxTokens set
// 1) anchors (protectedIds) kept unconditionally (AnchorRetention = 1.0)
// 2) fill remaining budget by highest-salience NON-anchor nodes; low-salience tail → brevity codes
```
Wiring is correctly gated — the graph AUGMENTS only on the magma path:
```ts
const serializeAllVisited =
  synthesize && config.maxTokens != null && ((config.traverse ?? false) || (config.multiHop ?? false))
```
`estimateTokens = ceil(len/4)` (chunker.ts) is the standard SCNS token proxy. `DEFAULT_BUDGET=200 = WHY_BEAM_BUDGET`,
so the whole ~60-node Visited subgraph flows to Stage-4 — consistent with the 3454-tok manifestation.

**No reproduction gate was weakened.** `reproductionBand` (`>= 0.6`) and `reproductionCategoryPattern` were both
added in the PRIOR session (`2e9693b`); `git log b21cdec..HEAD -- scripts/locomo-judge-lib.ts` shows the T027
commits do **not** touch the gate library at all. No threshold change.

*Symmetric caveat (does NOT change the verdict):* `isAnchor` is now flagged on **every** `adaptiveTraversalSearch`
return (even legacy topK), so a `traverse+synthesize`+**no-maxTokens** call whose char budget actually binds would
now protect anchors in char mode — a narrow, paper-FAITHFUL behavior change. It is not reachable in the measured
harness (Arm B at harness:1166 is `traverse` without `synthesize` → never calls `chooseKeepSet`; all magma arms
carry `maxTokens`) and the full suite is green, so "legacy paths byte-identical" is true for every reachable/measured
path but very slightly overstated for that one theoretical sub-path.

## Claim 2 — UNIT COVERAGE is real red-first, not tautological

**Verdict: CONFIRMED.** Confidence: **high**.

Independently ran `npm run test:unit`:
```
Test Files  402 passed (402)
     Tests  6035 passed (6035)          # baseline 6028 + 7 T027 tests
```
All 7 T027 tests RUN (not skipped) — verbose reporter:
```
✓ adaptive-traversal … RED T027: returnBudget serializes ALL of Visited (5 anchors + 3 causal), not the topK=5 swap
✓ adaptive-traversal … NEG T027: zero causal weight ⇒ anchors only  (no indiscriminate padding)
✓ adaptive-traversal … default returnBudget = topK ⇒ byte-identical (back-compat)
✓ retrieval-context  … RED T027: a low-salience ANCHOR is protected; a low-salience non-anchor tail elides
✓ retrieval-context  … NEG T027: with NO anchor flag the same node is NOT protected (elides under budget)
✓ retrieval-context  … maxTokens budgets by TOKENS not chars (fits maxChars, still compresses under maxTokens)
✓ retrieval-context  … RED T027: magma briefing contains anchors AND >=2 reached causal chunks (augment ≠ swap)
```
The tests lock exactly the claimed behaviors with specific assertions (`toEqual`/`arrayContaining`/`toContain`,
not `toBeTruthy`) and matched POS/NEG controls: **augment-not-swap** (`ids.length >= 8` vs topK=5), **anchor
retention** (anchor kept *despite lowest salience 0.01*), a **TOKEN (not char) budget** (huge `maxChars` still
compresses under small `maxTokens`), and NEG controls that prove the mechanism stays silent (zero-causal ⇒ none;
no `isAnchor` ⇒ elides). These are genuinely red-first (a topK=5 slice / char budget / no-protection code path
fails each assertion). Not tautological.

## Claim 3 — MANIFESTATION is real (Validity-of-Null satisfied)

**Verdict: CONFIRMED.** Confidence: **high**.

Independently re-ran the DETERMINISTIC no-ACP token probe (`SCNS_JUDGE_MODE=arm-frontier-tokens`, isolated
`SCNS_HOME`, reused snapshot). Reproduced the doc's numbers exactly:
```
PRE-CHECK causal materialized=216 persisted=108
hybrid        mean 147 tok  (Δ vs incumbent +0)
magma         mean 3454 tok (Δ vs incumbent +3308)
multihop-iter mean 149 tok  (Δ vs incumbent +2)
spawn guard: 0 ephemeral ACP spawned; live vault mtime unchanged: YES ✓ (1783256409593 → 1783256409593)
```
magma tokens rose to paper scale (~3.37k target → 3454); hybrid + multihop-iter unchanged. The pre-fix `272` is
corroborated in `reproduction-gate-band.RAW.md:112` (n=90 pre-T027 run, `mean_tokens_per_query:272`), so the
"272→3454" delta is honestly sourced. This satisfies Validity-of-Null: the mechanism is faithful+reachable, the
substrate is materialized (216 causal), and the setup DID move the judged overall +0.19 — a valid measured result,
not a starved/INCONCLUSIVE null.

## Claim 4 — THE JUDGED NUMBER is honestly measured

**Verdict: CONFIRMED.** Confidence: **high**.

The raw judged log (`.copilot-scratch/t027-judged-run.log:2080-2090`) matches `reproduction-gate-band-t027.RAW.md`
**verbatim**:
```
MAGMA reproduction: overall=0.7828 ± 0.0774 (95% CI) n=90 dropped=0; band_pass=true;
category_pattern_pass=false; verdict=NOT_REPRODUCED
perCategory: cat1=0.8083 cat2=0.5889 cat3=0.7611 cat4=0.8111 cat5=0.9444 ; mean_tokens_per_query=3454
```
The config actually run carries the fix in the measured path:
`magma-only {"traverse":true,"traversalOptions":{"maxDepth":5,"budget":200},"synthesize":true,"maxTokens":3400}`.
Guards in the log: `live vault mtime unchanged: YES ✓ (1783256409593 → 1783256409593)`, broker pid 3539 untouched,
`spawn guard: 180 spawned / 0 alive` (ACP 0-leak), ISO cleaned. `substrate_pass=true`, `ordering_pass=null`,
`scrambled_control=null` (Increment-2 controls unbuilt) ⇒ the harness can only auto-emit NOT_REPRODUCED, which the
docs state plainly. No sign of a mistested or inflated result — the metric is App-C.3 answer accuracy (not recall).

*Producer≠grader:* honored by **role/session separation** — the grader artifact declares an independent role and
did no harness re-run. Note this is asserted from the artifacts/protocol, not git-provable (all commits share one
author alias); that is consistent with the documented delegation-first workflow and is not itself a red flag.

## Claim 5 — THE GRADE is calibrated

**Verdict: CONFIRMED** (the grade "BAND-REPRODUCED, T030 PENDING — not BLOCKED, not full REPRODUCED" is the honest
reading). Confidence: **high**. I independently reproduced the gate math:
```
reproductionCategoryPattern:  min(single, adversarial) > multi  &&  multi === minAcc
  predicate1: min(0.8111, 0.9444)=0.8111 > multi 0.8083  → TRUE  (razor-thin margin 0.0028)
  predicate2: multi 0.8083 === minAcc 0.5889              → FALSE (minAcc is cat2=temporal, not multi-hop)
  ⇒ category_pattern_pass = false   (mechanically correct)
```
I **agree** with the grader that this is BOTH a real gap AND partly a check-design artifact:
- **Check artifact:** the `multi === minAcc` rank-shape proxy encodes "multi-hop is the bottom category" (the
  paper's Table-1 shape). It fails here **precisely because magma BEATS the multi-hop concession** (0.808 ≫ 0.528),
  so temporal — not multi-hop — is the minimum. Penalizing magma for exceeding a concession is not faithful to the
  Fidelity-Reproduction Floor (AGENTS.md #11 = reproduce the paper's **per-category wins** within tolerance).
  Predicate1 also passing by only 0.0028 shows the gate is knife-edge/fragile to that overshoot.
- **Real gap:** under a target-based read, **temporal 0.5889 < 0.650 is the one genuine miss**; the other four
  meet/exceed (overall 0.783≥0.700, single 0.811≥0.776, adversarial 0.944≥0.742, multi 0.808≥0.528).

Crucially, **both** the rank-shape gate and a target-based gate conclude "not full REPRODUCED" (temporal misses),
so the calibrated verdict is robust to the contested gate design. The docs do not over-claim REPRODUCED and do not
under-claim a fresh BLOCKED/starved null — calibrated in both directions.

## Claim 6 — THE TEMPORAL DIAGNOSTIC is sound

**Verdict: CONFIRMED** (honest; the residual is not being under-stated). Confidence: **medium-high**.

I independently verified the two load-bearing statistical facts:
```
temporal cat2 mean=0.5889 n=18 → 95% CI ≈ [0.36, 0.82]  ⇒ paper 0.650 IS inside the interval  (miss not established at n=18)
```
The diagnostic's core conclusion — retrieval is NOT the temporal bottleneck — is well-supported: magma surfaces
evidence+date for 87% of temporal items (evidence 88% vs hybrid 52%, **+36pts** — the augment HELPS temporal
retrieval), yet many *covered* items still score <1, so the binding constraint is relative-date reasoning + judge
grading, not memory fidelity. That reasoning is robust even though the absolute coverage % rests on a fuzzy
≥60%-content-word proxy — and the doc itself flags that proxy (and the earlier strict-match 2% false-negative);
because both arms are measured identically, the magma-vs-hybrid delta is sound regardless of the absolute threshold.

*Minor cosmetic note (no effect on the verdict):* the illustrative score histogram in the doc ("11×1.0, 6×0 …")
does not sum to mean×n=10.6 (a ~9×1.0 histogram fits); the authoritative mean/n come from RESULTS_JSON and the CI
conclusion is unaffected.

## Claim 7 — DRIFT / OVERCLAIM (either direction)

**Verdict: PARTIALLY-CONFIRMED** — the work is largely calibrated; I flag two minor precision items, none material.
Confidence: **high**.

- **Multi-hop framing — clean.** The docs correctly treat multi-hop as the paper's concession and frame magma's
  0.808 as *beating* it (not a celebrated multi-hop-QA win). This holds the handoff's framing correction. ✓
- **"Exceeds paper 0.700" — honest but thin.** 0.7828 ± 0.0774 ⇒ CI [0.7054, 0.8602]; even the CI-lower bound
  clears 0.700, but only by **+0.0054**. Fair to state (and it clears the 0.60 band comfortably), yet the specific
  "exceeds 0.700" margin is within noise — worth a "≈ at/above paper overall" softening rather than a firm beat.
- **"No other per-category retrieval gap" — slightly strong.** Scoped to retrieval + this run, but with n=18/category
  the per-category numbers are noisy, and open-domain has no paper target; "no other gap *indicated by this run*"
  would be the exact phrasing.
- **"Byte-identical legacy" — very slightly overstated** for the one narrow traverse+synthesize+no-maxTokens
  binding-char sub-path (see Claim 1); true for all reachable/measured paths.
- **No underclaim, no fabrication.** NOT_REPRODUCED is honestly reported and correctly explained as an
  unbuilt-controls artifact, not spun as a win; the mechanism-manifests evidence prevents a false BLOCKED.

---

## Overall judgment — is this real, honest progress?  **YES.**

This follows from the per-claim findings, not a preset conclusion: the fix is a faithful, additive Alg-1 L22-23 /
Eq-7 implementation with the beam untouched and **no reproduction gate softened** (Claim 1); coverage is genuine
red-first with matched pos/neg controls at an independently reproduced **6035** green (Claim 2); the paper-scale
manifestation (**magma 3454 tok**, hybrid/multihop unchanged) reproduces on re-run and satisfies Validity-of-Null
(Claim 3); the judged **0.7828 ±0.0774, n=90** matches the raw log verbatim with all guards held and the fix in the
measured path (Claim 4); and the grade is calibrated in both directions — BAND-REPRODUCED / T030-PENDING, with the
`category_pattern_pass=false` correctly diagnosed as partly a knife-edge check artifact (magma beats the multi-hop
concession) and partly a real **temporal** miss (0.589<0.650), a verdict robust to the gate-design question
(Claims 5–6). The only drift is minor wording thinness around "exceeds 0.700" / "no other gap" (Claim 7). Honest
status: **magma reproduces the paper's overall band and 4/5 per-category targets on a faithful, manifesting setup;
temporal is the one open per-category gap; ordering/scrambled controls remain unbuilt — so NOT_REPRODUCED-in-full is
the correct, non-inflated call.** No mistesting, no fabricated evidence, guards intact.

## G1 recommendation (one line, to inform John's decision)

**Adopt the target-based check** (per-category vs App-C.3: single≥0.776, temporal≥0.650, adversarial≥0.742,
overall≥0.700, with multi-hop 0.528 as a concession **floor**, never an upper constraint) — it is more faithful to
the Fidelity-Reproduction Floor and more diagnostic (it isolates the real temporal miss instead of mis-firing when
magma beats the concession); the change is correctly gate-governance and stays **AWAITING JOHN** (#12).
