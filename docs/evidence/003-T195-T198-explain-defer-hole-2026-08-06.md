# T195 / T198 — the explain-defer hole: red state, premise check, and the policy ruling

**Tasks**: T195, T198 (`specs/003-label-integrity-defects/tasks.md:1053-1069`), US11 / Phase 11a, issue #31.
**Date**: 2026-08-06. **Worktree**: `worktrees/explain-defer-hole`, branch
`fix/explain-defer-drops-signature-items` off `main` @ `68b6451`.
**Written BEFORE any source change** (Constitution III/V). The implementation is T199.

## 0. Read-only assertion

Every probe in this document reads the status directories with `readdirSync`/`readFileSync` and parses
with the shipped `parseSuggestion`. None uses `createSuggestionStore()`, because `list()` calls
`ensureDirs()` → `mkdirSync` (`suggestion-store.ts:346,121-125`) and is therefore a write path.

`mtime`+`size` captured for all 158 paths under `~/.scns/suggestions` immediately before and after
every probe:

```
pre  -> 06d296da6409bc6e  (158 paths)
post -> 06d296da6409bc6e  (158 paths)
LIVE STORE UNCHANGED (mtime+size identical, 158 paths)
```

Same digest as the nine snapshots taken across session `d396fe55`. `scns review weekly` was not run
(it is a writer). `scns suggest repair-labels` was not run. The broker on `:3456` was not started,
stopped or signalled, and `POST /api/extension/context` was not probed.

## 1. Baseline test row, witnessed at `68b6451` in this worktree

The `7589 passed | 2 skipped` row carried in the handoff was measured on the pre-merge branch tip and
nobody had witnessed it at the merge commit. Re-run here:

```
 Test Files  509 passed | 2 skipped (511)
      Tests  7588 passed | 3 skipped (7591)
   Duration  120.91s
```

Same file count, same total (7591), zero failures. One test that passed on the branch tip is
conditionally skipped in this environment. Recorded as an observed difference, not smoothed over.

## 2. T195 — the red state, with a pre-Phase-11 column

Probe: `files/t195-lane-matrix.mjs`, in-memory only. The item under test carries the SC-029 signature
(`machineReason: 'qg-fail:lint:3 errors'`, `attemptCount: 0` — the live shape of `65a914f4`, which
predates attempt counting) and is deliberately the **oldest** row in the fixture, so the matrix
measures pool MEMBERSHIP rather than slot competition. Non-decision fixtures carry exactly what
`recordWeeklyVerdict` persists: status preserved, `reviewVerdict` set, a `human:<code>: <prose>`
reason, and a human-authored `reviewedAt` (`weekly-session.ts:257-267`, `suggestion-store.ts:397`).

The `main` column is **`51b36b9`** — `68b6451^1`, i.e. `main` *before* PR #30 — built from source in a
throwaway worktree. Today's `main` already contains Phase 11, so comparing against it could not have
shown whether the hole predates Phase 11. `matchesCensusSignature` does not exist at `51b36b9`, hence
`n/a`.

| status | John's answer | pre-Phase-11 `51b36b9` | HEAD `68b6451` | verdict |
|---|---|---|---|---|
| `rejected` | untouched | `backfill` | `escalated` | fine |
| `rejected` | **EXPLAIN** | **INVISIBLE** | **INVISIBLE** | 🐛 the defect |
| `rejected` | **DEFER** | **INVISIBLE** | **INVISIBLE** | 🐛 the defect |
| `rejected` | APPROVE | INVISIBLE | INVISIBLE | correct — he decided |
| `rejected` | REJECT | INVISIBLE | INVISIBLE | correct — he decided |
| `implemented` | untouched | INVISIBLE | `escalated` | fixed by PR #30 |
| `implemented` | **EXPLAIN** | **INVISIBLE** | **INVISIBLE** | 🐛 the defect |
| `implemented` | **DEFER** | **INVISIBLE** | **INVISIBLE** | 🐛 the defect |
| `implemented` | APPROVE / REJECT | INVISIBLE | INVISIBLE | correct — he decided |
| `needs-human` | untouched | INVISIBLE | `backfill` | fixed by PR #30 |
| `needs-human` | **EXPLAIN** | **INVISIBLE** | **INVISIBLE** | 🐛 the defect |
| `needs-human` | **DEFER** | **INVISIBLE** | **INVISIBLE** | 🐛 the defect |
| `needs-human` | APPROVE / REJECT | INVISIBLE | INVISIBLE | correct — he decided |

Raw output: `files/t195-A-pre-phase11.txt`, `files/t195-B-head-before-fix.txt`.

**Attribution, settled.** No cell goes visible→invisible across PR #30; two go invisible→visible. The
`explain`/`defer` hole is present at `51b36b9` and unchanged at `68b6451`. **PRE-EXISTING. Not a
Phase 11 regression.** The session-`d396fe55` matrix asserted this from narration after its throwaway
worktree was deleted; this re-derives it from a preserved artefact.

Two incidental findings, both explained by the code and neither a new defect:

- `implemented` + untouched is invisible at `51b36b9` because the backfill sort had no `createdAt`
  tie-break yet — the oldest item lost to 40 younger fillers on UUID order. That is precisely the
  20-way tie PR #30 fixed.
- `needs-human` + untouched lands in `backfill`, not `escalated`, because `escalationKindOf` classifies
  it `gate-refused` (`attemptCount: 0`, no `escalation` tag → `legacyKind`), and only `gate-exhausted`
  enters the lane.

## 3. T198 — premise check: is the prescribed build redundant?

`tasks.md:1070-1072` prescribes "a shared `isDecisionVerdict` helper". **That helper already exists**:
`isDecision(verdict)` with `NON_DECISION_VERDICTS = ['defer','explain']` at
`src/suggest/review-reason.ts:56-60`. Building a second one would be the redundant build T155 already
taught this backlog to check for. **Ruling: reuse `isDecision`. Do not introduce a parallel concept.**

The capability "is this verdict a real human decision?" has five readers. Four agree; one dissents:

| Reader | file:line | Says |
|---|---|---|
| `isDecision` / `NON_DECISION_VERDICTS` | `review-reason.ts:56-60` | `defer`/`explain` are non-decisions |
| `historyFrom` skip | `weekly-session.ts:144-145` | same, inline |
| `wasHumanApproved` | `weekly-review.ts:223-226` | a non-decision verdict says he did not decide |
| `lastHumanDecisionAt` | `weekly-review.ts:182-191` | `approve`/`reject` only |
| **`matchesCensusSignature`** | **`escalation.ts:93-95`** | **any verdict drains — the lone dissenter** |

`weekly-session.ts:258` — the WRITER — already calls `isDecision`. The writer and the reader were using
different rules for the same concept, which is exactly the drift `escalation.ts:14-25` was written to
eliminate: *"Duplicated, so readers can drift and disagree about the same file."* **This defect is that
failure mode occurring inside the module built to prevent it.**

### 3.1 Is one predicate enough? Measured, not assumed.

`weekly-review.ts:248-249` composes `escalationKindOf(s) !== null ? isGateExhausted(s) :
matchesCensusSignature(s)`. Two consequences, both confirmed against the T195 matrix rather than
asserted:

1. **Changing `matchesCensusSignature` cannot alter `needs-human` routing**, because that branch never
   executes for a `needs-human` row. Proof in the matrix: every `needs-human` cell is decided by
   `escalationKindOf`/`isGateExhausted` and the backfill filter alone, and `matchesCensusSignature`
   evaluates identically (`true`) for the untouched `needs-human` row that nonetheless lands in
   `backfill`, never `escalated`. So `repromote` and proposal triage are untouched by this change.
2. **Therefore one predicate is NOT enough.** Fixing only `matchesCensusSignature` restores
   `rejected`/`implemented` × `explain`/`defer` (4 cells) and leaves `needs-human` × `explain`/`defer`
   (2 cells) invisible, because those rows depend entirely on the backfill filter at
   `weekly-review.ts:302-304`, which drops them for `hasHumanRationale`. Conversely, fixing only the
   backfill filter would restore visibility but in the wrong lane — a gate-failure item would land in
   the "tell me why" pool instead of the "decide this" pool.

**Ruling: the fix lands in BOTH predicates, because it is ONE policy with two renderings.**

### 3.2 The policy, stated

> **A question is not a decision, and answering with one must never remove the item from review.**
> An item leaves the escalated lane and the backfill pool only when a standing human DECISION
> (`approve` or `reject`) explains it. `defer` and `explain` write prose and decide nothing, so they
> leave the item exactly where it was.

This is a behaviour change, not a patch: deferred items now resurface until genuinely ruled on. It is
defensible because `defer` means "not now", not "resolved" — and `weekly-review.ts:87` already
documents this as the intended behaviour (*"Only `approve` and `reject` drain this pool; `explain` and
`skip` leave the item escalated"*). **The code did not match its own docblock. This makes it match.**

**Explicitly NOT widened:** an item explained through the verdict-ABSENT seam (a `human:` reason with
no `reviewVerdict`) still counts as decided, exactly as `lastHumanDecisionAt` treats it
(`weekly-review.ts:186`). Widening to "any human prose" would put every explained row in the store back
in the queue forever. That case is pinned by a negative-control test.

### 3.3 How much does this widen the LIVE population? (T198's measurement)

Probe: `files/t198-population-probe.mjs`, read-only, output `files/t198-population.txt`.

```
parsed rows      = 134   (unparseable, skipped = 2)
by status        = blocked-autonomy=1 implemented=45 needs-human=18 pending=14 rejected=56
terminal rows    = 119

=== BEFORE — from the shipped selector ===
totalEscalated   = 9    (selected 5, budget 5)
totalUnexplained = 107    (selected 2, slots 2)

=== the population a non-decision verdict describes ===
rows with reviewVerdict in {defer,explain}, whole store = 2
  ... of those, TERMINAL (the only rows either pool reads) = 1
    0dfe7c86 status=rejected verdict=explain sig=false rationale=true

=== PROJECTED — predicate 1: matchesCensusSignature widens to non-decisions ===
rows NEWLY entering the reserved lane = 0
totalEscalated: 9 -> 9

=== PROJECTED — predicate 2: a question no longer counts as an explanation ===
rows NEWLY entering the backfill pool = 1
    0dfe7c86 status=rejected verdict=explain
totalUnexplained: 107 -> 108
```

**The honest reading.** The live blast radius today is **one row**, and **zero** rows enter the reserved
lane. Exactly one terminal row in the entire store carries a non-decision verdict. This is a
**forward-looking correctness fix**, not an unblocking of a backlog — the same shape as T156's honest
negative, where SC-042 was satisfied on a population of zero. It must not be reported as "restored N
buried items". Its value is that the next question John asks does not delete the thing he asked about,
and the first live review is on record as him answering every proposal with a question.

### 3.4 FR-041 honest rendering

```
escalated 9 vs budget 5  -> EXCEEDS — cap must disclose totalEscalated
backfill  108 vs slots 2 -> EXCEEDS — cap must disclose totalUnexplained
```

Both pools **already** exceed their caps before this change (9 > 5 and 107 > 2), and both already
disclose their denominators (`totalEscalated`, `totalUnexplained`). T155's honest-rendering
requirement therefore applies **unchanged**; this change creates no new disclosure obligation and
removes none. No capped numerator is printed alone.

## 4. What T199 will change

1. `src/suggest/review-reason.ts` — add `isNonDecision(verdict)`, the shared reading of
   `NON_DECISION_VERDICTS` that both sites consume. The module keeps zero imports, so no cycle is
   possible (`escalation.ts` imports only `./types.js`).
2. `src/suggest/escalation.ts:93-95` — `matchesCensusSignature` stops treating a question as a
   standing verdict. The superseded expression `s.reviewVerdict === undefined` is **replaced, not left
   beside the new one** (Constitution IV).
3. `src/suggest/weekly-review.ts:302-304` — the backfill filter stops treating a question as an
   explanation, via one named predicate rather than a fifth inline sniff.

Nothing else. No FR is amended, no default is flipped, and no live row is relabelled — `65a914f4` in
particular is not touched in either direction (T149 is unresolved and is John's call).
