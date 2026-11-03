# C8 — settle precedence under a producer race — evidence (2026-08-02)

Finding C8 (MED): *"two producers race for the same record — first-signal-wins must favour the
higher-provenance signal"* had no task and no test. Investigating it found a **real TOCTOU defect**,
not just a missing test.

## 1. The premise, checked before building

> ⚠ **CORRECTED 2026-08-02 — this section's conclusion was WRONG.** Claim (1) below does **not** hold:
> the synchronous call order in `cli.ts` covers only the interactive path. `runSettleSweep`
> (`cli.ts:1876` → `settle-sweep.ts:131`) walks up to `DEFAULT_SWEEP_CONVERSATIONS = 5000` unsettled
> conversations running **only the two derived producers** — `settleGateAnswered` appears nowhere in
> `settle-sweep.ts` (`grep -rn settleGateAnswered src/` → `cli.ts:1363` and `gate-elicitation.ts` only).
> Claim (2) is also narrower than stated: `hasPendingGateQuestion` is called at exactly
> `query-chain.ts:367` (inside `findChainResidue`) and `:435` (inside `settleFollowupOutcome`).
> **`findChainCandidates` — the shared eligibility pass — has no gate predicate at all**, so
> `findChainOutcome` → `settleChainOutcome` will settle a gate-pending row and the oracle answer is then
> permanently refused. **C8 is HALF fixed.** Live exposure re-measured 2026-08-02 read-only: rows 843,
> 2068 and 2072 are delivered-unanswered, unsettled, on arm `magma`, and inside the 1500 ms delivery gate
> (2068/2072 appeared during this session — the exposed set grows with live traffic). Full detail and the
> scope decision: `003-judge-triage-2026-08-02.md` → DP-F1.

`settleHumanOutcome` (`experience-store.ts:460-465`) is `WHERE human_outcome IS NULL`. That is a
correct atomic no-lost-update, but it is **purely temporal** — the SQL has no idea which producer is
better. So the "higher-provenance wins" property is not in the database at all. It lives in two
places, and neither had a test:

1. the synchronous call ORDER in `cli.ts` (re-ask → gate → chain → follow-up reader **last**) —
   ⚠ **interactive path only; does not cover `runSettleSweep`** (see correction above), and
2. `hasPendingGateQuestion` (`query-chain.ts:374`), which stops a derived reader labelling a row that
   is waiting for an oracle answer — ⚠ **applied in `findChainResidue` and `settleFollowupOutcome`
   only, NOT in `findChainCandidates`** (see correction above).

I also verified the narrower worry is already closed: `answer_source` has exactly **one** writer in
`src/` (`experience-store.ts:462`) and it is inside the same guarded UPDATE, so a derived label cannot
overwrite an oracle one's provenance while leaving its value.

```
$ grep -rn "answer_source" src/ --include=*.ts | grep -v "^\s*\*"
src/memory/experience-store.ts:462:                answer_source = COALESCE(?, answer_source)   ← the only write
```

## 2. THE DEFECT — guard 2 is checked before an `await`, and settles after it

`findChainResidue` applies `hasPendingGateQuestion` at **candidate-selection** time. The caller then
awaits an ACP round-trip before settling (`cli.ts` ~1394-1410):

```ts
const residue = findChainResidue(store, {...})          // ← guard evaluated HERE
if (residue) {
  void (async () => {
    const reading = await readFollowupSatisfaction(...)  // ← seconds may pass
    if (reading) settleFollowupOutcome(store, {...})     // ← settles HERE, guard never re-read
```

A clarifying question **delivered during that window** (`markGateDelivered`, `cli.ts` ~1424, fires on
the very next briefing) is invisible to the earlier check. The derived label lands, and the human's
oracle-grade answer is then refused **permanently**, because the row is no longer NULL.

This is exactly the race the edge case names, and the direction that matters: the derived signal
winning is unrecoverable, whereas the oracle winning is the desired outcome.

## 3. RED first

```
× C8 [US2] settle precedence … > REFUSES a derived settle when a clarifying question was delivered DURING the await
     → expected true to be false // Object.is equality
 Test Files  1 failed (1)
```

`settleFollowupOutcome` returned **true** — it settled a row with a question in flight.

## 4. The fix

One statement in `settleFollowupOutcome` (`query-chain.ts`), re-reading the guard at settle time.
No new settle path, no new gradient, no change to `maxReads` or to the deterministic-before-derived
ordering.

GREEN, with the two adjacent suites that own this seam:

```
 Test Files  3 passed (3)
      Tests  48 passed (48)
```
(`settle-precedence-race.test.ts`, `chain-residue.test.ts`, `query-chain.test.ts`)

## 5. Mutations — both directions, because "always refuse" would also pass the headline test

| # | Mutation | Applied? | Result |
|---|---|---|---|
| M1 | delete the settle-time re-check | `grep -c` → 0 ✅ | `Tests 1 failed \| 4 passed (5)` — `expected true to be false` ✅ caught |
| M2 | **invert** it (`!hasPendingGateQuestion`) ⇒ always refuse | `grep -c` → 1 ✅ | `Tests 3 failed \| 2 passed (5)` — `expected false to be true` ×2 ✅ caught |
| M3 | **really reorder `cli.ts`**: swap the QUERY-CHAIN and FOLLOW-UP READER blocks so the derived producer runs first | verified by index: residue 74391 < chain 76137 ✅ | `Tests 1 failed \| 4 passed (5)` — `expected 37466 to be greater than 39005` ✅ caught |

M2 is the one that matters for honesty: without the negative controls, deleting the entire follow-up
signal ("always refuse") would have turned the headline test green. Restores verified byte-identical
with `diff -q` after all three; `diff -q /tmp/cli.bak src/cli.ts` clean after M3.

## 6. The order guard is comment-stripped and single-site

`cli.ts` documents this precedence in prose immediately next to the code, so an un-stripped source
scan would match the *explanation* rather than the call. The guard strips block and line comments
first, and asserts each producer has **exactly one** call site — a second occurrence would make
`indexOf` ambiguous and could hide a reorder behind a passing test. Verified each needle occurs once
and none appear in comment lines.
