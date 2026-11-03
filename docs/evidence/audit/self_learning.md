# Audit — self_learning (T013)

**Capability**: self-learning from the human accept-vs-waste signal · **State**: `built`

**Justification**: the learner + store code exists (default-OFF), but the human accept-vs-waste signal is
**not closed live** at the per-attempt seam. `settleHumanOutcomeForAttempt()` exists but has **0 live
callers**; `recordAttempt` has **0 occurrences** in `src/`. This is the pre-registered NEGATIVE CONTROL of
the audit (research R5 + fable5 §5.2: "per-attempt APIs have 0 live callers") — CONFIRMED by independent grep.

**Backing subsystems**: `src/memory/experience-store.ts`, `src/memory/human-outcome.ts`,
`src/reward/kto-learner.ts`, `src/reward/dr-estimator.ts`, `src/memory/arm-router.ts`,
`src/memory/explore-router.ts`, `src/suggest/outcome-writer.ts`, `src/cli.ts`.

**Reachability (independently re-verified)**
- `settleHumanOutcomeForAttempt` occurs ONLY at its definition (`src/memory/human-outcome.ts:86`) and the
  barrel re-export (`src/memory/index.ts:133`) — **no live caller**.
- `recordAttempt` → **0 matches** across `src/`.
- What IS wired live: retrieval logging (`src/cli.ts:996-1030`), shadow exploration logging
  (`src/cli.ts:1036-1066`), and entity-scoped (not attempt-scoped) settling (`src/suggest/outcome-writer.ts:175-184`).

**Evidence rows**
- claim: per-attempt human-outcome path present but unused live · quoted: `export function settleHumanOutcomeForAttempt(...)` · ref: `src/memory/human-outcome.ts:81-92`
- claim: live CLI logs retrievals but never calls per-attempt settling · quoted: `const loggedId = logRetrievalExperience(experienceStore, { ... })` · ref: `src/cli.ts:996-1030`
- claim: proposal outcome loop is entity-scoped, not attempt-scoped · quoted: `const settled = settleHumanOutcomeForEntity(deps.experienceStore, { entity: target.entity, value })` · ref: `src/suggest/outcome-writer.ts:175-184`
- claim: learner is offline/SELECT-only (cannot certify) · quoted: `this package has NO import path to the judge... and NO write path to the experience store (SELECT-only)` · ref: `src/reward/kto-learner.ts:21-25`
- claim: independent grep — 0 live callers · quoted: `settleHumanOutcomeForAttempt → def + barrel only; recordAttempt → count=0` · ref: `docs/evidence/audit/adversarial-verification.md` (T017)

**Controls**: n/a — graded ≤ built; no live reward→policy→outcome proof with controls.

**Gap** (load-bearing missing pieces): (1) a live caller for per-attempt settlement; (2) a live query path
that consults the learned policy by default (today default-OFF/shadow); (3) a measured before/after outcome
delta under pos/neg controls.

**Blocked**: null (fixable by wiring + measurement; not Validity-of-Null).

**Distance to usable**: the mechanisms (KTO/IPO/DR, experience store, human-outcome) are built and unit-tested
but shadow/offline; the accept-vs-waste loop is not closed on the live path and its improvement is unmeasured.
