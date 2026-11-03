# Intent keystone — annotated prior-art bibliography (extract → refine → measure)

> **Status: RESEARCH ONLY.** This is a literature map, not a design or an implementation. The design phase
> is a later, separate, evidence-gated step (per `docs/NORTH_STAR.md` next-move #1 and
> `.github/instructions/00-fix-first.instructions.md` §4). Nothing here flips a default or ships code.
>
> **Frame (held from `docs/NORTH_STAR.md`).** SCNS's north star is self-improvement/self-innovation. The
> MAGMA memory graph is BUILT, faithful, and LIVE — its value is a **self-learning substrate**, not a QA
> horse race (LoCoMo is the wrong axis). The ultimate payoff metric is **human ACCEPT-vs-WASTE on real
> usage**. **Blunt truth: there is NO real baseline — nothing has worked end-to-end on real usage once, so
> "beat hybrid" is a phantom.** The genuine keystone — and the thing nobody has fully cracked — is the
> mechanism to **EXTRACT** the user's actual intent from a coding session, **REFINE** it across interactions,
> and **MEASURE** whether an outcome served it.
>
> **Relationship to `docs/PRIOR_ART.md`.** That file is the routing/reward/recall catalogue (Adaptive-RAG,
> RouterRetriever, bandits, off-policy DR/IPS/HCOPE, KTO/DPO/IPO, CBR/Generative-Agents/MemGPT). This file
> **complements, does not duplicate** it: it catalogues the *intent* legos that file omits, and where the
> two overlap (reward modeling §4, off-policy §6) it **cross-references** the existing entries and adds only
> the sparse/implicit-signal angle specific to a real accept/waste loop. Read both together.

## How to read each entry
`Author, Venue Year, arXiv:ID` → **Lego** (the reusable mechanism) → **Assumes/data** (what it needs to work)
→ **SCNS: ADOPT / ADAPT / BUILD** (+ why, + the concrete substrate hook it plugs into). Every arXiv ID and
finding below was verified against a live source on 2026-07-08 (see the verification note at the end); where a
search engine hallucinated author lists, only the arXiv ID and title were trusted.

## The substrate hooks (what already exists to plug into)
Named once here so the entries can reference them tersely. All are **built, default-OFF, and UNMEASURED on
real usage** — they are the *inputs and outputs* of the keystone, waiting for the middle.
- **`retrieval_experience` store** (`src/memory/experience-store.ts`): one row per retrieval; columns
  `query_text`, `query_embedding`, `intent`, `target`, `(intent,target)` episode key, `human_outcome`
  (`[0,1]`), `propensity`, `explore_arm`, `flag_state`, `conversation_id`, `turn`, `latency_ms`, `judge_score`.
  **Honest scope (rubber-duck):** `query_embedding` is populated ONLY when a vector is *cheaply* available at
  the seam — never a live synchronous embed just to log — so it is a *retrospective* KNN/reuse hook, **not**
  automatically a live pre-routing classifier input. The store is a SQLite table, **not** a live `vec0`/NID
  index (cosine KNN exists in `similar-episode.ts`; a live route/discovery index does not).
- **Human accept-vs-waste signal** (`src/memory/human-outcome.ts`): 6-pt gradient
  `{accepted 1.0, acceptedEdited 0.8, partiallyUsed 0.6, ignored 0.4, waste 0.2, hardWaste 0.0}`;
  `ImplicitCue = used|edited|re-asked`; per-attempt + entity-scoped credit assignment.
- **Path-conditioned edge reinforcement** (`src/memory/edge-reinforcement.ts`): bounded multiplicative update
  `w ← clamp(w·(1+η·(2·outcome−1)), 0.25, 4.0)` on `memory_edges.weight` along a retrieved path, plus decay
  toward neutral; gated behind the `useEdgeWeights` beam lever.
- **The typed graph** (`src/memory/db.ts`): `memory_edges(src_chunk, edge_type∈{entity,temporal,causal,semantic},
  dst_entity, dst_chunk, weight REAL DEFAULT 1.0)`. **Caveat:** `chunks.id` is AUTOINCREMENT and re-created on
  re-index, so anything binding an outcome to a chunk *path* must survive re-chunking (a real data requirement).
- **Reward learner** (`src/reward/kto-learner.ts`): KTO desirability + clipped-IPS + IPO shrinkage; SELECT-only
  (Everitt reward-tamper isolation). **Off-policy** (`src/reward/dr-estimator.ts`): doubly-robust value estimate.
- **Routing gate** (`src/memory/routing-policy.ts` + `arm-router.ts` + `explore-router.ts`): deterministic
  query→arm router, ε-greedy exploration that logs `propensity`, and a certified-gate commit (HCOPE lower
  bound, fails closed, refuses guardrail paths).
- **CBR reuse** (`src/memory/similar-episode.ts`): "been-here-before" `(intent,target)` prefer/avoid advice.

> **THE GAP, named up front.** SCNS's `intent` today is a 4-value *query-type* classifier
> (`WHY | WHEN | ENTITY | DEFAULT`, `src/memory/intent.ts`) used to pick a *retrieval arm*. It is **not** a
> representation of the user's *task goal*. The keystone needs goal-level intent (§1–§2). Every store column
> named `intent`/`target` is a slot waiting for that richer object — the hook exists; the extractor does not.

---

## §1 — INTENT EXTRACTION from a coding-assistant session
*Inferring the user's actual goal from prompts, edits, accepted/rejected outputs, and surrounding context —
not the literal prompt.*

**Barke, James, Polikarpova — Grounded Copilot, OOPSLA 2023, arXiv:2206.15000.** Grounded-theory study of 20
programmers using Copilot.
- **Lego:** A validated **bimodal interaction taxonomy** — *acceleration* (user knows the goal, wants speed)
  vs *exploration* (user is unsure, uses the model to think). The mode *is* a coarse intent signal and it
  flips the meaning of every downstream behavior (a rejected suggestion in exploration ≠ waste).
- **Assumes/data:** observable edit/prompt cadence; no labels required (the mode is inferable from behavior).
- **SCNS: ADOPT the taxonomy as a feature.** Cheap to compute at the seam; a natural first axis of the
  `intent` object. Hook: a new categorical alongside `retrieval_experience.intent`. Why: it disambiguates the
  *outcome* mapping in `human-outcome.ts` (see §3's proxy-validity problem).

**Mozannar et al. — Reading Between the Lines (CUPS), arXiv:2311.07622.** Defines **CUPS = CodeRec User
Programming States**, a taxonomy of ~12 states a developer moves through around each suggestion (thinking,
verifying, editing, deferring, prompt-crafting…), learned from instrumented sessions.
- **Lego:** A **state machine over developer behavior** — a principled, empirically-grounded label set for
  "what is the user doing right now," recoverable from telemetry (dwell time, edit/accept/reject events).
- **Assumes/data:** fine-grained IDE/session telemetry (timestamps of accept/reject/edit); a labeling effort
  to bootstrap the state classifier.
- **SCNS: ADAPT.** SCNS sees prompts + accept/waste verdicts but not (yet) keystroke-level IDE telemetry, so
  the full CUPS is out of reach; adopt the *idea* of a behavioral state as the intent substrate and a reduced
  state set over the signals SCNS *can* observe. Hook: feeds the `intent` slot; the CUPS transitions map onto
  `ImplicitCue`. Why: it is the closest published thing to "extract intent from a coding session."

**Mozannar et al. — RealHumanEval, arXiv:2404.02806** (already cited in `human-outcome.ts`). Large user study
across LLM coding assistants.
- **Lego:** The **critical negative result — suggestion acceptance rate does NOT correlate with programmer
  productivity.** This is a *warning*, not a mechanism: it says the cheapest intent/outcome proxy (accept
  rate) is unreliable.
- **Assumes/data:** controlled task completion times as ground truth (which SCNS lacks live).
- **SCNS: ADOPT as a hard constraint.** It is *why* `human-outcome.ts` documents "acceptance is a BIASED
  proxy — never optimized naked," and why `kto-learner.ts` never certifies. Hook: the discipline gate on every
  reward consumer. Why: it pre-empts the most tempting keystone shortcut (optimize accept rate directly).

**Ziegler et al. — Productivity Assessment of Neural Code Completion, arXiv:2205.06537** (already cited).
- **Lego:** acceptance rate *does* correlate with developers' *self-reported* perceived productivity — the
  partial rehabilitation of the accept signal (perception, not throughput).
- **SCNS: ADOPT (already wired).** The tension with RealHumanEval is the point: accept-vs-waste is a *valid
  perception signal* and a *biased throughput signal* — treat it as the former. Hook: `HUMAN_OUTCOME_GRADIENT`.

---

## §2 — INTENT REFINEMENT over repeated interactions
*Updating/disambiguating a belief about intent across turns (dialogue-state tracking, user modeling,
preference elicitation).*

**Wu et al. — TRADE, ACL 2019, arXiv:1905.08743.** Neural dialogue-state tracker for task-oriented dialogue.
- **Lego:** The **belief-state framing** — maintain the system's running *estimate of the user goal* as
  (domain, slot, value) triples, updated every turn, with a copy mechanism for unseen values.
- **Assumes/data:** a slot schema and turn-annotated dialogues to train the generator (heavy for a general
  coding assistant).
- **SCNS: ADAPT the framing, not the model.** Recast the `(intent, target)` episode key as a lightweight
  belief state that accumulates across a conversation (`conversation_id`, `turn` already in the store), rather
  than training a full DST. Hook: `retrieval_experience.(intent,target,conversation_id,turn)`. Why: gives the
  keystone a *stateful* intent that refines, instead of re-classifying each query from scratch (today's
  `arm-router` is memoryless per query).

**Li, Tamkin, Goodman, Andreas — GATE (Generative Active Task Elicitation), ICLR 2024, arXiv:2310.11589.** An
LM interactively asks the user open-ended/edge-case questions to elicit fuzzy preferences.
- **Lego:** **Ask, don't guess** — turn intent inference into an active dialogue; the model generates the most
  informative clarifying question when the specification is under-determined.
- **Assumes/data:** a willing human and a budget for a few extra turns; an LM to generate questions (SCNS has
  ACP for exactly this).
- **SCNS: BUILD (high-leverage, no surface exists yet).** Directly attacks the keystone's extraction problem
  at the source and *manufactures a clean label* for the reward loop instead of a biased inference. Hook: fires
  when belief entropy is high (ambiguous query / thin `(intent,target)` episode support) → writes a
  higher-confidence `intent`. Why: converting a guess into a measured answer is the single highest-value new
  mechanism (see Assembled Approach B).

**Aliannejadi et al. — Asking Clarifying Questions in Open-Domain Information-Seeking, SIGIR 2019 (Qulac).**
- **Lego:** A **when-and-which-to-ask** model for clarifying questions in *retrieval* (not generation):
  estimate query ambiguity, select the question that most reduces it, measure the retrieval-quality lift.
- **Assumes/data:** a pool of candidate questions per topic (Qulac) or a generator; a simulated/real user.
- **SCNS: ADAPT.** The *trigger + selection* half of GATE, grounded in retrieval terms SCNS already speaks
  (ambiguity ≈ flat hybrid scores / no dominant entity anchor). Hook: pairs with `arm-router.shouldSkip`-style
  gating — a third branch "ask" alongside skip/route. Why: gives GATE a retrieval-native firing rule.

**Sadigh et al. — Active Preference-Based Learning of Reward Functions, RSS 2017.**
- **Lego:** **Information-gain query selection** — pick the comparison whose answer most shrinks the posterior
  over the reward/preference parameters; learn a reward from *few* well-chosen queries.
- **Assumes/data:** a parametric preference model and a way to synthesize informative query pairs; a Bayesian
  posterior to do information gain against.
- **SCNS: ADAPT (later).** The principled version of "which clarifying question / which arm to explore" — an
  upgrade path for `explore-router.ts` from uniform ε-greedy to *active* exploration once priors exist. Hook:
  `explore-router` arm selection + `propensity` logging. Why: makes every scarce human interaction maximally
  informative (real usage is sparse — you cannot waste queries).

---

## §3 — OUTCOME MEASUREMENT: capturing accept-vs-waste
*Implicit signals (edits kept, follow-ups, reverts, time-to-accept) AND explicit signals; how others define a
"successful" assist.*

**Joachims et al. — Accurately Interpreting Clickthrough Data as Implicit Feedback, SIGIR 2005.** The canonical
implicit-feedback paper.
- **Lego:** Implicit signals are **biased** (position/presentation bias); *relative/interleaved* comparisons
  and debiasing are required before a click (or an "accept") can be read as a preference.
- **Assumes/data:** enough traffic to interleave or to estimate a bias model.
- **SCNS: ADOPT the caution + the relative-comparison trick.** An "accept" is SCNS's "click" — position/
  presentation-biased in the same way. Prefer *paired* accept-vs-waste on comparable retrievals over absolute
  accept rates. Hook: guards the interpretation of `human_outcome`; motivates logging comparable
  `(intent,target)` pairs. Why: it is the 20-year-old lesson behind RealHumanEval's negative result.

**Radlinski & Joachims — Query Chains: Learning to Rank from Implicit Feedback, KDD 2005.**
Verified: https://www.cs.cornell.edu/people/tj/publications/radlinski_joachims_05a.pdf
The **producer half** that §3 was missing — Joachims SIGIR 2005 (above) says how to *distrust* an implicit
signal; this says how to *manufacture* one. Users issue a *sequence* of queries against one underlying
information need (a **query chain**), and the reformulation itself is the feedback: if the chain continues,
the earlier result set did not satisfy the need. Two mechanisms, taken from the paper rather than paraphrased:
- **Chain detection is allowed to be a heuristic.** They trained an SVM (94.3% acc / 96.5% precision) and then
  *shipped the simple rule* — same IP address, within 30 minutes — at 91.6% precision, explicitly judging it
  sufficient and the feature vector too expensive (§6).
- **Query similarity is the chain signal.** Largest positive SVM weight: `CosineDistance(q1, q2)`, with
  result-set overlap second (Table 2). Their best feedback strategy, `Click >q' Top Two Earlier Query`,
  reaches **84.5 ± 6.1** against an inter-judge agreement ceiling of **86.4** (Table 1).
- **Lego:** turns a sparse explicit-feedback funnel into dense implicit preference labels mined from logs
  you already have.
- **Assumes/data:** sessionized logs where consecutive requests can be grouped by user + time.
- **SCNS: ADOPTED — BUILT in `src/memory/query-chain.ts`.** SCNS's chain-detection substrate is *stronger*
  than the paper's: `conversation_id` plus adjacent human turns from the CLI transcript oracle
  (`session-transcript.ts`) is an exact record, not an IP-and-clock guess. **SCNS's N1 verbatim re-ask
  detector is the degenerate `similarity = 1.0` case of chain continuation**; this generalizes it from
  verbatim to semantic shape. Cosine (not Jaccard) is load-bearing — a reformulation restates the need and
  *adds* constraints, which Jaccard charges to the denominator (measured: 0.43 Jaccard vs 0.61 cosine on a
  real reformulation pair, straddling the threshold). Hook: emits `used`/`edited` onto the existing
  `settleHumanOutcomeForAttempt` seam — the two anchors that had **zero** producers before this.
- **Bias control (why this does NOT contradict Joachims SIGIR 2005):** the classifier ABSTAINS by default.
  A bare topic change yields null, never `used`, because absence-of-negative is not a positive. And a label
  is refused outright unless the briefing was actually *delivered* — measured 2026-07-25, only **321/664
  (48.3%)** of live magma rows finished inside the extension's 1500 ms abort budget.

**Jones & Klinkner — Beyond the Session Timeout: Automatic Hierarchical Segmentation of Search Topics in
Query Logs, CIKM 2008.** Verified: http://www.rosiejonesphd.com/papers/jonesKlinknerCIKM2008.pdf
Added to answer a live design question: *to raise recall, broaden the marker lexicon or go semantic?*
- **Direct caution about the paper above.** They re-implemented Radlinski & Joachims' features on web-search
  data and report that "**Radlinski and Joachims' result does not hold** — a thirty-minute threshold obtains
  similar results to a combination of common words and web-search result similarity" (§5.1). Chain-detection
  results do **not** transfer across corpora. SCNS must measure on SCNS data, not inherit KDD 2005's numbers.
- **Lego:** four feature families — temporal, edit-distance, query-log, web-search. Measured (§5.2, Tables
  9–11): on goal boundaries, timeouts alone **62.5%**, edit-distance alone **89%**, all four combined
  **93.0%**; on mission boundaries **67.6%** (time) and **79.7%** (edit) lift to **90.8%** combined. So
  lexical beats temporal decisively, but *combination* beats any single family.
- **The result that matters most for SCNS:** on **same-goal identification** — the sub-task closest to
  "is this next turn the same information need?" — the majority-class baseline is already **94.8%** and the
  best exhaustively-searched model reaches only **97.09%**. Roughly **two points of headroom.** On this exact
  question, classifier sophistication is close to exhausted before it starts.
- **Assumes/data:** human-labeled query pairs at a scale that supports exhaustive search over all 8-predictor
  logistic-regression models with AIC selection, plus ten-fold cross-validation.
- **SCNS: ADOPT the ordering, DEFER the upgrade.** The honest reading is that neither "broaden the lexicon"
  nor "go semantic" is the binding constraint — **label supply is.** With 17 delivery-eligible rows there is
  no held-out split, so any upgrade would be selected on the very rows it labels, which is what this file's
  §3 exists to prevent. Sequence: (1) fix delivery (the 1500 ms abort budget, since ~52% of briefings never
  arrived — a *delivery* deficit no classifier can recover); (2) accumulate a held-out split; (3) only then
  add features, and add them as a **combination** (lexical + temporal + behavioral), which is the finding
  here, rather than swapping cosine for embeddings and calling it an upgrade.

- **Lego:** Productivity is **multi-dimensional** (Satisfaction, Performance, Activity, Communication,
  Efficiency); **no single metric is valid alone** — always combine ≥2 dimensions and never optimize activity
  counts.
- **Assumes/data:** a mix of behavioral + perceptual (survey) signals.
- **SCNS: ADOPT as the outcome-validity rubric.** Accept-vs-waste is an Activity/Efficiency proxy; pair it
  with at least one Perception or Performance signal before trusting it. Hook: the definition of a "settled"
  outcome in `human-outcome.ts`. Why: keeps the reward from collapsing to a single gameable proxy.

**Peng et al. — The Impact of AI on Developer Productivity (GitHub Copilot RCT), arXiv:2302.06590.** RCT: task
completed 55.8% faster with Copilot; equal correctness.
- **Lego:** **Time-to-complete** as a clean, real, throughput outcome — the gold-standard signal RealHumanEval
  says accept rate fails to capture.
- **Assumes/data:** a bounded task with a measurable completion event (rare in open-ended assistant usage).
- **SCNS: ADAPT where a task boundary exists.** For SCNS's *proposal→merge* loop (`suggest/outcome-writer.ts`)
  a completion event *does* exist (implemented/merged/reverted). Hook: `humanOutcomeOfVerdict` already maps
  merge→accept, revert→hardWaste — this is SCNS's `time-to-accept`/`revert` analog. Why: it is the one place
  SCNS can measure a *throughput-like* outcome, not just perception.

---

## §4 — REWARD MODELING FROM HUMAN FEEDBACK (sparse, implicit accept/waste)
*Cross-references `docs/PRIOR_ART.md` §C.4 (KTO #12, DPO #13, IPO #14, Everitt #15 — already ADOPTED/BUILT in
`kto-learner.ts`). Added here: the RLHF lineage and the interactive-shaping angle specific to policy-dependent
implicit feedback.*

**Christiano et al. — Deep RL from Human Preferences, NeurIPS 2017, arXiv:1706.03741.** The RLHF template:
learn a reward model from pairwise human comparisons, then optimize it.
- **Lego:** **Decouple reward learning from policy learning** — a learned reward model stands in for a
  hand-coded objective; the Bradley-Terry preference likelihood.
- **Assumes/data:** *pairwise* comparisons (SCNS's signal is per-attempt binary, not pairs).
- **SCNS: REFERENCE (foundational, not directly adopted).** The conceptual parent of KTO; explains why SCNS
  went unpaired (KTO) instead of paired (DPO/#13). Hook: context for `kto-learner.ts`.

**Stiennon et al. — Learning to Summarize from Human Feedback, NeurIPS 2020, arXiv:2009.01325** · **Ouyang et
al. — InstructGPT, arXiv:2203.02155.** The scaled RLHF recipe (reward model + PPO + **KL-to-reference
penalty**).
- **Lego:** The **KL-anchor** — regularize the learned policy toward a trusted reference so a sparse/biased
  reward cannot drag it into degeneracy.
- **Assumes/data:** many ranked outputs; a reference policy.
- **SCNS: ADAPT the KL-anchor idea (already echoed).** SCNS's analog is IPO shrinkage-to-prior in
  `kto-learner.ts` and decay-toward-neutral in `edge-reinforcement.ts` — same anti-collapse role, cheaper form.
  Hook: those two regularizers. Why: confirms SCNS's shrinkage is the right family, not an ad-hoc hack.

**MacGlashan et al. — COACH: Interactive Learning from Policy-Dependent Human Feedback, ICML 2017,
arXiv:1701.06049** (contrast: **TAMER**, Knox & Stone 2008).
- **Lego:** Human feedback is **policy-dependent** — people reward *improvement relative to current behavior*,
  not absolute value; interpret feedback as a **policy-gradient advice signal**, not a stationary reward.
  (TAMER is the opposing "feedback = absolute reward" model.)
- **Assumes/data:** a stream of interactive feedback tied to the agent's current policy.
- **SCNS: ADOPT the caution.** A human's accept/waste on SCNS shifts as SCNS improves (an "ignored" verdict
  means something different once the baseline is good). Non-stationary reward → the decay term and re-earning
  in `edge-reinforcement.ts` are *correct*, and a naive stationary reward model would be wrong. Hook: informs
  how `human_outcome` is aggregated over time in `kto-learner.ts`. Why: prevents treating a moving target as
  fixed.

---

## §5 — GRAPH / MEMORY-CONDITIONED learning
*Using a typed-edge memory graph for path/context-conditioned reinforcement (what a flat index cannot do);
memory reinforcement / experience replay for agents. Extends `docs/PRIOR_ART.md` §C.5 (CBR, Generative Agents,
MemGPT) with the reinforcement/replay legos.*

**Schaul et al. — Prioritized Experience Replay, ICLR 2016, arXiv:1511.05952.**
- **Lego:** **Replay the most informative experiences more often** (sample ∝ TD-error), with an
  importance-sampling correction for the induced bias.
- **Assumes/data:** a replay buffer with a per-item "surprise" score.
- **SCNS: ADAPT.** The `retrieval_experience` store *is* a replay buffer; prioritize learning from
  high-|Δ| episodes (accepted-where-expected-waste and vice-versa) instead of uniform replay — and the IS
  correction is already the `propensity`/IPS machinery. Hook: `loadRewardRows` ordering + `dr-estimator`
  weights. Why: real accept/waste data will be scarce; spend learning where it moves the estimate most.

**Andrychowicz et al. — Hindsight Experience Replay, NeurIPS 2017, arXiv:1707.01495.**
- **Lego:** **Relabel outcomes as goals** — a trajectory that failed the intended goal is a *success* for the
  goal it actually achieved; turns sparse-reward failures into dense positive data.
- **Assumes/data:** a goal-conditioned value function; the ability to recompute reward under a substituted goal.
- **SCNS: ADAPT (directly addresses sparsity).** A retrieval "wasted" for intent A but that the human later
  used for intent B is a *positive* example for B. With the `(intent,target)` key this relabel is expressible.
  Hook: `settleHumanOutcomeForEntity`/`...ForAttempt` + the episode key. Why: the accept/waste loop is
  sparse-reward by nature — HER is the canonical fix and SCNS has the goal key to do it.

**Shinn et al. — Reflexion: verbal RL with episodic memory, NeurIPS 2023, arXiv:2303.11366** · **Zhao et al. —
ExpeL: LLM Agents Are Experiential Learners, AAAI 2024, arXiv:2308.10144.**
- **Lego:** **Extract a natural-language *insight* from an outcome and store it for reuse** — Reflexion writes
  a self-reflection after a failure; ExpeL mines a set of transferable insights across many episodes. Learning
  without gradient updates.
- **Assumes/data:** repeated attempts at related tasks; an LM to write/summarize insights (ACP available).
- **SCNS: ADAPT (the self-innovation angle).** Beyond up/down-weighting edges, mine wasted episodes into
  reusable *retrieval strategies* ("for WHY-questions about X, the causal beam over-retrieved"). Hook: insights
  as first-class nodes/edges in the graph feeding `arm-router` `episodeAdvice`. Why: this is how the graph
  learns *strategy*, not just weights — the differentiator vs a flat index.

**Wang et al. — Voyager, arXiv:2305.16291** · **Xu et al. — A-MEM: Agentic Memory, arXiv:2502.12110.**
- **Lego:** **A self-curating memory** — Voyager's growing, composable *skill library*; A-MEM's Zettelkasten
  dynamic linking (new memories link to and revise old ones).
- **Assumes/data:** persistent store; an agent that writes back structured memory.
- **SCNS: REFERENCE / ADAPT-later.** Confirms the typed graph + `edge-reinforcement` decay is the right
  substrate for evolving memory; A-MEM's dynamic linking is a candidate for how reinforced episodes create new
  `memory_edges`. Hook: `memory_edges` + `edge-reinforcement`. Why: validates the "graph as living substrate"
  bet; not load-bearing for the first baseline.

> **Why the graph, concretely:** §5's legos (path-prioritized replay, goal-relabeling, insight nodes) are all
> *path/context-conditioned* — they attach value to *transitions and typed edges*, which a flat vector index
> structurally cannot represent. This is the substrate claim `edge-reinforcement.ts` exists to test, and the
> reason NORTH_STAR's truth-test N2 ("learned vs static on real accepted outcomes") is the real verdict.

---

## §6 — OFF-POLICY EVALUATION on logged interaction data
*Cross-references `docs/PRIOR_ART.md` §C.3 (DR #9 — BUILT in `dr-estimator.ts`; IPS/CRM #10; HCOPE #11 — the
promotion gate's spine). Added here: the sparse/large-action + logged-A/B pitfalls specific to a thin
accept/waste log.*

**Saito & Joachims — Off-Policy Evaluation for Large Action Spaces via Embeddings, ICML 2022,
arXiv:2202.06317.**
- **Lego:** **Marginalized IPS (mIPS)** — reweight in an *action-embedding* space, not per-action, so variance
  stays finite when many arms/contexts have near-zero logging overlap.
- **Assumes/data:** a meaningful action (or context) embedding; embeddings that cover the logging support.
- **SCNS: ADAPT (the sparsity-robust upgrade).** With few arms today plain IPS suffices, but as arms/intents
  proliferate the `query_embedding` column is exactly the embedding mIPS needs. Hook:
  `retrieval_experience.query_embedding` (stored vec0-compatible) + `dr-estimator`. Why: pre-emptively answers
  the "our log is too thin/sparse for IPS" failure the keystone will hit first.

**Gilotte et al. — Offline A/B Testing for Recommender Systems, WSDM 2018, arXiv:1801.07030.**
- **Lego:** A **practitioner recipe for offline policy A/B from logged data** — capped IPS estimators,
  diagnostics (effective sample size, weight distributions) to know when the estimate is trustworthy *before*
  a live flip.
- **Assumes/data:** logged propensities (SCNS logs `propensity`) and enough effective sample size.
- **SCNS: ADOPT the diagnostics.** `kto-learner` already reports `effectiveN`; Gilotte's ESS/weight-tail
  checks are the missing "is this OPE even valid?" gate before `routing-policy.commit`. Hook: pre-conditions on
  `commitRoutingPolicy` (`negControlN>0`, HCOPE>0 already there). Why: operationalizes NORTH_STAR N3→N4 "no
  comparative go-live until a measured win," and Validity-of-Null (a thin log = BLOCKED, not a null).

---

## Substrate hook map (technique → where it plugs in)
| Keystone stage | Lego (source) | SCNS hook (file) | Call |
|---|---|---|---|
| Extract | Acceleration/exploration mode (Grounded Copilot) | `retrieval_experience.intent` (new axis) | ADOPT |
| Extract | CUPS behavioral states (2311.07622) | `intent` slot / `ImplicitCue` | ADAPT |
| Extract | Accept≠productivity guard (RealHumanEval 2404.02806) | reward-consumer discipline gate | ADOPT |
| Refine | Belief-state over user goal (TRADE 1905.08743) | `(intent,target,conversation_id,turn)` | ADAPT |
| Refine | Ask-don't-guess elicitation (GATE 2310.11589) | new clarify branch → writes `intent` | **BUILD** |
| Refine | Ambiguity trigger/selection (Aliannejadi SIGIR19) | `arm-router` skip/route/**ask** | ADAPT |
| Refine | Info-gain query choice (Sadigh RSS17) | `explore-router` arm + `propensity` | ADAPT-later |
| Measure | Implicit-signal bias / paired comparison (Joachims SIGIR05) | interpretation of `human_outcome` | ADOPT |
| Measure | Multi-dim validity (SPACE 2021) | "settled outcome" definition | ADOPT |
| Measure | Time-to-complete / revert (Copilot RCT 2302.06590) | `humanOutcomeOfVerdict` merge/revert | ADAPT |
| Reward | KL-anchor / anti-collapse (Stiennon/InstructGPT) | IPO shrinkage + edge decay | ADAPT (built) |
| Reward | Policy-dependent feedback (COACH 1701.06049) | outcome aggregation in `kto-learner` | ADOPT-caution |
| Graph | Prioritized replay (PER 1511.05952) | `loadRewardRows` ordering | ADAPT |
| Graph | Goal-relabel sparse reward (HER 1707.01495) | `settleHumanOutcomeForEntity` + episode key | ADAPT |
| Graph | Insight extraction (Reflexion/ExpeL) | insight nodes → `episodeAdvice` | ADAPT |
| OPE | Marginalized IPS (Saito&Joachims 2202.06317) | `query_embedding` + `dr-estimator` | ADAPT-later |
| OPE | Offline-A/B diagnostics (Gilotte 1801.07030) | pre-conditions on `commitRoutingPolicy` | ADOPT |

---

## The 2–3 most promising assembled approaches (legos combined)
Ordered by leverage on the *first real baseline*, not by novelty. **These are candidates to design later, not
decisions.**

**A — Belief-state intent → implicit accept/waste → path-conditioned reinforcement, gated by OPE (mostly
ADOPT).** Assemble the substrate's intended end-state from verified legos: derive a lightweight goal *belief
state* (TRADE framing over `(intent,target)`, seeded by Grounded-Copilot mode + a reduced CUPS) → settle
accept-vs-waste from implicit cues (existing `ImplicitCue`, debiased per Joachims, validity-checked per
SPACE/RealHumanEval) → reinforce `memory_edges.weight` path-conditioned → learn arm value via KTO+IPO → gate
any flip via DR/HCOPE + Gilotte diagnostics. *Why first:* every lego is ADOPT/ADAPT and every hook already
exists; it is the smallest path to *one measured real accept/waste tuple* (NORTH_STAR N1→N2), which is the
actual goal. *Risk:* rests entirely on the biased accept signal — which is why B exists.

**B — Ask-don't-guess elicitation at high belief-entropy (the BUILD, highest per-interaction value).** When
the intent belief is uncertain (ambiguous query / thin episode support), fire a GATE-style clarifying question
(triggered/selected per Aliannejadi, made maximally informative per Sadigh) instead of routing blind. *Why:* it
attacks the keystone's extraction problem *at the source* and **manufactures a clean intent+outcome label**,
side-stepping the accept-rate bias that undermines Approach A's signal. It is the one genuinely new surface
worth building. *Concrete live layer:* see §7 — an embedding route layer (semantic-router-style) classifies
live, New Intent Discovery (§7b) + OOS threshold detect the *novel* turn, and SCNS's own async settle
(`settleHumanOutcomeForAttempt`) lands the human's later answer on the exact `experience_id` without pausing the
main run. *Risk:* interaction cost / automation bias (GATE's own caveat) — must be rate-limited and measured.

**C — Experiential self-innovation: mine wasted episodes into reusable strategies (the self-innovation bet).**
Layer Reflexion/ExpeL insight-extraction + HER goal-relabeling over the experience store: a wasted retrieval
becomes (i) a natural-language *insight* stored as a graph node feeding `arm-router.episodeAdvice`, and (ii) a
*positive* example for whatever goal it actually served. *Why:* this is where the *graph* substrate earns its
keep over a flat index (path/context-conditioned strategy, §5), i.e., self-*innovation* not just self-tuning.
*Risk:* needs A's measurement loop working first to know an insight is real — sequence it after A/B.

---

## The single biggest open question for the intent keystone
> **Sequencing correction (independent rubber-duck, 2026-07-08).** The framing below originally said the crux
> was jointly identifying `(intent, outcome)`. That **overstates the need for an intent label** and jumps ahead
> of NORTH_STAR **N1**. Corrected: for the FIRST real baseline you do **not** need to name the intent — the
> human's own accept/waste verdict already *is* the implicit "served me / didn't." The true first crux is
> **outcome identification bound to the exact retrieval attempt**, not joint intent+outcome identification.

**Corrected crux — can we capture a TRUSTWORTHY human accept-vs-waste outcome, bound to the exact
`retrieval_experience.id` of a real live attempt, without perturbing the task or over-taxing the human?** The
user's prompt/session context stands in as the *latent* intent; an explicit GOAL-level intent label is
**optional metadata for later learning/generalization (§1–§2, §7)**, not a prerequisite for the first
datapoint. Inference of a symbolic intent is biased (RealHumanEval: accept ≠ productivity) and asking is costly
(GATE/Sadigh) — but the first baseline sidesteps both by recording *outcome* against the *already-known*
attempt. Everything downstream of a clean outcome tuple — reward modeling (§4), graph reinforcement (§5),
off-policy vetting (§6) — is well-solved prior art SCNS has already ADOPTED/BUILT. **So the unsolved,
load-bearing step is not the labeling of intent; it is capturing one trustworthy real *outcome* on the live
path (NORTH_STAR N1).** The intent-classification apparatus (§7) is a *post-N1* enrichment, and treating it as
the immediate keystone would repeat the "64-task build that moved the metric by 0" failure mode. The design
phase must answer the corrected crux first, with positive and negative controls, before any routing default
moves.

---

## §7 — The LIVE intent layer: classify live, discover the novel, elicit async
> **⚠ SUBORDINATE TO N1 (rubber-duck correction, 2026-07-08).** This entire section is a **post-baseline
> enrichment**, NOT the immediate next step. It becomes relevant only *after* SCNS can capture one real
> accept/waste outcome on the live path (NORTH_STAR N1). Building this 4-stage pipeline before that first
> datapoint is apparatus-before-baseline — the exact fix-first anti-pattern. Read §7 as "what a richer intent
> substrate could look like later," not "what to build now." The cold-start legos (§7c) are **later-stage
> hypotheses that require real logged tuples + controls**, not a justification to build now (the OOS→NID
> cold-start is genuinely circular until real outcome data exists).

*Addendum from a design-thinking exchange (2026-07-08). Scope: the **live** front-end of the keystone —
classify the user's intent/pathway *in-session*, detect when a turn is *genuinely novel*, and (only then) ask
the human **asynchronously** without pausing the main run. **Determination sought:** adopt an existing
open-source live-intent framework, or build a superior internal one? Still RESEARCH; no build. NB: offline
agent-EVAL frameworks are explicitly OUT of scope here — the need is a live in-session runtime, not a judge.*

### §7a — Live intent-classification frameworks (open-source fit-or-build)

**semantic-router — Aurelio Labs, MIT (`github.com/aurelio-labs/semantic-router`, consulted live 2026-07-08).**
- **Lego:** A **"superfast decision-making layer"** — `Route` objects defined by example `utterances`, matched
  to an input by **embedding similarity** in vector space (encoders: OpenAI/Cohere/**HuggingFace local**),
  returning a deterministic route *without* an LLM generation. Low-latency, deterministic, live.
- **Assumes/data:** an encoder + a handful of example utterances per route; a similarity threshold.
- **SCNS: strongest-fit ADOPT/ADAPT candidate for the live routing primitive.** It is embedding-native and
  SCNS *already* runs BGE-small + a sqlite-vec `vec0` store — a route layer over `query_embedding` is a
  natural, low-latency graft, MIT-licensed, no new model service. Hook: sits in front of / replaces the
  deterministic `arm-router.ts` intent branch; routes map to `retrieval_experience.intent`. Why: it is the one
  surveyed option that is *not* a square peg — it speaks SCNS's existing embedding substrate.

**Rasa Open Source — Apache 2.0 (`RasaHQ/rasa`).** Production conversational-AI NLU + dialogue stack.
- **Lego:** three reusable *patterns*: (a) **DIET** (Dual Intent & Entity Transformer, arXiv:2004.09936) —
  jointly predict intent + entities in one lightweight transformer; (b) **FallbackClassifier** — when NLU
  confidence < `nlu_threshold`, emit `nlu_fallback` (a built-in **OOS gate**); (c) **`rasa interactive`** —
  live human-in-the-loop correction of intent/entity predictions (the interactive-labeling UX).
- **Assumes/data:** a training corpus of intent examples + a slot/domain schema; a running Python NLU service.
- **SCNS: ADAPT the three patterns; do NOT adopt the framework (square-peg risk).** Rasa is a
  slot/domain-shaped, service-heavy TOD stack; a terminal coding-agent's "intent" is not restaurant-booking
  slots. Take DIET's joint intent+entity idea, the confidence-threshold fallback, and the interactive-labeling
  UX; leave the runtime. Hook: fallback threshold → the "when to ask" gate; interactive UX → the async-ask
  surface. Why: the patterns are gold, the runtime is the wrong shape.

**ConvLab-3 — `thu-coai/ConvLab-3` (research TOD toolkit: NLU/DST/policy/NLG + simulators).**
- **Lego:** a modular pipeline + **user simulators** for offline training/eval of a dialogue policy.
- **SCNS: REFERENCE only.** Research-grade, TOD-shaped; useful as an architecture reference for the
  NLU→DST→policy decomposition (mirrors §2's belief-state framing), not as a dependency.

### §7b — New Intent Discovery: the academic definition of "truly unique"

*This is the direct, published answer to the session's "if something is truly unique (threshold? already a
definition in the papers?) surface it and ask." The field is **New Intent Discovery (NID)** / open-intent
clustering — discover and cluster intents **not in the known label set** from unlabeled live traffic.*

**Zhang et al. — Discovering New Intents with Deep Aligned Clustering (DeepAligned), AAAI 2021,
arXiv:2012.08987.**
- **Lego:** Semi-supervised **discovery of novel intent clusters** — align cluster pseudo-labels across epochs
  to learn discriminative representations, so unseen intents form clean clusters using a few known ones as
  anchors.
- **Assumes/data:** an embedding space + a pool of unlabeled queries + some known-intent supervision; an
  estimate of the number of new clusters.
- **SCNS: ADAPT (the discovery engine).** Cluster over the `retrieval_experience.query_embedding` column
  (already stored, vec0-compatible) to surface *emergent* intents the static classifier has no label for.
  Hook: `query_embedding` → discovered clusters become new candidate `intent` values. Why: turns "novel" from
  a hand-wave into a clustering result.

**Lin et al. — CDAC+ (Constrained Deep Adaptive Clustering with Cluster Refinement), AAAI 2020,
arXiv:1911.08891.**
- **Lego:** **Constraint-guided** clustering — pairwise must-link/cannot-link (from weak signals or a few
  labels) steer cluster formation, then a refinement pass sharpens boundaries.
- **SCNS: ADAPT-later.** The upgrade path when weak constraints exist (e.g., two turns in the same
  `conversation_id` likely share intent → must-link). Hook: `conversation_id`/`(intent,target)` as constraints.

**Zhang et al. — New Intent Discovery with Pre-training and Contrastive Learning, ACL 2022, arXiv:2205.12914.**
- **Lego:** **Contrastive** representation learning for NID — pull semantically similar queries together / push
  dissimilar apart, yielding an embedding where new intents separate cleanly in low-data regimes.
- **SCNS: ADAPT (representation quality).** Complements DeepAligned; the contrastive objective is well-suited to
  SCNS's sparse real traffic. Hook: improves the space DeepAligned/CDAC+ cluster over.

**Larson et al. — CLINC150 / Out-of-Scope Intent Detection, EMNLP 2019, arXiv:1909.02027.**
- **Lego:** **Open-set / OOS detection** — "novel" is operationalized as *the top known-intent confidence
  falling below a calibrated threshold*; below it, don't force a label — flag OOS (which triggers NID +/or the
  human ask).
- **Assumes/data:** a calibrated confidence score + a dev set to tune the threshold; softmax confidence is
  famously miscalibrated, so the threshold itself **needs its own positive/negative control** before it is
  allowed to page a human.
- **SCNS: ADOPT as the novelty gate that decides when to ask.** Hook: the live classifier's confidence;
  sub-threshold ⇒ NID cluster + GATE elicitation (§2). Why: the published, testable "surface this one."

### §7c — Cold-start labeling + typed metadata into the MAGMA graph

**Settles — Active Learning Literature Survey, 2009.**
- **Lego:** **Uncertainty sampling** (least-confidence / margin / entropy) — spend the scarce human-label budget
  only where the classifier is least sure; plus the explicit **cold-start caveat** (early uncertainty is itself
  unreliable — don't trust it before the base classifier is warm).
- **SCNS: ADOPT the "ask only when it pays" budget discipline.** Ask on *novel (OOS/NID) OR uncertain*,
  rate-limited. Hook: gates the async ask; complements `explore-router`'s bounded budget. Why: real usage is
  sparse — over-asking trains the human to ignore the prompt.

**Ratner et al. — Data Programming (NeurIPS 2016) / Snorkel (VLDB 2017).**
- **Lego:** **Weak supervision via labeling functions** — cheap noisy heuristics as programmatic labelers; a
  generative model denoises their overlaps into training labels *before* any human labels exist.
- **SCNS: ADOPT to seed the classifiers at cold-start.** The Grounded-Copilot mode heuristic, a reduced CUPS
  state machine, and existing rules (`classifyIntent`, gazetteer) *are* labeling functions. Hook: bootstraps
  `retrieval_experience.intent`/`target` on day one. Why: directly answers "it'll be cumbersome for the human
  at first" — the machine proposes, the human only confirms the novel/uncertain.

**Typed structured extraction — Instructor (`instructor-ai/instructor`) / Pydantic + LLM function-calling /
JSON-schema-constrained decoding (industry pattern, 2023–2024).**
- **Lego:** **Schema-constrained extraction** — bind an LLM's output to a typed schema (Pydantic model / JSON
  schema) so it reliably emits well-typed `{entities, relations}` ready to become graph nodes/edges.
- **Assumes/data:** a defined schema + a function-calling-capable model (SCNS has ACP).
- **SCNS: ADAPT — this is how intent/outcome metadata gets *organized and typed into the MAGMA graph*** (the
  capability the session flagged as worth keeping, independent of any eval tool). SCNS already does typed ACP
  extraction (`fact-extractor-provider.ts`, `conversation-event-extractor.ts`) — extend the pattern with a
  typed **intent/outcome schema** whose instances populate `memory_edges`/entity nodes, so the graph itself
  carries the intent taxonomy (path/context-conditioned, §5). Hook: `memory_edges` + the existing extractor
  seam. Why: leverages the built MAGMA substrate as the *store* for the intent structure — no external framework
  needed for the typing.

### §7d — Async elicitation, SCNS-native (the "don't pause the main run" idea)
The session's own design instinct — *a hook/sub-process that opens a new terminal window + conversation for the
human to clarify, while the main run continues* — is sound and needs **no external framework**. SCNS has a
*partial* primitive: `settleHumanOutcomeForAttempt(store, experienceId, cue)` binds a **late** human answer to
the **exact** originating `experience_id` with **first-signal-wins** (`human-outcome.ts`). **Honest scope of
that primitive (rubber-duck correction):** it writes ONLY `human_outcome` from an `ImplicitCue`
(`used|edited|re-asked`); it does **not** name/confirm a new intent cluster, and does **not** write `intent` or
`target`. And first-signal-wins means an implicit cue that lands first will **block** a later human
clarification from correcting the outcome. So three concepts must be kept separate and only the first exists
today: **(1) outcome settlement** (built), **(2) intent labeling** (not built — the slot is query-type), **(3)
cluster naming** (not built). *What* to ask is grounded in §2 (GATE arXiv:2310.11589; Aliannejadi SIGIR19;
Sadigh RSS17); *when* to ask is §7b (OOS/NID) + Settles budget; *the surface* is a SCNS side sub-process (the
broker can already spawn), a first-class runtime prompt rather than an offline artifact. This is a **BUILD** —
and larger than it first appears, because only outcome settlement exists; intent-labeling and cluster-naming
write paths, plus an outcome-vs-clarification precedence policy, do not.

### §7e — Determination (open-source fit vs build internal)
**Net: BUILD a superior internal live-intent layer, optionally depending on `semantic-router` (MIT) for the
fast embedding-routing primitive; assemble the algorithmic core from NID (§7b) + OOS (Larson) + active learning
(Settles) + weak supervision (Snorkel) + typed extraction into the MAGMA graph (§7c); reuse SCNS's own async
settle for elicitation (§7d).** Rasa and ConvLab-3 are TOD/slot-shaped, service-heavy stacks — **pattern-
reference only** (DIET joint modeling, fallback threshold, interactive-labeling UX), not dependencies; adopting
either wholesale is the square-peg risk the session named. `semantic-router` is the only surveyed framework that
fits SCNS's existing embedding/`vec0` substrate cleanly, so it is the one adopt-candidate — pending a
latency/accuracy check against a trivial in-repo cosine router before taking the dependency. **Everything here
stays evidence-gated and research-only:** no classifier output may move a routing default without the held-out
gate + controls, and the novelty threshold + any live ask must clear positive/negative controls first.

**Substrate-hook additions (extends the map above):**
| Keystone stage | Lego (source) | SCNS hook | Call |
|---|---|---|---|
| Classify (live) | Embedding route layer (semantic-router, MIT) | route over `query_embedding`/`vec0` → `intent` | ADOPT/ADAPT |
| Classify (patterns) | DIET joint intent+entity (Rasa, 2004.09936) | live classifier design | ADAPT-pattern |
| Discover novel | New Intent Discovery (2012.08987 / 1911.08891 / 2205.12914) | cluster `query_embedding` → new `intent` | ADAPT / BUILD |
| When to ask | OOS threshold (Larson 1909.02027) | live-classifier confidence gate | ADOPT |
| Budget the ask | Uncertainty sampling (Settles 2009) | async-ask rate limit + `explore-router` budget | ADOPT |
| Cold-start | Weak supervision / LFs (Snorkel) | seed `intent` from mode/CUPS/entity rules | ADOPT |
| Type into graph | Schema-constrained extraction (Instructor/Pydantic pattern) | typed intent/outcome → `memory_edges` via existing extractors | ADAPT |
| Async ask | SCNS-native side sub-process | outcome settle exists (`settleHumanOutcomeForAttempt`); intent-label + cluster-name write paths + precedence policy do NOT | BUILD |

---

## Verification note (evidence-first, anti-overclaiming)
Every arXiv ID, venue, and load-bearing finding above was checked against a live source on 2026-07-08. The
in-repo citations (RealHumanEval `2404.02806`, Ziegler `2205.06537`) were already verified in
`src/memory/human-outcome.ts`. The §7 live-layer IDs were confirmed against **primary sources**: the four
new-intent-discovery / DIET / OOS papers by fetching their arXiv abstract pages directly (`2012.08987`
DeepAligned, `2205.12914` Contrastive-NID, `1911.08891` CDAC+, `2004.09936` DIET, `1909.02027` CLINC150), and
`semantic-router` (Aurelio Labs, **MIT**, embedding routing layer) + Rasa (**Apache-2.0**) from their repos.
Three guardrails were applied: (1) where a search engine returned a **hallucinated author list** (e.g.,
Reflexion `2303.11366`), only the arXiv ID + title were trusted and the author list corrected from independent
knowledge (Shinn et al.); (2) **a tool's or paper's identity was taken from its primary source (repo / arXiv
abs), never a search paraphrase** — one search paraphrase mis-identified a framework outright, so primary docs
were used throughout; (3) claims are stated at the confidence the source supports — e.g., CUPS's exact
IDE-telemetry requirement is characterized as an *assumption* SCNS may not meet,
not asserted as satisfied. No citation here should be treated as a design decision: this file is the input to a
later, separate, evidence-gated design phase (`docs/NORTH_STAR.md` next-move #1).
