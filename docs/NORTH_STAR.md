# SCNS North Star

This document defines SCNS's mission, enduring architectural decisions, success criteria, and
strategic priorities. Change it when that direction changes, not at each execution milestone.
It is not a progress tracker, deployment record, or session log.

## Mission

**SCNS is a system that self-improves and self-innovates.** Memory, ACP, blue/green deployment,
self-scaling, and the safety kernel are building blocks toward that capability, not ends in
themselves.

The north-star measure is **whether a human accepts an outcome or deems it a waste of time, at
what cost**, on real usage. Improvements must advance human outcome quality at equal or lower
cost. Retrieval recall, static QA scores, test counts, and infrastructure activity are not
substitutes for that result.

## Architectural direction

### Memory is a self-learning substrate

MAGMA's graph is intended to support learning from experience and conversation paths. Its value
is not a hybrid-versus-magma QA contest. Static retrieval benchmarks alone cannot establish
whether the graph improves human outcomes through learning.

Build on the existing retrieval, reinforcement, scheduling, and deployment mechanisms rather
than introducing parallel control lanes. SCNS owns its improvement cycle; safety guardrails
remain human-owned.

### Retrieval tools are purpose-routed

**`magma` handles single-hop retrieval; `multihop-iter` handles queries that require multi-hop
chaining.** They work in tandem. The system should classify a query's shape and send it to the
appropriate tool.

There is no incumbent, challenger, promotion, or retirement relationship between these tools.
The question is whether the right tool served the query, not which tool wins globally.
Query-independent, balanced assignment is for collecting routing evidence, not for selecting
a winner. Outcome labels and reviews should inform routing correctness within query shapes.

The purpose classifier is a narrower decision than understanding the human's intent. Do not
couple single-hop versus multi-hop routing to GATE or the broader intent interpreter.

### Intent elicitation is a separate capability

Use **GATE's ask-don't-guess elicitation** to clarify intent where needed. Intent understanding
must account for the state of the conversation and its path, not just an isolated prompt.
Ground that representation in prior art rather than a hand-built proxy.

GATE questions are an intent-capture channel, not the sole outcome-label channel. Not every
human prompt needs a question or a label; increasing the ask rate is not itself progress.
Preserve the `retrieval_experience`, accept-vs-waste, and settlement pipeline as evidence for
learning and routing.

## Success criteria

- **Human benefit plus cost:** demonstrate better accepted outcomes and less wasted human time
  at equal or lower cost, rather than optimizing a retrieval or activity proxy.
- **Trustworthy learning evidence:** connect outcomes to the relevant human interaction and
  retain provenance. Machine traffic must not masquerade as human acceptance or waste.
  Unsubstantiated outcomes remain unknown rather than becoming fabricated labels.
- **Purpose-correct routing:** evaluate the tool choice within the query shape it is intended
  to serve. Do not turn routing evidence back into a winner-take-all competition.
- **Honest conclusions:** distinguish a blocked measurement from a measured null, and an
  under-powered result from equivalence. Comparative claims need appropriate positive and
  negative controls, adequate evidence, and independent review.
- **Learning that changes outcomes:** connect experience to the existing learning mechanisms,
  then assess learned versus static behavior on human outcomes and cost. Building more
  reporting apparatus is not a substitute for closing the loop.

## Strategic priorities

1. **Strengthen intent and outcome quality.** Make clarification useful to the human, preserve
   trustworthy acceptance and waste evidence, and represent conversation-path state. Build
   from the concrete mechanisms in `docs/research/intent-prior-art.md`.
2. **Advance purpose routing.** Use outcome evidence to assess the hop-shape classifier
   independently of GATE. If heuristic routing is insufficient, develop a learned purpose
   classifier with held-out evaluation rather than repeatedly tuning against the same small
   sample. Preserve the framing in `docs/research/hop-shape-routing.md`.
3. **Close the learning loop.** Use real intent and outcome tuples to reinforce the existing
   graph and learn the purpose classifier, not a global arm picker. Build the mechanism first,
   then measure learned versus static behavior on the north-star outcome.
4. **Improve representation where it matters.** Assess Memora's abstraction-and-cue indexing
   and merging under a stable abstraction after the first learn-loop baseline. If node quality
   demonstrably blocks that measurement, use those mechanisms as the targeted unblocker;
   otherwise treat them as a later improvement. Reuse existing extraction, retrieval, and
   reinforcement rather than adopting a parallel runtime.

## Governance and scope

Design intent belongs in versioned documentation, not only in conversation or inferred from
the code. Preserve that intent when implementing or evaluating a mechanism.

`scns-auto` is a curated per-issue opt-in, not a default for every self-filed issue. Its absence
is a decision, not an oversight. Human-owned guardrail issues stay outside automatic intake;
machinery and tracking issues use `scns:self-improvement`. Do not widen the intake filter to
ingest everything. The full policy is in `docs/self-issue-intake.md`.

Before building apparatus, ask: **"What is the smallest change that advances the north-star
capability, and am I doing that?"** Fix a named bug before adding scaffolding around it. Check
existing code paths and extract the concrete prior-art algorithm before building a mechanism.
Check after doing; do not replace doing with another audit.
