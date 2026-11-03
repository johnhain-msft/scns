# T027 briefing-budget fix — deterministic manifestation (NO ACP)

Date: 2026-07-07 · Producer artifact (no judge/gen spawns). Confirms the T027 fix makes the magma arm
AUGMENT at paper scale BEFORE spending the ~1-2h judged run (handoff gate: "only if it manifests").

## What changed (commits on top of `b21cdec`)
- `91de730` feat(memory): serialize all Visited → Eq-7 token budget with anchor retention (T027)
- `a3a1879` feat(harness): budget magma Stage-4 to ~3.37k tokens (serialize-all-visited augment)

Mechanism: `TraversalOptions.returnBudget` (MAGMA path = beam budget) returns the whole Visited subgraph
(Alg 1 L22-23); Stage-4 `maxTokens` salience-token-budgets to ~3.37k (Eq. 7); anchors carry
`SearchResult.isAnchor` and are protected from elision (AnchorRetention=1.0).

## Guards
- Live vault `~/.scns/memory/vault.db` READ-ONLY: `mtime=1783256409 size=232488960` BEFORE and AFTER both runs.
- Broker `:3456`: observed LISTEN (pid 3539) before; untouched (deterministic modes open only snapshot copies).
- Isolated `SCNS_HOME=.copilot-scratch/scns-home-t027`. Snapshot probed via a COPY (pristine).

## Evidence 1 — arm-frontier-tokens (deterministic, real o200k tokens, NO spawns)
Command: `SCNS_JUDGE_MODE=arm-frontier-tokens SCNS_FRONTIER_SNAPSHOT=<snap> npx tsx
scripts/locomo-judge-harness.ts .copilot-scratch/locomo10.json` (held-out conv-48/49/50, 90 items).

```text
PRE-CHECK causal materialized=216 persisted=108 ⇒ beam has causal chains on ≥1 conv
  ── per-arm REAL o200k context tokens/query (incumbent 'hybrid' = 147) ──
  hybrid       mean 147 tok  (Δ vs incumbent +0)
  magma        mean 3454 tok  (Δ vs incumbent +3308)
  multihop-iter mean 149 tok  (Δ vs incumbent +2)
spawn guard: 0 ephemeral ACP process(es) spawned; still-alive 0; strays killed-by-pid 0; exit-signalled 0
ISO cleaned (zero-pollution): YES ✓
live vault mtime unchanged: YES ✓ (1783256409593.3137 → 1783256409593.3137)
```

**magma 272 (pre-fix, docs/evidence/reproduction-gate-faithfulness.md) → 3454 tok (post-fix)** — the briefing
now hits the paper's ≈3.37k (Table 3). multihop-iter unchanged (no synthesize ⇒ maxTokens inert), hybrid
unchanged (incumbent). This is the AUGMENT, not the topK=5 SWAP.

## Evidence 2 — chunk-level augment + anchor retention (conv-50 copy, one Q/category)
`.copilot-scratch/t027-augment-probe.ts` (throwaway) — hybrid vs magma retrieved chunk sets:

```text
[cat2] intent=WHEN    | hybrid=5 magma=60 | anchorsRetained=5/5 OK | augmented(+typed)=55 OK | <ref:> blocks=60 | chars=13040
[cat1] intent=DEFAULT | hybrid=5 magma=60 | anchorsRetained=5/5 OK | augmented(+typed)=55 OK | <ref:> blocks=60 | chars=9511
[cat3] intent=DEFAULT | hybrid=5 magma=60 | anchorsRetained=5/5 OK | augmented(+typed)=55 OK | <ref:> blocks=60 | chars=9080
[cat4] intent=DEFAULT | hybrid=5 magma=60 | anchorsRetained=5/5 OK | augmented(+typed)=55 OK | <ref:> blocks=60 | chars=12039
[cat5] intent=DEFAULT | hybrid=5 magma=60 | anchorsRetained=5/5 OK | augmented(+typed)=55 OK | <ref:> blocks=60 | chars=12554
SUMMARY: anchorRetention(all)=PASS | augment≥2(all)=PASS
```

Every hybrid top-5 anchor is retained in the 60-node magma briefing (magma∩hybrid = the full hybrid set) and
55 typed-edge-reached nodes are ADDED on top — the graph augments the anchors, provenance-scaffolded by
Stage-4 (60 `<ref:>` blocks). The subgraph (~60 nodes ≈ 2.3–3.3k tok) fits under the 3.4k budget, so it
augments without collapsing anchors.

## Verdict on manifestation
The mechanism under test now MANIFESTS deterministically (positive control): magma ≠ hybrid, augments with
multiple typed nodes, anchors retained, tokens at paper scale. Cleared to spend the judged `repro-accuracy`
run to obtain the honest post-fix answer-accuracy number.

## Unit coverage (red-first, green)
`test/unit/memory/adaptive-traversal.test.ts` (returnBudget serialize-all-visited + NEG + back-compat) and
`test/unit/memory/retrieval-context.test.ts` (Stage-4 token budget + anchor protection + NEG + integration).
Full unit suite `6035 passed` (6028 baseline + 7); typecheck/lint(0 err)/build exit 0.
