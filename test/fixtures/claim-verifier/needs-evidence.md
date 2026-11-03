# Findings

Heartbeat cleanup runs live in production every 30 seconds — I checked and it works [live-confirmed].

The rotation watchdog is unwired: no caller of createWatchdogDaemon found in source [code-only].
