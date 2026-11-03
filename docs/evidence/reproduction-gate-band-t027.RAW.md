# T027 post-fix MAGMA reproduction — judged repro-accuracy RAW (producer)

Date: 2026-07-07 · Producer raw measurement (NOT the independent verdict — see the grader artifact).
Mode: `SCNS_JUDGE_MODE=repro-accuracy` (MAGMA-only; no hybrid/comparative arms). Reused snapshot (no re-ingest).

## Command
```sh
SCNS_HOME=.copilot-scratch/scns-home-t027-judged \
SCNS_EMBED_WORKER_PATH=$PWD/dist/memory/embedding-worker.js \
SCNS_JUDGE_MODE=repro-accuracy \
SCNS_FRONTIER_SNAPSHOT=$PWD/.copilot-scratch/t030-20260706-203640/frontier/snap \
SCNS_LLM_JUDGE=1 SCNS_QA_GENERATOR=1 \
npx tsx scripts/locomo-judge-harness.ts .copilot-scratch/locomo10.json
```
Running magma config (log): `{"intentRouting":false,"traverse":true,"traversalOptions":{"maxDepth":5,"budget":200},"synthesize":true,"maxTokens":3400}` — the T027 briefing budget is IN the measured path.

## RESULTS_JSON (verbatim)
```json
{"mode":"repro-accuracy","snapshot":".../t030-20260706-203640/frontier/snap","sampleIds":["conv-48","conv-49","conv-50"],"nItems":90,"byCategory":"cat1=18 cat2=18 cat3=18 cat4=18 cat5=18","reproduction":{"overall":0.7828,"overall_ci95":0.0774,"full_context_overall":null,"perCategory":{"cat1":{"n":18,"accuracy":0.8083},"cat2":{"n":18,"accuracy":0.5889},"cat3":{"n":18,"accuracy":0.7611},"cat4":{"n":18,"accuracy":0.8111},"cat5":{"n":18,"accuracy":0.9444}},"band_pass":true,"category_pattern_pass":false,"ordering_pass":null,"substrate_pass":true,"scrambled_control":null,"diagnostics":{"anchor_retention":1,"anchor_retention_source":"T021 unit-test-proven","mean_tokens_per_query":3454},"verdict":"NOT_REPRODUCED"}}
```
Summary line:
```text
MAGMA reproduction: overall=0.7828 ± 0.0774 (95% CI) n=90 dropped=0; band_pass=true; category_pattern_pass=false; verdict=NOT_REPRODUCED
```

## Delta vs the two prior judged runs (same held-out conv-48/49/50, n=90)
| Run | overall | mean_tokens | band_pass | verdict |
|---|---:|---:|:--:|---|
| pre-fix (reproduction-gate-band.RAW.md) | 0.5911 ± 0.0949 | 272 | false | (graded BLOCKED) |
| causal-admission-only (reproduction-gate-band-postfix.RAW.md) | 0.5744 ± 0.0947 | 275 | false | NOT_REPRODUCED |
| **T027 briefing budget (this run)** | **0.7828 ± 0.0774** | **3454** | **true** | NOT_REPRODUCED |

Per-category (this run): cat1=0.8083 cat2=0.5889 cat3=0.7611 cat4=0.8111 cat5=0.9444
(pre-fix: cat1=0.5611 cat2=0.4444 cat3=0.5556 cat4=0.3944 cat5=1.0 — the previously-worst cat4 rose 0.3944→0.8111.)

Paper band targets (App C.3): Overall 0.700 · Single-Hop 0.776 · Temporal 0.650 · Adversarial 0.742 · Multi-Hop 0.528 (concession).

## Why the gate still says NOT_REPRODUCED (honest, producer read)
- `band_pass=true` — overall 0.7828 clears the 0.60 band; it is also at/above the paper's 0.700, but only
  thinly (95% CI [0.7054, 0.8602] — the CI-lower clears 0.700 by just +0.005 ⇒ an honest "≈ at/above", not a
  firm beat).
- `category_pattern_pass=false` — the per-category SHAPE does not match the expected MAGMA pattern (grader to
  assess which categories/relations fail and whether that is a real fidelity gap or a check-design issue).
- `ordering_pass=null`, `scrambled_control=null` — Increment-2 controls are NOT BUILT, so the mode can only
  ever emit NOT_REPRODUCED / BLOCKED / PARTIAL — never REPRODUCED on its own (handoff note).

This is NOT a starved/BLOCKED null: the mechanism MANIFESTS (272→3454 tok; conv-50 probe augment+anchor-
retention PASS, docs/evidence/t027-briefing-budget-manifestation.md), so the setup could have shown a win and
DID move overall by +0.19 — a VALID measured result, not INCONCLUSIVE. The strategic fork is a producer-vs-
grader judgment recorded separately.

## Guards (asserted before + after)
```text
live vault ~/.scns/memory/vault.db: mtime=1783256409 size=232488960 (BEFORE and AFTER — unchanged)
live vault mtime unchanged: YES ✓ (1783256409593.3137 → 1783256409593.3137)
broker :3456: pid 3539 LISTEN (BEFORE and AFTER — untouched)
spawn guard: 180 ephemeral ACP process(es) spawned; still-alive 0; strays killed-by-pid 0; exit-signalled 180
ACP leak count: spawned=180, alive-after=0
ISO cleaned (zero-pollution): YES ✓  (SCNS_HOME=.copilot-scratch/scns-home-t027-judged empty after)
copilot/acp procs: 6 baseline → 6 after (no leak)
NO push. Local-only. Snapshot reused (no re-ingest).
```
