# SCNS North-Star Readiness Map (feature 002, US1 — T018)

**Question answered**: *How close is SCNS to the north star, and what is the gap?* · **Machine copy**:
[`readiness-map.json`](./readiness-map.json) (validated against `contracts/readiness-map.schema.md` via
`scripts/lib/readiness-map.ts`) · **Method**: [`audit-protocol.md`](./audit-protocol.md) · **Adversarial
pass**: [`audit/adversarial-verification.md`](./audit/adversarial-verification.md).

> **Verdict status**: STRUCTURALLY VALID, **pending independent sign-off**. The schema validator returns
> exactly ONE outstanding item — `signoff.agreed must be true` — which is **T019** (the independent, fresh-
> context re-derivation; producer ≠ grader). This MVP stops at T018 by design. Everything else passes.

## Headline: NOT usable at the north star on any capability (honest distance)

No capability is graded `usable`. `safe_outward` is the closest; the two headline autonomy moonshots are
largely unbuilt. This is the anti-over-claim result the operator asked for — no inflated "yes".

## Readiness table

| Capability | State | One-line gap | Evidence (audit artifact) |
|---|---|---|---|
| **safe_outward** | `measured_with_controls` | deny-all/fail-closed, wired-live, pos/neg controlled — lacks only an archived **live e2e** row | [safe_outward.md](./audit/safe_outward.md) |
| **trustworthy_recall** | `built` | faithful MAGMA path is default-OFF; only a **measured NULL** exists — needs US2 fix + measurement | [trustworthy_recall.md](./audit/trustworthy_recall.md) |
| **self_learning** | `built` | accept-vs-waste loop not closed live — `settleHumanOutcomeForAttempt` has **0 live callers** · ⚠ **stale as of 2026-07-25 — see erratum below** | [self_learning.md](./audit/self_learning.md) |
| **self_direction** | `built` · BLOCKED | deterministic + SCNS-scoped; **no machine scheduler**, no new-app self-direction (`src/autonomy` = 1 file) | [self_direction.md](./audit/self_direction.md) |
| **voice_cloning** | `specified` · BLOCKED | **no** persona/voice subsystem, texts ingestion, or persona-contact model | [voice_cloning.md](./audit/voice_cloning.md) |
| _cross-cutting guards_ | `measured_with_controls` | core guards negatively-controlled; broker/allowlist/levers structural this session | [guards.md](./audit/guards.md) |

- **`usable` count: 0.** No over-claims to withdraw (adversarial pass upheld every grade).
- **BLOCKED (Validity-of-Null)**: `self_direction`, `voice_cloning` — no mechanism exists to probe.
- **Not blocked (fixable/measurable)**: `trustworthy_recall` (US2), `self_learning` (live loop wiring).

> ### ⚠ ERRATUM 2026-07-25 — `self_learning`: the "0 live callers" gap line is out of date
>
> The `self_learning` row above (and `readiness-map.json` gaps/evidence/`distance_summary`) states that
> `settleHumanOutcomeForAttempt` has **0 live callers**. That was accurate when the audit was taken —
> the audit and the first live caller landed the same day, 2026-07-08 (`ba4a8e6` / `067eee4`) — but it
> is **false as of 2026-07-25**. Recorded here because a later session that reads this table as ground
> truth would conclude the producer is missing and rebuild it.
>
> Grep-verified, non-test callers (`grep -rn "settleHumanOutcomeForAttempt(" --include=*.ts src/`):
> ```
> src/cli.ts:1269               settleHumanOutcomeForAttempt(experienceStore, reaskPriorId, 're-asked')
> src/memory/query-chain.ts:280 settleHumanOutcomeForAttempt(store, outcome.experienceId, outcome.cue)
> ```
> Both sit on the live extension briefing path (`POST /api/extension/context` → `dashboard-routes.ts:983`
> → the `briefing:` closure at `cli.ts:1190`). `~/.scns/memory/experience.db` holds **9 settled rows**:
> 4 query-chain-derived, 3 from the older N1 re-ask detector, 2 held-out transcript-oracle rows.
>
> **This erratum deliberately does NOT re-grade `self_learning`, and the `state` column is untouched.**
> The producer of that change wrote this note, and this artifact is independently signed off
> (`agreed: true`, grader `06c710b0`) under a producer ≠ grader rule. Two of the three listed missing
> pieces also remain genuinely open: there is still no default-on learned-policy consult, and no
> before/after delta — only a **single-arm baseline** of 2/4 = 50.0%, 95% Wilson CI **[15.0%, 85.0%]**,
> which is below the KTO learner's `minN` of 10 and therefore trains nothing. A comparison needs a
> challenger arm (`SCNS_EXPLORE_ROUTING=1` is live as of 2026-07-25 but has produced 0 challenger rows).
> Re-grading is an independent grader's call, on evidence, not the producer's.
>
> `readiness-map.json` is intentionally left unmodified: it is schema-validated with a completed sign-off,
> and silently editing a signed machine artifact is worse than an unmissable erratum beside it.

## Prioritized gap map (what to build/fix next)

| Priority | Capability | Load-bearing missing pieces | Blocks |
|---|---|---|---|
| **1** | trustworthy_recall (**← MAGMA fix / US2**) | Alg-1 anchor-eviction return-contract fix · Alg-3 causal-density restore · LoCoMo reproduction/health gate before any comparison | `measured_with_controls`; any faithful hybrid-vs-magma verdict |
| **2** | self_learning | live per-attempt settling caller · default-on learned-policy consult · measured before/after outcome delta | the accept-vs-waste north-star loop |
| **3** | self_direction | machine-limit scheduler · autonomous target discovery beyond SCNS · live observe→decide→schedule→act loop | point-it-at-a-new-app autonomy |
| **4** | voice_cloning | texts ingestion · voice-feature extraction · persona-contact policy · persona-faithful agent generation · faithfulness measure | a faithful voice-clone skill+agent |
| **5** | safe_outward | archived live e2e deny-all row via a guarded runtime broker probe | `safe_outward → usable` (hardening only) |

## MAGMA placement

**Priority 1.** The MAGMA corrective remediation (US2 of this spec) is the immediate next work: it moves
`trustworthy_recall` from `built → measured_with_controls` and is the precondition for any trustworthy
hybrid-vs-magma verdict. It is a scoped fix behind default-OFF levers — not a moonshot.

## Honest distance-to-north-star

The safety substrate is strong; memory recall is **one scoped fix (US2/MAGMA)** away from being *measurable*
(not yet *proven*); self-learning needs its live loop closed and measured; and the two headline autonomy
capabilities — **autonomous self-direction** and **voice cloning** — are largely unbuilt downstream work the
audit sizes but this effort does not deliver. SCNS is a well-guarded harness with real memory/learning
mechanisms mostly running **dark** (default-OFF, shadow, or unwired), not yet a point-it-and-go second brain.

## One surfaced deviation (not buried)

`safe_outward` was pre-registered as the audit's POSITIVE control expected to grade `usable`; it honestly
graded `measured_with_controls` because the strict rubric requires an **archived live e2e row** and only
controlled tests + a wired path exist (a live broker probe is deferred for safety). Surfaced in
[adversarial-verification.md](./audit/adversarial-verification.md); the positive/negative control separation
(safe_outward ≫ self_learning) still holds.

## Next step (handed off)

**T019 — independent sign-off** in a fresh grader context (producer ≠ grader) that re-derives this verdict and
sets `signoff.agreed=true` (or records BLOCKED per capability). Then US2 (MAGMA, priority 1) proceeds.
