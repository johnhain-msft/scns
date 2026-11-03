# Definition-of-Done evidence — specs/001-learning-memory-loop (2026-07-06)

Quoted live evidence per quickstart scenario (Constitution I–II: every claim carries its output row;
nulls and in-flight work reported plainly, never reframed).

## Toolchain (T001/T063)

- `npm run build` clean (dist/cli.js present) · `npm run typecheck` 0 errors · `npm run lint` 0 errors
  (451 pre-existing warnings).
- Full suites: `Test Files 398 passed (398) / Tests 5958 passed (5958)` (unit) and
  `Test Files 32 passed | 1 skipped / Tests 397 passed | 1 skipped` (integration; the skip is the
  env-gated launchctl bootout test).

## The ruler (T004)

- σ = **0.0267**, MEASURED 2026-07-03 via harness variance mode under the PINNED judge
  `claude-opus-4.8` (`locomo-judge-harness.ts:208`); `nToResolveDelta(0.04, σ) = 4`/arm. Every judged
  gate this feature pins `SCNS_JUDGE_MODEL=claude-opus-4.8 SCNS_JUDGE_SIGMA=0.0267`; σ must be
  re-measured before trusting any verdict under a different judge model.

## Scenario 1 — answer proven on the right axis (US1)

- Fidelity gate (unit, red-first): 100% `<ref:id>` provenance incl. elided nodes; Eq-7 ordering
  (WHY topo / WHEN τ-asc); budgeted briefing ≪ full join; literal Eq-5 closed-form equal to 10dp
  with and without the edge-weight readout. Default-OFF byte-identical negative controls pass.
- Live smoke (2026-07-06, pinned judge): `RESULTS_JSON: {"mode":"smoke","genAnswer":"Paris",
  "genError":false,"posScore":1,"negScore":0,"plumbingOk":true}` — 3 spawns / 0 strays, vault
  mtime unchanged.
- Live controls (2026-07-06, pinned judge): `RESULTS_JSON: {"mode":"controls","posMean":1,
  "negMean":0,"separation":1,"pass":true,"nPos":10,"nNeg":10,"posDropped":0,"negDropped":0,...}`
  — separation 1.0 ≫ σ, vault unchanged (full log: docs/evidence/us1-cert-run-2026-07-06.log).
- Comparative gate: **COMPLETE — MEASURED NULL (the incumbent hybrid stands).** Cert-ingest of the
  held-out {conv-44, conv-47} snapshot succeeded (`RESULTS_JSON: {"mode":"cert-ingest",
  "heldOut":true,...,"nItems":60,"byCategory":"cat1=12 cat2=12 cat3=12 cat4=12 cat5=12",
  "preCheckOk":true}`). The judged gate ran POWERED and HELD-OUT (`confirmatoryOnly:false`,
  60/60 scored, 0 dropped, judge pinned claude-opus-4.8, σ=0.0267, 360 ACP spawns / 0 strays,
  vault unchanged). Quoted per-arm rows:

  | arm | accuracy | ±CI95 | o200k tokens |
  |---|---|---|---|
  | **hybrid (incumbent)** | **0.4475** | 0.1183 | **137** |
  | magma | 0.2492 | 0.1063 | 281 |
  | multihop-iter | 0.2483 | 0.1069 | 153 |

  `VERDICT: no candidate arm certifies a win vs the incumbent at any swept λ ⇒ measured NULL
  (incumbent hybrid stands)` — every candidate (and the C3 router) posted a NEGATIVE value delta at
  every λ ∈ {0, 0.05, 0.1, 0.25, 0.5, 1.0}; per-item wins at λ=0: hybrid 53 / magma 5 /
  multihop-iter 2. `ARBITER_JSON: {"decision":"hold-incumbent","enacted":false,"dominantArm":null,
  ...}` — the evidence arbiter held the incumbent and wrote NOTHING (0 flips on a null, SC-006/
  SC-012 demonstrated live). Deterministic token axis: hybrid 137 vs magma 281 (+144) — hybrid wins
  BOTH axes on this corpus. This null is consistent with the prior offline evaluator null
  (commit b659577) and is reported plainly per FR-006: on LoCoMo held-out, the graph arms lose to
  plain hybrid on answer accuracy AND cost; every lever therefore stays default-OFF.
- LongMemEval go-live harness (T019): built + structurally locked; flags-off dry run exits 0 with
  zero spawns. A judged LME run is a follow-up gate before any output-changing flip.

## Scenario 2 — every retrieval experience recorded (US2)

- Live integration (real `dist/cli.js`, ephemeral port, HOME sandboxed): one seven-field row per
  attempt under the RETURNED `experienceId`; per-attempt verdict binding (same-topic sibling stays
  NULL — 0% topic-only); vault mtime/size unchanged by searching; fail-safe negative (unopenable
  experience.db ⇒ answers still serve, no fabricated id). 2/2 green.

## Scenario 3 — right strategy per prompt, on measured evidence (US3)

- Prior-art bibliography exists in-repo (docs/PRIOR_ART.md) and is cited by the design (tripwire
  suite). Default = hybrid; commit-gate scenarios prove a >σ win certifies, a tie refuses, and a
  neg-control regression is BLOCKED (real pairedValueDelta→hcopeLowerBound→gateVerdict pipeline).
- Live shadowed exploration (integration, real broker, ε=0.95): shadow rows logged at
  μ=ε/|arms|=0.475; **6/6 served rows stayed hybrid** — the production answer never followed the
  explored arm.
- The evidence arbiter runs SHADOW during bring-up; enactment requires certified evidence to pass
  `commitRoutingPolicy` (LB>0, controls measured+passing, σ, det×2, ≤cost) — uncertified or
  guardrail-targeting commits are refused with nothing written.

## Scenario 4 — learn from accept-vs-waste (US4)

- Live reinforce run on a vault COPY: `RESULTS_JSON: {"mode":"reinforce-edges",...,"rowsApplied":1,
  "edgesTouched":1,"decayTouched":1,...}` — edge weight 1.0 → **1.19**, idempotency log row present.
- NEGATIVE control (live): `REFUSED: $HOME/.scns/memory/vault.db is the LIVE vault …`
  exit 2.
- Been-here-before: collision trap structurally impossible (episode-key pre-filter); unsettled
  priors never bias; router reuses/avoids per advice (15/15).
- Learned-controller promotion: `humanOutcomePromotion` — hand-computed Welch LB (0.3260 case)
  promotes; ties/thin support refuse honestly. Live reward report quoted DR[magma]=0.92 vs
  DR[hybrid]=0.32 with an honest no-proposal at n=5.

## Scenario 5 — operate outwardly, safely (US5)

- Integration suite (REAL shipped allowlist — proven empty ⇒ deny-all, loader fails closed):
  ask_human ALLOWED + audited with zero egress/spend; off-list consult REFUSED + audited with the
  fetch never firing; spend REFUSED regardless of destination; kernel/allowlist diffs REFUSED
  (arbiter parser + the automated evidence arbiter even with certified evidence);
  `verifyAuditChain()` intact across all allows AND denies; the allowlist file's mtime/size never
  moved. 5/5 green.

## Guardrail audit (T064, 2026-07-06T05:05Z)

- Live vault: `mtime=1783256409 size=232488960` — byte-identical to the session-start snapshot.
- Broker :3456: untouched, still listening (node 7524).
- 11 feature commits, ALL unpushed — no `git push` occurred.
- `config/safety-allowlist.json` + `src/broker/services/safety-kernel/**`: last touched by the
  original WS-0 commit (0f15fff) — never written by this feature or any automated path.
- No production default flip: every lever default-OFF; no committed routing policy exists; the
  arbiter is in shadow mode.
- Process hygiene: kill-by-exact-PID only (integration harness + ACP spawner); ACP baseline 0
  outside the deliberately-running cert-ingest background job.

## Deletion gates (T058/T059)

- T058 (`us*ew*decay` surrogate): **already deleted in prior work** — the beam computes ONLY the
  literal Eq-5 (closed-form-verified). Nothing to delete; no parallel implementation exists.
- T059 (`settleHumanOutcomeForEntity`): **kept, with justification** — per-attempt binding is
  proven live for the ANSWER path (Scenario 2), but the entity-scoped binding still serves a
  DIFFERENT live surface (`suggest/outcome-writer.ts:181` — proposal outcomes carry no attempt id
  until a per-suggestion experience linkage exists). It is not superseded code; flagged for
  deletion when that linkage lands.
