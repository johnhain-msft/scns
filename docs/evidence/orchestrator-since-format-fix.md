# Self-audit: orchestrator dashboard staleness — findings

**Team:** team-sugg-4d0f2d96 · **Date:** 2026-09-21

## Summary

Of the five requested items, **four were already satisfied in `HEAD` before this branch** — but the
suggestion's core symptom (orchestrator dashboard staleness) was real and had a different, deeper
cause than the one described. Item 1 (in-flight excludes `implemented`/`rejected`), item 3
(diagnostic-sender filtering), items 4 and 5 (archived plan docs, `.github/logs/` ignored) were all
verified present and are re-confirmed by existing tests, so no change was needed. Item 2's `?since=`
plumbing was also present — every endpoint parsed the parameter and threaded it into its query — but
it **never actually worked**: `parseSinceParam` emits an ISO-8601 cutoff while every `created_at`
column is written by the SQLite default `datetime('now')`. SQLite has no date type, so `created_at >= ?`
is a plain string comparison; at offset 10 a stored value holds `' '` (0x20) and an ISO cutoff holds
`'T'` (0x54), so **every row sharing the cutoff's calendar date sorted below it and was silently
dropped regardless of how recent it was**. That is the staleness. This branch ships the fix —
a `toSqliteDateTime` normalizer applied at the four repository query boundaries. Nothing was
deferred.

## Why this shipped green

The pre-existing tests seeded fixtures with `new Date(...).toISOString()`, which is **not** how
production writes the column. With ISO on both sides the comparison was consistent and the suite
passed, so the defect was invisible to the tests that were supposed to cover it.

## Evidence

Reproduction is pinned to a fixed UTC date (not wall-clock) so it cannot flake across midnight, and
each case carries a negative control.

```
$ node -e "... WHERE created_at >= '2026-09-20T11:11:13.832Z'"
rows: [{"id":2,"created_at":"2026-09-21 06:00:00"}]      # id=1 @ 2026-09-20 15:00:00 dropped,
                                                          # despite being inside the 24h window
```

| Stage | Command | Result |
| --- | --- | --- |
| Red (before fix) | `vitest run test/unit/broker/routes/orchestrator-since-format.test.ts` | `Tests  6 failed \| 1 passed (7)` — every in-window query returned `[]` |
| Green (after fix) | same | `Tests  7 passed (7)` |
| Regression | `vitest run` on the 4 touched repository suites | `Test Files  4 passed (4)` / `Tests  33 passed (33)` |
| Regression | `vitest run test/unit/broker/routes/orchestrator-routes.test.ts` | `Tests  22 passed (22)` (with the two new files) |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `eslint` on the 6 changed files | exit 0, no findings |

## Item status

| # | Item | Status |
| --- | --- | --- |
| 1 | in-flight excludes `implemented`/`rejected` | Already in `HEAD` (`IN_FLIGHT_SUGGESTION_STATUSES`) — verified, no change |
| 2 | `?since=` on verdicts/completions/scaling-decisions/recent-messages + page selector | Parsing/selector already present but **non-functional**; **fixed here** |
| 3 | Recent Messages excludes `^(test-\|manual-test-\|broadcast$)` | Already in `HEAD` (`DIAGNOSTIC_ID_PATTERN`) — verified, no change |
| 4 | Move `PHASE-12-PLAN.md`, `PLAN.md`, `CLAUDE.md` to `docs/archive/` | Already done — `git ls-files docs/archive/` lists all three; none tracked at root |
| 5 | `.github/logs/` in `.gitignore` | Already done — `git show HEAD:.gitignore` line 23 |

## Changes

- **`src/broker/storage/sqlite-time.ts`** (new) — `toSqliteDateTime`, an idempotent normalizer.
  It short-circuits on already-stored format because `Date.parse('2026-03-15 11:00:00')` would read
  a bare stored value as *local* time and shift it by the UTC offset. Normalizing the **parameter**
  rather than wrapping the column in `datetime(...)` keeps `idx_events_type` and
  `idx_scaling_decisions_created` usable.
- **`message-repository.ts`** — applied at `findAllMessages` and at the `findMessagesForReceiver`
  `since` filter (same defect, same column, one function away).
- **`event-repository.ts`** — applied at both `created_at >= ?` sites.
- **`scaling-outcomes-repository.ts`** — applied at `findRecentScalingDecisions`.

## Scope note

`src/observe/plugins/session-store-poller.ts:89` compares `sessions.created_at > ?` against a
caller-supplied cursor and is the same bug class. It is outside the orchestrator dashboard scope and
was **not** changed here; flagging it rather than fixing it blind.
