# T019 — US1 North-Star Readiness Audit — Independent Grader Sign-off

**Verdict: `APPROVE-WITH-NITS`**

**Backs**: SC-001, SC-002, SC-003, SC-012 · **Contract**:
[`contracts/readiness-map.schema.md`](../../../specs/002-north-star-audit-remediation/contracts/readiness-map.schema.md)
· **Validator**: `scripts/lib/readiness-map.ts` (T009) · **Graded artifact**:
[`readiness-map.json`](./readiness-map.json).

---

## Grader identity (fresh, independent context — SC-003 / schema Rule 4)

| | |
|---|---|
| Grader session (this fresh context) | `06c710b0-d079-4cb4-8047-71dc055228b5` |
| `grader_context_id` recorded in the map | `06c710b0-t019-independent-grader` |
| Producer | `496bc1fe-dev-worker` (session `496bc1fe-2fe8-477d-8139-3b17568d56e4`) |
| producer ≠ grader | ✅ (self-graded verdict rejected by validator; passes here) |
| Own fresh context, not the tail of an overloaded run | ✅ this session did nothing but grade T019 |

I did **not** produce any of the graded artifacts. I re-derived the verdict from the raw evidence and
graded adversarially (skeptic-first). My conclusion **agrees** with the producer's map.

---

## What I RE-RAN vs. REVIEWED

**Re-ran** (every live command under `SCNS_HOME=$(mktemp -d)`; live vault read-only):

- `validateReadinessMap(readiness-map.json)` via a throwaway Node `--experimental-strip-types` driver (not
  committed): **1 problem as-is** (`signoff.agreed must be true`), **0 problems** once signed as this grader.
  Confirms the handoff's "validator returns exactly ONE outstanding item" claim.
- `vitest run` (isolated): `readiness-map.test.ts` (15) + `readiness-map-controls.test.ts` (5) +
  `consult-source.test.ts` (5) = **25 passed / 25**. Quoted row:
  `Test Files  3 passed (3) · Tests  25 passed (25)`.
- Source spot-checks of **all 15 evidence rows** (5 capabilities × 3) + both BLOCKED preconditions, via
  `grep`/`sed` against real `path:line` (table below).

**Reviewed** (read-only, not re-executed): the six auditor files + `audit/adversarial-verification.md`;
`audit-protocol.md`; `readiness-map.md`; `baseline-2026-07-06.md`; `AWAITING-JOHN.md`; the producer handoff.

---

## Grade against the spec (not the producer's summary)

### SC-001 — coverage (100% of capabilities, each with a state + named gap) — **PASS**
All `capability_id`s present exactly once with a valid `state` and a non-empty `gap`
(validator Rule 1 + per-capability checks, 0 violations): `trustworthy_recall`=`built`,
`self_learning`=`built`, `self_direction`=`built`(+BLOCKED),
`safe_outward`=`measured_with_controls`.

> **2026-11 note:** a fifth, since-retired capability was part of the original signed-off set; its rows
> were removed from this record when it was dropped from the roadmap.

### SC-002 — no unproven `usable` (0 usable without live e2e + pos/neg controls) — **PASS**
**Zero** capabilities graded `usable`, so the SC-002 over-claim bar is met by construction. The single
highest grade — `safe_outward` = `measured_with_controls` — is backed by wired-live code
(`src/broker/startup.ts:313-315`) **and passing pos/neg controls I re-ran**
(`test/unit/broker/services/outward/consult-source.test.ts:37-87`, 5/5). The producer honestly declined the
pre-registered `usable` for lack of an archived live e2e row — the correct conservative call.

### SC-003 — independent sign-off in its own fresh context — **PASS**
producer (`496bc1fe-dev-worker`) ≠ grader (`06c710b0-…`); this is a dedicated fresh grading context.

### SC-012 — prioritized gap map + honest distance + `magma_placement`, consistent with auditors — **PASS**
`prioritized_gap_map` has 5 ordered, unique-priority entries; `magma_placement` = Priority 1;
`distance_summary` opens "SCNS is NOT yet usable … on ANY of the four capabilities" (honest, not inflated —
validator Rule 6 clean). Every per-capability state in the map matches its auditor file
(`audit/*.md` state lines) and the adversarial re-verification table
(`audit/adversarial-verification.md:19-24`, all "Upheld").

### Schema (T009 contract) — **PASS**
`validateReadinessMap` → **0 problems** once the grader sign-off is recorded (was 1: the intentional
pending `agreed=true`).

---

## Evidence re-verification (all 15 rows)

| # | Capability | Citation | Result |
|---|---|---|---|
| 1 | trustworthy_recall | `src/cli.ts:949-951` (`SCNS_INTENT_ROUTING === '1'`) | ✅ exact |
| 2 | trustworthy_recall | `src/cli.ts:919-921` (`traverseOn` default-OFF) | ✅ exact |
| 3 | trustworthy_recall | `us1-cert-run-2026-07-06.log:45-53` (measured NULL VERDICT) | ⚠️ **claim TRUE, line WRONG** — see NIT-1 |
| 4 | self_learning | `settleHumanOutcomeForAttempt` 0 callers / `recordAttempt` 0 in src/ | ✅ def@`human-outcome.ts:86` + barrel@`index.ts:133` only; `recordAttempt` count=0 |
| 5 | self_learning | `src/cli.ts:996-1030` (`logRetrievalExperience`, no per-attempt settle) | ✅ present in range |
| 6 | self_learning | `src/reward/kto-learner.ts:21-25` (SELECT-only, no write path) | ✅ exact |
| 7 | self_direction | `src/autonomy/index.ts` (1 file) | ✅ `ls src/autonomy` → only `index.ts` |
| 8 | self_direction | `src/suggest/extractors/self-improvement-extractor.ts:17-18` (`SCNS_REPO_RE`) | ✅ exact |
| 9 | self_direction | `src/brain/decision-tree.ts:67-69` (`contextUsagePercent >= …`) | ✅ quote at line 68 (in range) |
| 10 | safe_outward | `config/safety-allowlist.json:3-5` (ships EMPTY = deny-all) | ✅ `_comment`@3, `hosts:[]`@4 |
| 11 | safe_outward | `src/broker/startup.ts:313-315` (`loadAllowlist(SAFETY_ALLOWLIST_PATH)`) | ✅ exact |
| 12 | safe_outward | `test/unit/broker/services/outward/consult-source.test.ts:37-87` (pos+neg) | ✅ exact + **re-ran, 5/5 pass** |

**14/15 rows verify exactly.** Row 3's claim is substantiated (the artifact genuinely contains the quoted
VERDICT) — only the line number is wrong (NIT-1).

---

## Nits (recorded; do NOT block the verdict)

- **NIT-1 — mis-located log citation (cosmetic, replicated 3×).** The "measured NULL" VERDICT quoted for
  `trustworthy_recall` is cited at `docs/evidence/us1-cert-run-2026-07-06.log:45-53`, but lines 45-53 are
  POS-score rows; the verbatim VERDICT
  (`… ⇒ measured NULL (incumbent hybrid stands)`) is at **line 1108** of that log. The quote is
  verbatim-accurate and the claim is TRUE — this is a wrong line range, not an unbacked number. Same
  mislocation appears at:
  - `docs/evidence/readiness-map.json:18` (`artifact_ref` of `trustworthy_recall.evidence[2]`)
  - `docs/evidence/audit/trustworthy_recall.md:25`
  - `docs/evidence/audit/adversarial-verification.md:19`

  Suggested fix during US2 cleanup: change `:45-53` → `:1108` in those three places. **Not fixed here** — my
  edit scope is limited to the map's `signoff` fields.

## Observations (accepted, not defects)

- **`safe_outward` = `measured_with_controls` is defensible, not an over-claim.** Its "measurement" is live
  wiring (`startup.ts:313-315`) + unit-level pos/neg controls, not a live-measured e2e broker row. The
  producer transparently downgraded from the pre-registered `usable` positive control
  (`audit/adversarial-verification.md:23`, `audit/safe_outward.md:9-12`). Since it is **not** graded
  `usable`, SC-002 is not engaged; the honest downgrade is the right call. Accepted.
- **7 files in `audit/` = 5 capability auditors + `guards.md` (6th, cross-cutting) + `adversarial-
  verification.md` (T017 pass).** Consistent with the six-vs-five resolution in `audit-protocol.md:25-33`.
  The map's `cross_cutting_guards` block (`measured_with_controls`) matches `audit/guards.md:5`.

## Claims I could NOT independently verify

- **Full baseline suite** (`baseline-2026-07-06.md`: 398 files / 5958 unit tests green, 0 typecheck errors,
  451 lint warnings). I re-ran only the 3 targeted suites (25 tests); the full baseline is **reviewed, not
  re-run** (out of scope for the verdict + avoids a long run). No reason to doubt it.
- **A live broker / retrieval e2e probe** — not run by design (guards forbid touching broker :3456; the audit
  is read-only). This is exactly why `safe_outward` correctly remains **not** `usable`.

---

## Guards honored during grading

- Every live command ran under `SCNS_HOME=$(mktemp -d)`.
- Live vault `$HOME/.scns/memory/vault.db` **byte-identical before AND after**:
  `mtime=1783256409 size=232488960` (asserted at start and after all test/validation runs).
- Broker :3456 and `config/safety-allowlist.json` untouched; no PID kills; **no push**; no US2+ (T020+) work.

## Map edit made (schema-required for a valid signed-off map)

Per the T009 acceptance ("valid signed-off map"), I updated only the `signoff` block of
`readiness-map.json`:

- `signoff.grader_context_id`: `PENDING-T019-fresh-context` → `06c710b0-t019-independent-grader`
- `signoff.agreed`: `false` → `true`
- `signoff_note`: updated to record the completed independent sign-off.

Re-validated after the edit: **`validateReadinessMap` → 0 problems.** No other file was modified.

---

**Bottom line:** The US1 readiness verdict is honest, evidence-cited, adversarially upheld, schema-valid, and
independently signed off. Nothing is over-claimed; the single nit is a mislocated (but truthful) log
citation. **`APPROVE-WITH-NITS`.**
