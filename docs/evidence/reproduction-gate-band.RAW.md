# T030 reproduction gate — magma-only band/category RAW producer evidence

## Scope
Producer raw measurement for Increment 1 only: MAGMA-only judged reproduction read over the existing held-out snapshot. This is not the independent final verdict and does not write `docs/evidence/reproduction-gate-run.md`.

## Code added
- `scripts/locomo-judge-lib.ts`: added pure `reproductionBand(overall)` with inclusive `0.60` boundary and `reproductionCategoryPattern(perCatAcc)` for the Table-1 pattern leg.
- `scripts/locomo-judge-harness.ts`: added `SCNS_JUDGE_MODE=repro-accuracy`, reopening `SCNS_FRONTIER_SNAPSHOT`, binding native LoCoMo QA items, re-running the substrate pre-check, scoring only the faithful magma config `{intentRouting:false,traverse:true,traversalOptions:{maxDepth:5,budget:200},synthesize:true}`, aggregating overall/per-category accuracy, and emitting the reproduction `RESULTS_JSON` block. The harness ISO cwd is project-local under `.copilot-scratch/` for this environment.
- `test/unit/scripts/locomo-judge-harness.test.ts`: added red-first unit tests for the reproduction band boundary and category-pattern positive/negative cases.

Local commits:
```text
863120b test: add repro accuracy gates red
2e9693b feat: add magma repro accuracy gate
```

## Validation
```text
Test Files  402 passed (402)
Tests  6026 passed (6026)
```

```text
> scns@0.1.0 typecheck
> tsc --noEmit

TYPECHECK_EXIT=0
```

Targeted red-first row before implementation:
```text
FAIL  test/unit/scripts/locomo-judge-harness.test.ts > T030 — magma-only reproduction band + Table-1 category pattern > band boundary is inclusive at 0.60
TypeError: (0 , reproductionBand) is not a function
```

## Guards
BEFORE:
```text
mtime=1783256409 size=232488960
node    64889 <user>     22u  IPv6 0x96b40449b36095b1      0t0  TCP *:3456 (LISTEN)
```

AFTER:
```text
mtime=1783256409 size=232488960
node    64889 <user>     22u  IPv6 0x96b40449b36095b1      0t0  TCP *:3456 (LISTEN)
```

Guard result: BEFORE == AFTER for live vault mtime/size. Broker PID on `:3456` remained `64889` and was not touched.

## De-risk run
Command used:
```bash
cd $HOME/Coding_Projects/scns_root/scns
mkdir -p .copilot-scratch/t030-repro-accuracy-derisk/scns-home docs/evidence
SCNS_HOME="$PWD/.copilot-scratch/t030-repro-accuracy-derisk/scns-home" \
SCNS_EMBED_WORKER_PATH="$PWD/dist/memory/embedding-worker.js" \
SCNS_JUDGE_MODE=repro-accuracy \
SCNS_FRONTIER_SNAPSHOT="$PWD/.copilot-scratch/t030-20260706-203640/frontier/snap" \
SCNS_LLM_JUDGE=1 \
SCNS_QA_GENERATOR=1 \
SCNS_ARM_N_PER_CAT=1 \
npx tsx scripts/locomo-judge-harness.ts /tmp/locomo10.json > docs/evidence/reproduction-gate-band.derisk.log 2>&1
```

De-risk aggregate lines:
```text
cat1: n=3 meanScore=0.7333
cat2: n=3 meanScore=0
cat3: n=3 meanScore=0.6
cat4: n=3 meanScore=0
cat5: n=3 meanScore=1
MAGMA reproduction: overall=0.4667 ± 0.2409 (95% CI) n=15 dropped=0; band_pass=false; category_pattern_pass=false; verdict=NOT_REPRODUCED
spawn guard: 30 ephemeral ACP process(es) spawned; still-alive 0; strays killed-by-pid 0; exit-signalled 30
live vault mtime unchanged: YES ✓ (1783256409593.3137 → 1783256409593.3137)
```

De-risk `RESULTS_JSON.reproduction`:
```json
{"overall":0.4667,"overall_ci95":0.2409,"full_context_overall":null,"perCategory":{"cat1":{"n":3,"accuracy":0.7333},"cat2":{"n":3,"accuracy":0},"cat3":{"n":3,"accuracy":0.6},"cat4":{"n":3,"accuracy":0},"cat5":{"n":3,"accuracy":1}},"band_pass":false,"category_pattern_pass":false,"ordering_pass":null,"substrate_pass":true,"scrambled_control":null,"diagnostics":{"anchor_retention":1,"anchor_retention_source":"T021 unit-test-proven","mean_tokens_per_query":288},"verdict":"NOT_REPRODUCED"}
```

## Full det×1 run
Full log path: `docs/evidence/reproduction-gate-band.log` (un-truncated).

Command used:
```bash
cd $HOME/Coding_Projects/scns_root/scns
mkdir -p .copilot-scratch/t030-repro-accuracy/scns-home docs/evidence
export SCNS_HOME="$PWD/.copilot-scratch/t030-repro-accuracy/scns-home"
export SCNS_EMBED_WORKER_PATH="$PWD/dist/memory/embedding-worker.js"
export SCNS_JUDGE_MODE=repro-accuracy
export SCNS_FRONTIER_SNAPSHOT="$PWD/.copilot-scratch/t030-20260706-203640/frontier/snap"
export SCNS_LLM_JUDGE=1
export SCNS_QA_GENERATOR=1
LOG=docs/evidence/reproduction-gate-band.log
nohup npx tsx scripts/locomo-judge-harness.ts /tmp/locomo10.json > "$LOG" 2>&1 &
```

Per-category aggregate lines:
```text
cat1: n=18 meanScore=0.5611
cat2: n=18 meanScore=0.4444
cat3: n=18 meanScore=0.5556
cat4: n=18 meanScore=0.3944
cat5: n=18 meanScore=1
MAGMA reproduction: overall=0.5911 ± 0.0949 (95% CI) n=90 dropped=0; band_pass=false; category_pattern_pass=false; verdict=NOT_REPRODUCED
```

Full `RESULTS_JSON.reproduction` block:
```json
{"overall":0.5911,"overall_ci95":0.0949,"full_context_overall":null,"perCategory":{"cat1":{"n":18,"accuracy":0.5611},"cat2":{"n":18,"accuracy":0.4444},"cat3":{"n":18,"accuracy":0.5556},"cat4":{"n":18,"accuracy":0.3944},"cat5":{"n":18,"accuracy":1}},"band_pass":false,"category_pattern_pass":false,"ordering_pass":null,"substrate_pass":true,"scrambled_control":null,"diagnostics":{"anchor_retention":1,"anchor_retention_source":"T021 unit-test-proven","mean_tokens_per_query":272},"verdict":"NOT_REPRODUCED"}
```

No det×2 run was launched because det×1 `band_pass=false` (`overall=0.5911 < 0.60`).

## ACP leak count
```text
spawn guard: 180 ephemeral ACP process(es) spawned; still-alive 0; strays killed-by-pid 0; exit-signalled 180
ACP leak count: spawned=180, alive-after=0
```

## PROPOSED verdict
PROPOSED verdict: `NOT_REPRODUCED`. The MAGMA-only reproduction score was `overall=0.5911 ± 0.0949`, below the reproduction band threshold `0.60` and below the paper reference Overall `0.700`. The category pattern also failed: cat5/adversarial was high (`1.0000`) but cat4/single-hop was low (`0.3944`) and cat1/multi-hop (`0.5611`) was not the bottom category (cat4 and cat2 were lower), diverging from the paper pattern Adversarial `0.742`, Single-Hop `0.776`, Temporal `0.650`, Multi-Hop `0.528`. Ordering and scrambled controls were intentionally unmeasured in this increment (`null`), so even a band+pattern pass would have been `PARTIAL`, never `REPRODUCED`.
