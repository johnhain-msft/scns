# Audit protocol — north-star readiness (feature 002, task T011)

**Backs**: FR-001..FR-006, SC-001..SC-003, SC-012 · **Method**: research R4 (generalize the fable5
multi-agent, adversarially-verified, independently-signed-off audit) · **Coverage map**: research R5 ·
**Output contract**: [`contracts/readiness-map.schema.md`](../../../specs/002-north-star-audit-remediation/contracts/readiness-map.schema.md)
· **Validator**: `scripts/lib/readiness-map.ts` (T009).

## Purpose

Grade how close SCNS actually is to its north star — a self-learning "second brain" that can be pointed at
a new app and decide/schedule/go, and clone the operator's voice into a working skill+agent — **honestly**,
with quoted evidence and pos/neg controls, and emit a prioritized gap map that places the MAGMA fix. The
audit is **read-only** (plan.md: "no code change"); it changes nothing and flips no default.

## Pipeline

```
6 read-only auditors ──▶ attribution/synthesis ──▶ adversarial re-verification ──▶ completeness critic ──▶ independent sign-off
   (T012–T016 + guards)        (T018)                       (T017)                       (T017)              (T019 — fresh context)
```

> **T019 is out of this MVP's scope** and runs in its OWN fresh context with an independent grader
> (producer ≠ grader). This MVP stops after **T018** (assembled + self-validated map) and hands off.

## The SIX auditors (six-vs-five resolution — recorded, not silently dropped)

Research R4/R5 specify **five capability auditors + a cross-cutting guards auditor** ("one per north-star
capability + cross-cutting guards"), but `tasks.md` enumerates only five auditor tasks (T012–T016).

**Resolution (decision):** add a **sixth output file** `audit/guards.md` (the cross-cutting RunGuards from
data-model §6), produced alongside the five capability auditors and **adversarially re-verified in T017**.
The alternative — folding guards into T017's prose — was rejected because it would dilute T017's skeptic
focus and leave the guard invariants without their own gradeable artifact. Nothing is dropped.

| # | Auditor | Capability / scope | Backing subsystems (read-only) | Output |
|---|---|---|---|---|
| T012 | trustworthy_recall | answer quality + tokens | `src/memory/*` (adaptive-traversal, intent-search, retrieval-context, indexer, causal-*) | `audit/trustworthy_recall.md` |
| T013 | self_learning | accept-vs-waste loop | `src/reward/*`, `src/suggest/*`, `src/ideate/*`, `src/brain/*`, `experience-store.ts`, `arm-router.ts`, `human-outcome.ts` | `audit/self_learning.md` |
| T014 | self_direction | decide/schedule/go | `src/autonomy/*` (thin, 1 file), `src/selfopt/*`, `src/observe/*`, `src/meta-broker/*` | `audit/self_direction.md` |
| T015 | voice_cloning | persona→skill+agent | no dedicated subsystem (`ideate/`, `core-file-generator.ts`, skills) | `audit/voice_cloning.md` |
| T016 | safe_outward | guardrails | `src/broker/services/outward/*`, `config/safety-allowlist.json`, kernel | `audit/safe_outward.md` |
| T011b | **guards (cross-cutting)** | RunGuards §6 | vault RO / kernel+allowlist untouched / broker :3456 / isolated home / PID-kill / levers default-OFF | `audit/guards.md` |

## Grading rubric (per capability — data-model §1)

State ∈ `specified → built → wired_live → measured_with_controls → usable` (monotonic). Rules the validator
ENFORCES (an auditor cannot over-claim):

- **`usable`** ⇒ ≥1 **live end-to-end** evidence row (verbatim `quoted_output` + resolvable `artifact_ref`)
  **AND** a passing positive + negative control. **Code-complete without a live caller MUST be `built`, never
  `usable`.**
- **`measured_with_controls`** ⇒ both controls present.
- **BLOCKED** (Validity-of-Null) ⇒ set `blocked = { missing_precondition, could_setup_show_win:false }` when
  the probe structurally can't show the effect; not a pass/fail leaf.
- **`gap`** is always a non-empty concrete distance to "usable / just point it and go".

## Evidence discipline (read-only)

1. **Cite real artifacts** — real source (`path:line`) + EXISTING archived evidence
   (`fable5-audit-findings.md`, `dod-001-learning-memory-loop.md`, `us1-cert-run-2026-07-06.log`,
   `baseline-2026-07-06.md`). **No new live benchmarks** are run by the audit (that would risk the vault /
   spawn processes; and US2/US3 own the live gates).
2. **No live-e2e proof ⇒ ≤ built.** If a capability's `usable` claim would need a live run that no archived
   artifact backs, grade it `built`/`wired_live` and name the gap — never `usable`.
3. **Quote, don't assert** — every "works/done" line carries a verbatim row; a measured NULL, honestly
   reported, is a success.

## Audit-level positive & negative controls (T010 fixtures — the audit's own falsifiability)

- **POSITIVE control** — `safe_outward`: deny-all, fail-closed, kernel untouched ⇒ MUST grade `usable` with
  its evidence row. If the audit can't grade a genuinely-usable capability usable, the method is broken.
- **NEGATIVE control** — `self_learning` per-attempt experience APIs with **0 live callers** ⇒ MUST grade
  **≤ built**. If the audit grades a code-complete-no-caller capability `usable`, the method is broken.

These are locked by `test/unit/scripts/readiness-map-controls.test.ts`; the validator rejects either failure.

## Independent sign-off (T019, fresh context)

The verdict is re-derived in a separate context; `signoff.producer_context_id ≠ grader_context_id`,
`agreed=true`. Never produced at the tail of an overloaded run (SC-003). This MVP prepares the map; the
sign-off is the handed-off next step.
