# Orchestration & execution loop (feature 002, task T004)

**Backs**: FR-020..FR-023, FR-025, SC-009, SC-010 · **Contract**:
[`specs/002-north-star-audit-remediation/contracts/orchestration-execution.contract.md`](../../../specs/002-north-star-audit-remediation/contracts/orchestration-execution.contract.md)
· **Grounded in**: research R6 + the operator's stored orchestration preference.

## Established loop (how THIS effort actually runs)

This effort runs as a long-running **tmux** session with a strict role split:

| Layer | Who | Does | Never does |
|---|---|---|---|
| **Orchestrator** | the operator's tmux facilitator pane | sequences tasks, forwards prompts, clears dialogs, reads concise reports/verdicts, decides, maintains the hard-stop queue | run tests · edit code · ingest raw logs · run a verdict in its own context |
| **DEV worker** | this Copilot pane (implementer) | implements tasks, writes + runs targeted tests, **delegates** sub-work (baseline, auditors, judges) to fresh-context sub-agents, reports concise CHECKPOINT lines | push · flip a prod default · run a scientific verdict at the tail of its own long context |
| **Delegated sub-agents** | `task`-tool agents (fresh context each) | `implementer` / `judge` / `qa` / `auditor` — do the work, return a **concise report** | — |

> **Resolution (recorded).** The DEV worker does **not** spawn a nested `tmux-dev-loop`: the loop is the
> operator's facilitator pane + this dev pane. Delegation-first is honored *within* the worker via the
> `task` tool (T001 baseline sub-agent; T012–T016 + guards auditors; T017 skeptic; verdict graders). The
> `tmux-dev-loop` skill is the facilitator's tool, not the worker's.

## Orchestrator invariants (MUST — evidenced by the session transcript)

```json
{ "tests_run_by_orchestrator": 0, "code_edits_by_orchestrator": 0, "raw_logs_ingested": 0,
  "delegated_fraction": 1.0, "context_within_budget": true, "handoffs": ">=1 per saturation" }
```

1. **Delegate everything executable** — implementation, test execution, and judging are delegated; the
   orchestrator performs none (FR-020, SC-009).
2. **Concise reports only** — the orchestrator consumes verdicts/summaries, never raw logs; a separate
   `judge`/`qa` sub-agent verifies a delegated result (FR-023, R6).
3. **Fresh-context decomposition** — plan → implement → independent QA → handoff; **each scientific
   verdict** (US1 audit T019, US2 reproduction T030, comparative T033) runs in its **own** fresh context
   (FR-021, SC-003). Hand off before saturation. See [`handoff-policy.md`](./handoff-policy.md).
4. **Hard-stop queue** — every `git_push | prod_default_flip | deploy | populate_allowlist |
   authorize_spend` is queued to [`AWAITING-JOHN.md`](./AWAITING-JOHN.md); **0 executed unattended**
   (FR-022, FR-025, SC-010).

## How discipline is measured (US4 / Phase 6, out of this MVP's scope)

The US4 discipline audit (T041–T043) asserts, from the transcript: `tests_run==0`, `code_edits==0`,
`raw_logs_ingested==0` **by the orchestrator**, `delegated_fraction==1.0`, each verdict in its own fresh
context, and 100% of hard-stops queued. This MVP (T001–T018) establishes the substrate those checks read.

## Rejection cases (a run is non-compliant if…)

- the orchestrator runs "just one quick test" or makes an edit itself;
- it pastes a full raw benchmark log into its own context (delegate + summarize instead);
- a comparative/go-live verdict is produced in the orchestrator's own (non-fresh) context;
- any hard-stop is executed without a human approving the queued entry.
