# T150 — backfill-pool baseline, and the Phase 11 premise check

**Task**: T150 (`specs/003-label-integrity-defects/tasks.md:935`), US11 / Phase 11.
**Date**: 2026-08-06. **Branch**: `003-us11-backfill-resurfacing` off `main` @ `51b36b9`.
**Probe**: `selectWeeklyPacket()` called directly on the live store. `scns review weekly` was **not** run
(it is a writer — `tasks.md:930-934`).

## 0. Read-only assertion

The probe reads the status directories with `readdirSync`/`readFileSync` and parses with
`parseSuggestion`. It deliberately does **not** use `createSuggestionStore()`, because `list()` calls
`ensureDirs()` → `mkdirSync` (`suggestion-store.ts:121-124`), which is a write path.

`mtime`+`size` captured for all 158 paths under `~/.scns/suggestions` immediately before and after every
probe in this document:

```
=== diff before/after (empty == unchanged) ===
NO DIFF — mtime and size unchanged on all 158 paths
06d296da6409bc6e5493240bd93d9069ba58fac86fbe5ef3f64e989bd4b3802b  before.tsv
06d296da6409bc6e5493240bd93d9069ba58fac86fbe5ef3f64e989bd4b3802b  after.tsv
```

The broker on `:3456` was not started, stopped or signalled. `POST /api/extension/context` was not probed.

## 1. The recorded baseline in `tasks.md` is stale — re-measured

`tasks.md:938-940` pins `totalUnexplained=116`, `selectedBackfill=2`, rank `63 of 116`,
`priority=1.0116`, `updatedAt=2026-08-04T16:54:14.405Z`. Session `84d5b6e1` repaired the live row on
2026-08-05 at John's instruction, so those numbers no longer describe the store. Measured now:

```
=== live store composition (parsed) ===
pending           10
approved          0
in-progress       0
implemented       45
rejected          55
needs-human       19
failed            0
archive           4
blocked-autonomy  1
TOTAL             134

=== constants ===
DEFAULT_BACKFILL_SLOTS = 2
DEFAULT_WEEKLY_BUDGET  = 5
STALE_AFTER_DAYS       = 30
probe now              = 2026-08-06T02:43:02.932Z

=== selectWeeklyPacket(live) ===
totalUnexplained     = 107
selectedBackfill     = 2
selectedPending      = 3
selectedEscalated    = 5
totalEscalated       = 9
totalPending         = 14
nonActionablePending = 0
budget               = 5

=== backfill ranking (unexplained pool = 107) ===
65a914f4-b229-4fde-874e-c46a44dd845f rank 107 of 107
  priority      = 0.0015599229938271606
  status        = implemented
  updatedAt     = 2026-08-05T23:30:30.588Z
  createdAt     = 2026-05-13T05:36:17.587Z
  reviewedAt    = 2026-08-05T23:30:30.590Z
  reviewVerdict = "approve"
  reviewReason  = "human:cheap-win:"
  machineReason = "machine:applied-and-verified: pyright registered in ~/.copilot/lsp-con"
  attemptCount  = 0
  weeks to surface at 2/week = 54
```

| | `tasks.md` baseline (2026-08-05) | measured now (2026-08-06) |
|---|---|---|
| `totalUnexplained` | 116 | **107** |
| `selectedBackfill` | 2 | 2 |
| `DEFAULT_BACKFILL_SLOTS` | 2 | 2 |
| `65a914f4` rank | 63 of 116 | **107 of 107 — dead last** |
| `65a914f4` priority | 1.0116 | **0.00156** |
| `65a914f4` `updatedAt` | 2026-08-04T16:54:14.405Z | **2026-08-05T23:30:30.588Z** |
| projection | ~32 weeks | **~54 weeks** |

The repair made the ranking **worse**, because both scoring terms collapsed at once: the status moved
`rejected → implemented` so `rejectionBonus` went 1 → 0 (`weekly-review.ts:256`), and a machine write
moved `updatedAt` to ~now so `W_STALENESS * age` went ~0.0116 → ~0.0016 (`weekly-review.ts:257`).

## 2. Premise check — what Phase 11 says to build, versus what the code and the live store say

Three of Phase 11's premises are refuted by measurement. One is confirmed, and one new defect is found.

### 2.1 REFUTED — "the only 2026-08-05 item with a live unresolvable violation behind it"

`tasks.md:927-929` justifies taking Phase 11 first on the grounds of a live SC-029 violation. Running the
real census (`censusQgMislabels`, read-only):

```
scanned                     = 148
unreadable                  = 0
violations (SC-029)         = 0
  verdict-intact            = 0
  verdict-erased            = 0
  zeroAttempts              = 0
machineWrittenRefusals      = 0
```

**Zero.** `censusQgMislabels` scopes the signature to `status: rejected`
(`qg-mislabel-census.ts:31` `HUMAN_REFUSAL_STATUS = 'rejected'`, enforced at `:141`), and the repair moved
`65a914f4` out of `rejected`. The violation Phase 11 exists to make resolvable no longer exists.

### 2.2 REFUTED — T149's structural block, and `65a914f4`'s eligibility for either fix

T149 records `65a914f4` as `status: rejected`, `attemptCount: 0`, `reviewVerdict` cleared. It is now
`status: implemented` with `reviewVerdict: "approve"` standing and
`machineReason: "machine:applied-and-verified: …"`. Consequences:

- It **no longer matches the SC-029 signature** (no `qg-fail:` machine reason, and a standing verdict), so
  FR-071's reserved lane would never catch it however the lane is built.
- Its `reviewedAt` is `2026-08-05T23:30:30.590Z` — written by a *machine* status transition
  (`suggestion-store.ts:383` bumps `reviewedAt` unconditionally). So FR-070 scoring from the last human
  decision **also** reads it as freshly decided, and will not move it either.

**Neither half of Phase 11 surfaces `65a914f4`.** It remains in the backfill pool only because
`reviewReason: "human:cheap-win:"` has empty prose, so `hasHumanRationale` is false
(`review-reason.ts:309-313`) — i.e. the one thing still missing from it is John's *why*, not his verdict.

### 2.3 REFUTED as written — T155's "reserved lane", because the lane already exists

`weekly-review.ts:299-325` already builds an `escalated` pool that surfaces `qg-fail:` items at
`priority: Number.MAX_SAFE_INTEGER` (`:309`) with a deterministic tie-break (`:321-323`, `updatedAt` then
`id`) and a disclosed cap (`totalEscalated`). Every row carrying a `qg-fail:` machine reason with no
verdict in the live store is **already** surfaced by it:

```
=== SC-029 census signature across ALL statuses ===
count = 9
  0e404fde status=needs-human  attempts=0 escalation="gate-exhausted" kindOf="gate-exhausted" gateExhausted=true
  4d0f2d96 status=needs-human  attempts=0 escalation="gate-exhausted" kindOf="gate-exhausted" gateExhausted=true
  70b8bcc5 status=needs-human  attempts=0 escalation="gate-exhausted" kindOf="gate-exhausted" gateExhausted=true
  71b0181f status=needs-human  attempts=0 escalation="gate-exhausted" kindOf="gate-exhausted" gateExhausted=true
  76707c3d status=needs-human  attempts=0 escalation="gate-exhausted" kindOf="gate-exhausted" gateExhausted=true
  9872e17a status=needs-human  attempts=0 escalation="gate-exhausted" kindOf="gate-exhausted" gateExhausted=true
  af489c08 status=needs-human  attempts=0 escalation="gate-exhausted" kindOf="gate-exhausted" gateExhausted=true
  e8cd6d62 status=needs-human  attempts=0 escalation="gate-exhausted" kindOf="gate-exhausted" gateExhausted=true
  f4366b86 status=needs-human  attempts=0 escalation="gate-exhausted" kindOf="gate-exhausted" gateExhausted=true

surfaced by the EXISTING escalated lane: 9 of 9
NOT surfaced (the FR-071 hole):          0
```

The `attemptCount: 0` hole the handoff expected is already closed: all nine carry an explicit
`escalation: "gate-exhausted"` tag, so `escalationKindOf` (`escalation.ts:51-54`) returns the tag and never
reaches the `attemptCount > 0` legacy sniff.

**Building a second lane is therefore rejected.** It would reintroduce exactly the "duplicated readers
drift and disagree about the same file" failure that `escalation.ts:14-18` exists to eliminate, to serve a
population of zero.

**But a real, structural hole remains, and it is a different one than the handoff predicted.**
`escalationKindOf` returns `null` for every `status !== 'needs-human'` (`escalation.ts:52`), while the
SC-029 census signature is defined **only** at `status: rejected` (`qg-mislabel-census.ts:31`). The two
predicates are **disjoint by construction**: a census violation can never, at any time, for any row, be
surfaced by the escalated lane. That disjointness is precisely what made T149 unsatisfiable in the first
place. It is empty today only because the repair emptied it.

**Ruling for T155**: define the census signature **once**, status-agnostically, in `escalation.ts`
beside `escalationKindOf` — reusing a single `qg-fail:` constant, which is currently copy-pasted in three
modules (`escalation.ts:39`, `qg-mislabel-census.ts:34`, `qg-mislabel-repair.ts:73`) — and widen the
**existing** escalated lane's membership to include it. `escalationKindOf` keeps its `needs-human` scoping,
because "which kind of `needs-human` is this" is genuinely meaningless for other statuses and `repromote`
and triage depend on that scoping. This is consolidation, not a second lane. On today's store it admits
**0** additional rows, so it ships as a structural guard with a test, not as a behaviour change.

### 2.4 CONFIRMED — FR-070 is a real, live defect, and it is worse than `weekly-review.ts:257` alone

`weekly-review.ts:257` `staleness(input.now, s.updatedAt || s.createdAt)` is the expression T154 names.
But switching it to `reviewedAt` would **not** satisfy FR-070b, because
`suggestion-store.ts:383` sets `reviewedAt: new Date().toISOString()` on *every* `updateStatus` call —
including `author: 'machine'` writes (`:377`), which are threaded from real call sites
(`quality-gate-arbiter.ts:1168`, `review.ts:159/185/193`, `proposal-triage-run.ts:97/108`, `cli.ts:3896/3947/3956`).

So the machine resets the clock in **two** places, and both must change or the fix is cosmetic. The second
one is also a live truthfulness defect on a human-facing surface: `weekly-session.ts:157` renders
`at: s.reviewedAt ?? s.updatedAt` as *when John reviewed the item*, and that feeds `assessEngagement`,
which gates an autonomy raise.

### 2.5 NEW — the backfill lane buries a 20-deep tie in UUID order, permanently

The 32-week projection is a symptom of a more general defect that no task names. Measured:

```
=== priority TIE distribution in the backfill ranking ===
  priority 1.350000: 20 item(s)
  priority 1.049729: 2 item(s)
  priority 1.049728: 2 item(s)
  ...

  TOP bucket priority=1.350000 holds 20 items against 2 slots.
  Order inside it is decided by id.localeCompare (UUID order) — createdAt for each:
    1. id=0fd967ba createdAt=2026-04-16T16:40:30.602Z
    2. id=1a421b57 createdAt=2026-04-17T02:12:16.918Z
    3. id=1cff5056 createdAt=2026-04-15T22:54:48.177Z
    4. id=1dcf697f createdAt=2026-04-15T23:16:32.005Z
    5. id=31c280b3 createdAt=2026-04-15T22:54:48.179Z
    ...
  If tie-broken by OLDEST-FIRST instead, the two surfaced would be:
    1. id=e5767000 createdAt=2026-04-15T22:03:27.306Z
    2. id=1cff5056 createdAt=2026-04-15T22:54:48.177Z
  Items in the top bucket that UUID order can NEVER reach at 2/week while the bucket does not drain: 18
```

Twenty items are already pinned at the staleness cap (`STALE_AFTER_DAYS = 30`, and these are ~110 days
old), so `priority` is identical to the last decimal and the sort falls through to
`a.item.id.localeCompare(b.item.id)` (`weekly-review.ts:281`) — a random v4 UUID that never changes.
`0fd967ba` and `1a421b57` win every week forever; the genuinely oldest item, `e5767000`, is unreachable.

This is the same defect the escalated lane already fixed — its `sortKey: s.updatedAt` carries the note
*"an id is a random v4 UUID that never changes … the same `budget` items held the entire window every
single week and everything behind them was unreachable"* (`weekly-review.ts:317-323`) — still live in the
backfill lane. And FR-070 makes it **worse**, not better: scoring maximal staleness for every item with no
surviving human decision moves more items into the tied top bucket.

T155 already requires the fix: *"make ties between two maximally-stale items deterministic and
explainable, not incidental to storage order."* Ordering is currently deterministic but neither
explainable nor drainable.

## 3. What this branch will therefore build

| Task | Ruling | Change |
|---|---|---|
| T151–T153 | as written | Red tests for FR-070a/b/c. |
| T154 | as written, **plus its root cause** | Score backfill staleness from the last surviving human decision; delete `staleness(now, s.updatedAt \|\| s.createdAt)` in the same change. **And** stop `updateStatus` bumping `reviewedAt` on machine writes, without which FR-070b is unsatisfiable. |
| T155 | **re-framed** | (a) One status-agnostic census-signature predicate in `escalation.ts`, wired into the **existing** escalated lane — not a second lane. (b) Tie-break maximally-stale backfill items oldest-first, then id, so the 20-deep tied bucket drains instead of re-showing the same two UUIDs forever. |
| T156 | as written | Re-run this probe, quote rank before/after, assert stored history byte-identical. |

## 4. For John — two items that are your call, not mine

1. **T149's prohibition vs. the repair.** T149 says *"do not relabel the file to unblock this."* Session
   `84d5b6e1` relabelled `65a914f4` because you instructed it to fix the row. Same file effect, different
   motive. `tasks.md` was never updated to record it, and the SC-029 census now reads 0 as a result.
   Nothing in this branch re-edits that row in either direction.
2. **`65a914f4` is not reachable by either half of Phase 11** (§2.2). Its verdict and its implementation
   are both intact; the only thing still missing is your *reason*. If you want it in front of you, that is a
   T149 re-decision, not a ranking change — and after §2.5 it will sit behind 20 genuinely-older items
   rather than behind a UUID sort.

## 5. Reproduction

Probe scripts: `~/.copilot/session-state/d396fe55-13d3-4f38-b6d7-42a32de7d6d1/files/`
(`t150-probe.mjs`, `snapshot.sh`). Built from `51b36b9` via `npm run build` (exit 0).
