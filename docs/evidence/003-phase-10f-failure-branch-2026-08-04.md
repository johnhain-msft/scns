# Phase 10f — the failure branch: a build failure is not the human's refusal

**Spec:** 003-label-integrity-defects · **Tasks:** T142–T149 (+ T131c/T131d) · **Date:** 2026-08-04
**Branch:** `003-approval-rationale-gap` · **FRs:** FR-050c, FR-055b, FR-056–FR-059 · **SCs:** SC-028–SC-031

---

## 1. The defect, as found

`~/.scns/suggestions/rejected/65a914f4-b229-4fde-874e-c46a44dd845f.md`, read live and read-only:

```
status: "rejected"
reviewReason: "human:cheap-win:"
machineReason: "qg-fail:tests-failed"
```

No `attemptCount`. No `reviewVerdict`.

John approved this proposal at 16:33. A team spawned; both dev sessions exited with `diff_bytes=0`;
the quality gate failed at 16:53; the arbiter wrote `status: rejected`. Because `rejected ∈
FAILED_VERDICTS` (`proposal-outcomes.ts:40`), the learner counted **John's approval as John's
refusal** and fed it to family suppression (`memory-self-improvement.ts:193`).

Three distinct harms in one write:
1. A human intent signal was **inverted** — accept recorded as reject.
2. The evidence was **destroyed** — the same write cleared `reviewVerdict: approve`, so the file no
   longer proves he ever approved it. Only the `human:` prefix on his reason survived to testify.
3. The proposal was made **terminal on attempt one**, with no retry, for a failure that was the
   executor's (`diff_bytes=0` — nothing was even written), not the idea's.

## 2. What was actually wrong — wiring, not a missing capability

This is worth stating plainly because it determined the size of the fix. Every part needed already
existed:

| Capability | Already existed at | Used by the gate? |
|---|---|---|
| attempt counting, exponential backoff, ceiling | `recordFailure`, `suggestion-store.ts:316` | **no** |
| a verdict-neutral terminal status | `needs-human` | **no** |
| the fail-then-retry precedent | stall timeout, `agent-loop.ts:1171` | — |

`quality-gate-arbiter.ts:1086 rejectSuggestion` called none of it. The fix connects existing parts;
it does not build a second retry system (which was the explicit `__fleet__` failure mode to avoid).

## 3. What changed

**`suggestion-store.ts`**
- `updateStatus` takes a `StatusAuthor` (`'human' | 'machine'`); `verdictContradictsStatus` now
  fires only for `author === 'human'` (T131c/SC-028). Default is `'human'` — deliberately, so the
  reviewed FR-051b behaviour is preserved byte-for-byte and the new protection is an explicit
  machine **opt-in** rather than something a caller loses by forgetting a parameter.
- New private `recordAttemptFailure` is now the **single** retry implementation, parameterised by
  `betweenAttemptsStatus` / `terminalStatus` / `clearInflightTeam` / `recordAsMachineReason`.
  `recordFailure` (executor path, terminal `failed`) and the new `recordQualityGateFailure` (gate
  path, terminal `needs-human`) both delegate to it. The counter, backoff curve and ceiling
  therefore **cannot diverge** — this is how T146 is satisfied without a second constant.
- `recordQualityGateFailure` writes the file directly rather than going through `updateStatus`, so
  `verdictContradictsStatus` structurally never sees a machine write on this path.

**`quality-gate-arbiter.ts`** — `rejectSuggestion` → `recordGateFailure`; all three failure call
sites rerouted (`:1241` analysis-fail, `:1296` no-diff, `:2068` main fail-tail). Between attempts
the proposal returns to **`approved`**, not `in-progress`: the brain's retry loop lists `approved`
only, so parking it in `in-progress` would have stranded it forever — a silent no-retry that would
have looked exactly like success. `inflightTeamId` is cleared (FR-057c). At the ceiling: `needs-human`.

**`proposal-outcomes.ts`** — `FAILED_VERDICTS` = `{rejected, reverted}` (FR-059).

**`cli.ts`** — `review approve` now uses `requiredOption('--reason')` (FR-055b).

## 4. Coupled live bug found and fixed

While declaring machine authorship at each seam, the brain's `updateStatus` adapter in `cli.ts` was
found to be `(id, status) => updateStatus(id, status)` — while `agent-loop.ts` passes real `reason`
and `blockedMetadata` values (`self-critique: …`, `team-stalled`, required autonomy level).

**Every brain-side reason was being silently discarded at the wire.** Not truncated or mangled —
dropped, with no error. This is adjacent to 003's subject (reasons failing to reach the corpus) and
was fixed at the same boundary. It was not visible from the defect report and was found only by
enumerating call sites before modifying the shared primitive.

## 5. Evidence

> **Read §10 first if you are grading this.** Everything in §5 describes the change AFTER independent
> review; the first pass was graded **DO NOT SHIP** and six further defects were fixed. §10 records what
> was wrong, because the interesting evidence in this phase is what the first pass missed.

### 5.1 Red state (self-established, T142)

The first red attempt was **discarded**: it failed on a missing helper ("is not a function"), which
proves nothing about the defect. Rewritten to drive the real arbiter (`handleTeamCompletion`)
against a real isolated `createSuggestionStore` with git mocked via injected `runCommand`:

```
× T142(a): the gate FAIL branch does not label a human approval `rejected` 42ms
× T142(b): the gate FAIL branch increments `attemptCount` and schedules a retry 25ms
× T142(c) / T131d: the gate FAIL branch leaves the human verdict and words intact 23ms
× T144: the FAIL branch returns the proposal to `approved` so the brain retries it 24ms
✓ T142 positive control: a gate PASS still reaches `implemented` on the first attempt 30ms
 Tests  4 failed | 1 passed (5)
```

The positive control passed from the start and stayed green throughout — this is what rules out
"fixing" the defect by disabling the gate.

### 5.2 Green, after

```
✓ test/unit/broker/services/quality-gate-arbiter.failure-branch.test.ts (5 tests)
✓ test/unit/suggest/qg-failure-not-rejection.test.ts (14 tests)
✓ test/unit/suggest/machine-cannot-erase-human-verdict.test.ts (6 tests)
✓ test/unit/brain/retry-fresh-context.test.ts (3 tests)
✓ test/unit/memory/failed-verdict-gradient.test.ts (9 tests)
✓ test/unit/suggest/qg-mislabel-census.test.ts (7 tests)
```

Full suite: **`Test Files 501 passed | 2 skipped (503)`** · **`Tests 7447 passed | 2 skipped (7449)`**
`npx tsc --noEmit` → clean. (Measured after the §10 fixes; the first-pass figure of 7420 is superseded.)

### 5.3 Mutation test (T148)

Re-pointed the gate at the defective `updateStatus(sourceSuggestionId, 'rejected', reason)`:

```
× T142(a) … × T142(b) … × T142(c)/T131d … × T144 …
× QualityGateArbiter > FAIL path (test failure): … rejects suggestion
× QualityGateArbiter > empty-diff short-circuits to no-diff verdict without touching git
 Tests  6 failed | 29 passed (35)
```

Six red, and every unrelated test stayed green. The tests detect *this* defect specifically.
Mutation reverted; `tsc` clean afterward.

### 5.4 Census — before and after

Identical code both runs (`src/suggest/qg-mislabel-census.ts` via `scripts/qg-mislabel-census.ts`).

```
# SC-029 census — $HOME/.scns/suggestions
scanned:                     147
unreadable:                  0
VIOLATIONS (SC-029):         1
  verdict intact:            0
  verdict erased:            1
  terminal on attempt 1:     1
  - 65a914f4-… status=rejected evidence=verdict-erased attemptCount=0
    machineReason=qg-fail:tests-failed reviewReason=human:cheap-win:

# SC-031 census — vault.db (readonly)
proposal_outcomes rows:      1
suppression threshold:       2
suppressed families:         0
  suppressed SOLELY by `failed`: 0
```

**The after-figure is identical to the before-figure, and that is the correct result.**

## 6. Honest limits of this evidence

These are the places where the numbers above are weaker than they look. Stating them explicitly
because each one could otherwise be read as a stronger result than it is.

1. **SC-029 is still 1, not 0.** T148 asks for 0. The one violation is `65a914f4` itself — a
   historical file. The fix prevents *new* mislabels; it does not rewrite history, and T149 rules
   that this item is to be **re-decided by John, not relabelled**. Editing that file would drive the
   metric to 0 by destroying the only surviving record of the defect. **The count should be read as
   "0 new violations, 1 outstanding human re-decision."**
2. **SC-031 moved 0 → 0, and could not have moved.** `proposal_outcomes` contains exactly **one**
   row (a `rejected` for `autonomy/autonomy-transition-log`). FR-059's retroactive un-suppression is
   real, but on today's corpus it un-suppresses **nothing**. This is not evidence that FR-059 works
   in the field; it is evidence that the field is currently empty. The unit tests carry that claim,
   not this census.
3. **The census's own zero required verification.** After the fix, a correct census and a completely
   broken one both return low numbers. `qg-mislabel-census.test.ts` therefore adds positive and
   negative controls for **both** halves — including the control that a **genuine human rejection
   must NOT be counted**, without which the metric could be improved by deleting John's real
   decisions. *(Corrected: the first pass claimed this while only `censusQgMislabels` had controls.
   `censusFamilySuppression` shipped inverted and untested — see §10.3.)*
4. **The census predicate is a union, because the defect destroys its own evidence.** The strict
   `reviewVerdict === 'approve'` filter that T143 originally specified reports **0** violations —
   including on `65a914f4` — because the mislabelling write also cleared the verdict. Counting only
   verdict-intact cases would have reported a clean corpus on the very corpus that motivated the
   phase. Sub-counts are broken out so the two evidence classes stay distinguishable.
5. **`tsconfig.json` excludes `test/`.** "`tsc --noEmit` clean" is a statement about `src/` only.
   This bit during the phase: the pre-existing arbiter test stub did not implement the new required
   `recordQualityGateFailure`, and because `recordGateFailure` wraps the call in try/catch by design
   (FR-058b — a store error must leave the item non-terminal rather than crash the gate), the
   missing method surfaced as a **caught TypeError and an empty assertion target**, not a type error
   or a crash. Any future stub against this interface can fail the same silent way.
6. **T145 is an assertion, not an implementation.** `brainOnSpawnTeam` (`cli.ts:2203`) already calls
   `spawnAgent` fresh per invocation. Note the `teamId` **is** reused (`team-sugg-<8char>`, guarded
   by `if (!existing)`); what is fresh is the agent *session*. Clearing `inflightTeamId` is what
   prevents a stale `team_completed` mapping back to the previous attempt.
7. **The `diff_bytes` anomaly is now load-bearing** (§9, "found but not acted on"). Before this
   phase a wrong `diff_bytes: 0` produced one mislabel; now it drives an automatic 5-attempt loop,
   and the arbiter's own no-diff comment states the premise — *"an agent that wrote nothing is the
   strongest possible case for a fresh retry."* If a team can report `diffBytes: 14624` while every
   session on it logs `0`, that premise is unverified. This phase promoted the anomaly from a
   one-shot mislabel to a repeated automated action, so deferring it is a real risk, not a clean
   scope boundary.
8. **`needs-human` is still in `dedup-policy.ts`'s `ACTIVE_STATUSES`**, which blocks the title-family
   from re-surfacing indefinitely (no dedup window, unlike terminal statuses). So harm #3 — "the
   family was suppressed" — is fixed at the `proposal_outcomes` layer and **unchanged at the
   generator layer**, still on machine evidence. Not addressed here.
9. **FR-059 as implemented is broader than the ruling quoted for it.** John's recorded words were
   *"FAILED should not stay in failed verdicts **after a human has reviewed it**"*; `failed` is now
   excluded unconditionally, including for proposals no human ever saw. Probably the better rule,
   but it is not verbatim what was decided. Related: with `failed` and `needs-human` both out, and
   `rejected`/`reverted` both requiring John, **nothing the machine observes can suppress a family
   any more** — every suppression now costs a human decision. Defensible under the north star, and
   a real tradeoff that was not stated when the decision was taken.
   **Correction (re-grade, §12.6):** that claim was false as written. `familyLandingStats` in
   `selfopt/ideation-gate.ts` carried its own hardcoded `('failed','rejected','reverted')` that
   FR-059 never reached, so a build failure *could* still suppress a family through the ideation
   gate. Now fixed by deriving both lists from `FAILED_VERDICTS`/`LANDED_VERDICTS`; the claim holds
   only as of that fix. The lesson is that "nothing can X any more" is a claim about **every**
   reader, and it was made after auditing one.

## 7. Breaking change: `scns review approve --reason` is now required

FR-055b. `option('--reason')` → `requiredOption('--reason')`, matching `reject`. Verified live:

```
$ npx tsx src/cli.ts review approve some-id
error: required option '--reason <reason>' not specified
```

**Caller audit before shipping** (this is a human-facing CLI contract): `review approve` has exactly
one definition (`cli.ts:3589`) and **no non-interactive caller**. Searched `src/`, `scripts/`,
`dashboard/src`, `~/Library/LaunchAgents/com.scns.broker.plist` (0 matches for `review`) and
`crontab -l` (no entries). The auto-approve path (`SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD`, live on the
plist) runs through `suggestion-promoter.ts` → `updateStatus` and never shells out to this command.
All remaining textual references are prose pointing a human at `scns review weekly`.

A machine caller appearing later must get its own path — **not** a placeholder rationale.
FR-051/SC-025 forbid inferred reasons entering the corpus, and the empty prose on `65a914f4` is
exactly the artefact that would result.

Blank `--reason` is still refused separately: `requiredOption` enforces presence, not content.

## 8. Guards

- Vault `~/.scns/memory/vault.db` — **232488960 bytes / Aug 4 08:00:19 2026**, asserted identical
  before and after every census run. Opened `readonly: true`.
- Broker `:3456` (pid 12855) untouched. No push, no merge, no production flip.
- All tests use `mkdtempSync`; `~/.scns` is never opened for writing by any test.

## 9. Outstanding

- **T149** — re-decide `65a914f4`. ⚠️ **No mechanism currently accepts it**: `review approve`/`reject`
  hard-guard `status !== Pending` (`review.ts:132`, `:210`), the item is `rejected`, and `repromote`
  (`suggestion-store.ts:565-580`) promotes only `failed` or gate-exhausted `needs-human`
  (`qg-fail:*` **and** `attemptCount > 0`) — handed a `rejected` item it rewrites the file at the
  same status, a silent no-op rather than an error. `65a914f4` misses both arms twice over: wrong
  status, and `attemptCount: 0` because it predates the counting this phase installed. The one
  unblocked route is the dashboard approve button, which records **no reason** — the opposite of what
  T149 asks for, and now inconsistent with the mandatory `--reason` on the CLI. Building a
  re-decision path is follow-on work; §6.1 previously implied this was actionable today and it is
  not. **The census will therefore keep reporting `VIOLATIONS: 1` and that is correct** — relabelling
  the file to zero it would be rewriting history to improve a count.
- **T141** — producer ≠ grader. **Done FOUR times, and it changed the outcome every time.** All four
  passes returned DO NOT SHIP: §10 (pass 1, `code-review` + `rubber-duck`, 6 findings, 1 Critical),
  §12 (pass 2, 8 findings, 1 Critical), §14 (pass 3, 3 Medium + a meta-finding), §15 (pass 4, 3
  Medium + 1 Low). Severity converged (2 High → 1 High → 0 High → 0 High) and passes 2–4 each
  independently confirmed the original defect is durably fixed at both the file and ledger seams.
  ⚠️ **The §15 remediation AND all of §16 are themselves ungraded.** Given §12.11 — every pass has
  found defects created by the previous pass's fixes, and pass 4's own remediation again turned up a
  zero-coverage fix (§16.3) — a fifth pass over §15+§16 is not optional bookkeeping. Converged is
  not finished.
- **T131b/T140** — GitHub issue for the three unrepointed `reviewReason` readers
  (`weekly-session.ts:111`, `:237`, `weekly-review.ts:123`) + the A12 consumption deferral. T140's
  precondition is a completed weekly review session, which has not happened (and `scns review weekly`
  is a writer, guarded from casual runs).
- ~~**§11**, **§13**, and the `dedup-policy.ts` `ACTIVE_STATUSES` question~~ — **all three RULED by
  John on 2026-08-04 and implemented. See §16.** `failed` → neutral (`null`); the ideation-gate
  plist is correct and the comment was stale; `needs-human` is split into `gate-exhausted` vs
  `gate-refused`, which also answers the dedup question. ⚠️ One judgement call inside §16.3 is mine
  rather than his and is flagged as such there. **§16 itself is ungraded** — see T141 below.

### Found, deliberately not acted on (outside 003's scope)

- `team-lifecycle` reported `outcome:"success", diffBytes:14624` while both dev sessions on the same
  team logged `diff_bytes: 0`. **Filed as GitHub issue #27 (John's ruling, §16.4) — and investigating
  it CHANGED the conclusion, so the sentence that stood here is retracted.** There is no phantom
  writer: `diffBytes` (`team-lifecycle.ts:411`) is the whole-team staged diff and `diff_bytes`
  (`dev-productivity-monitor.ts:308`) is a per-session dispatch-attributed measure with four
  unconditional `return 0` bailouts (`startup.ts:467-500`). They are different measurements that
  were never required to agree. `diff_bytes=0` is indeed untrustworthy as a stuck-context signal —
  but the arbiter's `no-diff` branch gates on the **team** diff, so Phase 10f's behaviour is sound;
  only its stated reasoning at `quality-gate-arbiter.ts:1318` leans on the weak signal. Full
  correction in §16.4.
- The critic separates signal at 227 `suppress` / 9 `keep`, but is aimed at the negative-memory
  corpus rather than the suggestion queue.

---

## 10. What independent grading caught (T141)

The first pass of this phase was declared green — full suite passing, `tsc` clean, mutation test
passing, evidence written. It was then graded by two fresh contexts (a `code-review` agent and a
`rubber-duck`, per T141) and the verdict was **DO NOT SHIP**. They found six further defects, four of
which they agreed on independently.

This section exists because that is the most useful evidence the phase produced. A change can pass
its own tests, its own mutation test, and its own honesty review, and still be wrong in ways the
author structurally cannot see — here, because the author kept checking *the seam they had just
fixed* rather than following the signal outward to what reads it and inward to the states it could
now produce.

### 10.1 The fix did not reach the layer the defect actually damaged — **Critical**

`recordGateFailure` correctly stopped writing `rejected` to the suggestion **file**. But the arbiter
then called `emitOutcome(…, passed=false, …)`, and the `onOutcome` consumer in `cli.ts` did
`passed ? 'implemented' : 'rejected'` — banking `rejected` into `proposal_outcomes`, which **is** the
table that feeds family suppression and the accept-vs-waste gradient. **The harm the spec describes
was still live, one layer below the fix.** Reachable unattended for any auto-approved item, since
`SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD=0.80` and `SCNS_IDEATE_MEMORY=1` are both on the plist.

The human-approved case survived only *incidentally*, via an unrelated guard
(`humanVerdictToProposalVerdict('approve','rejected') → null`). Nothing named or tested it.

Worse, this falsified §3's own rationale: the doc argued that removing `failed` from
`FAILED_VERDICTS` fixed the suppression harm, but the gate path never banked `failed` — it banked
`rejected`, which was never removed.

The single live row in `proposal_outcomes` was produced by exactly this path, and it is **not**
65a914f4 — an earlier draft of this section claimed it was, contradicting §6.2 two pages up. The
actual row, read read-only from the live vault:

```json
{"id":1,"entity":"autonomy","family":"autonomy-transition-log",
 "verdict":"rejected","suggestion_id":"1fe872c4-fc45-489b-a641-205f11a6f192",
 "rationale":"qg-fail:tests-failed","created_at":"2026-06-26 19:19:24"}
```

`1fe872c4`, six weeks before the incident. The mechanism claim is sound — a build failure
(`rationale: qg-fail:tests-failed`) banked under `verdict: rejected` is the defect itself, in the
ledger — but 65a914f4 *cannot* have produced this row, and this section's own preceding paragraph
says why: the human-approved case is filtered out by
`humanVerdictToProposalVerdict('approve','rejected') → null`. The attribution was the overclaim; the
evidence is stronger without it, because it shows the harm landing on a proposal nobody was watching.

**Fixed:** `onOutcome` now carries an explicit `verdict` (`'implemented' | 'failed'`); `cli.ts`
prefers it over the boolean.

**Re-grade correction:** this fix shipped with **no test coverage at all**. An independent re-grade
reverted both ends of the wiring and reported `Tests 7447 passed | 2 skipped (7449)` with
`tsc --noEmit` clean — byte-identical to the fixed tree. The three tests filed under this finding
assert properties of `recordProposalOutcome` and `FAILED_VERDICTS`, not the wiring that *was* the
defect. See §12.4.

### 10.2 Retries made the ledger's first-write-wins rule wrong — **Critical**, and self-inflicted

`recordProposalOutcome` is `ON CONFLICT … DO NOTHING`, which was correct while a gate failure was
terminal on attempt one: first row == last row. **Adding retries is what broke it.** A proposal that
fails attempt 1 and lands on attempt 3 had the attempt-1 row locked in permanently.

This is the clearest example of the pattern above: the defect was created *by* the fix, in a file the
fix never touched, and no test in the phase could have caught it because the phase only tested the
seam it changed.

**Fixed:** a stored `failed` is provisional and may be superseded; `rejected`/`reverted`/`implemented`
keep first-write-wins. A later `failed` can never overwrite an earlier `rejected` — John's refusal
outranks a build failure, the same precedence the whole phase rests on.

### 10.3 The SC-031 measuring instrument was inverted and had zero tests — **High**

`censusFamilySuppression` computed its `failed` count using the **post-fix** `FAILED_VERDICTS`, which
no longer contains `failed`. Consequences, both now pinned by test:
- a family with 3 × `failed` — *the exact population FR-059 targets* — scored 0 and was discarded by
  the `< maxFamilyFailures` gate. The census missed **100%** of what it was built to find.
- a family with 2 × `rejected` + 1 × `failed` was reported as *"suppressed SOLELY by `failed`"*,
  attributing suppression by two genuine human refusals to a build failure.

§5.4 printed this function's output as a measurement, and §6.3 claimed the census had controls while
auditing only its other half. It read `0` solely because the live table holds one row.

**Fixed:** counts against the pre-FR-059 rule (the change is *what it measures*, so it must measure
the state before it); five tests added, verified to go red under the original arithmetic.

### 10.4 The SC-029 census counted John's genuine rejections as violations — **High**

The `verdict-erased` arm never checked the verdict was actually **absent**, so an explicit
`reviewVerdict: "reject"` fell through to the surviving-`human:`-reason test — which is true of his
rejection prose. And the reachable sequence is the *normal post-fix one*: John approves → the gate
fails → the `qg-fail:` machineReason now **survives** (that is the fix working) → John later rejects
it for real.

So the fix made this false positive **more** common, SC-029 would drift upward during correct
operation, and the way to improve the number would be to delete his decisions — the exact perverse
incentive the file's own negative control claimed to block. That control passed only because its
fixture omitted `machineReason` entirely and was filtered out one check earlier.

**Fixed:** the arm requires an absent verdict; the missing control (explicit `reject` **with** a
`qg-fail:` machineReason) is now a test.

### 10.5 A gate failure could resurrect a proposal the human had rejected — **High**, new inversion

`recordAttemptFailure` computed the new status purely from the attempt count, never consulting the
current one. `betweenAttemptsStatus: 'approved'` — introduced by this phase — therefore moved a
**rejected** item back to **approved** when a gate failure arrived for a team the human had cancelled
mid-flight (teams resolve to suggestions by string-parsing the id, independent of status).

Result: the brain re-spawns a team for work he explicitly declined, up to five times; the file
carries `status: approved` beside `reviewVerdict: reject`; and `weekly-session.ts` reads it back as
`status === 'rejected' ? 'reject' : 'approve'` — **re-counting his rejection as an approval.** That is
this phase's own defect running in the opposite direction, introduced by the fix for it.

`recordFailure` never had this exposure because it defaults to `current.status`.

**Fixed:** a machine retry never moves an item whose `reviewVerdict` is `reject`, nor one already
`rejected` or `implemented`.

### 10.6 The escalation had no delivery path and no way back — **High**

FR-058 escalates to `needs-human` so John can decide "fix it or close it". Three independent facts
made that undeliverable:

1. **Invisible in the weekly review** — and invisible *because the fix succeeded*. The backfill pool
   selects terminal items with **no** human reason; an escalated item has one: John's approval, which
   this phase exists to preserve. Protecting his words was sufficient to hide the item from the
   surface built to show him things. `hasWork` gates whether the review window opens at all, so
   nothing would have opened.
2. **`scns suggest retry` refused it** (`status !== 'failed'`).
3. **`repromote` — the only other exit — cleared `reviewVerdict` and `reviewReason`**, so the machine
   erased John's approval one hop after the gate had been stopped from doing it (harm #2, relocated
   rather than removed), and left `attemptCount` at the ceiling, so the **next single** failure went
   terminal — harm #3, "terminal on attempt one", restored through the back door.

**Fixed:** escalated items are their own pool in the weekly packet (not budget-capped: the ceiling is
5 per proposal, so it is small by construction, and truncating "the machine gave up on your approved
work" is the failure being fixed); `retry`/`clearBackoff` accept the gate-exhausted meaning;
`repromote` preserves verdict + reason and resets the counter for it, while keeping the 13.12.16
rebuild behaviour unchanged. All six branches are pinned in
`test/unit/suggest/phase-10f-review-findings.test.ts`.

### 10.7 One reviewer finding was REJECTED, deliberately

The duck argued (persuasively) that leaving `humanOutcomeOfVerdict('failed') = 0.2 waste` while
removing `failed` from `FAILED_VERDICTS` is a half-fix, and the surviving half sits on the north-star
metric itself. I made that change — and it broke **T156**, a named invariant whose comment reads:

> *"Undisclosed regression in the first pass: `approve` + `failed` used to bank `failed` (waste) and
> started banking nothing. The IDEA was not waste but the EXECUTION was, and that is a real signal
> the learner had before."*

A previous session had already made this exact change, it was caught as an undisclosed regression,
and T156 exists to stop it recurring. **Reverted.** The argument is real and the two graders disagree
on it, which is precisely why it is John's call and not mine: FR-059's ruling was scoped to
`FAILED_VERDICTS`, and retiring a reviewed invariant is a design decision, not wiring. Logged in the
code comment at `human-outcome.ts` and in §11 below.

### 10.8 Process finding — I edited the tree while it was being graded

Fair, and worth recording: the reviewer began grading, and I continued fixing the duck's findings in
parallel, so the diff hash moved three times during the review window and the reviewer's mid-run
suite measurement caught a red tree. T141's producer ≠ grader separation is weakened if the artefact
moves underneath the grader. **The tree is now frozen for re-grading.** Any future phase should
freeze before handing off.

---

## 11. For John — open design questions

**Should `humanOutcomeOfVerdict('failed')` stay at 0.2 waste?** (§10.7.) FR-059 removed `failed` from
family suppression on the reasoning that a build failure says nothing about whether you wanted the
outcome — but it still scores 0.2 waste on the accept-vs-waste gradient, under a comment that reads
*"the human (or the gate on the human's behalf) deemed it not worth it"*. Either the parenthetical is
right and FR-059 was too broad, or FR-059 is right and the gradient is inconsistent with it.

Both graders were split. T156 defends the current value explicitly, so it was left alone. Now that
retries exist there is also a second-order effect: a proposal can settle 0.2 on attempt 1 and 1.0 on
attempt 3, settling twice for one proposal.

---

## 12. What the RE-GRADE caught (T141, second pass)

The tree was frozen at diff hash `2fb3d807f228` and handed to a fresh `code-review` context that had
not seen §10. It returned **DO NOT SHIP again**, with eight findings. Of the six §10 fixes it
re-verified, two were genuinely fixed, two partially, one fixed-but-untested, and **one had created a
strictly worse bug than the one it removed**.

That last one is the headline, and it is the same lesson as §10 at higher resolution: *the fixes for
a review are themselves unreviewed code.* Every §10 remediation was written under time pressure after
a DO-NOT-SHIP, and that is exactly when a guard gets added without asking what else it changes.

### 12.1 The `humanOwnsOutcome` guard converted a bounded loop into an unbounded one — **Critical**

§10.5 added a guard so a gate failure could not move a human-REJECTED item back to `approved` and
have the brain rebuild work he declined "up to five times". It did that by holding the current
status, nulling `nextRetryAt`, **and** skipping the terminal transition.

For `status: approved` + `reviewVerdict: reject` all three clauses fire together, and the item is
left in a **promotable** status with no backoff and no ceiling. That shape is not hypothetical: the
weekly review produced it, because `approved` is in `TERMINAL_STATUSES` and a reject there preserved
the status.

Reproduced against a real store, the real weekly session and the real promoter:

```
WEEKLY REJECT ok= true   status= approved  verdict= reject
AFTER 8 GATE FAILS       status= approved  attemptCount= 8  nextRetryAt= null  ceiling= 5
PROMOTER                 promoted= 1  skipped= []
```

`attemptCount: 8` against `MAX_ATTEMPTS_BEFORE_FAILED = 5`, never terminal, still promoted. **The
guard against "five rebuilds of declined work" had made it unlimited.** Before Phase 10f the gate
wrote `rejected` and the loop ended after one failure — so on this specific axis the phase had made
the system worse than the defect it was fixing.

**Fixed:** "the human owns this" now means *the machine stops*, not *leave the status alone*. A
refusal parks at `rejected`, which is not promotable. This is the machine **conforming** to his
verdict, not overriding it: `status: approved` beside `reviewVerdict: reject` is the stale field, and
his verdict is the true one.

### 12.2 The escalated pool could not be drained or answered — **High**

§10.6 made escalated `needs-human` items visible in the weekly packet. It did not make them
**actionable**. `needs-human` is in `TERMINAL_STATUSES`, so `recordWeeklyVerdict` preserved the
status for *both* answers:

```
--- B: John REJECTS an escalated item ("close it") ---
ok = true   status = needs-human   reviewVerdict = reject
STILL in escalated pool next week?  contains rejected id = true

--- C: John APPROVES an escalated item ("retry it") ---
ok = true   status = needs-human   attemptCount = 5   nextRetryAt = null
```

The packet said *"retry it or close it"* and neither was reachable from the prompt it was attached
to. Approve printed a success line and retried nothing; reject printed a success line and closed
nothing, leaving the item pinned at `priority: MAX_SAFE_INTEGER` — **first** — in every future packet
forever. The pool was uncapped, and §10.6's justification for that ("the ceiling is 5 attempts per
proposal, so the pool is small by construction") confused *attempts per proposal* with *number of
escalated proposals*. With no drain it could only grow. §10.6's "Fixed" was stronger than the code.

**Fixed:** `implemented` is the only genuinely un-flippable status (work shipped; a verdict cannot
un-ship it). Everything else moves: approve on an escalated item → `approved` **with the retry budget
restored via `clearBackoff`**, reject → `rejected`. The pool is now bounded because both answers
drain it.

### 12.3 His rejection was read back as an approval — **High**

`historyFrom` derived the verdict from **status** (`status === 'rejected' ? 'reject' : 'approve'`)
while `reviewVerdict` sat on the same file. Every refusal recorded against a status that cannot move
was therefore counted as an **approval**:

```
on disk:     status = needs-human   reviewVerdict = reject   reason = human:not-valuable: close it
engagement:  {"n":1,"approvalRate":1,"disagreedRecently":false}
```

`approvalRate: 1` and `disagreedRecently: false` for a session in which he rejected. Those two values
are the inputs that block an autonomy raise, so **his refusals were pushing the system toward more
autonomy.** This is the phase's own defect — a human decision read back as its opposite — surviving
in a reader, and the escalated pool added in §10.6 is what routed him into it.

**Fixed:** read the recorded verdict; fall back to status only when there isn't one. `defer` and
`explain` are excluded outright — they are not decisions, and banking them as approvals inflated the
very rate the anti-rubber-stamp guard exists to watch.

### 12.4 The Critical §10.1 fix was defended by nothing — **High**

The re-grade reverted both ends of the verdict wiring and ran everything:

```
Test Files  501 passed | 2 skipped (503)
Tests  7447 passed | 2 skipped (7449)
tsc --noEmit: exit 0 (after removing the now-unused binding)
```

Byte-identical to the fixed tree. **The phase's own Critical fix could be fully reverted with a green
suite and a clean typecheck.** The three tests filed under §10.1 assert properties of
`recordProposalOutcome` and `FAILED_VERDICTS` — not the wiring that *was* the defect. This repo
already had the right pattern for exactly this (`test/unit/suggest/wiring-guard.test.ts`, written
because "deleting the entire F1 cron caller left the whole suite green"); it simply was not applied.

**Fixed:** a source-level wiring guard *and* a behavioural `onOutcome` spy on the arbiter's failure
branch, so both the emitter and the consumer are pinned. Mutation-verified — reverting both ends now
produces `3 failed` in the guard plus a red spy assertion.

### 12.5 The SC-031 census still did not mirror the rule it claimed to mirror — **Medium**

Second pass on the same instrument. The real rule is
`familyLanded > 0 || familyFailed >= maxFamilyFailures`; the census implemented only the second
disjunct while its own comment claimed it mirrored the whole thing "rather than restating it, so a
change to one side shows up here". A family suppressed because it had **already landed** was scored
as suppressed by `failed` — crediting FR-059 with un-suppressing something it does not touch.

**Fixed:** the `landed > 0` disjunct is counted, and a landed family can never be "solely
attributable to `failed`". Three tests added.

### 12.6 FR-059 missed a second failed-verdict set — **Medium**

`familyLandingStats` (`selfopt/ideation-gate.ts`) hardcoded
`verdict IN ('failed','rejected','reverted')` — an independent second definition of "failure verdict"
that FR-059 never reached. It still counted a build failure as a family failure, and Phase 10f makes
`failed` rows the routine product of every gate failure. Impact today is nil (the one live row is
`rejected`); it activates the moment `failed` rows accumulate, which is now.

This also falsified §6.9's claim that *"nothing the machine observes can suppress a family any
more"*. It did not hold for this scorer.

**Fixed:** both lists derive from `FAILED_VERDICTS` / `LANDED_VERDICTS`. The pre-existing test that
encoded the old behaviour (`{ landed: 1, failed: 1 }` for one `implemented` + one `failed`) was
updated to `{ landed: 1, failed: 0 }` **with rationale**, and a new test pins that five build
failures alone never accumulate into suppression.

### 12.7 An escalated item could be asked about twice in one sitting — **Medium**

The escalated and backfill filters were not mutually exclusive. An **auto-approved** proposal has no
human reason (after escalation it carries `qg-fail:no-diff`), so it qualified for both pools; the CLI
walks `items` by index, so John was asked the same proposal twice and the second answer overwrote the
first, while `selectedBackfill` and `totalUnexplained` double-counted it. Separately,
`selectedEscalated` was computed and **never rendered** — the header claimed "N of M pending item(s)"
while the loop presented N+E, which is the FR-041 miscount the header's own comment says it fixed.

**Fixed:** one shared `isGateEscalated` predicate used by both pools, escalated ids excluded from
backfill, and `selectedEscalated` rendered.

### 12.8 §10.1 misattributed the live ledger row — **Medium**

Corrected in place; see §10.1. The row is `1fe872c4` from 2026-06-26, not 65a914f4, and §6.2 had it
right — the document contradicted itself. The mechanism claim survives; the attribution to the
motivating artefact does not.

### 12.9 What the re-grade confirmed

Verified independently and accurate: §5.2's suite figures reproduced exactly; §5.3's mutation test
produces exactly the six named failures; §5.4's census reproduced byte-for-byte; §8's guards held
(vault byte-identical before and after every run). §10.2 (ledger precedence) and §10.4 (the
`reviewVerdict === null` arm) were confirmed **genuinely fixed**, in both directions. `repromote`
still clears the verdict for the 13.12.16 rebuilt meaning. No machine seam in `src/` calls
`updateStatus` without `author: 'machine'`.

**§10.7 was confirmed as the right call** — refusing the `humanOutcomeOfVerdict('failed')` change and
escalating it instead. T156 really does defend that value under a comment naming it a previously
undisclosed regression, and silently retiring a named invariant written to catch that exact change
would repeat the pattern this phase exists to remove.

### 12.10 Verification after the re-grade fixes

```
Test Files  502 passed | 2 skipped (504)
Tests  7465 passed | 2 skipped (7467)
npx tsc --noEmit → exit 0
```

Live census, unchanged before and after (read-only, vault `232488960` bytes / Aug 4 08:00:19 2026
asserted identical on both sides):

```
scanned: 147   unreadable: 0   VIOLATIONS (SC-029): 1
  - 65a914f4 status=rejected evidence=verdict-erased attemptCount=0
proposal_outcomes rows: 1   suppressed families: 0   solely by `failed`: 0
```

### 12.11 The process finding

§10.8 said "freeze the tree before handing it to a grader". That worked — the re-grade verified the
hash on entry and restored it on exit. The finding this round is different and sharper:

**A remediation pass needs the same grading as the original phase.** Five of the eight findings here
were in code written *to fix* the previous review, and the most serious one (§12.1) was a guard that
made its own target harm unbounded. A DO-NOT-SHIP creates urgency, and urgency is when a guard gets
added without asking what else it touches. The fixes for a review are not review-exempt.

---

## 13. For John — second open question (raised by the re-grade)

**The ideation gate is installed on `enforce` alone, and the live plist sets it.**

`ideation-gate.ts` states its own contract as *"a caller only acts on it when `measure` is also
true"*. `cli.ts` installs the gate on `ideateGateMode.enforce` by itself. Your
`~/Library/LaunchAgents/com.scns.broker.plist` sets `SCNS_IDEATE_GATE_ENFORCE=1` and does **not** set
`SCNS_IDEATE_GATE`, so the intended guard is bypassed on the running system right now.

This was found while fixing §12.6 and it is deliberately **not** fixed here. Correcting it would flip
the behaviour of a gate that is live on your machine, and that is a behavioural default-flip on an
assumption — the thing the standards forbid without your sign-off. Two readings, opposite fixes:

- the module contract is right → `cli.ts` should require `measure && enforce`, which **turns the gate
  off** on the current plist until you add `SCNS_IDEATE_GATE=1`;
- the plist is right → the contract comment is stale and `enforce` alone is intended, in which case
  the comment should go.

The SQL defect underneath it (§12.6) is fixed either way, so nothing is blocked on this answer.

---

## 14. What the THIRD grading pass caught (T141, pass 3)

The tree was frozen at diff hash `55cc4d33220b` and handed to a fresh-context grader with no
knowledge of the two prior passes. Verdict: **DO NOT SHIP** — three Medium findings and one meta-
finding. Every one was verified independently before anything was changed.

The trend matters as much as the findings. Pass 1 was six findings including two High; pass 2 was
eight including one that made the target harm *unbounded*; pass 3 is three Mediums and an explicit
confirmation that **the original defect is genuinely and durably fixed on both the file and the
ledger**. But all three findings were again in code written to fix the previous pass — §12.11 held.

### 14.1 The `implemented` protection was DEAD CODE — a build failure could un-ship shipped work — **Medium**

The pass-2 guard read `humanRefused` first and `landed` second:

```ts
const humanRefused = current.reviewVerdict === 'reject' || current.status === 'rejected'
const landed = current.status === 'implemented'
```

A proposal that shipped and *then* received a backfilled `reviewVerdict: reject` (which §13/14.2's
own backfill path writes, by design, without changing status) satisfies `humanRefused`. So the
`humanRefused` arm won, the item was parked at `rejected`, and the next gate failure **moved a file
out of `implemented/`**. The `landed` clause could never be reached for the only shape it existed to
protect. The protection I added in pass 2 to stop the machine overwriting human outcomes was itself
capable of destroying the strongest human outcome there is.

Fixed by making the ordering explicit and load-bearing:

```ts
const landed = current.status === 'implemented'
const humanRefused =
  !landed && (current.reviewVerdict === 'reject' || current.status === 'rejected')
const humanOwnsOutcome = landed || humanRefused
```

Pinned by two tests — the arbiter path and the executor path — because `recordAttemptFailure` is the
shared primitive and a fix that only held on one caller would be a coincidence, not an invariant.

### 14.2 The escalated/backfill dedup had ZERO coverage — **Medium**

§12.4 filed "a fix with no test is not a fix" as a High finding against pass 1. Pass 3 found the same
class in pass 2's own work: reverting the escalated-excluded-from-backfill change left the **entire
suite green**. An auto-approved escalation could appear in both pools — twice in one packet, asked
about twice, with the second answer overwriting the first — and nothing would have said so.

Now pinned by a test that builds a real auto-approved escalation and asserts it appears exactly once,
in the escalated pool only.

### 14.3 "Both answers drain the pool" was FALSE — **Medium**

§12's justification for capping the escalated pool assumed every answer drains it. The CLI
(`cli.ts:3489`) offers **four**: approve, reject, explain, skip. `skip` never calls
`recordWeeklyVerdict` at all, and `explain` and `defer` take the `!isDecision` early return, which
preserves status by design (§13.12.1 — a non-decision must never be banked as an outcome). So only
two of four drain, while auto-approval (`SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD=0.80`, live on the
plist) *produces* escalations with no human in the loop at all.

~~Measured before the fix: **41 escalated items rendering first, uncapped**, ahead of every
budget-limited pool.~~ ⚠️ **RETRACTED by pass 5 — see §17.4.** Re-measured with the SHIPPED
`isGateExhausted` predicate against John's live corpus (147 files, read-only): the escalated pool is
**0**, not 41. Not one file in the entire corpus carries an `attemptCount` field, which the
predicate requires. The cap and the ordering fix are still correct as code, but they were reasoned
against a population the shipped predicate cannot produce, and "41" was stated as measurement. The cap is what makes this survivable; the disclosure
(`selectedEscalated of totalEscalated`) is what makes it honest. Both are now pinned, including a
test that answers with `explain` and asserts the item is **not** drained and the count says so.

### 14.4 The meta-finding: the flagship regression test had stopped biting

§12.1 — the unbounded-loop finding, the most serious thing in this whole phase — was pinned by a test
that built its contradictory shape *through the weekly review path*. Fix §14.2 changed that path, so
the fixture stopped producing the shape, and the test kept passing for a reason that had nothing to
do with the invariant it was written to defend. It was green, and it was defending nothing.

This is worse than a missing test, because a missing test is visible. Rewritten to construct the
shape **directly at the seam under test** and assert non-promotability against a real promoter.

The generalisation, now the rule for this codebase: **a regression test must construct its shape at
the seam it defends.** If its fixture depends on a later fix, that fix can silently retire it. A
brittle source-text anchor in `wiring-guard.test.ts` (`onOutcomeBody()`) was de-brittled for the same
reason — an anchor that stops matching stops guarding, silently.

### 14.5 What pass 3 confirmed

The grader independently reproduced §5's evidence and confirmed: the original defect is fixed at both
the file seam and the ledger seam; `recordAttemptFailure` as the single parameterised retry
implementation is sound and is the reason the counter, backoff and ceiling cannot diverge (all three
passes said this); `sqlList` interpolation is safe, consuming only module-level
`ReadonlySet<ProposalVerdict>` constants with no external input reaching it; and §10.7's refusal to
change `humanOutcomeOfVerdict('failed')` was correct.

### 14.6 Verification after the pass-3 fixes

```
Test Files  502 passed | 2 skipped (504)
Tests  7471 passed | 2 skipped (7473)
npx tsc --noEmit → exit 0
```

Mutation-tested in isolation. The fourth pass caught this paragraph overstating itself, so it now
records exactly which mutation reds which test:

- **Reorder the `newStatus` ternary** to `humanRefused ? 'rejected' : landed ? …` (the real pass-2
  defect) → **2 red**, both in `third-pass finding 1`: the arbiter path and the executor path.
  `1b` passes.
- **Restore the pass-2 hold-current-status guard** (the §12.1 defect proper) → **1b goes red**
  (`expected 'approved' to be 'rejected'`). This is where the rewritten headline test bites.
- Reverting the §14.2 dedup → red; removing the §14.3 `.slice(0, budget)` → red
  (`expected 5, received 41`).

§14.6 previously claimed the first mutation redded the rewritten §12.1 test. It does not — that test
defends against the *second* mutation. The count was right and the attribution was wrong, which is
the same class as §10.1 and §12.8, in the document those findings are recorded in.

One further honesty note the fourth pass surfaced indirectly: in `humanRefused`, the `!landed &&`
clause is **redundant today**, because the `newStatus` ternary already tests `landed` first —
mutating the clause alone produces **0 red**. It is kept deliberately as a second layer, so that
reordering the ternary later cannot silently re-open §14.1. That is defence in depth, not coverage,
and it should not be mistaken for a tested invariant.

Live census, read-only, unchanged before and after (vault `232488960` bytes / Aug 4 08:00:19 2026
asserted byte-identical on both sides; broker `:3456` pid 12855 untouched):

```
scanned: 147   unreadable: 0   VIOLATIONS (SC-029): 1
  - 65a914f4 status=rejected evidence=verdict-erased attemptCount=0
proposal_outcomes rows: 1   suppressed families: 0   solely by `failed`: 0
```

### 14.7 Doc debt cleared

`recordWeeklyVerdict`'s docblock rule 2 said "when the suggestion is already terminal, its status is
preserved" — true before §12.2, false after it, and the header said "two rules" above a list of
three. Stale prose next to changed behaviour is how the next reader gets the old model. Rewritten to
state the narrower `implemented`-only rule and why it is narrower.

### 14.8 On stopping

Three passes have each found defects in the previous pass's remediation, which is an argument for a
fourth. Against it: the severity trend is 2 High → 1 unbounded-loop High → 0 High, the original
defect has now been confirmed fixed by two independent graders, and each pass costs a full
fresh-context review. The honest position is that this converged rather than finished — a fourth pass
scoped **only** to the §14 remediation is defensible and is John's call, not mine to declare
unnecessary.

---

## 15. What the FOURTH grading pass caught (T141, pass 4)

Frozen at diff hash `5f8fc7cfca48` and handed to a fresh `code-review` context. **DO NOT SHIP** —
three Medium findings and one Low. Four passes, four DO-NOT-SHIPs, and for the fourth consecutive
time **every finding was in code written to fix the previous pass**. §12.11 is no longer a lesson
from one bad round; it is the observed base rate of this phase.

Three of the four §14 changes survived mutation. The fourth — §14.3, the escalated pool — shipped
half-tested, and both defects were in the half that reaches John.

### 15.1 The disclosure that makes the cap honest had zero coverage — **Medium**

`weekly-format.ts:41-45`. §14.3 claimed *"Both are now pinned"* — the cap and the disclosure. Only
the cap was. Deleting the entire `if (packet.selectedEscalated > 0)` block left **all 935 suggest
tests green**, verified directly:

```
mutation: disclosure block deleted     →  Tests  935 passed (935)
```

This is verbatim the finding §14.2 filed against pass 2, recurring inside pass 3's own remediation —
and worse than a generic gap, because `weekly-format.test.ts:440` already had a
`formatWeeklyHeader — FR-041 population integrity (T096)` block pinning the pending numerator, the
backfill numerator **and** an empty-pool negative control. The pattern existed and was cited in the
fix's own comment. It simply was not extended. Now pinned, with its negative control.

### 15.2 The packet told John he approved work that auto-approval approved — **Medium**

`weekly-review.ts:288` and `weekly-format.ts:43` both asserted his authorship unconditionally:

```
you approved this and the build failed 5× (qg-fail:no-diff) — retry it or close it
1 of 1 proposal(s) you approved that the build could not land …
```

For an auto-approved escalation there is no human anywhere in that sentence. `agent-loop.ts:1102`
writes `updateStatus(id, 'approved')` with **no verdict and no reason**, and
`SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD=0.80` is live on the plist. The grader drove it through the real
promoter at the live threshold and printed what John would see, with the ground truth beside it:
`reviewVerdict = undefined`, `human reviewReason = none`.

The §14.3 comment fifteen lines above the string says so itself — *"auto-approval is live on the
plist, so escalations are PRODUCED with no human in the loop at all"*. The code contradicted its own
justification.

**Why this is not cosmetic.** It is a false attributed endorsement, delivered at the moment he is
deciding whether to spend more machine time, and it biases toward "retry" for precisely the
unattended population §10.1 identified as where the harm lands. This phase exists because the machine
mislabelled who decided what; this is the same conflation running the other way, on the surface built
to fix it.

Fixed with a `wasHumanApproved` predicate (`reviewVerdict === 'approve'` or a `human:` reason); the
auto-approved variant now names the confidence and says nobody reviewed it. The header's subject is
now the build, since the pool is mixed and no claim about John is true of all of it. Same class, same
seam: the CLI's `explain` branch printed `✓ noted — still pending` for an item sitting at
`needs-human`; it now reports the real state.

### 15.3 The §14.3 cap made its own tail permanently unreachable — **Medium**

Every escalated item gets `priority: Number.MAX_SAFE_INTEGER`, so the only selector was
`.sort((a, b) => a.id.localeCompare(b.id)).slice(0, budget)` — a **random v4 UUID**, with no age or
staleness term (both other pools have one). Since `explain` and `skip` do not drain the pool — §14.3
established that itself — and an id never changes, the same `budget` items held the entire window
every week, forever. `skip` is the CLI **default**: a bare Enter at `cli.ts:3488` records nothing.

```
WEEK 1 escalated shown: [ 22222220, 22222221, 22222222, 22222223, 22222224 ]
WEEK 2 escalated shown: [ 22222220, 22222221, 22222222, 22222223, 22222224 ]
WEEK 3 escalated shown: [ 22222220, 22222221, 22222222, 22222223, 22222224 ]
NEVER SHOWN:            [ 22222225, 22222226 ]
```

Before the cap, all 41 live escalated items rendered — noisy but reachable. After it, 36 of them
depended on John finishing the 5 lowest UUIDs. ⚠️ **The "41" here is retracted too (§17.4): the live
figure under the shipped predicate is 0.** The starvation argument stands on its own logic — a
UUID-sorted cap does make the tail unreachable — but it is reasoning, not a live measurement. **§14.3 fixed §10.6's noise by restoring §10.6's
harm** for everything outside the head.

Now ordered by `updatedAt` ascending (longest-waiting first, id only as a deterministic tie-break).
`updatedAt` moves whenever anything is recorded against an item, so answering rotates it to the back
and the queue drains in age order. The header additionally names `--budget N`, so the tail is
reachable in one sitting even under pure skipping — which `updatedAt` alone does not fix, because a
skip writes nothing. That residue is disclosed rather than papered over.

### 15.4 §14.6's own mutation evidence was wrong — **Low**

The doc claimed *"restoring the pass-1 guard ordering → 2 red (including the rewritten §12.1 test,
which now genuinely bites)"*. The count was right; the attribution was not. Measured directly:

| mutation | red |
|---|---|
| reorder the `newStatus` ternary to `humanRefused ? … : landed ? …` | **2** — both `third-pass finding 1`; `1b` passes |
| restore the pass-2 hold-current-status guard | **1b** (`expected 'approved' to be 'rejected'`) |
| reorder only the `const` declarations | **0** |

So the rewritten §12.1 test does genuinely bite — against a *different* mutation than the one
recorded. §14.6 is corrected in place. This is the same class as §10.1 and §12.8: a true mechanism
attached to the wrong artefact, inside the document the ship decision is made from.

That third row is the more useful discovery. The `!landed &&` clause in `humanRefused` is
**redundant today**, because the `newStatus` ternary already tests `landed` first. It is kept as a
deliberate second layer so a future ternary reorder cannot silently re-open §14.1 — but it is
defence in depth, not a tested invariant, and §14.6 now says so.

### 15.5 What pass 4 confirmed

Independently re-derived and verified correct: the frozen tree is green (`502 passed | 2 skipped`,
`7471 passed`, `tsc` exit 0 — reproduced exactly); **§14.1's guard ordering is load-bearing on BOTH
callers**, the arbiter and the executor, so the shared-primitive concern is genuinely covered rather
than coincidental; **§12.1 is not re-opened** — every branch of `recordAttemptFailure` was re-derived
against the real promoter and every terminal-ish arm is non-promotable, with the `landed` arm's
`nextRetryAt: null` safe because the promoter skips `implemented`; §14.2's dedup and §14.3's cap both
bite under mutation; §12.2's escalated items are answerable and genuinely drain, with `clearBackoff`
resetting the budget rather than leaving a terminal-on-attempt-one back door; §10.2's ledger
precedence and §10.4's census arm are untouched and correct; the `needs-human` discriminator is
applied consistently at **all five** readers; and the de-brittled wiring anchors fail loudly rather
than silently matching nothing.

### 15.6 Verification after the pass-4 fixes

```
Test Files  503 passed | 2 skipped (505)
Tests  7478 passed | 2 skipped (7480)
npx tsc --noEmit → exit 0
```

Each fix mutation-tested in isolation, restored and re-verified green between every run:

```
revert escalated sort to id            →  2 failed | 5 passed
revert `why` to unconditional          →  1 failed | 6 passed
delete the header disclosure block     →  2 failed | 5 passed   (was 0 before this pass)
revert header to "proposal(s) you approved" → 1 failed | 6 passed
restored                               →  7 passed
```

### 15.7 Reported by pass 4, pre-existing, NOT caused by this phase

`serializeSuggestion` writes the literal string `undefined` into the `## Description` section when a
suggestion has no description, and it round-trips back as the string `"undefined"`, so
`formatReviewItem` prints a bare `undefined` line to John. `suggestion-file.ts` is untouched by this
diff. Recorded here rather than fixed, because it is a separate defect on a separate seam and
bundling it would make this diff harder to review, not easier.

---

## 16. John's rulings (2026-08-04) and what they changed

Four questions raised across §11, §13 and §15 were escalated rather than decided by the
implementer, per the producer ≠ grader rule. He ruled on all four. This section records the ruling,
the implementation, and — where I exercised judgement inside a ruling — says so explicitly.

### 16.1 Ruling: the `failed` gradient is NEUTRAL, not waste

**Question (§11, first raised by the pass-1 grader and REFUSED by me at the time).** Pass 1 said
`humanOutcomeOfVerdict('failed')` should stop returning `0.2` ("waste"). I refused, because the
change broke **T156**, and escalated instead of overruling a test.

**Ruling: neutral.** Implemented as `null`, not `0.5`:

- The function already spells "not a score" as `null` (that is what `needs-human` returns).
- `outcome-writer.ts:256` guards `if (value !== null)`, so a `null` **settles nothing**. A midpoint
  would still be a datum and would still drag the mean — it would record a soft opinion John never
  gave, which is a smaller version of the very defect this phase exists to fix.

`failed` means *the machine could not build it*. It says nothing about whether he wanted it.

**T156 is retired**, in `test/unit/suggest/verdict-integrity.test.ts`, with a dated, attributed
disclosure block naming this ruling and naming the fact that the change was previously refused. The
half of T156 that is still true — `humanVerdictToProposalVerdict('approve','failed') === 'failed'`,
the ledger seam — is **kept**, with a positive control on `rejected` so the retirement cannot
quietly widen. The pre-existing assertion in `test/unit/memory/human-outcome.test.ts:32` carries the
same disclosure. **Two tests changed their expected values in this phase and neither did so
silently.**

### 16.2 Ruling: the ideation gate's plist is right; the comment was stale

`src/selfopt/ideation-gate.ts` carried a contract comment describing a `measure && enforce` pairing
that the live plist does not implement. **Ruling: the plist is correct, delete the stale comment.**
Replaced with the ruling itself so the next reader does not re-derive the same false conflict.
No behaviour changed.

### 16.3 Ruling: split `needs-human` into two categories — "this is basic OOP"

**The problem.** `needs-human` meant two unrelated things, and five separate readers each
re-derived the distinction inline with the same copy-pasted sniff
(`machineReason.startsWith('qg-fail:') && attemptCount > 0`):

| meaning | what happened | what should happen next |
|---|---|---|
| **gate-exhausted** | John approved it; the build failed 5× | offer him a **retry**; keep it in the weekly escalated pool |
| **gate-refused** | a safety gate said *no* (executor declined the type, critic returned needs-evidence) | **rebuild**, not retry |

**Implemented as a FIELD, not two new statuses.** `status` is the on-disk directory name, so adding
statuses would move and relabel live `~/.scns/suggestions/needs-human/` files — the exact "rewriting
history" that T149 forbids. New module `src/suggest/escalation.ts` owns the classification:
`escalationKindOf` / `isGateExhausted` / `isGateRefused`.

**The legacy fallback is politeness, not load-bearing — corrected 2026-08-04.** The earlier claim in
this section ("load-bearing") was wrong and is retracted. It was never measured against the corpus.
Measured: `grep -rl "attemptCount" ~/.scns/suggestions | wc -l` → **0 of 147 files**. Root cause:
`suggestion-file.ts:195` serializes `attemptCount` only when `> 0`, so every file that never
accumulated an attempt omits the field entirely. `legacyKind` therefore returns `gate-refused` for
**every** legacy file and can never yield `gate-exhausted`. That happens to be the correct default
for pre-split files — all of which came from the safety-gate path — so the fallback is harmless and
is kept for exactly that reason, but it must not be described as carrying load. The mutation that
"turns one test red" proves only that the fixture reaches the branch, not that live data does.

⚠️ **The legacy sniff is still wrong for the motivating artefact.** `65a914f4` has `qg-fail:` with
`attemptCount: 0` (it predates counting), so the fallback calls it *not* exhausted. This is a known,
accepted limit — it is the same reason T149 is blocked (§9), not a new one.

**Producers now tag at the source:** `recordAttemptFailure` writes `gate-exhausted` at the ceiling;
the executor-declines path (`agent-loop.ts`, `cli.ts`) and the self-critique `needs-evidence` path
write `gate-refused`. **The five inline sniffs this phase introduced were consolidated into
`escalation.ts`** (`weekly-review.ts`, `weekly-session.ts`, `cli/suggest.ts`, and the store's two).
⚠️ **Corrected 2026-08-04:** an earlier draft framed these as pre-existing debt that this phase paid
down. That was wrong and is retracted. `git grep "attemptCount > 0" HEAD -- src/` returns exactly one
match, `suggestion-file.ts:195`, which is a serialization guard and not the escalation sniff; none of
the five readers sniffed at HEAD. **This phase created all five, then removed them.** Net contribution
to pre-existing debt: zero.

**The tag has a lifecycle, and that was found by mutation, not by design.** ⚠️ Deleting the
clear-on-exit guard in `updateStatus` left all nine original tests **green**. A stale tag is not
cosmetic: `escalationKindOf` reads the field *first*, so a `gate-refused` tag left on a resumed item
makes its next genuine exhaustion classify as a refusal — it leaves the escalated pool, `retry`
refuses it, and dedup blocks its family. That is the 65a914f4 mislabelling again, one seam over.
Four tests were added; `updateStatus`, `repromote` and `clearBackoff` all clear the tag.

**⚠️ Judgement call inside the ruling — flagged for John, not settled by me.** The ruling did not
say what the split should do to **dedup**. I chose: a **gate-exhausted** item stops counting as
ACTIVE and falls through to the ordinary time window; a **gate-refused** item keeps blocking. My
reasoning is that the two meanings want *opposite* dedup behaviour — which is itself the argument
that they could never share one label — and that a failure to *build* an idea must not veto the
idea for life, whereas a gate refusing it should. This is the one part of §16.3 that is my
inference rather than his instruction. **If it is wrong, it is wrong in the direction of
re-proposing ideas John already saw**, which is noise, not data loss.

### 16.4 Ruling: open the diffBytes issue — **GitHub #27**

Opened. The investigation **changed the conclusion** and the issue records the corrected version:
`diffBytes` (`team-lifecycle.ts:411`, whole-team staged diff) and `diff_bytes`
(`dev-productivity-monitor.ts:308`, per-session dispatch-attributed) are **different measurements**,
not one measurement with a phantom writer. The per-session probe has four unconditional `return 0`
bailouts (`startup.ts:467-500`), notably an mtime filter that yields `0` whenever the quality gate
already harvested the work — a false `silent_exit` from exactly this cause is documented at
`dev-productivity-monitor.ts:223` and its mitigation is in-memory and restart-fragile.

**Blast radius is narrower than §9 first implied**, and this is a correction to my own earlier
framing: the arbiter's `no-diff` branch gates on the **team** diff, so Phase 10f's *behaviour* is
sound. Only its stated *reasoning* (`quality-gate-arbiter.ts:1318`) leans on the weaker signal.

### 16.5 Verification of the ruling changes

Every fix mutation-tested in isolation, restored and re-verified green between runs:

```
remove the dedup gate-exhausted exception   →  1 failed | 12 passed
remove the legacy fallback in escalation.ts →  1 failed | 12 passed
remove updateStatus clear-on-exit guard     →  1 failed | 12 passed   (was 0 before 4 tests added)
remove repromote clears                     →  1 failed | 12 passed
remove clearBackoff clear                   →  1 failed | 12 passed
producer stops tagging gate-exhausted       →  4 failed |  9 passed
agent-loop stops tagging gate-refused       →  2 failed | 83 passed
restored                                    → 13 passed
```

Three pre-existing `agent-loop.test.ts` assertions failed on the new argument. They were **widened,
not weakened**: each now pins the escalation tag, and the `blocked-autonomy` case pins `undefined`
as a **negative control** proving the tag is scoped to `needs-human`.

## 17. Pass 5, and the independent re-verification that closed the phase (2026-08-04)

§14.3 and §15.3 cite "**§17.4**" for the retraction of the "41 escalated items" figure. That section
was never written, so those citations dangled — the retraction pointed at nothing. This section is
that record. It is deliberately the last one: the phase closes here.

### 17.1 The "41 escalated items" figure is retracted

Claimed in §14.3/§15.3 as a measurement. **The live number is 0.** Measured with the *shipped*
`isGateExhausted` over every file in `~/.scns/suggestions` (147 files, read-only):

```
scanned files:                   147
needs-human (classified):        9      (the other 11 in that dir are .critique.md sidecars,
gate-EXHAUSTED (escalated pool): 0       correctly filtered by the store's readDir)
gate-REFUSED:                    9
```

The pool is empty because the escalation tag is new and nothing has exhausted a retry budget yet —
it is forward-looking, not dead. `suggestion-store.ts:302` writes `escalation: 'gate-exhausted'` at
the ceiling, so the pool fills the first time the arbiter's new path burns a budget. But **0 is the
number today**, and the "41" was never measured against anything.

### 17.2 Fields the corpus does not have

```
attemptCount  0 / 147      nextRetryAt  0 / 147      escalation  0 / 147
reviewVerdict 4 / 147      machineReason 2 / 147
```

Consequences, both already corrected in §16.3: the legacy fallback can never return
`gate-exhausted`, and the census's `machineReason` key could not see the older mislabel shape.

### 17.3 The nine machine-written refusals are REAL but they are HISTORY, not an open hole

`rejected/` holds 9 files with `reviewReason: "qg-fail:*"` (3 `no-diff`, 6 `tests-failed`) and **no
`machineReason`** — the gate's failure string written into the human's own reason field. Verified
file-by-file. But their `updatedAt` runs **2026-04-21 → 2026-06-05**, and the guard that stops a
machine reason landing in `reviewReason` shipped **2026-08-03** (`37a8092`), the day before this
phase. They are residue from a writer that was already fixed. Describing them as this phase's "live
blast radius of 10" overstates the case, and that framing is retracted.

⚠️ **What IS live, and is NOT fixed by this phase:** `generator.ts:252 titleMatchesRejected` is an
exact-match, lifetime, **no-window** blocklist over all 65 `rejected/` titles. So those 9 ideas —
blocked because a BUILD failed, not because a human refused — can never be re-proposed. That is real
accept-vs-waste harm and it remains **open**. The dedup exception that would have addressed it was
written and then reverted (see `dedup-policy.ts`) because it was unreachable behind
`store.findSimilar` and unsafe if made reachable. The correct fix is to RESUME the existing
suggestion so `attemptCount` accumulates, which is a design change and is out of scope here.

### 17.4 The census reported a number it could not justify

`censusQgMislabels` had **zero production consumers** — its only non-test caller is
`scripts/qg-mislabel-census.ts`, and that script never printed `machineWrittenRefusals`. A live run
therefore printed `VIOLATIONS: 1` and stayed silent about the 9. Fixed here: the script now prints
the category, kept separate from `violations` so SC-029's number is not inflated.

`VIOLATIONS: 1` is **correct and expected** to persist. It is `65a914f4`, and relabelling it to zero
would be rewriting history (T149).

### 17.5 What was trimmed before shipping

Four test files were named after the audit pass that produced them
(`phase-10f-{review,regrade,pass4,pass5}-findings.test.ts`) — a structure the pass-4 reviewer
correctly said *guarantees* that pass N+1 produces file N+1. The tests themselves defend real
invariants with positive and negative controls, so they were **renamed, not deleted**:

| was | now |
|---|---|
| `phase-10f-review-findings` | `gate-failure-human-decision-integrity` |
| `phase-10f-regrade-findings` | `retry-budget-and-escalation-answerability` |
| `phase-10f-pass4-findings` | `escalated-pool-disclosure` |
| `phase-10f-pass5-findings` | `escalation-tag-and-approval-attribution` |

Every `describe` was rewritten to name the invariant instead of the finding number. The 18-line
comment block in `dedup-policy.ts` was cut to the part a future reader needs.

### 17.6 Guards

Vault `~/.scns/memory/vault.db` **232488960 bytes / Aug 4 08:00:19 2026**, byte-identical before and
after every probe. Broker `:3456` pid 12855 untouched. All probes read-only; `scns review weekly`
(a writer) never run. No probe reached live write state.
