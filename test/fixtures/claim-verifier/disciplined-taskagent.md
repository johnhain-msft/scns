# Findings Summary

Evidence level: source-code/read-only investigation; broker was not run.

## 1. Broker scheduler tick
Therefore, the scheduler tick actually executes only those seven handler-backed tasks when due. The heartbeat-poller, zombie-cleanup, rotation-watchdog, newsletter-daily, and realestate-news-learner rows are present/enabled but have no registered scheduler handler.

## 2. Heartbeat poller and zombie cleanup
Heartbeat/zombie cleanup does not run through the broker task scheduler. The scheduled task rows heartbeat-poller and zombie-cleanup are not wired to scheduler handlers.

## 3. Rotation watchdog production wiring
createWatchdogDaemon is not active in production from source wiring. It is exported but source search shows no production caller of createWatchdogDaemon; only tests and exports reference it.

## 4. newsletter-daily and realestate-news-learner
Therefore the SCNS broker scheduler does not execute these jobs. If they run, they are expected to run outside the broker via the launchd jobs named in the descriptions.
