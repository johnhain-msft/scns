# Fresh-context handoff policy (feature 002, task T006)

**Backs**: FR-021, SC-003 · **Contract**:
[`orchestration-execution.contract.md`](../../../specs/002-north-star-audit-remediation/contracts/orchestration-execution.contract.md)
· **Mechanism**: the `handoff` skill (saves session state + writes a continuation file so a fresh context
resumes exactly where this one stopped).

## Policy

The effort decomposes across **fresh-context handoffs** so no single context saturates and no verdict lands
at the tail of an overloaded run (the fable5 failure mode):

```
plan ──▶ implement ──▶ independent QA ──▶ handoff ──▶ (fresh context) next increment
```

1. **Handoff before saturation** — when a context approaches its budget, invoke the `handoff` skill and
   resume in a fresh context, rather than pushing work through an exhausted one.
2. **Each scientific verdict runs in its OWN fresh context** with an **independent sign-off** (producer ≠
   sole grader). The three verdicts of this feature:
   - **T019** — US1 readiness verdict (independent re-derivation of the readiness map).
   - **T030** — US2 LoCoMo reproduction/health gate.
   - **T033** — US2 comparative gate (equal token budget).
   None of these may be produced by the context that implemented the work it grades.
3. **Producer ≠ grader** — the sign-off context re-derives the verdict independently; `producer_context_id
   ≠ grader_context_id`.

## Application to this MVP (T001–T018)

- The MVP (Phase 1 Setup, Phase 2 Foundational, Phase 3/US1 audit **through T018**) is implemented by the
  DEV worker with delegated sub-agents.
- **STOP after T018.** T018 assembles the ReadinessMap; **T019 (the verdict) is deliberately NOT run in
  this context** — it is handed off to a fresh, independent grader context per this policy.
- At the T018 checkpoint the DEV worker invokes the **`handoff` skill** to persist state and write the
  continuation prompt, then waits. The fresh context picks up at T019.

## Handoff artifact

The `handoff` skill writes a continuation file under the session state directory capturing: what was
completed (T001–T018 + evidence paths), the vault-guard status (byte-identical), the exact next step
(T019 with an independent grader), and the standing safety orders. That file is the sole state transfer;
the fresh context needs nothing from this context's scrollback.
