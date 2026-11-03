---
applyTo: "**"
---

# SCNS working discipline — fix-first, evidence-first, no circling (permanent)

> These are the DURABLE process lessons (survive after the temporary `AGENTS.md` MAGMA scaffolding is deleted).
> Read `docs/NORTH_STAR.md` first — it holds the single current metric + ranked next moves.

## 1. Fix-first, not audit-first (the anti-circling rule)
Before building measurement/audit apparatus or "one more gate," ask the fix-first question:
**"What is the smallest change that moves the north-star metric — and am I doing THAT, or building apparatus?"**
A named bug in your path gets FIXED (TDD, red-first) before you scaffold more measurement around it.
Check-AFTER-doing is good; check-INSTEAD-of-doing is how the project circled for weeks. History: a 64/64-task
build and 121 commits over ~12 days moved the target metric by 0; a ~120-line targeted fix moved it 0.59→0.78.

### 1a. Capability, not a proxy instrument (the trap fix-first itself can spring)
Fix-first is only safe when the "metric" IS the north-star CAPABILITY. If the metric is a **proxy instrument
reading** (e.g. "produce one `human_outcome` row", "make the gate emit", "get a green harness"), fix-first will
faithfully drive you to build the smallest **proxy** — which moves the reading and not the ball. Before acting:
**"Is this deliverable the north-star capability, or an instrument that measures a small piece of it? If an
instrument — reject it and build the mechanism instead."** A re-ask string-matcher that emits a row is the
reductio: smallest change that moves the proxy, ~zero contribution to the actual capability (learning/intent).

### 1b. Build-from-paper, not instrument-a-proxy; grade in parts, measure once at the end
For any north-star mechanism, the FIRST move is to **name the academic/prior-art source and extract its concrete
algorithm** (not a bibliography summary — the actual mechanism), then **BUILD it**. Do NOT create a whole phase
whose deliverable is *measuring* a small thing — that is the manufactured-apparatus anti-pattern. **Measure ONCE,
after the mechanism is built; grade in PARTS with independent fresh-context graders along the way** (producer ≠
grader still holds). If no paper grounds the work, the first move is to find one — never substitute a hand-rolled
proxy for the researched mechanism because it was tagged "later."

### 1c. Challenge the FRAME, not just its facts (inherited-plan discipline)
A handed-off framing can be architecturally wrong even when every cited fact is literally true (§5 below). When a
plan says "defer the keystone X, do proxy Y first," check X against our OWN in-repo research before executing: if
the research names X as THE build and Y rests on a signal X exists to debias, the sequence is backwards —
escalate the contradiction, do not faithfully execute the proxy. "Apparatus-before-baseline" is a real caution,
but building the product MECHANISM that manufactures the baseline is NOT apparatus.

## 2. Name the ONE metric, and hold the framing
State the single success metric for the task and what the work IS and IS NOT (guard against drift — e.g. MAGMA
is a self-learning SUBSTRATE, not a hybrid-vs-magma QA horse race; LoCoMo QA is the wrong axis for it). The
metric is answer/outcome quality + cost, never retrieval recall.

## 3. Evidence-first, anti-overclaiming (see .github/copilot-instructions.md)
Quote the real output row. Live-verify (not exit codes / HTTP 200). A measured NULL, honestly reported, is a
success. Never claim "tests pass" / "it works" without the actual row. Positive AND negative controls.

### 3a. Claim-evidence table for runtime claims (the anti-overclaim gate)
Any analysis, report, or handoff that makes a RUNTIME-BEHAVIOR claim — signal words **"runs live / handled by /
never fired / unwired / vestigial / dead / disabled / always / never / X runs via Y"** — MUST ship a
claim-evidence table labeling EACH such claim exactly one of:
- **`live-confirmed`** — quote the actual log line / event row / probe output that proves it (NOT a code path,
  NOT an exit code, NOT HTTP 200).
- **`code-only / inferred`** — traced from source, not observed at runtime.
Every `code-only` runtime-behavior claim must be **verified-live OR explicitly downgraded to a code-only phrasing
BEFORE the report ships** (e.g. "the watchdog never fires" → "no caller of `createWatchdogDaemon` found in source
`[code-only]`"). Verify **per item** — never generalize one mechanism across several IDs. And remember:
**`run_count=0` ≠ capability dead** — the work may run via a poller/`setInterval`/other path. Optional but
recommended: a `rubber-duck` pass on any report carrying ≥1 runtime claim. When continuing from a prior session,
do NOT re-assert its `[live]` claims as your own — carry them tagged as inherited until you re-verify.
History (2026-07-09): a report called heartbeat/zombie/rotation scheduler rows "vestigial … handled by separate
pollers" as asserted fact from code-tracing alone — but `run_count=0` only proved the SCHEDULER didn't fire them:
heartbeat/zombie actually run live via `startHeartbeatPoller` (488 `zombie_cleaned` events), while
rotation-watchdog really WAS unwired (`createWatchdogDaemon` has no caller; 0 rotations ever). One live-vs-code
label per item — instead of one plausible code path over-generalized across three IDs — would have caught it.

### 3a.1. Mechanism evidence is not causal attribution
`X is broken` and `X caused Y` are separate claims. A causal claim MUST enumerate the other paths capable of
producing the same observation and cite the evidence that rules each one out. If any plausible producer remains
unexcluded, write **`attribution not established`**. Verifying a mechanism and then assigning it the observed rows
is an overclaim, not a diagnosis.

Use this table for every causal conclusion:

| Observation | Mechanism evidence | Other producing paths | Exclusion evidence | Attribution |
| --- | --- | --- | --- | --- |

### 3a.2. Blind-first review commissioning
When a producer commissions review of its own work, pass one MUST use
`.github/skills/blind-review/SKILL.md`. The reviewer receives only hash-frozen artifact pointers and the
acceptance-source pointer generated by `scripts/blind-review-prompt.ts` — never producer findings, alleged fixes,
or a tailored review list. The actual task prompt MUST be recovered from the session event log and hash-matched
with `scripts/blind-review-dispatch-proof.ts`; intended text is not evidence of dispatched text.

If prior findings are needed, they enter only through a separately generated
`BLIND_REVIEW_FOLLOWUP_V1` request after the blind verdict exists. A different model or session identity without
this framing separation does not satisfy producer ≠ grader.

### 3b. Probe an ISOLATED instance — never write test traffic into the live corpus
§3/§3a demand live verification. They do **NOT** license pointing write-traffic at the live system.
**Only real rows belong in the real DB.** Before any verification step, classify it:
- **READ-ONLY against live is fine** — `GET`s, `PRAGMA`/`mode=ro` SQLite reads, reading `~/.scns/logs/*`,
  `ps`. Use these to confirm a deployment took effect.
- **ANY WRITE-PATH probe goes to an isolated instance** — a broker on a spare port with **BOTH**
  `SCNS_HOME=$(mktemp -d)` **AND** `BROKER_DB_PATH=…` (SCNS_HOME alone does *not* scope the scheduler DB).
  This covers every endpoint that records an experience/observation/outcome — `POST /api/extension/context`
  is the trap: it looks like a read ("just fetch the briefing") but it **appends a `retrieval_experience`
  row**, and a repeated probe query is then read by the follow-up satisfaction reader as a dissatisfied
  human re-ask.
Any prompt, skill, note, or handoff that asks for live verification MUST say up front which DB the probe
targets and that non-human traffic is forbidden in the live corpus. If a probe does reach live state,
say so in the report and remove the rows you created — do not quietly leave them.
History (2026-07-28): verifying the weekly-review nudge, two identical probes to `POST /api/extension/context`
on the LIVE broker :3456 wrote rows 1016–1018; the reader labelled 1017 `human_outcome=0.2` against
`arm=magma`. Mechanically correct, semantically false — and it was the **only** learnable row in the
corpus (`BOTH` 0 → 1), so it would have taught the learner "magma caused friction" from a test artifact.
The isolated-broker pattern was already used earlier in that same session for the scheduler check; the
briefing probe simply wasn't recognized as a write. **Corollary defect (open):** nothing marks a retrieval
as machine-originated, so agent/probe traffic is indistinguishable from human traffic at label time.

## 4. Prior-art first — literature AND codebase (don't reinvent; validate the premise, not just the facts)
For research/design work, search the literature FIRST (annotated bibliography: technique → lego it provides →
adopt-vs-build) BEFORE designing. It's probably solved in parts.
**For ANY "build X / wire up Y / fill this gap" work, do CODEBASE prior-art first: map ALL existing code paths
that already serve the target capability BEFORE building — not just the one dead/unwired component a plan names.**
When executing a handed-off/inherited plan, check its ARCHITECTURAL PREMISE against the code, not only its literal
facts: a cited fact can be TRUE ("component X's scale-up is unwired") while the framing is WRONG ("so the system
can't scale up") because another path already serves the capability. Run the whole-system capability map during
PLANNING, not after building. History: built a redundant `__fleet__` flat-worker lane to light up a dead
auto-scaler `onSpawn` — the capability already existed (task→manager→dev/qa + `AgentCapExceededError` cap +
team-reaper); it had to be deleted. The post-hoc surface map would have prevented it had it run first.

### 4a. Dogfood-first: use the SYSTEM's own primitives (the trigger fires on ops/automation verbs too)
The §4 map is NOT just for "build/wire/fill-gap" tasks — it MUST fire for any **schedule / automate / make it
recurring / spawn / orchestrate / notify / retry / persist / observe** verb. If you are working on or with a
system that HAS that capability (SCNS: broker scheduler + `agent.addTask` self-scheduling + team spawn + memory
+ blue/green), the DEFAULT is to use the system's own primitive. Reaching for a generic EXTERNAL tool (launchd,
raw cron, a hand-rolled shell script, a fresh DB) to do something the host system already does is the `__fleet__`
redundancy in a new costume — and "it's just ops / just a cron" is exactly the mis-bucketing that lets the §4
trigger sleep. Before writing an external mechanism, name the in-system primitive you checked and why it does or
doesn't fit. History (this session): built a static every-day **launchd** cron for a scheduled project when SCNS
has its own broker scheduler (60s tick + sleep-catch-up), a self-scheduling handler pattern
(`self-issue-ingest → agent.addTask`), and literal precedent for driving external projects
(`newsletter-daily` / `realestate-news-learner`) — none were mapped before building.

### 4b. Preserve the ACTOR the user named; "it works" ≠ "it's right"
Restate WHO the user named as the owner/actor of the capability and preserve it. "X schedules its OWN jobs",
"the brain fixes itself", "SCNS manages the cycle" name **X / the brain / SCNS** as the actor — do NOT silently
substitute yourself or an external tool as the doer. When the user has expressed an architectural preference
(who owns it, which mechanism, dynamic vs static), state the DESIGN back and get a thumbs-up BEFORE building —
end-to-end verification of a design that doesn't match intent is wasted rigor. A green, fully-verified artifact
that runs the wrong architecture is a MISS, not a win; "it works" is not "it's right per your intent."

## 5. Dev-default-ON: ship it, iterate in branches (no premature prod gating)
**SCNS is pre-production — there is no prod environment yet, so there is NO "default-OFF until a measured
win" gate.** Ship new capabilities ENABLED and iterate: work in branches, commit often, break things and
recover. Reflexively hiding new work behind an env flag / a "measure-first go-live ladder" / AWAITING-JOHN
was the single biggest source of circling (building apparatus and never turning it on) — do NOT do it.
That gate is a PROD flag to add IF/WHEN a production environment exists.
This does NOT relax: (a) **evidence-first reporting** (§3/§3a — quote the real row, live-verify, label
live-confirmed vs code-only, no overclaiming); (b) **no-mistesting** — when you DO measure a genuine
scientific/comparative CLAIM, use positive+negative controls and give a real verdict its own fresh-context
INDEPENDENT sign-off (producer ≠ sole grader); (c) the **safety guards** (§6) protecting the one shared
running dev instance — the live `:3456` broker, `~/.scns` vault, allowlist, spend — which stay human-owned.
Measure to BACK A CLAIM, never as a prerequisite to enabling dev work.

## 6. Guards (non-negotiable for any run)
Isolated `SCNS_HOME` **and** `BROKER_DB_PATH` (SCNS_HOME alone does not scope the scheduler DB); the live
vault `~/.scns/memory/vault.db` is READ-ONLY (assert mtime/size unchanged before+after; open a COPY to
test); the live experience corpus `~/.scns/memory/experience.db` is likewise **never** a probe target
(see §3b — only real rows in the real DB); broker `:3456` untouched — read-only `GET`s to confirm a
deploy are fine, write-path probes are not; kill-by-PID only; no unapproved push; hard-stops →
`docs/evidence/AWAITING-JOHN.md`.

## 7. Cycle the session before it degrades
Long contexts regress (framing drift, mistesting). Hand off (the `handoff` skill) before a scientific verdict
and when a session crosses a complexity threshold — a fresh context per verdict is a feature, not overhead.
