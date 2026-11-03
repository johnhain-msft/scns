# scns-verifier — the claim-evidence gate (Track 1 / 1B)

Status: **BUILT — deterministic core + QG wiring + the independent producer≠verifier
spawn (seam + spawned agent)** (branch `track1/anti-overclaim`). The spawn seam is
default-OFF; live-validated end-to-end 2026-07-11 (see the "BUILT — the producer≠verifier
spawn" section below + `docs/evidence/claim-verifier-blind-test.md`). Go-live (deploy the
new dist + enable `SCNS_QG_CLAIM_SPAWN`) is queued in `docs/evidence/AWAITING-JOHN.md`.
This doc is the spec of record.

## Why this exists (the motivating failure)
2026-07-09: an analysis OVERCLAIMED — it asserted, from reading code with no live
check, that the heartbeat-poller / zombie-cleanup / rotation-watchdog scheduler rows
were "vestigial … handled by pollers." Reality (later live-verified): heartbeat/zombie
DO run live (488 `zombie_cleaned` events); rotation-watchdog really is unwired. A
code-traced RUNTIME claim shipped as fact. SCNS's evidence-first guard was passive text
and did not bind. §3a (`.github/instructions/00-fix-first.instructions.md`) added the
Layer-A discipline (claim-evidence table); 1B is the Layer-B STRUCTURAL gate.

## The key tension (why 1A alone was not enough)
1A is *better passive text* — necessary but voluntary. guard-rca's root cause was that
passive text FAILED. The structural fix is a gate that BINDS. Split by layer:
- **Layer A** (developing SCNS: human + Copilot CLI): no broker gate exists for the
  human-facing agent → enforcement can only be workflow discipline (§3a + a mandatory
  independent pass).
- **Layer B** (SCNS's internal self-improvement loop): the broker CAN host a real gate.
  That is this verifier, wired into the quality-gate arbiter.

## Premise correction (challenge the framing, not just its facts)
The handoff framed 1B as "attach after `team_completed`, BEFORE QG marks PASS." Reading
the code invalidated the *placement*: `quality-gate-arbiter.ts` `handleTeamCompletion`
**auto-FAILs any no-diff completion** ("Team produced no staged diff") and only inspects
**code diffs** thereafter. So an **analysis/claim output — the actual failure mode — hits
the no-diff auto-fail and is NEVER claim-checked**; wiring only at the rubric-PASS branch
would gate code tasks, not the analysis case. It was also a latent bug: applying a
*code-diff* gate to work that legitimately produces no code (e.g. a `scns-researcher`
investigation) is the wrong rule (John: "silly to enforce a code-diff gate on something
that doesn't change code"). The completion payload DOES carry the output:
`TeamCompletionData.logs[].tail` + `stagedDiff` (team-lifecycle.ts:56-64).

## Prior art (the legos — don't reinvent)
- **CriticGPT / generator≠verifier** — the producing agent must not be its own grader; a
  separate critic finds errors the author misses. ⇒ the verifier is independent of the
  producer; the deep re-check is a *fresh* spawn (deferred, below).
- **LLM-as-judge (bias-aware)** — judge on a rubric with quoted evidence, not vibes. ⇒
  the rubric here is §3a: every runtime claim needs a `live-confirmed` (quoted row) or
  `code-only` label; an exit code / HTTP 200 is not evidence.
- **Reflexion** — feedback into memory, never the final verdict. ⇒ a `fail` is recorded
  as negative memory + event, informing future runs.
- **Self-Refine** — drafts are not acceptance. ⇒ measure-mode records; only enforce-mode
  changes the outcome.

## Mechanism (BUILT)
`src/broker/services/claim-evidence-verifier.ts` — pure, no spawn, no I/O:
- `extractRuntimeClaims(text)` — one claim per line containing a runtime signal word
  (`runs live`, `handled by`, `never fired`, `unwired`, `vestigial`, `dead code`,
  `disabled`, `runs via`, `run_count`), with its detected label + whether a substantive
  quoted row is present.
- `verifyClaimEvidence(text)` → `pass` | `fail` | `needs-evidence`:
  - **pass** — no runtime claims, OR every claim is labeled and every `live-confirmed`
    claim has a quoted row.
  - **fail** — a runtime claim is asserted with NO label (the guard-rca overclaim).
  - **needs-evidence** — a `live-confirmed` claim lacks a quoted row (HTTP 200 / exit
    codes explicitly do not count).
Tests: `test/unit/broker/services/claim-evidence-verifier.test.ts` (10, pos/neg).

## Wiring (BUILT) — `quality-gate-arbiter.ts`, both branches
- **No-diff ANALYSIS branch** — when a completion has no diff AND a `scns-researcher`
  member (`isAnalysisCompletion`), it is judged by `verifyClaimEvidence` on the joined
  `logs[].tail` — its OWN rule — instead of the code-diff no-diff auto-fail. `pass`⇒QG
  pass; `fail`/`needs-evidence`⇒QG fail with reason `claim-verifier:<kind>`.
- **Code PASS branch** — `verifyClaimEvidence` runs on the combined build/test/lint
  output. Advisory by default; downgrades PASS→FAIL only under enforce.
- **Modes** — `resolveClaimVerifierMode(env)`:
  - `measure` **DEFAULT-ON** (records verdict + emits `claimVerifierKind` /
    `claimVerifierClaimCount`; kill-switch `SCNS_QG_CLAIM_VERIFIER=0`). It is NOT inert
    apparatus — it runs on every completion once deployed.
  - `enforce` DEFAULT-OFF (`SCNS_QG_CLAIM_ENFORCE=1`) — lets a fail downgrade a *code*
    PASS. Go-live gated (needs measured false-positive evidence first).
Tests: `test/unit/broker/services/quality-gate-arbiter.claim-verifier.test.ts` (7,
pos/neg on both branches).

## Go-live plan (per John: default high-quality testing, not default-off-and-wait)
1. Blind AI-drives-AI test: a real agent produces a real analysis on a neutral prompt
   (no leaked expectations); run the verifier on its output; compare flagged vs
   predicted. If close, keep measure ON; else iterate the heuristics. (Run this session.)
2. Deploy = rebuild `dist` + broker restart → **AWAITING-JOHN** (guard: no restart of the
   singleton :3456 without approval). measure-ON ships with the deploy.
3. Flip `SCNS_QG_CLAIM_ENFORCE=1` only after measure shows an acceptable false-positive
   rate on real completions → **AWAITING-JOHN**.

## BUILT — the producer≠verifier spawn (2026-07-11, this session)
The deferred deep check now exists. It is the execution-grounded counterpart to the
deterministic core (CriticGPT arXiv:2309.00864 / Faithful-Reasoning-with-Verification
arXiv:2305.14104 / Toolformer arXiv:2302.04761; in-repo generator≠critic precedent
`src/brain/self-critique.ts`).

- **Injection seam** — `QualityGateArbiterDeps.claimVerifier.makeVerifierBackend?:
  () => ClaimVerifierBackend` (mirrors `behavioralGate.makeBackends`). Default-OFF: the
  arbiter builds/consults a backend ONLY when `SCNS_QG_CLAIM_SPAWN=1` AND the deterministic
  pre-filter found ≥1 runtime claim. Unset ⇒ verdict + event byte-identical to the
  pre-filter-only path (proven by test S0/S0b). `resolveClaimVerifierMode` gained a `spawn`
  flag alongside measure/enforce.
- **Spawned scns-verifier** — `src/broker/services/claim-verifier-backend.ts`:
  `runClaimReverification` (mirrors `runSelfCritique`), `buildReverifyPrompt` (a
  producer≠verifier persona that instructs the agent to INDEPENDENTLY re-run each cited
  probe and confirm the quoted row — "never trust the label"), `parseReverifyResponse`
  (defensive JSON → pass|fail|needs-evidence), `createDefaultVerifierSpawner` (bounded
  `copilot` one-shot, SIGKILL timeout, env-overridable CMD/ARGS/TIMEOUT), and
  `createSpawnVerifierBackend` (the seam factory). The spawner is INJECTED so tests never
  fork. Timeouts / non-zero exits / malformed JSON / a thrown backend degrade to
  `needs-evidence`, NEVER a silent `pass`.
- **Governance** — when the spawn ran, its verdict GOVERNS (it is the primary judge; the
  deterministic core is the cheap pre-filter). Analysis (no-diff) branch: reason becomes
  `claim-reverify:<kind>` and the outcome follows the spawn. Code PASS branch: the spawn's
  kind feeds the same enforce-gated downgrade. Both branches still record the core verdict
  (`claimVerifier`) plus the spawn verdict (`claimReverify`) on the event + ArbiterVerdict.
- **Why it matters (the gap closed)** — a claim like *`embeddings … "ready"
  [live-confirmed]` (cited: `curl …/api/health`)* PASSES the deterministic core (label +
  quoted row present) but is FALSE (embeddings are idle). The spawn re-runs the curl and
  contradicts it → fail. Fixture `false-live-core-blindspot.md` documents this boundary.
- **Tests** — `test/unit/broker/services/claim-verifier-backend.test.ts` (25, pos/neg +
  the full degradation contract); `…/quality-gate-arbiter.claim-verifier.test.ts` +8 seam
  tests (S0–S6: default-OFF inertness, spawn-governs on both branches, pre-filter
  short-circuit, needs-evidence never silent-passes); gated live e2e
  `…/quality-gate-arbiter.claim-reverify-live.test.ts` (SCNS_LIVE_REVERIFY=1).
- **Live validation (2026-07-11)** — real `copilot` spawn, isolated broker :3477,
  pre-registered pos/neg controls: POS (db ready, TRUE) → pass/corroborated; NEG
  (embeddings/overall "ready", FALSE) → fail/contradicted ("stable across 4 re-runs").
  Full real dispatcher → arbiter → real spawn e2e → `claimReverifyKind=fail`. Detail in
  `docs/evidence/claim-verifier-blind-test.md`.

## BUILT but REDUNDANT — superseded, see handoff (2026-07-12) — suggestion→scns-researcher emission
Commit `647a985` added a suggestion→researcher emission path
(`src/suggest/research-role-classifier.ts` + a `researchRoleEmission` option at
the `tryEmit` chokepoint in `src/suggest/generator.ts` + a `cli.ts` flag; tests
16+3+2, all green). **It is REDUNDANT and being re-evaluated — do not treat this
as the accepted design.** Two findings (see
`~/.copilot/session-state/ac6054d2-37bd-48a7-83ac-a563aabee2b4/handoff.md` §2–§4):
- Its classifier DUPLICATES `assignRole` (`src/brain/classifier-utils.ts:76`),
  the existing investigation→researcher classifier.
- The real gap is a NAMESPACE fracture (brain `researcher` vs broker
  `scns-researcher`, no mapping bridge) + the on-demand question — the likely-correct
  fix is reuse `assignRole` + ONE `researcher→scns-researcher` bridge at
  role-resolution, and researcher-on-demand for manager/human/CLI-agent, NOT a
  generation-time keyword guess.
Per the current dev discipline (`.github/instructions/00-fix-first.instructions.md`
§5 — pre-production, Dev-default-ON): the fresh session builds the correct wiring
**ENABLED in a branch** (no env gate), and decides 647a985's fate (rework/drop).

## DONE — enabled on the live :3456 broker (2026-07-12)
Deployed + enabled on the live `:3456` broker: `SCNS_QG_CLAIM_SPAWN=1` + `SCNS_QG_CLAIM_ENFORCE=1`
(plist + reload; pid 56406 ready, both flags confirmed in-process). Go-live earned by a blind
AI-drives-AI test (fresh tmux producer, no leaked expectations) + an independent fresh-context judge
GO; caveat locked by tests S7/S8. See `docs/evidence/claim-verifier-blind-test.md` §Enforce go-live.
