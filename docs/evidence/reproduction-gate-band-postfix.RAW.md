# T030 post-fix MAGMA reproduction raw evidence (producer)

Date: 2026-07-07. Producer only; final verdict file intentionally not written.

## Code diff summary

Commits:
- `8d45905 test(memory): expose causal admission eviction` (red-first tests)
- `0e4302e fix(memory): admit Eq5 causal traversal into magma context` (green fix)

Files/lines:
- `src/memory/adaptive-traversal.ts:140-145` documents Alg-1/Eq-5 final admission; `:176-190` tracks Eq-5 log-salience for anchors; `:221-233` records best transition salience; `:247-275` deletes the superseded pure-cosine slice and replaces it with min-anchor + Eq-5 salience admission.
- `test/unit/memory/adaptive-traversal.test.ts:314-342` red causal-admission test; `:344-376` zero-causal-weight negative control; `:591-618` T021 rewrite to minimum-anchor + augmentation.
- `docs/PRIOR_ART.md:62-66` adopt-vs-build entry.

`git diff --stat HEAD~2..HEAD`:
```text
docs/PRIOR_ART.md                           |  7 ++-
src/memory/adaptive-traversal.ts            | 58 ++++++++++++++++------
test/unit/memory/adaptive-traversal.test.ts | 74 +++++++++++++++++++++++++++--
3 files changed, 118 insertions(+), 21 deletions(-)
```

## Red-first fail row

Command: `npm test -- --run test/unit/memory/adaptive-traversal.test.ts -t "T030"`

```text
× adaptiveTraversalSearch — causal beam dimension (WS-2b write/read-split; faithful sims) > RED T030: admits a lower-cosine causal node for WHY when Eq-5 reaches it under tight topK 17ms
  → expected [ 1, 2, 3, 4, 5 ] to include 6
Test Files  1 failed (1)
Tests  1 failed | 1 passed | 18 skipped (20)
```

## Green validation

Targeted:
```text
✓ test/unit/memory/adaptive-traversal.test.ts (20 tests) 73ms
Test Files  1 passed (1)
Tests  20 passed (20)
```

Full unit:
```text
Test Files  402 passed (402)
Tests  6028 passed (6028)
```

Typecheck/lint/build:
```text
typecheck exit 0
lint exit 0
build exit 0
```

## PRIOR_ART adopt-vs-build entry

`docs/PRIOR_ART.md:62-66`:
```text
§C.6 — T030 MAGMA causal admission return ranking (2026-07-07): adopt MAGMA Algorithm 1 lines 22-23 + Eq. 5 + Stage-4 Eq. 7; build an SCNS boundary adapter that keeps a minimum hybrid-anchor floor, then fills by Eq.5 log-salience. Rejected pure query-cosine return (T030 inert magma bug) and pure cumulative beam return (old anchor-eviction bug). T021 semantics intentionally changed to augment-not-replace.
```

## Deterministic before/after

Before (from `docs/evidence/reproduction-gate-faithfulness.md`):
```text
hybrid       mean 147 tok  (Δ vs incumbent +0)
magma        mean 272 tok  (Δ vs incumbent +126)
retrieveContext chunkIds: 647,623,590,16,571
causal in final: 0
```

After command: `SCNS_JUDGE_MODE=arm-frontier-tokens ... npx tsx scripts/locomo-judge-harness.ts .copilot-scratch/locomo10.json`
```text
hybrid       mean 147 tok  (Δ vs incumbent +0)
magma        mean 275 tok  (Δ vs incumbent +129)
multihop-iter mean 149 tok  (Δ vs incumbent +2)
RESULTS_JSON: {"mode":"arm-frontier-tokens","preCheck":{"materialized":216,"persisted":108},"nItems":90,"arms":[{"name":"hybrid","meanTokO200k":147,"deltaVsIncumbent":0},{"name":"magma","meanTokO200k":275,"deltaVsIncumbent":129},{"name":"multihop-iter","meanTokO200k":149,"deltaVsIncumbent":2}],"incumbent":"hybrid"}
```

WHY item causal proof from `.copilot-scratch/causal-admission-probe.ts` on `conv-2.db`:
```json
{
  "why": "Why was Calvin inspired to start his journey to Japan?",
  "anchors": [647, 623, 590, 16, 571],
  "retrieveContextChunkIds": [630, 647, 623, 590, 16],
  "causalReachedIds": [578, 622, 639, 619, 630, 628, 594],
  "causalInRetrieve": [630],
  "anchorsRetained": 4
}
```

Interpretation: causal-in-final = YES (`630`), and anchors retained = 4/5. The probe's legacy `final by ... relevance-rerank` line is the old pure-cosine diagnostic mirror, not the post-fix `retrieveContext` return.

## Judged post-fix reproduction

Command used `.copilot-scratch/locomo10.json` instead of `/tmp/locomo10.json` because this runtime forbids `/tmp` file operations.

```text
MAGMA reproduction: overall=0.5744 ± 0.0947 (95% CI) n=90 dropped=0; band_pass=false; category_pattern_pass=false; verdict=NOT_REPRODUCED
```

Full `RESULTS_JSON.reproduction` block:
```json
{
  "overall": 0.5744,
  "overall_ci95": 0.0947,
  "full_context_overall": null,
  "perCategory": {
    "cat1": { "n": 18, "accuracy": 0.4611 },
    "cat2": { "n": 18, "accuracy": 0.4444 },
    "cat3": { "n": 18, "accuracy": 0.5167 },
    "cat4": { "n": 18, "accuracy": 0.45 },
    "cat5": { "n": 18, "accuracy": 1 }
  },
  "band_pass": false,
  "category_pattern_pass": false,
  "ordering_pass": null,
  "substrate_pass": true,
  "scrambled_control": null,
  "diagnostics": {
    "anchor_retention": 1,
    "anchor_retention_source": "T021 unit-test-proven",
    "mean_tokens_per_query": 275
  },
  "verdict": "NOT_REPRODUCED"
}
```

## Guards / ACP

Before live vault:
```text
mtime=1783256409 size=232488960
```

After live vault:
```text
mtime=1783256409 size=232488960
```

Harness guard rows:
```text
spawn guard: 180 ephemeral ACP process(es) spawned; still-alive 0; strays killed-by-pid 0; exit-signalled 180
ISO cleaned (zero-pollution): YES ✓
live vault mtime unchanged: YES ✓ (1783256409593.3137 → 1783256409593.3137)
```

ACP leak count: 0 still-alive / 0 strays. Broker PID on `:3456` was observed pre-run and not touched. No push performed.

## PROPOSED verdict

PROPOSED: valid-null / `NOT_REPRODUCED`. The T030 mechanism now manifests (magma differs from hybrid and admits causal-reached node `630` while retaining anchors), substrate passes, and mean tokens rose to 275. However, judged Overall is `0.5744 ± 0.0947`, below the `band_pass` threshold and below the paper band target (Overall 0.700; Adversarial 0.742; Single-Hop 0.776; Temporal 0.650; Multi-Hop 0.528), with `category_pattern_pass=false`. Therefore this is not a reproduction; it is an honest measured null after the inert-arm bug was fixed.
