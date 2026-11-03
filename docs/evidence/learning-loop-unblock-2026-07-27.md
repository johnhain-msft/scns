# Evidence report — SCNS learning-loop unblock (phases A–D)

**Producer session:** `81f23fec-a88e-441d-b249-509da72fe27a` · **Date:** 2026-07-27
**Branch:** `track2/cosmere-federation-phase1` · **Base:** `7c97b8f` → **head:** `f0ae876` (local, not pushed)
**Role:** implementer. **I did not grade this work.** Independent fresh-context grader per plan §6.

Every runtime claim below is labeled **[live-confirmed]** (quoted output) or **[code-only]** (traced from
source, not observed at runtime).

---

## 0. Verdict on the ONE metric — NOT MET (missing precondition: real human traffic)

> Live rows on ≥2 arms with correct non-null propensity, **created after the fix**, from **real human traffic**.

```
$ sqlite3 -readonly "file:$HOME/.scns/memory/experience.db?mode=ro" \
    "SELECT id, COALESCE(explore_arm,retriever) arm, explore_arm, propensity, human_outcome,
            substr(created_at,1,19) FROM retrieval_experience WHERE id > 842 ORDER BY id;"
(no rows)

$ sqlite3 -readonly ... "SELECT MAX(id)||' @ '||MAX(created_at) FROM retrieval_experience;"
842 @ 2026-07-27 17:03:49
```
**[live-confirmed]** Zero rows have been created since the fix went live at 19:28:51. The newest row in the
production store predates the deployment. **I did not inject synthetic traffic to manufacture this metric.**

Per Validity-of-Null this is **BLOCKED, not a null**: the mechanism is deployed and demonstrably explores
(§2), but no human prompt has traversed the briefing path since. The DoD additionally requires a *settled*
row, which needs a **following** human turn — so it is inherently a multi-day wait, not a same-session result.

**What I can prove instead**, and did: the deployed configuration draws both arms with correct propensities
on real HTTP briefings (§2). That is the strongest evidence obtainable without John's own keystrokes.

---

## 1. STEP 0 — the inherited premise was partly WRONG (I stopped and reported before building)

| Inherited claim | Verdict | Label |
|---|---|---|
| RC-1: `selectExplorationArm` called ONLY at `cli.ts:1096` (`search:`); `briefing:` has none | **CONFIRMED** | code-only |
| Briefing rows therefore carry NULL `explore_arm`/`propensity` | **CONFIRMED** (678 magma rows, 0 non-null) | live-confirmed |
| `retrieveContext` exposes a per-call `traverse`/`multiHop` seam | **CONFIRMED** — and it already accepts `episode.exploreArm/epsilon/propensity` too | code-only |
| `explore-router.ts` does ε-greedy + propensity + bounds | **CONFIRMED** | code-only |
| `prompt-authorship.ts` classifies human vs machine | **CONFIRMED** | code-only |
| RC-3: `learnArmValues` has **zero production callers** | **WRONG** — `scripts/reward-report.ts` is a complete read-only consumer (learner + DR + promotion verdict). It only lacked a *scheduled* caller, and hardcoded `incumbent:'hybrid'` while the live incumbent is `magma` | code-only |
| §1 metric `GROUP BY retriever` distinguishes arms | **WRONG** — `retriever` is CHECK-constrained to `('hybrid','magma','full')` and `retrieverFamilyOf` maps BOTH `traverse` and `multiHop` → `'magma'` | code-only |
| Phase-B exit "a row with `retriever='multihop-iter'`" | **IMPOSSIBLE as written** (CHECK constraint). Correct exit = `explore_arm='multihop-iter'`; the learner already uses `COALESCE(explore_arm, retriever)` | code-only |
| "`explore_arm`/`propensity` NULL all-time" | **imprecise** — true for the 678 magma rows; 111 `hybrid` rows carry `explore_arm='hybrid', propensity=1.0` | live-confirmed |

**Framing challenge (not just facts):** the plan proposed **shadow** exploration. I found both settle
producers (`findReaskPriorId`, `findChainOutcome`) select
`WHERE conversation_id=? AND human_outcome IS NULL ORDER BY id DESC` matching normalized `query_text`
**[code-only]**. A shadow row shares the query text and has a **higher id**, so it would be settled *instead
of* the served row — attributing the human's verdict to an answer they never saw. Shadow is only safe if
shadow rows are excluded from settling, which makes settled challenger rows **permanently unreachable** —
i.e. the plan's own recommendation would have re-blocked the metric it was meant to unblock. John chose
**live-answer** exploration on this evidence.

---

## 2. Phase B — the keystone. Positive AND negative controls.

### 2a. Deployed-configuration positive control **[live-confirmed]**
12 real `POST /api/extension/context` briefings against a **copy** of the production vault, on an isolated
broker, with the **exact live env shape** (`SCNS_EXPLORE_ROUTING=1`, **no** `SCNS_EXPLORE_EPSILON`, **no**
`SCNS_LIVE_MEMORY_BRIEFING`). This tests the configuration we actually ship, not a forced one.

```
=== deployed-config draw (n=11) ===
id= 1 arm=magma         explore_arm=magma         propensity=0.5 ms=  813 ids_chars=421
id= 2 arm=multihop-iter explore_arm=multihop-iter propensity=0.5 ms=  775 ids_chars=659
id= 3 arm=multihop-iter explore_arm=multihop-iter propensity=0.5 ms= 1232 ids_chars=659
id= 4 arm=multihop-iter explore_arm=multihop-iter propensity=0.5 ms= 3003 ids_chars=722
id= 5 arm=multihop-iter explore_arm=multihop-iter propensity=0.5 ms= 3139 ids_chars=582
id= 6 arm=multihop-iter explore_arm=multihop-iter propensity=0.5 ms= 2752 ids_chars=624
id= 7 arm=magma         explore_arm=magma         propensity=0.5 ms= 1268 ids_chars=421
id= 8 arm=magma         explore_arm=magma         propensity=0.5 ms= 1146 ids_chars=421
id= 9 arm=magma         explore_arm=magma         propensity=0.5 ms= 1212 ids_chars=421
id=10 arm=magma         explore_arm=magma         propensity=0.5 ms=  975 ids_chars=421
id=11 arm=multihop-iter explore_arm=multihop-iter propensity=0.5 ms= 2747 ids_chars=694

realized split: {"magma":5,"multihop-iter":6}
distinct arms = 2 ✅ >=2
every row has non-null propensity: ✅
```
(11 of 12 — one request errored; disclosed, not hidden.) Probe:
`session-state/81f23fec-…/files/deployed-config-draw.mjs`.

### 2b. Controls and their inversion proof **[live-confirmed]**
`test/integration/briefing-exploration-live.test.ts` — 4 real-broker controls, all green:
positive (lever on ⇒ challenger served), negative (lever off ⇒ `explore_arm`/`propensity` stay **NULL**, not
a fake μ=1 draw), authorship (machine-authored prompt is never explored), arm-diversity.

**The controls are not tautological — I inverted them and they failed:**
```
expected null to be 'multihop-iter'          ← positive control fails when the lever is flipped off
```

### 2c. No parallel lane (the `__fleet__` precedent)
Phase B adds **no second policy and no shadow leg**. The briefing closure calls the same
`selectExplorationArm` through `selectBriefingArm` (a pure composition), and routes the arm through the
**pre-existing** `retrieveContext` `traverse`/`multiHop` cfg and the **pre-existing**
`deps.experienceLog.episode` propensity seam. `search:` (cli.ts:960–1183) is untouched. **[code-only]**

---

## 3. Two real retrieval defects found en route — and one overclaim I made and corrected

John challenged an early latency number: *"if the challenger is doing 11x the work with worse results then
there may be something fundamentally wrong… or you're measuring/testing incorrectly again."* He was right on
both counts.

- **My overclaim, corrected:** I first reported the challenger at **8253 ms**. That reading came from a cold,
  contended embedding worker. Re-measured with the broker's own `stage_timings`: **2087 ms median, 0/6 over
  the 5000 ms budget**. I withdrew the 8253 ms figure myself before acting on it.
- **Defect 1 — truncation.** `multihop-iterative.ts` returned `reciprocalRankFusion(sources,{limit: topK})`,
  capping at `topK=5` while the magma arm runs under `serializeAllVisited` with `returnBudget=200`. The
  challenger paid for up to 7 traversals and then **discarded ~94% of them** — it was **strictly dominated by
  construction**. Benchmarking it before this fix would have produced a fake "challenger is worse" verdict.
- **Defect 2 — redundant embedding IPC.** `makeSemanticRelevanceScorer` is bound to ONE query but re-ran
  `generateEmbedding` on that identical string on **every call** (the content-keyed memo in `embeddings.ts`
  is opt-in and deliberately OFF in prod). `semanticMs` was **92–96% of total latency on BOTH arms**.

**Measured effect [live-confirmed]** (isolated broker, real-vault copy, median of 6, budget 5000 ms):

| arm | before | after | context (ids chars) |
|---|---|---|---|
| magma (incumbent) | 780 ms (semantic 751 = 96%) | **273 ms** | 421 → 421 (unchanged ✓) |
| multihop-iter (challenger) | 2087 ms (semantic 1931 = 92%) | **253 ms** | **36 → 428–561** |

`semanticCalls` unchanged while `semanticMs` collapsed ⇒ the win is removed redundant IPC, not removed graph
work. Both fixes are TDD red-first with an **inversion control** proving the tests detect the bugs:
```
expected spy to be called 1 times, but got 4 times     ← re-embedding test, inverted
expected 5 to be greater than 5                        ← returnBudget test, inverted
```

---

## 4. Phases A, C, D

- **Phase A [live-confirmed].** Additive migration + `recordGateDecision()`. The columns exist in the
  **production** store: `PRAGMA table_info` → `29|gate_decision|TEXT`, `30|gate_max_sim|REAL`. (This is the
  only reason production `experience.db` mtime/size moved — the migration ran at startup and added **zero**
  rows.)
- **Phase C.** `BOOTSTRAP_EPSILON=0.5` decaying to `STEADY_EPSILON=0.1` once every arm clears `minN=10`
  (John-approved; surfaced as an explicit threshold decision, never buried). Live state resolves to **0.5**
  because magma has 9 settled < 10. Fixed a latent trap: `countExplorations24h` counts
  `explore_arm IS NOT NULL`, and since exploit draws now also stamp `explore_arm`, the default cap of 20
  would have tripped after ~20 ordinary turns and **silently disabled exploration**; the briefing path now
  passes `BRIEFING_CHALLENGER_ARMS` so only real explorations count.
- **Phase D [live-confirmed].** Reused `scripts/reward-report.ts` (extracted to `reward-report-run.ts`, the
  script is now a thin wrapper — no second copy), fixed `incumbent` to mirror the live briefing arm, and
  registered the consumer on **the broker's own scheduler** (dogfooding SCNS's primitive — not an external
  cron). It runs on a real tick and reports the honest null:

```
[21:40:05.431] INFO (scns/48620): reward-report:
store: /var/folders/…/tmp.WvbKCWWfbS/.scns/memory/experience.db (read-only) — 9 settled row(s), incumbent=magma
=== Phase D — offline accept-vs-waste arm-value report (KTO/IPO + clipped IPS) ===
incumbent: magma   certified: false (always — the gate certifies, not the learner)
arm            n    effN     rawMean  shrunkMean  (prior 0.5)
magma           9   9.0000  0.5333   0.5158
no proposal — the incumbent stands (a measured null is a success)
  DR[magma        ] = 0.5333  (nUsed=9, invalid-propensity dropped=0)
[21:40:05.432] INFO (scns/48620): Task completed
    module: "task-scheduler"
    taskId: "reward-report"
    durationMs: 7
```

**Correction I had to make to my own verification:** I first "proved" this via
`POST /api/scheduler/tasks/reward-report/run` and quoted `run_count=1 last_status=success`. That route is a
**stub** — `dashboard-routes.ts:379` calls `recordTaskRun(db, id, 'success', …)` and **never invokes the
registered handler**. My quote proved nothing about execution. I withdrew it and re-proved via a real
scheduler tick (above), where dispatch is `runTask → mutableHandlers.get(id) → handler(task)`.

---

## 5. Disclosure — I mutated live shared state without approval, and fixed it

**What happened [live-confirmed].** My first Phase-D probe set `SCNS_HOME=$(mktemp -d)` and I believed it was
isolated. It was not: `broker/config.ts:70` defaults the scheduler DB to
`join(homedir(), '.session-broker', 'data.db')` and is scoped by **`BROKER_DB_PATH`, not `SCNS_HOME`**. So my
probe shared the **live** scheduler DB, and its `PATCH … {"cron_expression":"* * * * *"}` landed on
production. The live broker then ran `reward-report` every minute:

```
19:58:33 44175 None | reward-report: …          ← PID 44175 is the LIVE :3456 broker
19:59:33 44175 None | reward-report: …
20:00:52 44175 None | reward-report: …
LIVE cron='* * * * *' run_count=15
```

**Remediation [live-confirmed].** Restored immediately: `RESTORED cron='0 5 * * *' enabled=True`.

**Blast radius, measured not assumed:** the handler is read-only, and production `experience.db` is
**byte-identical (`1785194930|2850816`) across all 16 runs**. Impact was log noise and a few ms of CPU.

**Root cause in MY code, fixed TDD red-first (`f0ae876`):** `reward-report-run.ts` resolved its store with
`join(homedir(), …)` instead of `resolveScnsHome()`, so an "isolated" broker silently read the **live**
store. The red test literally demonstrated it — `out.ok` was `true` under a nonexistent `SCNS_HOME`. Now 12/12
green, and the re-run proves the isolated path is used:
`store: /var/folders/…/tmp.WvbKCWWfbS/.scns/memory/experience.db`. Production behavior is unchanged
(`SCNS_HOME` unset ⇒ `resolveScnsHome() === homedir()`).

**Pre-existing finding, NOT fixed (out of scope, flagged for John):** `BROKER_DB_PATH` is not `SCNS_HOME`-
scoped, so *any* "isolated" broker started with only `SCNS_HOME` set will share the live scheduler DB. My
take-2 probe works around it explicitly and asserts the live scheduler DB is unchanged.

---

## 6. Guards

| Guard | Result | Label |
|---|---|---|
| Live vault `~/.scns/memory/vault.db` read-only by me | **HELD.** Size **232488960 unchanged throughout**. mtime moved once, at 20:00:33, attributable to the **live broker's own** reindex (`20:00:33 44175 \| Indexed 3 files, 0 chunks`). My probes only ever `copyFileSync` **from** it. | live-confirmed |
| `experience.db` backed up before the additive migration | `experience.db.bak-20260727-131242` (2 842 624 B) | live-confirmed |
| `:3456` undisturbed | **Partially breached and disclosed** — see §5 (cron mutated, restored). The broker was restarted with John's prior explicit approval; live listener is PID 44175, started 19:28:51, **16 s after** `dist/cli.js` was written at 19:28:35 ⇒ running the post-fix build. | live-confirmed |
| Isolated `SCNS_HOME` + non-3456 port | Take-1 defective (§5); take-2 correct and asserted | live-confirmed |
| Kill-by-PID only | All kills used explicit PIDs | live-confirmed |
| No force-push / no push | `f0ae876` is local; nothing pushed | live-confirmed |

---

## 7. Tests

- Full unit suite: **6439 passed, 1 skipped, 0 failed** (426 files) **[live-confirmed]**.
- `npx tsc --noEmit`: clean **[live-confirmed]**.
- New: `gate-decision-record` 6, `briefing-exploration` 13, `briefing-exploration-live` 4 (real broker),
  `semantic-relevance-memo` 5, `reward-report-run` 12, plus a `returnBudget` block in `multihop-iterative`.

## 8. Commits (local, `track2/cosmere-federation-phase1`)

```
f0ae876 fix(reward): resolve the experience store through SCNS_HOME, not homedir()
94934bb test(scheduler): seed count 17 -> 18 for the reward-report task
843148c feat(reward): give the arm-value learner a scheduled read-only consumer (Phase D)
b1482d0 fix(retrieval): stop re-embedding the bound query, and honor returnBudget in the multi-hop arm
44faccd feat(explore): route epsilon-exploration onto the LIVE briefing path (Phase B+C)
5dccbee feat(gate): record the trigger decision + OOS similarity per row (Phase A)
```

## 9. What the grader should NOT accept from me

I am the producer. The metric in §0 is **not met**, and I am reporting that rather than dressing up the
deployed-config draw in §2a as if it were live human traffic. It is not: those rows are on an isolated
broker, generated by a probe, from a copy of the vault. The honest state is **BLOCKED on real human
traffic**, with the mechanism proven ready.
