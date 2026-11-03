I have traced the full execution paths from source. All claims below are code-traced ([code-only]) — this was a read-only static investigation, not a live broker run.

## Findings: SCNS broker background-job execution

### Q1 — Tasks that actually run on the scheduler tick
Only seeded cron rows that ALSO have a registered handler execute. Seeded, enabled cron rows with no handler → no-op on the tick: rotation-watchdog, newsletter-daily, realestate-news-learner.

### Q2 — Heartbeat-poller & zombie-cleanup
Run on a dedicated setInterval, independent of the scheduler and not a scheduled_tasks row. startHeartbeatPoller (startup.ts:751-760); interval default 30s.

### Q3 — Rotation-watchdog in production?
Not active/automatic. createWatchdogDaemon is only exported and defined; grep across src/ finds no caller/instantiation (unwired dead code). The seeded rotation-watchdog cron row has no registered handler, so the scheduler skips it.

### Q4 — newsletter-daily & realestate-news-learner
They do not execute through the broker. Both are seeded, enabled cron rows but have no registerTaskHandler → skipped every tick. They run via external macOS launchd agents (com.morningpod.daily / com.realestate.newslearner).

## Summary
1. Scheduler tick runs only handler-backed rows.
2. Heartbeat/zombie cleanup runs on its own 30s setInterval poller, separate from the scheduler.
3. Rotation-watchdog is NOT active in production: createWatchdogDaemon has no caller.
4. newsletter-daily & realestate-news-learner run via external launchd agents, not the broker scheduler.

Caveat: all conclusions are code-only/inferred (static read). To confirm at runtime, check task_run_history for the 7 handler-backed IDs vs the 3 handler-less IDs, and confirm zombie_cleaned events carry cleanup_source:'heartbeat_poller'.
