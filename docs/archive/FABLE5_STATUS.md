# FABLE5 Run Status — SCNS spec-kit feature 001-learning-memory-loop (branch `feature/fable-5-implementation`)

> Working contract: commit after every green increment; this file is updated at each checkpoint.
> Authoritative oracles: specs/001-learning-memory-loop/ (spec/plan/tasks/research/contracts/quickstart)
> + .specify/memory/constitution.md. Verdict metric = blind LLM-judge ANSWER accuracy + o200k tokens;
> NEVER recall. Judge PINNED claude-opus-4.8 (σ=0.0267 measured 2026-07-03 under it).

## 2026-07-06 — spec-kit implement run (Fable 5): 64/64 tasks done

All phases executed per specs/001-learning-memory-loop/tasks.md (marked [X] there with per-task
notes). Full evidence: docs/evidence/dod-001-learning-memory-loop.md. Highlights:

- Setup/Foundational: isolation helper (read-only-vault guard), first-class propensity+target +
  (intent,target) index (additive migration), vault-invariant locks.
- US1: SCNS_NARRATIVE_SYNTHESIS / SCNS_MULTIHOP_ITER / SCNS_EDGE_WEIGHTS levers (default-OFF,
  byte-identical); literal Eq-5 closed-form-verified (the surrogate was ALREADY deleted — T058
  satisfied); judge blindness locked; harness axis-locks drove moving normalizeGold/mean/dia_id
  into locomo-corpus; negControlN vacuous-pass hole closed at gateVerdict + both call sites;
  LongMemEval harness BUILT (lib 13 tests + CLI, flags-off ⇒ 0 spawns).
- US2: live seven-field record per attempt; {results, experienceId} returned; per-attempt verdict
  binding first-signal-wins; cues used/edited/re-asked; query embedding captured at zero cost;
  live integration green against the real dist/cli.js.
- US3: docs/PRIOR_ART.md authored + tripwire-tested; dr-estimator.ts BUILT (Dudík 2011,
  hand-computed); EVIDENCE ARBITER: routing-policy.ts (commitRoutingPolicy refuses uncertified
  evidence + guardrail paths; reads fail closed) + harness dominance-across-λ promotion (SHADOW
  during bring-up: SCNS_ARBITER_ENACT + SCNS_ARBITER_DET_RUNS); live shadowed exploration proven
  (μ=0.475 shadow rows; 6/6 served rows hybrid).
- US4: similar-episode.ts BUILT ((intent,target)-keyed KNN, collision-trap-proof) + router
  episodeAdvice; humanOutcomePromotion (Welch LB, SC-008); magma-reinforced challenger arm behind
  SCNS_REINFORCED_ARM; reward report + DR + promotion verdict; LIVE: vault-copy weight 1.0→1.19,
  live vault REFUSED exit 2.
- US5: outward/ BUILT (ask_human, consult_source) behind the UNCHANGED kernel; MCP tools
  registered behind the threaded kernel instance; async humanPermission path in acp-client (ACP
  cancel contract honored); SC-010 table proven on the REAL shipped (empty) allowlist.
- Quality: typecheck 0 / lint 0 errors / unit 5958 passed (398 files) / integration 397 passed.

## T020 comparative gate — COMPLETE: MEASURED NULL (hybrid stands)

- Held-out powered judged gate (conv-44/conv-47, 60/60 scored, 0 dropped, judge pinned opus-4.8,
  σ=0.0267, 360 spawns/0 strays, vault unchanged): hybrid acc=0.4475±0.1183 @137 tok ≫ magma
  0.2492 @281 and multihop-iter 0.2483 @153. No candidate (nor the C3 router) certifies at ANY
  swept λ; ARBITER_JSON decision=hold-incumbent, enacted=false — 0 flips on a null (SC-006/SC-012
  demonstrated live). Consistent with the prior offline null (b659577). All levers stay
  default-OFF. Full rows: docs/evidence/us1-cert-run-2026-07-06.log + dod record.
- Env notes for future runs: tsx needs SCNS_EMBED_WORKER_PATH=$PWD/dist/memory/embedding-worker.js;
  cert-ingest needs SCNS_CONVERSATION_EVENTS=1 SCNS_DREAM_CAUSAL_ACP=1; MODE is env
  SCNS_JUDGE_MODE (not argv).

## Deletion-gate outcomes (Constitution IV)

- T058 surrogate: already deleted in prior work — nothing remained.
- T059 settleHumanOutcomeForEntity: KEPT — still serves suggest/outcome-writer.ts:181 (proposal
  outcomes carry no attempt id); delete when a per-suggestion experience linkage lands.

## Guards (verified 2026-07-06T05:05Z)

Live vault mtime/size 1783256409/232488960 byte-identical; broker :3456 untouched; 11 commits all
UNPUSHED (no git push); kernel + allowlist untouched since WS-0 (0f15fff); all levers default-OFF,
no committed routing policy, arbiter in shadow; kill-by-exact-PID only.

## Exact next step

Feature complete (64/64). Candidate follow-ups, in order: (1) a judged LongMemEval run
(scripts/longmemeval-judge-harness.ts smoke → controls → judge) as the second held-out corpus —
the LoCoMo null says hybrid wins there; LME's longer haystacks are the graph arms' best remaining
case; (2) accumulate settled human outcomes live, then re-run the reward report + the
magma-reinforced challenger gate (SCNS_REINFORCED_ARM=1 SCNS_EXPERIENCE_DB=...); (3) delete
settleHumanOutcomeForEntity once a per-suggestion experience linkage lands.

## Pending/failing tests

(none — full suites green)
