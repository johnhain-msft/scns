# T030 reproduction/health gate — RAW producer evidence

## Scope
Producer raw measurement for the T030 substrate density floor only. This is not the independent final verdict.

## Held-out ids
- `conv-48,conv-49,conv-50`
- Freshness justification: these held-out ids are not any of the disallowed/tuning cert ids `conv-26/30/41/42/43/44/47`.

## Guard baseline BEFORE
```text
mtime=1783256409 size=232488960
```

## Exact env/command used
Note: the first launch with only the requested env exited immediately with `generator/judge default-OFF — set SCNS_LLM_JUDGE=1 SCNS_QA_GENERATOR=1 to run real spawns (no spawn performed)`. The successful relaunch used isolated project-local scratch directories (to avoid touching the live vault) and added the required real-spawn toggles:

```bash
cd $HOME/Coding_Projects/scns_root/scns
set -e
stat -f 'mtime=%m size=%z' ~/.scns/memory/vault.db
RUN_ID=t030-20260706-203640
SCNS_HOME_DIR="$PWD/.copilot-scratch/$RUN_ID/scns-home"
FRONTIER_DIR="$PWD/.copilot-scratch/$RUN_ID/frontier"
mkdir -p "$SCNS_HOME_DIR" "$FRONTIER_DIR" docs/evidence
export SCNS_HOME="$SCNS_HOME_DIR"
export SCNS_EMBED_WORKER_PATH="$PWD/dist/memory/embedding-worker.js"
export SCNS_CONVERSATION_EVENTS=1
export SCNS_DREAM_CAUSAL_ACP=1
export SCNS_JUDGE_MODE=cert-ingest
export SCNS_CERT_SAMPLE_IDS=conv-48,conv-49,conv-50
export SCNS_FRONTIER_SNAPSHOT="$FRONTIER_DIR/snap"
export SCNS_M2_MIN_CONFIDENCE=0.5
export SCNS_LLM_JUDGE=1
export SCNS_QA_GENERATOR=1
LOG=$HOME/Coding_Projects/scns_root/scns/docs/evidence/reproduction-gate-cert-ingest.log
nohup npx tsx scripts/locomo-judge-harness.ts /tmp/locomo10.json > "$LOG" 2>&1 &
PID=$!
echo "PID=$PID"
```

Recorded PID: `24130`.

## Per-conv ingest lines
```text
  [conv-48] segmented=136 dated=30 eventCand=134 chunkCand=200 persisted=16 materialized=32
  [conv-49] segmented=114 dated=25 eventCand=112 chunkCand=200 persisted=42 materialized=84
  [conv-50] segmented=127 dated=30 eventCand=125 chunkCand=200 persisted=50 materialized=100
```

## PRE-CHECK line
```text
  materialized chunk→chunk causal memory_edges = 216 (persisted memory_causal = 108); perConv=[32,84,100] min=32 perWhyItem=2.40 floor={perConv:8,perWhyItem:0.5} ⇒ OK — the beam has a dense-enough causal substrate to walk ✓
```

## RESULTS_JSON block
```text
RESULTS_JSON: {"mode":"cert-ingest","heldOut":true,"snapshot":"$HOME/Coding_Projects/scns_root/scns/.copilot-scratch/t030-20260706-203640/frontier/snap","dev":3,"nItems":90,"byCategory":"cat1=18 cat2=18 cat3=18 cat4=18 cat5=18","sampleIds":["conv-48","conv-49","conv-50"],"materialized":[32,84,100],"persisted":[16,42,50],"totalMaterialized":216,"totalPersisted":108,"maxCandidates":200,"causalAttemptMs":300000,"preCheckOk":true,"substrate":{"perConv":[32,84,100],"perConvMin":32,"meanPerConv":72,"perWhyItem":2.4,"floor":{"perConv":8,"perWhyItem":0.5},"preCheckOk":true}}
```

## Guard baseline AFTER
```text
mtime=1783256409 size=232488960
```

## ACP leak count
- ACP client initialized/spawned count observed in log: `115`
- ACP process exited count observed in log: `115`
- Alive-after ACP/copilot processes attributable to this run after completion: `0`
- ACP leak count: `spawned=115, alive-after=0`

## PROPOSED verdict
PROPOSED verdict: `PROCEED-TO-BAND` for the substrate density floor only, because `preCheckOk:true` and the measured substrate exceeds all floor terms: per-conv materialized `[32,84,100]`, `perConvMin=32 >= 8`, and `perWhyItem=2.4 >= 0.5`. The band/scrambled/category legs still need to run and be independently graded. Monotonicity note: `materialized` is derived from post-confidence-gate `persisted`; at `SCNS_M2_MIN_CONFIDENCE=0.5` this is the ceiling for materialization relative to higher thresholds, so no higher threshold is needed for the density-floor precondition.
