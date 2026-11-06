# Self-issue intake, consolidation control planes, and child-broker onboarding

> Written with the `fix/brain-consolidate-livelock` change (2026-08-10). Records the intake
> recipe that exists TODAY, the two-control-planes design intent no doc previously stated,
> and the onboarding checklist for pointing SCNS at a new project.

## 1. How a child broker ingests GitHub issues (the recipe that exists today)

The `self-issue-ingest` scheduled task (`src/cli.ts`, handler registered per broker) pulls
open issues from the repo resolved by `resolveSelfIssueRepo` (`src/brain/self-issue-source.ts`):
`SCNS_SELF_ISSUE_REPO` env wins; a meta-child with no explicit repo derives the repo from
its own project's origin remote; the singleton with no explicit repo REFUSES to ingest
(#58 — there is no default target, because the historical hardcoded default pointed every
install at the public upstream repo).

**Allowlist gate.** A child ingests ONLY issues carrying at least one label from its
`SCNS_SELF_ISSUE_LABELS` allowlist (comma-separated env). The Cosmere child's allowlist is
`scns-auto`. An issue without an allowlisted label is INVISIBLE to that child — it is
filtered out before priority is even considered.

> **Superseded note (2026-08-10 → 2026-08-14):** an earlier revision of this doc called the
> unlabelled issues #12–#14 in the Cosmere child's (private) repo a "live blind spot" and suggested
> labelling them or widening the allowlist. John decided otherwise on 2026-08-14: those are
> HUMAN-OWNED guardrail issues and their missing label is deliberate. See section 4 for the
> full label-routing policy.

**Priority comes from OTHER labels**, mapped by `priorityForSignal`
(`src/brain/self-issue-source.ts`):

| Labels on the issue                          | Task priority |
| -------------------------------------------- | ------------- |
| `critical`, `security`, `p0`, `urgent`       | Critical      |
| `bug`, `regression`, `p1`, `high`            | High          |
| (failing-test signals, regardless of labels) | High          |
| anything else — including `scns-auto` alone  | Normal        |

**The pre-W1 trap, for the record:** an issue labeled ONLY `scns-auto` (+ e.g.
`enhancement`) passed the allowlist but mapped to Normal — and before the R1 fix the
brain's Consolidate branch preempted Normal tasks on every wake whenever consolidation
looked stale, so such issues sat in the queue forever (13,825+ consecutive consolidate
decisions on the Cosmere child). R1 closed this: a gate-blocked consolidation now falls
through to task processing. The label mapping itself is unchanged — `scns-auto` alone
still means Normal, which is correct now that Normal tasks actually dispatch.

Dedup/lease lifecycle: a signal is skipped only while it is actively handled — a durable
lease (`in-progress`/`done` in the self-issue tracker), the attempt cap
(`SCNS_SELF_ISSUE_MAX_ATTEMPTS`, default 3), or presence in the live in-memory queue.
Restart loss is transient: the queue is rebuilt on the next ingest tick (~15 min).

## 2. Two control planes over one consolidation executor (design intent)

Both of these paths funnel into the SAME gated executor, `dreamDaemon.run()`
(`src/dream/dream-daemon.ts`), which applies the lock/time/count gates
(`src/dream/dream-gates.ts`) itself:

1. **Adaptive plane — the brain's Consolidate branch** (`src/brain/decision-tree.ts`).
   Fires when consolidation looks stale relative to `consolidationThreshold`, i.e. it
   reacts to observed staleness. Since R1 it also requires the executor's own gate check
   (`dreamDaemon.getStatus().gateCheck.canRun`, wired as the brain's `canConsolidate`
   dep) so it never decides an action the executor would refuse.
2. **Wall-clock plane — the `dream-consolidation` scheduled task** (cron, task
   scheduler). A backstop that runs on schedule regardless of what the brain is doing,
   so consolidation still happens if the brain is idle, wedged, or disabled.

This duplication is INTENTIONAL: adaptive trigger + wall-clock backstop, one executor,
one set of gates. Do not delete either plane; fix entry conditions instead (that was the
R1 lesson). Honest accounting (R3): a gate-skipped run records scheduler
`last_status='skipped'` (with the failed gate name), never `'success'`.

## 3. Onboarding checklist — pointing SCNS at a new project

When registering a new project with the meta-broker (`scns meta-broker register`):

- [ ] **Livelock fix deployed (W1/R1):** the child's build includes the gate-aware
      Consolidate entry (`canConsolidate` wired in `cli.ts`); without it a never-run
      child starves its own task queue.
- [ ] **Consolidation material sensor chosen (W3/R2):** decide what counts as "new
      material" for this child's count gate. Children get no CLI session-end hooks
      (machine-wide session observers are deliberately disabled for children —
      Track-2 encapsulation), so the default `sessions_since_last_run` counter never
      fills on its own. Recommended sensor: the child's own team-completion events.
      Whatever is chosen must be stated explicitly — never soften the gate silently.
- [ ] **Issue intake configured:** `SCNS_SELF_ISSUE_REPO` set (or derivable), the
      allowlist label (e.g. `scns-auto`) created in the repo and applied to intake
      issues, and priority labels (`bug`/`high`/`p1`/`security`…) used deliberately.
- [ ] **Feedback routed (W5):** the project is registered with the meta-broker so
      `GET /api/meta/resolve` maps its root (and any subdirectory) to the child's
      bound port — registering the project is SUFFICIENT for the Copilot extension to
      route `scns_report_negative_feedback` to it. Verify the tool's response echoes
      `storedAt: project:<id> @ http://127.0.0.1:<port>`.
- [ ] **Queue observable (W2/R3):** `GET /api/brain/status` on the child exposes
      `taskQueueDepth` (the REAL task queue) alongside `pendingSuggestions`; a stuck
      queue is visible, and gate-skipped dream runs show as `skipped` in the scheduler
      history.

## 4. The `scns-auto` label — curated per-issue opt-in (John's decided policy, 2026-08-14)

`scns-auto` means: **"SCNS may autonomously pick this issue up and spawn a team for it."**
It is granted per issue, by a human who has read the issue body — never in bulk, never by
default, never inferred. These rules are authoritative; a fresh audit session must be able
to file issues correctly from this section alone.

1. **Adding the label is a curated human act.** A human reads an issue body and adds
   `scns-auto` deliberately. Never add `scns-auto` to an EXISTING issue on SCNS's behalf —
   if an issue seems like it should be automated, say so in a comment and let John label it.
2. **A missing label is a decision, not an oversight.** HUMAN-OWNED guardrail issues (e.g.
   the Cosmere child's #12–#14) omit the label on purpose. Do not "fix" an unlabelled issue by
   labelling it, and do not treat unlabelled issues as a backlog bug.
3. **One narrow exception for audits filing NEW issues:** an audit may create a new issue
   carrying `scns-auto` directly ONLY when the issue is well-specified and machine-safe —
   crisp acceptance criteria a fresh team can land without judgment calls, no guardrail or
   policy content, no destructive or irreversible steps. When in doubt, file WITHOUT the
   label and let John opt it in.
4. **Never blank or widen the allowlist.** The plist ships
   `SCNS_SELF_ISSUE_LABELS=scns-auto` (comma-separated allowlist, parsed in `src/cli.ts`).
   An EMPTY allowlist ingests EVERYTHING (issue #13). Routing changes happen per issue via
   the label, not by loosening the gate.
5. **Machinery issues use `scns:self-improvement`, never `scns-auto`.** The drift
   watchdog, the NORTH_STAR nudge, and self-improvement gap filings all carry
   `scns:self-improvement` only — tracking issues describe work for humans to triage, not
   work pre-approved for autonomous pickup.
