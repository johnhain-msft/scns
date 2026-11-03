# Findings: SCNS broker background jobs

The heartbeat-poller, zombie-cleanup and rotation-watchdog scheduler rows are vestigial — they are handled by separate pollers.

The rotation-watchdog is unwired and createWatchdogDaemon has no caller; the newsletter job does not run.

Heartbeat cleanup runs through startHeartbeatPoller's own setInterval, not the scheduler.

newsletter-daily and realestate-news-learner run via external launchd agents.
