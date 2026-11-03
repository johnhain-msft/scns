# Audit — voice_cloning (T015)

**Capability**: faithful persona/voice cloning into a working skill+agent ("read my texts + here's who you
may talk to → a faithful, working skill + agent in my tone") · **State**: `specified` (mostly unbuilt)

**Justification**: there is NO dedicated voice/persona cloning subsystem, no texts-ingestion pipeline for
modeling the operator's voice, and no persona-scoped approved-contact mechanism (distinct from the safety
allowlist). What exists is generic artifact/skill scaffolding + generic safety gates — not a "read my texts
+ talk to these contacts in my tone" system. Per research R5, "likely mostly unbuilt".

**Backing subsystems**: none dedicated (proven by grep). Adjacent only: `src/suggest/artifact-generators.ts`
(generic skill/prompt scaffolding), `src/broker/services/safety-kernel/*` (egress guardrails, NOT a persona
contact list).

**Absence proofs (independently re-verified)**
- `grep -rin "imessage|sms" src` → **0 matches** (no message-history ingestion).
- `grep -rin "approved contact|persona contact" src` → **0 matches** (no persona-scoped contact model).
- `grep -rin "persona|voice|tone|style|clone" src` → only incidental mentions (QA prompt inference), no
  cloning pipeline.

**Evidence rows**
- claim: no texts ingestion for voice modeling · quoted: `No matches found.` · ref: `grep -rin "imessage\|sms" src → 0`
- claim: no persona-scoped approved-contact model · quoted: `No matches found.` · ref: `grep -rin "approved contact\|persona contact" src → 0`
- claim: only generic skill generator exists · quoted: `This skill can be invoked to automate the described pattern.` · ref: `src/suggest/artifact-generators.ts:234-272`
- claim: safety allowlist is egress-only, not persona contacts · quoted: `The allowlist is the ONLY thing that opens egress/spend.` · ref: `src/broker/services/safety-kernel/kernel-allowlist.ts:2-8`

**Controls**: n/a — no mechanism to probe.

**Gap** (missing pieces to reach usable): (1) an ingestion path for the operator's texts/message history;
(2) stable voice/style feature extraction; (3) a persona-scoped contact policy distinct from the safety
allowlist; (4) wiring those into agent generation so outputs are consistently voice-matched + contact-
restricted; (5) a faithfulness measure (does the generated agent sound like the operator?).

**Blocked**: `{ missing_precondition: "no voice/persona subsystem, texts-ingestion, or persona-contact model exists; nothing to probe", could_setup_show_win: false }` (Validity-of-Null).

**Distance to north-star**: largest of the five together with self_direction — this is essentially unbuilt.
The repo has generic skill/artifact scaffolding and generic safety gates, but nothing that learns a voice
from texts or generates a faithful persona agent. A downstream moonshot the audit sizes, not this effort's work.
