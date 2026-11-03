# Adversarial re-verification + completeness critic (T017)

**Backs**: FR-002, FR-004, SC-002, SC-003 · **Method**: research R4 — an independent skeptic challenges
every `usable`/`done` claim from T012–T016 (+ guards); refuted claims are withdrawn; a completeness critic
confirms coverage. The load-bearing claims below were **independently re-verified by grep in this context**
(quoted in the "re-verification" column), separate from the auditors that produced them.

## Headline finding

**No capability is graded `usable`.** The strongest possible anti-over-claim result: there is nothing to
withdraw, because the audit awarded its top grade to nothing. `safe_outward` is the closest
(`measured_with_controls`), and its downgrade from the pre-registered "usable" expectation is itself an
honest correction (below).

## Challenge log

| Capability | Claimed state | Skeptic challenge | Re-verification (independent) | Verdict |
|---|---|---|---|---|
| trustworthy_recall | `built` | "Is the faithful magma path actually the live default?" | `SCNS_INTENT_ROUTING === '1'` + `SCNS_TRAVERSE_ROUTING === '1'` gates (`src/cli.ts:919-951`) ⇒ default hybrid; only archived live evidence is a measured NULL (`us1-cert-run…log:45-53`). | **Upheld** — not usable; US2 unmeasured. |
| self_learning | `built` | "Is the accept-vs-waste loop closed live?" | `settleHumanOutcomeForAttempt` → **def (`human-outcome.ts:86`) + barrel (`index.ts:133`) only, 0 callers**; `recordAttempt` → **0 matches in src/**. | **Upheld** — negative control CONFIRMED. |
| self_direction | `built` + BLOCKED | "Is there any new-app self-direction or machine scheduler?" | `ls src/autonomy` → **1 file (index.ts)**; seeds gated on `SCNS_REPO_RE`; scheduling is context-threshold rotation only. | **Upheld** — largest gap; BLOCKED valid. |
| voice_cloning | `specified` + BLOCKED | "Any texts ingestion or persona-contact model?" | `grep imessage\|sms` → **0**; `grep 'approved contact\|persona contact'` → **0**. | **Upheld** — essentially unbuilt. |
| safe_outward | `measured_with_controls` | "Pre-registered as the `usable` POSITIVE control — why not usable?" | Wired live (`startup.ts:313-315`) + pos/neg controls (`consult-source.test.ts:37-87`), BUT **no archived live e2e row**; a live broker probe is deferred (safety guard: broker :3456 untouched). | **Upheld with correction** (see below). |
| guards (x-cutting) | `measured_with_controls` | "Are all six invariants negatively controlled?" | Guards 1–3 (vault/PID/home) have executed negative controls; guards 4–6 (broker/allowlist/levers) are structural/pos-only this session. | **Upheld** — honest partial. |

## The one surfaced deviation (not buried)

The audit **pre-registered** `safe_outward` as the POSITIVE control expected to grade `usable` (research R5 /
fable5 §5.1). The T016 auditor honestly graded it **`measured_with_controls`** instead, because the strict
rubric requires an **archived live end-to-end evidence row** and only controlled unit tests + a wired code
path exist. Obtaining the live row requires a runtime broker deny-all probe, which this read-only, broker-
untouched MVP deliberately does not run.

- This is a **downgrade from expectation, surfaced explicitly** (per FR-019 spirit: never bury a gate change).
- The audit's positive control still serves its purpose: `safe_outward` (`measured_with_controls`, wired-live,
  pos+neg controls) is **cleanly separated** from the negative control `self_learning` (`built`, 0 live
  callers, no controls). The audit CAN distinguish a strong controlled capability from a code-complete one.
- **Actionable**: a guarded live broker deny-all probe (isolated, PID-kill, archived row) would move
  `safe_outward` to `usable`; it is the smallest remaining step and can be queued as a controlled exercise.

## Blocked-classification review (Validity-of-Null)

- `self_direction`, `voice_cloning` → **BLOCKED** (`could_setup_show_win:false`): correct — no mechanism
  exists to probe, so no setup could show the effect.
- `trustworthy_recall`, `self_learning` → **not blocked** (`blocked:null`): correct — these are fixable/
  measurable (US2 fix; live loop wiring), not structurally can't-win. Distinguishing these from the BLOCKED
  pair is itself an anti-mistesting control.

## Completeness critic

- **Coverage**: all 5 north-star capabilities present once + the cross-cutting guards artifact (six-vs-five
  resolved by the sixth `audit/guards.md`, per `audit-protocol.md`). ✓
- **Every leaf has**: a state, a non-empty gap, evidence rows (or grep-absence facts), and controls-or-BLOCKED. ✓
- **No unproven `usable`**: 0 capabilities usable ⇒ 0 over-claims. ✓
- **Synthesis note surfaced**: the guards auditor's compound state string was normalized to a single
  `measured_with_controls` (core guards controlled; broker/allowlist structural) — recorded here, not hidden.

## Outstanding (by design)

The **independent sign-off (T019)** is NOT performed in this context. Per the handoff policy, the readiness
verdict is re-derived by a separate grader context (producer ≠ grader). The assembled map (T018) therefore
carries `signoff.agreed=false` as its single intentionally-outstanding validation item.
