# T027 post-fix MAGMA reproduction — independent graded verdict

Date: 2026-07-07. Role: independent grader. Scope: read raw evidence and code; no code changes, no commits, no push, no expensive harness re-run. This file is the requested grading artifact.

## Adopted category mapping

I adopt the harness/lib mapping with **medium-high confidence**: `cat1=multi-hop`, `cat2=temporal`, `cat3=open-domain`, `cat4=single-hop`, `cat5=adversarial`.

Evidence:

```ts
// scripts/locomo-judge-lib.ts:23-52
* Gold reference for a LoCoMo QA. Categories 1–4 (multi-hop/temporal/open-domain/single-hop) use the
* `answer` field; category 5 (adversarial) uses the MAGMA abstain convention
...
export const LOCOMO_CAT = {
  multihop: 1,
  temporal: 2,
  openDomain: 3,
  singleHop: 4,
  adversarial: 5,
} as const
```

```text
scripts/locomo-judge-harness.ts:2095-2099
NEG = {multihop} ... POS = {temporal, singleHop, adversarial} ... NEUTRAL = {openDomain}
```

The local LoCoMo data exemplars also fit `cat2=temporal`, `cat3=open-domain/hypothetical`, and `cat5=adversarial/unanswerable`; cat1 vs cat4 is less obvious from a few examples, but the code comments are explicit and treated as the single source of truth.

## Authority / gates quoted

```text
AGENTS.md:25-26 — The metric is LLM-as-Judge ANSWER accuracy + token efficiency ... Retrieval recall is a sanity check only, never the verdict.
AGENTS.md:60-65 — A NULL counts ONLY if the setup could have shown a win ... otherwise INCONCLUSIVE → report BLOCKED.
AGENTS.md:66-70 — Before pitting magma against hybrid, magma MUST first reproduce the paper's own number (LoCoMo Overall ~0.700 + its per-category wins) within tolerance.
AGENTS.md:71-75 — A comparative/go-live verdict needs an INDEPENDENT fresh-context sign-off.
```

Paper target evidence used by the run and confirmed from `magma.pdf` text extraction:

```text
Paper band targets (App C.3): Overall 0.700 · Single-Hop 0.776 · Temporal 0.650 · Adversarial 0.742 · Multi-Hop 0.528 (concession).
```

## Per-claim grades

### 1. GUARDS held

**Verdict: CONFIRMED.**

Quoted evidence:

```text
docs/evidence/reproduction-gate-band-t027.RAW.md:50-59
live vault ~/.scns/memory/vault.db: mtime=1783256409 size=232488960 (BEFORE and AFTER — unchanged)
live vault mtime unchanged: YES ✓ (1783256409593.3137 → 1783256409593.3137)
broker :3456: pid 3539 LISTEN (BEFORE and AFTER — untouched)
spawn guard: 180 ephemeral ACP process(es) spawned; still-alive 0; strays killed-by-pid 0; exit-signalled 180
ACP leak count: spawned=180, alive-after=0
ISO cleaned (zero-pollution): YES ✓  (SCNS_HOME=.copilot-scratch/scns-home-t027-judged empty after)
copilot/acp procs: 6 baseline → 6 after (no leak)
NO push. Local-only. Snapshot reused (no re-ingest).
```

Assessment: internally consistent and sufficient for this read-only grading purpose; I did not touch the live vault or broker.

Confidence: **high** — one coherent guard block covers vault, broker, ACP, ISO, and no-push.

### 2. MECHANISM MANIFESTS / Validity-of-Null

**Verdict: CONFIRMED.**

Quoted evidence:

```text
docs/evidence/t027-briefing-budget-manifestation.md:23-31
PRE-CHECK causal materialized=216 persisted=108 ⇒ beam has causal chains on ≥1 conv
hybrid       mean 147 tok  (Δ vs incumbent +0)
magma        mean 3454 tok  (Δ vs incumbent +3308)
multihop-iter mean 149 tok  (Δ vs incumbent +2)
...
live vault mtime unchanged: YES ✓
```

```text
docs/evidence/t027-briefing-budget-manifestation.md:41-48
[cat2] ... hybrid=5 magma=60 | anchorsRetained=5/5 OK | augmented(+typed)=55 OK
[cat1] ... hybrid=5 magma=60 | anchorsRetained=5/5 OK | augmented(+typed)=55 OK
[cat3] ... hybrid=5 magma=60 | anchorsRetained=5/5 OK | augmented(+typed)=55 OK
[cat4] ... hybrid=5 magma=60 | anchorsRetained=5/5 OK | augmented(+typed)=55 OK
[cat5] ... hybrid=5 magma=60 | anchorsRetained=5/5 OK | augmented(+typed)=55 OK
SUMMARY: anchorRetention(all)=PASS | augment≥2(all)=PASS
```

```text
docs/evidence/reproduction-gate-run.md:5-7
BLOCKED ... judged overall=0.5911 null is not informative ... final MAGMA context does not show the faithful causal mechanism under test manifesting ... same chunk IDs as hybrid ... zero causal-edge nodes ... structurally-can't-win setup.
```

Assessment: the prior run was correctly BLOCKED because the mechanism was effectively starved/inert. T027 is not that: token budget jumps from the old 272-ish scale to 3454, the magma context grows from 5 to 60 chunks, anchors are retained, and typed nodes augment the anchors. The setup could show a win; any remaining miss is a valid measured result, not BLOCKED.

Confidence: **high** — deterministic manifestation and prior-blocked contrast are direct.

### 3. BAND

**Verdict: CONFIRMED.**

Quoted code:

```ts
// scripts/locomo-judge-lib.ts:501-504
/** T030 reproduction floor: MAGMA paper-band reproduction is inclusive at 0.60 overall accuracy. */
export function reproductionBand(overall: number): boolean {
  return overall >= 0.6
}
```

Quoted result:

```json
docs/evidence/reproduction-gate-band-t027.RAW.md:19
"overall":0.7828,"overall_ci95":0.0774,..."band_pass":true
```

```text
docs/evidence/reproduction-gate-band-t027.RAW.md:23
MAGMA reproduction: overall=0.7828 ± 0.0774 (95% CI) n=90 dropped=0; band_pass=true; category_pattern_pass=false; verdict=NOT_REPRODUCED
```

Assessment: `0.7828 >= 0.60` and also exceeds the paper overall target `0.700`. The band leg is cleanly reproduced.

Confidence: **high** — direct function and result row.

### 4. CATEGORY PATTERN

**Verdict: PARTIALLY-CONFIRMED.**

Quoted code:

```ts
// scripts/locomo-judge-lib.ts:506-524
/**
 * T030 MAGMA Table-1 category pattern: adversarial + single-hop are the top band, while multi-hop is the
 * bottom category. This is a reproduction leg, not a final verdict; ordering/scrambled controls are
 * measured separately.
 */
export function reproductionCategoryPattern(perCatAcc: Record<number, number>): boolean {
  const required = [
    LOCOMO_CAT.multihop,
    LOCOMO_CAT.temporal,
    LOCOMO_CAT.openDomain,
    LOCOMO_CAT.singleHop,
    LOCOMO_CAT.adversarial,
  ]
  if (!required.every((c) => Number.isFinite(perCatAcc[c]))) return false
  const multi = perCatAcc[LOCOMO_CAT.multihop]!
  const single = perCatAcc[LOCOMO_CAT.singleHop]!
  const adversarial = perCatAcc[LOCOMO_CAT.adversarial]!
  const minAcc = Math.min(...required.map((c) => perCatAcc[c]!))
  return Math.min(single, adversarial) > multi && multi === minAcc
}
```

Quoted result:

```text
docs/evidence/reproduction-gate-band-t027.RAW.md:33
Per-category (this run): cat1=0.8083 cat2=0.5889 cat3=0.7611 cat4=0.8111 cat5=0.9444
```

Evaluation under adopted mapping:

- multi-hop `cat1=0.8083`
- temporal `cat2=0.5889`
- open-domain `cat3=0.7611`
- single-hop `cat4=0.8111`
- adversarial `cat5=0.9444`

The first predicate is barely true: `min(single=0.8111, adversarial=0.9444) > multi=0.8083`. The second predicate is false: `minAcc=temporal=0.5889`, not multi-hop. Therefore `category_pattern_pass=false` is mechanically correct.

Judgment: this is **not** a starved-null artifact. It is a real per-category concern because temporal misses the paper target `0.650` (`0.5889 < 0.650`). However, as a hard gate, `multi === minAcc` is also a **check-design artifact / too-strict shape proxy**: it fails because multi-hop greatly exceeds the paper's concession target (`0.8083` vs `0.528`), while the actual target miss is temporal. The meaningful fidelity gap to investigate is **temporal under target**, not “multi-hop is too good.”

Confidence: **medium-high** — function and numbers are exact; interpretation depends on whether T030 wants target reproduction or exact Table-1 rank shape.

### 5. FIDELITY-REPRODUCTION FLOOR

**Verdict: PARTIALLY-CONFIRMED.**

Quoted authority:

```text
AGENTS.md:66-70
Before pitting magma against hybrid, magma MUST first reproduce the paper's own number (LoCoMo Overall ~0.700 + its per-category wins) within tolerance on a faithful ingest.
```

Against paper targets:

| Category | Paper target | This run | Status |
|---|---:|---:|---|
| Overall | 0.700 | 0.7828 | meet/exceed |
| Multi-hop / cat1 | 0.528 concession | 0.8083 | exceed; not a paper win requirement |
| Temporal / cat2 | 0.650 | 0.5889 | **miss** |
| Open-domain / cat3 | 0.517 | 0.7611 | exceed |
| Single-hop / cat4 | 0.776 | 0.8111 | meet/exceed |
| Adversarial / cat5 | 0.742 | 0.9444 | meet/exceed |

Assessment: the floor is substantially closer and the **overall paper number is reproduced**, but full “Overall + per-category wins” is not fully certified because temporal is below target and category/ordering/scrambled controls are incomplete.

Confidence: **medium-high** — target comparison is straightforward; tolerance for one category miss is not defined in the quoted gate.

### 6. HONEST OVERALL VERDICT + FORK

**Verdict: CONFIRMED for fork (a): BAND-REPRODUCED, category+controls PENDING.**

Quoted harness behavior:

```ts
// scripts/locomo-judge-harness.ts:2724-2726
const bandPass = reproductionBand(agg.meanScore)
const categoryPatternPass = reproductionCategoryPattern(perCatAcc)
const verdict = bandPass && categoryPatternPass ? 'PARTIAL' : 'NOT_REPRODUCED'
```

```ts
// scripts/locomo-judge-harness.ts:2739-2748
overall: r4(agg.meanScore),
overall_ci95: r4(ci.ci),
full_context_overall: null,
...
ordering_pass: null,
substrate_pass: true,
scrambled_control: null,
```

Quoted result:

```json
docs/evidence/reproduction-gate-band-t027.RAW.md:19
"overall":0.7828,..."band_pass":true,"category_pattern_pass":false,"ordering_pass":null,"substrate_pass":true,"scrambled_control":null,..."verdict":"NOT_REPRODUCED"
```

Assessment: the auto-emitted `NOT_REPRODUCED` is expected from the current harness because category pattern is false and Increment-2 controls are unbuilt. It should not be treated as a fresh BLOCKED/starved null: the mechanism manifests and the band strongly passes. It also should not be promoted to full `REPRODUCED`: temporal misses the paper target, the category-pattern check needs repair/clarification, and ordering/scrambled controls are null.

Correct fork: **(a) BAND-REPRODUCED, category+controls PENDING → build Increment 2 (ordering-full-context arm + scrambled-graph control) and investigate/repair the category_pattern check before certifying REPRODUCED.** Specifically: preserve the honest band win, stop chasing “one more budget fix” for the overall number, and target the remaining blockers: temporal fidelity, category check semantics, and missing controls. **NO T033 comparison until T030 is fully REPRODUCED.**

Confidence: **high** — this follows directly from the result row and harness verdict logic.

## Overall judgment

This is real, honest progress: the T027 fix changed the mechanism from a structurally-inert/starved setup into a valid measured reproduction run, and the overall band now exceeds both the code gate and the paper's overall value (`0.7828 ± 0.0774`, n=90). The honest status is **not BLOCKED** and not full **REPRODUCED**. It is **BAND-REPRODUCED / T030 still pending** because temporal is below paper target, the category-pattern hard gate is partly a shape-proxy artifact, and ordering/scrambled controls are unbuilt.

Next step: implement Increment 2 controls and repair/clarify the category-pattern criterion around explicit paper targets (especially temporal) before any T033 hybrid-vs-MAGMA comparison.
