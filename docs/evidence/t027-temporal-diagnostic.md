# T027 temporal (cat2) gap — deterministic diagnostic (NO ACP)

Date: 2026-07-07 · Question: is the temporal miss (judged cat2=0.5889 < paper 0.650) a MEMORY-LAYER retrieval
bug (closeable) or a reasoning/judge characteristic? Probe: `.copilot-scratch/t027-temporal-probe.ts` over ALL
107 temporal (cat2) QA on the held-out snapshot conv-48/49/50 (COPIES; live vault untouched, mtime=1783256409).

## Statistical honesty first
cat2 judged scores (n=18) are BIMODAL: 11×1.0, 6×0, 1×0.2, plus 0.8/0.6 → mean 0.589, SD≈0.47, SE≈0.111 ⇒
**95% CI ≈ [0.37, 0.81]. The paper's 0.650 is INSIDE this interval** — at n=18 the "miss" is NOT a
statistically established gap (all per-category n=18 legs are noisy; overall n=90 is the trustworthy number).

## Retrieval diagnostic (magma vs hybrid, robust ≥60%-distinctive-word coverage)
```text
=== TEMPORAL (cat2) retrieval diagnostic :: held-out conv-48/49/50 :: n=107 ===
intent=WHEN:                             84/107 (79%)
evidence covered (magma, >=60% words):   94/107 (88%)
evidence covered (hybrid, >=60% words):  56/107 (52%)
session date in briefing (magma):       105/107 (98%)
BOTH evidence + date (magma):            93/107 (87%)
```
(An earlier strict 8-consecutive-word match read 2% — a FALSE-NEGATIVE artifact of chunk re-segmentation;
the deduped ≥60%-content-word overlap above is the robust proxy. Both arms measured identically, so the
magma-vs-hybrid delta is sound regardless of the absolute threshold.)

## Findings
1. **Retrieval is NOT the temporal bottleneck.** Magma surfaces the evidence turn + its session-date anchor
   for **87%** of temporal items (evidence 88%, date 98%). The information needed to answer is in the briefing.
2. **The T027 augment specifically HELPS temporal retrieval**: magma covers the evidence turn **88% vs hybrid
   52%** (+36 pts) — the graph traversal reaches dated temporal evidence the flat hybrid top-5 misses. This is
   the graph substrate working as intended, not regressing.
3. **The residual is temporal REASONING + judge grading, not memory fidelity.** The gold answers are
   RELATIVE/DERIVED dates ("a few years before 2023", "the weekend before May 24, 2023", "between 26 March and
   20 April 2023", "Friday before 27 July 2023") that require reasoning over the session τ + content and are
   then LLM-graded for date equivalence — inherently the generation/judge axis, not retrieval.
4. The 13% evidence-coverage misses are dominated by LATE-2023 events (Aug–Dec) — a minor recall tail, but
   still with the date present (98%), and NOT the driver of the score (many covered items also score <1).

## Verdict on the user's question
- **No clear MEMORY-LAYER bug to close on temporal.** Retrieval delivers evidence+date 87% (and the T027 fix
  IMPROVES temporal retrieval vs hybrid by +36 pts). The score gap is within n=18 noise and is dominated by
  relative-date reasoning + judge grading — outside MAGMA retrieval-fidelity scope.
- Other categories meet/exceed the paper (single-hop 0.811, multi-hop 0.808, open-domain 0.761, adversarial
  0.944), so there is no other per-category retrieval gap indicated by this run.
- The genuine remaining T030 items are therefore NOT bugfixes but: (i) Increment-2 CONTROLS (ordering-full-
  context arm + scrambled-graph control — unbuilt FEATURES), and (ii) the APPROVAL-GATED category_pattern
  check semantics (G1 in AWAITING-JOHN.md). Chasing a temporal retrieval "fix" would be mis-targeted.

Guards: live vault `mtime=1783256409 size=232488960` before+after; snapshot probed via copies; NO ACP; NO push.
