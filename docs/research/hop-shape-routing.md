# Hop-shape routing — design, prior art, ground truth, and the cutover bar

**Status:** Step 2 of the purpose-routing rework (branch `feat/step2-purpose-routing-accuracy`,
2026-08-15). Shadow/offline only. Zero live behaviour change.
**Authority:** `docs/NORTH_STAR.md` → "Retrieval design intent" (John, 2026-08-14). Read that first;
this document implements it and does not re-litigate it.

## 1. What this is

`magma` serves **single-hop** retrieval (one thing to look up, then Stage-4 narrative synthesis).
`multihop-iter` serves **multi-hop** retrieval (several things that must be chained: entity → relation
→ entity, cause → effect, state-then vs state-now). They are purpose-routed tools, not rivals. The
routing question is therefore *"which shape does this query have?"*, and the evaluation question is
*"was the query sent to the tool its shape required?"* — routing accuracy, not arm superiority.

Step 2 delivers:

- **D1 — the weekly review speaks routing accuracy.** `src/reward/routing-accuracy.ts` computes it,
  `src/suggest/routing-format.ts` renders it, `src/suggest/weekly-report.ts` reads the corpus for it,
  and both live callers (`weekly-promotion-review` cron and `scns review weekly`) render from that one
  path. The promote/retire verdict and the `arm-promotion` proposal are gone.
- **D2 — the hop-shape classifier, heuristic first, offline first.** `src/memory/hop-shape.ts` (+
  `hop-shape-signals.ts`) classifies a query as `single-hop` / `multi-hop` / `ambiguous` with typed
  reasons; `scripts/hop-shape-eval.ts` measures its agreement with human outcomes over the labelled
  corpus, read-only.

## 2. Prior art (project rule: prior-art first)

**Adaptive-RAG** — Jeong, Baek, Cho, Hwang, Park. *Adaptive-RAG: Learning to Adapt Retrieval-Augmented
Large Language Models through Question Complexity.* NAACL 2024, arXiv:2403.14403.

What it does: a small classifier (T5-large) predicts a query's complexity class — **A** no retrieval,
**B** single-step retrieval, **C** multi-step iterative retrieval (IRCoT-style) — and the system runs
the matching strategy. Two properties are the direct precedent here:

1. **Route by complexity, not by a global winner.** The paper's whole point is that no single strategy
   dominates; the win comes from sending each query to the strategy its complexity calls for. That
   is the purpose frame.
2. **Ground truth from outcomes, not annotation.** Its training labels are "silver": each query is
   labelled with the *simplest* strategy that produced a correct answer; unlabelled queries inherit
   a dataset-level bias (single-hop datasets → B, multi-hop → C). Nobody hand-annotates complexity.

What is adapted, and what is not:

| Adaptive-RAG                                | SCNS Step 2                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| three classes A/B/C                         | two tools + an explicit `ambiguous` class ("no retrieval" is GATE's `no-memory-need`, out of scope) |
| learned T5 classifier                       | **heuristic first**: deterministic structural scorer, versioned; a learned classifier comes later |
| labels = which strategy answered correctly  | labels = the human accept/waste outcome under **query-independent assignment** (see §4)         |
| "simplest strategy that succeeds" bias      | single-hop is the default; multi-hop must be *argued for* (`HOP_SHAPE_MULTI_MIN_EVIDENCE`)      |
| its codebase                                | nothing borrowed but the idea                                                                   |

## 3. The classifier — `heuristic-v1`

Pure, deterministic, never throws, case- and whitespace-insensitive. Reads only the query's structure.
It does **not** read GATE / the Phase-13 intent interpreter and must not be coupled to it — hop-shape
("how many things must retrieval chain?") is a narrower question than intent ("what does the human
want?"). John was explicit.

**Signals** (`hop-shape-signals.ts`, all plain regular expressions, tuned to the live corpus's shape —
typo-laden coding-assistant traffic, not textbook QA):

- *referents*: PR/issue numbers, paths, filenames, spec/task ids (`T045`, `FR-034`, `SC-019`), spec
  dirs, backticked code, double-quoted strings, snake_case / camelCase / `ALL_CAPS_WITH_UNDERSCORE`
  identifiers — with **containment dedupe** (a path ⊃ its filename ⊃ an `a/b` token is one referent);
- *work nouns* outside referents ("the fix", "the tasks") — nominal entities;
- *anaphora* that must resolve against something else ("these bugs", "that handoff", "the fix we need");
- relation words (between / against / fit into / depends on …), comparison, causal (why / root cause /
  how could …), temporal (since / where we left off / what changed / ≥ 2 dates …), aggregation
  (overall / summarize / where are we …), sequence (then / after that / so they can), question count;
- imperative and yes/no openers; the "read `<one path>` and …" file-directive shape.

**Reasons and weights** (`HOP_SHAPE_WEIGHTS`): multi-hop — `multi-entity-relation` 2, `causal-chain` 2,
`comparison` 2, `temporal-chain` 1.5, `aggregation` 1.5, `reference-following` 1.5, `multi-question` 1,
`sequence-chain` 1, `multi-referent` 1; single-hop — `short-directive` 2, `file-directive` 2,
`single-referent` 1.5, `yes-no-status` 1.5, `plain-request` 1 (fires only when nothing else did).

**Decision rule:** `multi` and `single` are the summed weights.

- both zero → `ambiguous` / `no-signal` (empty prompt, "ok", "thanks");
- multi leads by ≥ `HOP_SHAPE_MARGIN` (1) **and** multi ≥ `HOP_SHAPE_MULTI_MIN_EVIDENCE` (1.5) → `multi-hop`;
- multi leads but is below 1.5 → `ambiguous` / `weak-signal` (a lone "then" is not an argument for chaining);
- single leads by ≥ 1 → `single-hop`;
- otherwise → `ambiguous` / `conflicting-signals`.

`ambiguous` is a **class**, never a coin flip: it carries the reasons it saw and recommends no tool. A
coin flip would silently poison the agreement measurement that gates the live cutover.

**Version discipline:** any change to a pattern, weight, margin, or the decision rule bumps
`HOP_SHAPE_CLASSIFIER_VERSION`; every report and JSON summary names the version it measured, so a
revision cannot inherit an old number.

**Unit controls** (`test/unit/memory/hop-shape.test.ts`): clear single-hop (directives, one-path
directives, yes/no status on one referent), clear multi-hop (causal, relational, temporal,
aggregation, reference-following), and ambiguous (empty, acknowledgements, balanced conflict, lone
weak cue), with negative controls in each direction. The controls are the only "structural
annotation" this design uses (see §4).

## 4. Ground truth — decided: outcome-based, per class, under query-independent assignment

Two candidates were weighed for "what is the right tool for this query?":

**(a) Structural annotation.** A human labels a sample of queries with their true hop-shape; the
classifier is scored as precision/recall against that.

**(b) Outcome-based, per class, under query-independent assignment.** The ε-exploration policy picks
the tool from an RNG and the exploration bounds, never from the query, so within each predicted
shape both tools were served the *same* query distribution. Slice the settled rows by the
classifier's predicted shape; within each shape the tool the shape calls for should accept at a
higher rate than the other tool.

**(b) is chosen**, for three reasons that are each sufficient:

1. It measures the north-star quantity — accept-vs-waste on real usage — rather than a human's
   opinion about query structure. A classifier that matches an annotator but does not move outcomes
   is not a routing classifier.
2. It costs **zero new labels**. Labels are the scarcest resource (74 of 2,623 rows on 2026-08-14;
   GATE asks 0–1/day). Annotation would spend John's attention on a proxy.
3. It is exactly how Adaptive-RAG derives its own routing labels (§2): from which strategy actually
   succeeded, not from annotation.

(a) survives only as the hand-picked positive/negative controls in the unit tests, which pin the
classifier's *behaviour* on unambiguous shapes; they are not the accuracy metric.

**The agreement metric and its chance level — stratified and balanced.** With
`accepted = human_outcome > 0.5` (the 6-point gradient: 0.6 partially-used and above is an accept;
0.4 ignored, 0.2 waste, 0.0 hard waste are not), for each non-ambiguous shape *s* in which both tools
have settled rows:

    advantage(s) = acceptRate(shape's tool | s) − acceptRate(other tool | s)
    agreement(s) = 0.5 + 0.5 · advantage(s)
    agreement    = Σ_s w_s · agreement(s),   w_s = settled rows in s / total comparable rows

If the classifier carries no routing information, the two tools accept at the same rate within every
shape, so every `agreement(s)` is 0.5 and the total is 0.5 — **under any assignment ratio and any
per-shape base accept rate**. That unconditional chance level is the reason for the stratified form.
The naive pooled form `agree(row) = (servedTool == recommendedTool) == accepted(row)` — which the
first draft of this PR used — does *not* have it: its chance level is `0.5 + ½(2q−1)(2p−1)…` in the
served share *q* and the base rate *p*, and the independent review of the PR reproduced it reading
0.65 (Wilson lower bound 0.58, "cutover MET") for a provably uninformative classifier under an 80/20
served split. The live sample is not 50/50 (see §5), so the pooled form is unusable here; its raw
2×2 counts are still printed because they are legible, labelled as not-the-metric.

The interval is an *approximate* 95% interval: Wilson half-widths per (shape, tool) cell,
propagated through the weighted difference. The report says "under-powered" whenever it includes
0.5, "informative" only when the whole interval sits above 0.5, and — a distinct, actionable finding
— "below chance / anti-informative" when the whole interval sits below 0.5.

**Caveats carried, not hidden** (they are in the code header and the rendered text):

- Assignment is query-independent but not uniform over time: `propensity` records the logging
  policy per row — 0.5 in the balanced era, 0.9/0.1 in the ε=0.1 era, 1.0 when an exploration bound
  forced the default tool. The settled sample mixes all three (§5) and the report prints that mix.
  Stratification handles the ratio; it does not handle a difference in query MIX between eras, so a
  propensity-weighted variant is a documented follow-up if that is ever suspected.
- The **settled** population is not the **served** population. Live 2026-08-15: 561 of 803 served
  human-attributable rows classify single-hop, but 459 of those are the machine-templated
  `Read the file at /var/…/tmpXXXX.md and follow the instructions inside it exactly` sub-agent prompts,
  which are `prompt_origin='human'` by the authorship classifier yet can never settle. The settled rows
  are John's real conversational prompts and skew multi-hop (37 of 55 classified). Agreement is
  computed on settled rows only, so it is not distorted by the templates — but the "unsettled served
  rows classify as" line in the report should be read with this in mind. (Authorship classification
  is a separate concern and is not touched here.)
- `hybrid` is no longer served, has NULL `conversation_id` on all 73 rows, and is excluded from every
  comparison; it appears only in the "No longer served" funnel line.
- Data-integrity caveats (FR-034 provenance-free labels; issue #18 duplicate turn binding) are
  measured against the corpus each run and printed under the numbers, in three states (listed / none /
  NOT MEASURED).

## 5. Measured on the live corpus, 2026-08-15 (read-only; `experience.db` mtime/size unchanged)

`npx tsx scripts/hop-shape-eval.ts` on `~/.scns/memory/experience.db` (2,777 rows / 85 settled in
total; 745 served human-attributable rows on the two live tools, 72 of them settled). Assignment mix
among those 72: served magma 58 / multihop-iter 14; logged assignment probability p=0.50: 30,
p=0.90: 29, p=1.00: 12, p=0.10: 1 — i.e. **not** a balanced sample, which is why the metric is
stratified.

```
magma:          58 settled of 605 served — 36 accepted / 22 wasted (accept rate 0.62, mean outcome 0.62)
multihop-iter:  14 settled of 140 served —  8 accepted /  6 wasted (accept rate 0.57, mean outcome 0.59)
single-hop  (calls for magma):         18 settled of 544 served — magma 0.57 (n=14) vs multihop-iter 0.50 (n=4)  → shape's tool did better; too few labels (mh n=4 < 10)
multi-hop   (calls for multihop-iter): 39 settled of 157 served — multihop-iter 0.57 (n=7) vs magma 0.59 (n=32) → the OTHER tool did better; too few labels (mh n=7 < 10)
ambiguous   (no recommendation):       15 settled of  44 served — magma 0.75 (n=12), multihop-iter 0.67 (n=3)
Classifier-vs-outcome agreement: 0.50 (over 57 comparable settled rows; chance 0.50; approximate 95% interval 0.37–0.64)
  raw 2×2: accepted as recommended 12, wasted when not 15, accepted when not 21, wasted as recommended 9
Cutover bar: lower bound > 0.55 on ≥ 100 comparable settled rows. Today: lower bound 0.37 on n=57 — NOT met.
```

**Reading:** the heuristic is **at chance and under-powered** on today's labels. That is neither
confirmation nor refutation — with n=57 the interval spans 0.37–0.64. It was *not* tuned against
these outcomes (57 rows would be overfit in one pass); the only post-measurement change to the
classifier was the principled `weak-signal` rule (§3). The report says all of this in words. (The
corpus is live: the count moves by a few rows between runs.)

## 6. Naming — decided

- The two tools keep their stored names, `magma` and `multihop-iter`. `retrieval_experience.explore_arm`
  rows are history and are never rewritten; the tool names *are* the arm names
  (`RETRIEVAL_TOOLS` ≡ `EXPLORE_ARMS`, pinned by test).
- New vocabulary (used by all new code): `RETRIEVAL_TOOLS`, `TOOL_FOR_HOP_SHAPE`,
  `BRIEFING_ALTERNATE_TOOLS`, `resolveBriefingDefaultTool()`, `resolveBriefingTools()`.
- Drift-era exports are **aliases, not removals**: `BRIEFING_CHALLENGER_ARMS` is the same array
  object as `BRIEFING_ALTERNATE_TOOLS`; `resolveLiveIncumbent()` delegates to
  `resolveBriefingDefaultTool()`. Both are marked `@deprecated`. This is what keeps the live briefing
  handler byte-identical (§7) — the rename of that handler's own identifiers is deliberately *not*
  done in Step 2, because touching the live path for vocabulary alone would violate the acceptance
  criterion that matters more.
- The reward learner (`reward/kto-learner.ts`, `reward/reward-report-run.ts`, `reward/promotion-gate.ts`)
  is **parked, not deleted**: the scheduled `reward-report` task and `scripts/reward-report.ts` still
  run it read-only; its `promotion` seam has no live caller. `suggest/arm-promotion.ts` (the only
  thing that turned a verdict into a proposal) is deleted; the `arm-promotion` `SuggestionType` stays
  so historic on-disk items still parse (there are none today).
- The scheduler task id `weekly-promotion-review` is a **stored key** in the scheduler DB and stays.
  Its human-readable name/description live in `scheduler-repository.ts` `DEFAULT_TASKS`, a Step 3–owned
  file, and are unchanged in this PR.
- The rendered section never uses *promote / retire / verdict / incumbent / challenger / HOLD*
  (negative-vocabulary scan in `routing-format.test.ts`).

## 7. What changed live — nothing (and how that is proven)

- `selectBriefingArm`, `selectExplorationArm`, `resolveBootstrapEpsilon` and the briefing handler in
  `cli.ts` are untouched. `test/unit/memory/routing-golden.test.ts` replays a 61-decision scenario grid
  on `mulberry32(20260815)` and asserts deep equality with a fixture generated on `main @ 67ff69f`
  before any Step 2 change.
- `experience.db` writes are unchanged — there is no new column. **Decision:** the hop-shape is
  classified **at read time** from `query_text` (weekly review and harness), not logged at capture
  time. The heuristic is a pure, versioned function, so a stored verdict would duplicate derivable
  data and go stale on every revision; and read-time classification is what makes "zero live change"
  literally true. Shadow-logging a column is a trivial follow-up if a *learned* classifier ever needs
  its historical live predictions preserved.
- Every read of the corpus is `{ readonly: true, fileMustExist: true }`; the section and harness
  tests assert the store file is byte-identical before/after.
- ε, the plist, the settle sweep / refusal back-off, the gate publisher, and cadence/budget knobs are
  untouched.

## 8. Cutover — pre-framed, not decided (John's decision)

Live classify-then-route becomes a **candidate** when the classifier's agreement with outcomes is
credibly above chance:

- **metric:** stratified balanced classifier-vs-outcome agreement (§4), approximate 95% **lower** bound;
- **threshold:** lower bound **> 0.55** on **≥ 100** comparable settled rows (rows in shapes where both tools have labels)
  (`CUTOVER_AGREEMENT_LOWER_BOUND`, `CUTOVER_MIN_CLASSIFIED`). 0.55 rather than 0.50 so a bound that
  merely grazes chance does not qualify; 100 rows so the bound means something at all.

The report evaluates this bar every run and prints MET / NOT met. Meeting it is necessary, not
sufficient: a cutover would also need (named here so the decision is framed, not made) a residual
exploration rate so evidence keeps accruing on both tools; a rule for `ambiguous` (default tool vs
keep-random); and the same golden test re-baselined on the new decision function. If the heuristic
never clears the bar, the next move is the **learned** classifier (Adaptive-RAG's own path), trained
on the outcome labels with a held-out split — not more hand-tuning of v1.

## 9. How to run

```
npx tsx scripts/hop-shape-eval.ts                      # live store, read-only, same text as the weekly review
npx tsx scripts/hop-shape-eval.ts --show 8 --settled-only   # + 8 sample classifications per shape, with reasons
npx tsx scripts/hop-shape-eval.ts /path/to/copy.db --json   # a snapshot, + machine-readable summary
```

Unit suites: `test/unit/memory/hop-shape.test.ts`, `test/unit/reward/routing-accuracy.test.ts`,
`test/unit/suggest/routing-format.test.ts`, `test/unit/suggest/weekly-report.test.ts`,
`test/unit/memory/routing-golden.test.ts`, `test/unit/scripts/hop-shape-eval.test.ts`.
