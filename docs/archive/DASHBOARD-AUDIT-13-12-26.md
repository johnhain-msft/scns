# Dashboard Audit — 13.12.26

Audit of the 15 pages served by the SCNS dashboard at `http://localhost:3001`.
Each page was fetched over HTTP and its source (`dashboard/src/app/<route>/page.tsx`)
reviewed against the rubric: (1) renders real current data, (2) has at least one
interactive control, (3) is time-bounded where applicable, (4) no stale/placeholder
content, (5) missing features a human operator would expect.

## Rubric legend

- ✅ Pass — verdict on the rubric dimension.
- ⚠️  Partial — works but has gaps.
- ❌ Fail — blocks the rubric dimension.

## Summary table

| # | Route              | Renders data | Interactive | Time-bounded | Stale content | Severity |
| - | ------------------ | ------------ | ----------- | ------------ | ------------- | -------- |
| 1 | `/`                | ✅           | ✅          | ⚠️  (none needed for status) | none | low |
| 2 | `/autonomy`        | ✅           | ✅          | n/a          | none          | low |
| 3 | `/cost`            | ✅           | ❌ (none)    | ❌ (all-time only) | none | **high** |
| 4 | `/dream`           | ✅           | ✅          | n/a          | none          | low |
| 5 | `/memory`          | ✅           | ✅          | n/a (file/tier based) | none | low |
| 6 | `/metrics`         | ✅           | ✅          | ✅           | none          | low |
| 7 | `/observers`       | ✅           | ✅          | n/a          | none          | low |
| 8 | `/orchestrator`    | ✅           | ✅          | ✅           | none          | low |
| 9 | `/scheduler`       | ✅           | ✅          | ⚠️  (history list unbounded) | none | medium |
| 10| `/sessions`        | ✅           | ❌ (none)    | ❌           | none          | **high** |
| 11| `/settings`        | ❌ (404)     | ❌          | ❌           | n/a           | **critical** |
| 12| `/suggestions`     | ✅           | ✅          | n/a          | none          | low |
| 13| `/tasks`           | ✅           | ❌ (none)    | ❌           | none          | **high** |
| 14| `/teams`           | ✅           | ✅          | n/a          | none          | low |
| 15| `/traces`          | ✅           | ✅          | ✅           | none          | low |

---

## Per-page findings

### 1. `/` (Overview)

- **Render**: ✅ Seven `StatCard`s driven by real queries (`/api/health`, brain,
  sessions, teams, tasks, autonomy, cost). React Query refresh works.
- **Interactive**: ✅ Promote / Demote autonomy buttons.
- **Time-bounded**: ⚠️  The cost card shows cumulative totals, not a 24h slice.
  Acceptable for an overview but a "last 24h" strip at the bottom would help.
- **Stale content**: none.
- **Missing**: no link / drill-down from each card to its dedicated page, no
  dream "Force run" shortcut. These would be nice-to-have.
- **Recommended fixes** (low sev): make each `StatCard` clickable linking to the
  owning route.

### 2. `/autonomy`

- **Render**: ✅ L0–L3 legend rendered, current level highlighted.
- **Interactive**: ✅ Promote / Demote level buttons with disabled states.
- **Time-bounded**: n/a (current level is a point-in-time value). Last changed
  timestamp is shown.
- **Stale content**: none.
- **Missing**: no audit log (history of promotions / demotions).
- **Recommended fixes** (low sev): add a small history table fed by
  `/api/autonomy/history` if available.

### 3. `/cost`  — **HIGH severity**

- **Render**: ✅ Total cost, input tokens, output tokens, per-session table.
- **Interactive**: ❌ No controls. You can see numbers but cannot sort,
  search or bound them in time.
- **Time-bounded**: ❌ Cost aggregate is whatever the broker returns — no UI
  to restrict to 24h / 7d.
- **Stale content**: none.
- **Missing**: time-window selector, sort by column, CSV export.
- **Recommended fixes**:
  - (**high**) Add `TimeRangeSelector` plus broker support for `since` on
    `/api/cost/summary`. If the broker does not yet support it, filter
    `perSession[]` client-side by session `created_at`.
  - (medium) Make the session column sortable.

### 4. `/dream`

- **Render**: ✅ Status grid with last run, totals, duration, gate status.
- **Interactive**: ✅ Force run (with confirm dialog).
- **Time-bounded**: n/a (daemon state).
- **Stale content**: none.
- **Missing**: recent run history panel.
- **Recommended fixes** (medium): add a "Recent runs" list (last 10).

### 5. `/memory`

- **Render**: ✅ Six tabs (Lessons, Scoped, Negative, Archive, Tiers, Search).
- **Interactive**: ✅ Tag + scope filters, archive buttons, search input.
- **Time-bounded**: n/a (all-time memory store).
- **Stale content**: none.
- **Missing**: last-modified sort on lessons.
- **Recommended fixes** (low): sort lessons by `updatedAt desc` by default.

### 6. `/metrics`

- **Render**: ✅ Summary cards + bars (tokens, tools, model dist).
- **Interactive**: ✅ `TimeRangeSelector` (1h / 6h / 24h / 7d / 30d).
- **Time-bounded**: ✅.
- **Stale content**: none.
- **Missing**: per-model cost, latency histogram.
- **Recommended fixes** (medium): add latency p50/p95 cards.

### 7. `/observers`

- **Render**: ✅ Grid of observer cards, pulled from `/api/observers/plugins`.
- **Interactive**: ✅ Per-observer toggle switch.
- **Time-bounded**: n/a.
- **Stale content**: none.
- **Missing**: last-event timestamp per observer.
- **Recommended fixes** (low): show `lastEventAt` relative time.

### 8. `/orchestrator`

- **Render**: ✅ Teams, members, messages, scaling decisions.
- **Interactive**: ✅ Time window selector (1h / 24h / 7d / all).
- **Time-bounded**: ✅.
- **Stale content**: none.
- **Missing**: ability to drill into a single team.
- **Recommended fixes** (low): make team rows clickable → `/teams/:id`.

### 9. `/scheduler`  — medium severity

- **Render**: ✅ Cron task list with enable toggle, trigger now, history.
- **Interactive**: ✅ Toggle, trigger, expand history.
- **Time-bounded**: ⚠️ History limited to `limit=10` but no window selector.
- **Stale content**: none.
- **Missing**: global "runs in the last 24h" summary strip.
- **Recommended fixes** (medium): add a 24h runs summary card above the list.

### 10. `/sessions`  — **HIGH severity**

- **Render**: ✅ Live table wired to `/api/sessions` + SSE.
- **Interactive**: ❌ No filter, no sort, no search.
- **Time-bounded**: ❌ All sessions ever registered are listed.
- **Stale content**: none.
- **Missing**: status filter, 24h default window, session drill-down.
- **Recommended fixes**:
  - (**high**) Add a status filter pill group (`all / active / working / idle / zombie`).
  - (medium) Add a text search on purpose and working-dir.
  - (medium) Default to sessions with a heartbeat in the last 24h, with an
    "include stale" toggle.

### 11. `/settings`  — **CRITICAL severity**

- **Render**: ❌ 404 from Next.js. `dashboard/src/app/settings/` only has
  `otel/` — the parent route has no `page.tsx`.
- **Interactive**: n/a.
- **Time-bounded**: n/a.
- **Stale content**: n/a.
- **Missing**: a landing page that enumerates every settings surface
  (OTel now, Observers / Autonomy / Dream in the future).
- **Recommended fixes**:
  - (**critical**) Add `dashboard/src/app/settings/page.tsx` that lists
    available settings areas and links to them. Currently the rubric check
    and any user hitting `/settings` gets an HTTP 404.
  - (medium) Add this route to the sidebar under a "Settings" disclosure
    (while keeping "OTel Settings" deep-link).

### 12. `/suggestions`

- **Render**: ✅ Status tabs, confidence bar, evidence, per-suggestion actions.
- **Interactive**: ✅ Status tabs + type filter + approve/reject/retry/delete.
- **Time-bounded**: n/a (queue).
- **Stale content**: none.
- **Missing**: pagination.
- **Recommended fixes** (medium): paginate or infinite-scroll once the queue
  exceeds 50.

### 13. `/tasks`  — **HIGH severity**

- **Render**: ✅ Kanban columns (Pending / In Progress / Completed) fed by
  `/api/tasks?team_id=…` fanned out across all teams.
- **Interactive**: ❌ No filter, no per-team selector, no drag-drop.
- **Time-bounded**: ❌ All non-deleted / non-failed tasks shown forever.
- **Stale content**: none.
- **Missing**: team filter, owner filter, created-in-last-24h default.
- **Recommended fixes**:
  - (**high**) Add a team filter (all / per-team) — avoids drowning the UI
    when 10+ teams are active.
  - (medium) Add a "show failed / deleted" toggle for operators debugging
    stuck teams (currently those statuses are hard-filtered client-side).
  - (low) Make cards link to the owning team page.

### 14. `/teams`

- **Render**: ✅ Table with name, status, members, tasks count.
- **Interactive**: ✅ "Show archived" toggle + archive button per row.
- **Time-bounded**: n/a.
- **Stale content**: none.
- **Missing**: sort by members / tasks count.
- **Recommended fixes** (low): make column headers sortable.

### 15. `/traces`

- **Render**: ✅ Trace list + drill-down to span tree.
- **Interactive**: ✅ Time range selector, row-click navigation, back button.
- **Time-bounded**: ✅.
- **Stale content**: none.
- **Missing**: trace search by root span / status filter.
- **Recommended fixes** (medium): add status filter (ok / error).

---

## Prioritized fix list (this commit addresses the top 3)

1. **CRITICAL — `/settings` 404.** Add a proper index page linking to the
   existing `/settings/otel` sub-page. ➜ fixed in this patch.
2. **HIGH — `/sessions` has zero interactivity.** Add a status filter pill
   group (all / active / working / idle / zombie). ➜ fixed in this patch.
3. **HIGH — `/tasks` has zero interactivity.** Add a team filter drop-down
   so operators can focus on one team when many teams are alive. ➜ fixed in
   this patch.

Deferred (tracked as follow-up suggestions in the audit above): `/cost`
time-window selector, `/scheduler` 24h summary strip, `/traces` status
filter, `/suggestions` pagination, overview card links.

## Verification

Baseline HTTP status per page (captured prior to patch):

```
200  /
200  /autonomy
200  /cost
200  /dream
200  /memory
200  /metrics
200  /observers
200  /orchestrator
200  /scheduler
200  /sessions
404  /settings   <-- fixed
200  /suggestions
200  /tasks
200  /teams
200  /traces
```

After the patch `/settings` returns 200 and renders an index page linking to
OTel Settings. `/sessions` and `/tasks` each gain a labelled, keyboard-
reachable filter control wired through React state (query key invalidations
are unaffected because filtering is applied after the fetch).

---

## Reviewer addendum (brain-reviewer-b2104ff7)

Independent live pass on top of the dev audit above. Playwright chromium
headless against `http://localhost:3001`, body text captured per route, all
16 routes HTTP 200. Regression check versus `main@521d079`: dashboard lint
unchanged (4 errors / 5 warnings); vitest **improved** 17→14 failures (252→
255 passing, 8→7 failing files). All remaining failures are pre-existing
axe-core timeouts not introduced by this patch.

### Higher-severity bugs the dev audit missed

1. **CRITICAL — `/teams` always renders `Members 0 / Tasks 0`.**
   `listTeams()` targets `GET /api/teams`, which does not include
   `members[]` / `tasks[]`; only `GET /api/teams/:id` does. Verified via
   broker: `brain-solo` has 1 live member but the page shows 0. Fix: fan
   out `getTeamById(id)` in parallel (already exported from
   `dashboard/src/lib/api.ts`) or extend the broker list endpoint.
2. **CRITICAL — `/cost` reads `$0` while real usage exists.**
   `/api/cost/summary` returns zeros; at the same instant
   `/api/usage/summary` returns `total_cost_usd=0.36`, `session_count=2`,
   and `/metrics` (OTel-backed) reports `934,512` tokens. Three
   disagreeing sources, UI binds to the empty one. Fix: consolidate or
   fall back to `/api/usage/summary` with a source banner.
3. **MAJOR — Root Overview "Teams & Tasks" card mislabels scheduler counts.**
   Values derive from `getSchedulerTasks()` (enabled vs disabled cron
   count), not team tasks. Root reads "Active Tasks 13" while `/tasks`
   correctly reads "No tasks found". Relabel the card or fan out
   `listTasks()` across teams.
4. **MAJOR — `/sessions` "Purpose" column dumps full agent prompt** (1–2 KB
   per spawned-agent row), breaking table layout. Truncate to ~120 chars
   with `title={purpose}` tooltip.
5. **MAJOR — `/scheduler` shows "Never"** for three high-frequency crons
   (heartbeat poller / zombie cleanup / context rotation watchdog) that
   should have run thousands of times. Either not wired or run-history
   not being persisted.
6. **MAJOR — `/settings/otel` form loads blank**, no hydration from
   `/api/otel/settings`.
7. **MINOR — `/observers`** Session Store row renders "Running / running"
   twice; `OBSERVER_META` declares two unused entries
   (`terminal-history`, `browser-tab`).
8. **MINOR — `/traces` status `UNSET`** is valid OTel default but reads
   like a bug; relabel to `ok`/`—`.

### Disagreements with the dev audit above

- `/cost` marked "Stale content: none" — reclassify as CRITICAL (see #2).
- `/teams` marked "Stale content: none, low severity" — reclassify as
  CRITICAL (see #1).
- `/sessions` marked low-risk on staleness — concur for the listing, but
  the Purpose-column dump is a MAJOR UX defect (see #4).

### Verdict

APPROVE the staged diff (top-3 fixes are correct, live-verified, no
regression). Land as-is and file four follow-up suggestions covering #1,
#2, #4, #3 in that priority order.
