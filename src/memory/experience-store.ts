/**
 * Phase B — Shared Retrieval-Experience Store (north-star SUBSTRATE).
 *
 * ONE greenfield SQLite table (`retrieval_experience`) in a SEPARATE file (`experience.db`, sibling of
 * `vault.db`) that records ONE row per retrieval on BOTH prod paths — the offline `retrieveContext`
 * funnel AND the live `intentAwareSearch` closure (`cli.ts`). It is the foundation for all three
 * north-star uses: routing training data, the "have we been here before" reuse/avoid lookup, and the
 * Phase-D human accept-vs-waste reward loop (master plan §9, schema ~line 425; five design traps
 * 434-439).
 *
 * DESIGN INVARIANTS (do not weaken):
 *  - SEPARATE FILE, never `vault.db`. Writing a table into `vault.db` would mutate it on every retrieval
 *    and break the guard (vault.db mtime/size must stay 1782827348 / 232488960). The store path is
 *    ALWAYS dependency-injected (never homedir-derived here), so isolated verify/tests point it at a
 *    tmpdir/`:memory:` and the live vault is untouched.
 *  - ADDITIVE + FAIL-SAFE. Every write is wrapped so a store error returns `-1` and NEVER affects the
 *    retrieval result or latency. Logging is a post-retrieval side effect; retrieved chunks/order/text
 *    stay byte-identical whether the store is on or off.
 *  - `human_outcome` is UN-WIRED in Phase B (always NULL). The behavior→anchor mapping onto the same
 *    6-pt judge gradient (1.0/0.8/0.6/0.4/0.2/0.0) + the emitting surface are Phase D.
 *  - `query_embedding` is populated ONLY when a query+context vector is cheaply available at the seam
 *    (never a synchronous embed on the live path — gate #9). NULL otherwise; offline backfill is a
 *    documented follow-up. It is stored with {@link serializeEmbedding} so it is byte-compatible with
 *    `chunk_embeddings` for a future vec0 reuse index (that index is DEFERRED — not built here).
 */

import Database from 'better-sqlite3'
import { statSync } from 'node:fs'
import { serializeEmbedding } from './embeddings.js'
import { NULL_JUDGE_SCORE } from './judge-provider.js'
import { classifyPromptAuthorship } from './prompt-authorship.js'

/**
 * The coarse §9 retriever family persisted per row. The FINE magma arm (entity / causal-beam /
 * synthesis) is recoverable from {@link RetrievalLevers} in `flag_state` — trap #1 attribution.
 */
export type RetrieverFamily = 'hybrid' | 'magma' | 'full'

/**
 * The retrieval levers that produced a row — the five-traps attribution state (trap #1 "which lever?"
 * + #5 auditability). The shared logger derives {retriever, flag_state} from these in ONE place so the
 * two prod call-sites carry zero classification logic. B-EXPLORE fields (exploreArm/epsilon/propensity)
 * are NULL/undefined in B-core.
 */
export interface RetrievalLevers {
  readonly intentRouting?: boolean
  readonly fusion?: boolean
  readonly traverse?: boolean
  readonly semantic?: boolean
  readonly timeline?: boolean
  readonly entityRelevanceRank?: boolean
  readonly synthesize?: boolean
  /** C2 — the multi-hop iterative arm (graph-based deep retrieval ⇒ family 'magma'). */
  readonly multiHop?: boolean
  readonly learnedEntityQuery?: boolean
  readonly traversalOptions?:
    | {
        readonly maxDepth?: number
        readonly budget?: number
        /** T017 [US1] — the Phase-D edge-weight beam readout, when the live lever is ON (trap-#1 attribution). */
        readonly useEdgeWeights?: boolean
      }
    | undefined
  /** B-EXPLORE (LATER): the ε-arm actually run, its ε, and its selection propensity (for off-policy IPS/DR). */
  readonly exploreArm?: string | undefined
  readonly epsilon?: number | undefined
  readonly propensity?: number | undefined
}

/** Provenance/episode fields the CALLER supplies (the seam knows them; the logger does not compute them). */
export interface EpisodeContext {
  readonly conversationId?: string | undefined
  readonly turn?: number | undefined
  /** LoCoMo category (offline items). Feeds the pos/neg control class in {@link projectToArmFrontierRow}. */
  readonly category?: number | undefined
  readonly exploreArm?: string | undefined
  readonly epsilon?: number | undefined
  readonly propensity?: number | undefined
  /** Abort budget (ms) the CLIENT enforced on this request. Recorded, never inferred. */
  readonly clientTimeoutMs?: number | undefined
}

/** The single arg shape BOTH prod call-sites pass to {@link logRetrievalExperience} (zero duplication). */
export interface RetrievalExperienceInput {
  readonly queryText: string
  readonly levers: RetrievalLevers
  readonly retrievedChunkIds: readonly number[]
  /** Routed intent (episode key part 2). Cheap/deterministic; NULL if the seam doesn't classify. */
  readonly intent?: string | undefined
  readonly category?: number | undefined
  readonly conversationId?: string | undefined
  readonly turn?: number | undefined
  readonly latencyMs?: number | undefined
  /** query+context vector — OPTIONAL. Passed ONLY when cheaply available (NEVER a live sync embed). */
  readonly queryEmbedding?: Float32Array | undefined
  /** Selection propensity μ(arm|x) of the LOGGED arm ∈ (0,1] — first-class for clean IPS/DR (research
   *  D1). Falls back to `levers.propensity` so offline B-EXPLORE rows populate it without call-site
   *  changes. */
  readonly propensity?: number | undefined
  /** The specific causal target; with `intent` it forms the (intent,target) episode key — finer than
   *  topic/anchor (research D3, the collision trap). */
  readonly target?: string | undefined
  /** Abort budget (ms) the CLIENT enforced. Lets the delivery gate ask "did this briefing actually
   *  reach the human?" per row instead of guessing from a global constant. */
  readonly clientTimeoutMs?: number | undefined
  /** JSON stage breakdown (search / semantic / synthesis / total) — makes a slow row attributable. */
  readonly stageTimings?: string | undefined
}

/** Post-hoc outcome for the offline settle (the live path never settles — no judge live). */
export interface RetrievalOutcome {
  readonly genAnswer?: string | undefined
  /** [0,1] judge score, or null when unscored/dropped (stored as NULL, NOT the -1 sentinel). */
  readonly judgeScore?: number | null | undefined
  readonly dropped?: boolean | undefined
  readonly tokens?: number | undefined
  readonly latencyMs?: number | undefined
}

/** Tokens-only `full`-context baseline row (MAGMA Table-3 ~101K analog). No retrieval/answer/chunks. */
export interface FullContextBaselineInput {
  readonly queryText: string
  readonly tokens: number
  readonly category?: number | undefined
  readonly conversationId?: string | undefined
  readonly turn?: number | undefined
}

/**
 * Structurally identical to the evaluator's `ArmFrontierRow` (scripts/locomo-judge-lib.ts). Declared
 * here so `src/` stays independent of `scripts/`; the evaluator consumes it by structural typing.
 */
export interface ArmFrontierRowProjection {
  readonly category: number
  readonly score: number
  readonly contextTokens: number
}

/** The subset of a stored row consumed by {@link projectToArmFrontierRow}. */
export interface RetrievalExperienceRow {
  readonly category: number | null
  readonly judge_score: number | null
  readonly dropped: number
  readonly tokens: number | null
}

export interface ExperienceStore {
  readonly db: Database.Database
  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS retrieval_experience (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id     TEXT,
  turn                INTEGER,
  query_text          TEXT NOT NULL,
  query_embedding     BLOB,
  retriever           TEXT NOT NULL CHECK (retriever IN ('hybrid','magma','full')),
  magma_path          TEXT,
  retrieved_chunk_ids TEXT,
  gen_answer          TEXT,
  judge_score         REAL,
  dropped             INTEGER NOT NULL DEFAULT 0,
  tokens              INTEGER,
  latency_ms          INTEGER,
  human_outcome       REAL CHECK (human_outcome IS NULL OR (human_outcome >= 0 AND human_outcome <= 1)),
  category            INTEGER,
  intent              TEXT,
  explore_arm         TEXT,
  propensity          REAL,
  target              TEXT,
  flag_state          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rexp_retriever ON retrieval_experience(retriever);
CREATE INDEX IF NOT EXISTS idx_rexp_category  ON retrieval_experience(category);
CREATE INDEX IF NOT EXISTS idx_rexp_created   ON retrieval_experience(created_at);
`

/** Applied AFTER {@link migrateAdditiveColumns} so pre-feature DBs already carry \`target\`. */
const INTENT_TARGET_INDEX = `
CREATE INDEX IF NOT EXISTS idx_rexp_intent_target ON retrieval_experience(intent, target);
`

/**
 * Issue #17 (spec 003 US4, contracts/refusal-backoff.md): the DURABLE record that a pair was offered
 * to the expensive ACP follow-up reader and declined. The settle sweep used to keep this in an
 * in-memory Set constructed inside a single run, so the same permanently-refused pairs were
 * re-offered every hour until the whole 12-read budget was gone (measured live: 283 of 319 runs
 * settled zero with \`followupAbstained\` pinned at exactly \`maxReads\`). One row per refused pair,
 * keyed by experience id; \`CREATE TABLE IF NOT EXISTS\` is the established additive path, so
 * pre-feature DBs gain the table on reopen without any data rewrite. Growth is bounded by the
 * unsettled frontier: {@link settleHumanOutcome} clears the row the moment the record settles (RR5).
 */
const FOLLOWUP_REFUSAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS followup_refusal (
  experience_id    INTEGER PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  first_refused_at TEXT NOT NULL,
  last_refused_at  TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 1,
  turns_at_refusal INTEGER
);
CREATE INDEX IF NOT EXISTS idx_followup_refusal_conv ON followup_refusal(conversation_id);
`

/**
 * Additive, non-destructive migration for pre-feature experience DBs: \`propensity\` (first-class for
 * clean IPS/DR — research D1) and \`target\` (the (intent,target) episode key — research D3) are ADDED
 * when absent; existing rows keep NULLs. Never drops, rewrites, or touches data.
 */
function migrateAdditiveColumns(db: Database.Database): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(retrieval_experience)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  )
  if (!cols.has('propensity'))
    db.exec('ALTER TABLE retrieval_experience ADD COLUMN propensity REAL')
  if (!cols.has('target')) db.exec('ALTER TABLE retrieval_experience ADD COLUMN target TEXT')
  // GATE (arXiv:2310.11589) intent-elicitation columns — additive, NULL/0 on existing rows; the coarse
  // `intent` routing bucket is left untouched. gate_question = the clarifying question generated for an
  // under-determined prompt; gate_delivered = 0 until surfaced to the human; elicited_intent = the
  // human's answer (the higher-confidence goal-level intent).
  if (!cols.has('gate_question'))
    db.exec('ALTER TABLE retrieval_experience ADD COLUMN gate_question TEXT')
  if (!cols.has('gate_delivered'))
    db.exec('ALTER TABLE retrieval_experience ADD COLUMN gate_delivered INTEGER NOT NULL DEFAULT 0')
  if (!cols.has('elicited_intent'))
    db.exec('ALTER TABLE retrieval_experience ADD COLUMN elicited_intent TEXT')
  // GATE label-validity columns (NORTH_STAR move 3b/3c). gate_delivered_ref = the experience id of the
  // briefing that actually SURFACED the question; its query_text is what lets the settle locate the
  // delivering turn in the Copilot CLI transcript, so "the answer" means "the next human turn AFTER
  // delivery" rather than "whatever prompt arrived next". gate_delivered_at = delivery wall-clock (epoch
  // ms) for funnel telemetry. answer_source = provenance of the settled label, so a real accept is never
  // again indistinguishable from a machine-authored one.
  if (!cols.has('gate_delivered_ref'))
    db.exec('ALTER TABLE retrieval_experience ADD COLUMN gate_delivered_ref INTEGER')
  if (!cols.has('gate_delivered_at'))
    db.exec('ALTER TABLE retrieval_experience ADD COLUMN gate_delivered_at INTEGER')
  if (!cols.has('answer_source'))
    db.exec('ALTER TABLE retrieval_experience ADD COLUMN answer_source TEXT')
  // DELIVERY VALIDITY: the abort budget the CLIENT actually enforced on this request. The Copilot
  // extension aborts `/api/extension/context` on its own timer, but the route logs the row server-side
  // regardless — so a row slower than the client's budget describes a briefing the model never received.
  // That budget changed (1500 -> 5000) and both populations coexist, so it must be RECORDED per row and
  // never inferred from wall-clock. NULL on pre-feature rows ⇒ callers fall back to the conservative
  // 1500 ms default.
  if (!cols.has('client_timeout_ms'))
    db.exec('ALTER TABLE retrieval_experience ADD COLUMN client_timeout_ms INTEGER')
  // STAGE ATTRIBUTION: JSON breakdown of where a briefing spent its time (search / semantic scoring /
  // synthesis / total). `latency_ms` covers only the search leg, so a slow row was previously
  // unattributable AND understated what the human actually waited for. NULL on pre-feature rows.
  if (!cols.has('stage_timings'))
    db.exec('ALTER TABLE retrieval_experience ADD COLUMN stage_timings TEXT')
  // TRIGGER TELEMETRY (Phase A): `shouldElicit` already returns {ask, reason} and the caller already
  // computes the OOS similarity — both were DISCARDED, which made a dry funnel undiagnosable (measured
  // 2026-07-27: 0 asks in 162 rows / 10 days, with no way to tell "the trigger declined, and why" from
  // "the trigger never ran"). gate_decision = the reason string verbatim (`too-short`, `no-memory-need`,
  // `ask-budget-exhausted`, `underspecified`, `clearly-specific`, `oos-novel(...)`, `confident-serve`);
  // gate_max_sim = the max cosine to a prior episode, NULL when the embedding worker was cold. NULL on
  // pre-feature rows ⇒ "never recorded", which is semantically distinct from "recorded as declined".
  if (!cols.has('gate_decision'))
    db.exec('ALTER TABLE retrieval_experience ADD COLUMN gate_decision TEXT')
  if (!cols.has('gate_max_sim'))
    db.exec('ALTER TABLE retrieval_experience ADD COLUMN gate_max_sim REAL')

  // prompt_origin = who authored the query THIS row was logged for, decided at capture time rather than
  // re-derived at label time. John's decision (2026-07-31): machine traffic is KEPT (it is useful data
  // for optimizing the harness later) but must be MARKED, so a sub-agent prompt is never mistaken for a
  // human signal. prompt_origin_rule names the matching rule so the classifier itself stays auditable.
  // NULL on pre-feature rows ⇒ "never recorded", distinct from "recorded as human".
  if (!cols.has('prompt_origin'))
    db.exec('ALTER TABLE retrieval_experience ADD COLUMN prompt_origin TEXT')
  if (!cols.has('prompt_origin_rule'))
    db.exec('ALTER TABLE retrieval_experience ADD COLUMN prompt_origin_rule TEXT')
  backfillPromptOrigin(db)
}

/**
 * One-time backfill so the EXISTING corpus is analysable too — a column that is NULL for every historic
 * row teaches nothing. Derived purely from `query_text` already on the row (no new facts invented), and
 * annotate-only: it never touches `human_outcome`, so rows already settled keep their verdict. Bounded
 * by `prompt_origin IS NULL`, so it is a no-op on every subsequent open. FAIL-SAFE: a backfill problem
 * must never stop the store from opening.
 */
function backfillPromptOrigin(db: Database.Database): void {
  try {
    const rows = db
      .prepare(`SELECT id, query_text FROM retrieval_experience WHERE prompt_origin IS NULL`)
      .all() as Array<{ id: number; query_text: string | null }>
    if (rows.length === 0) return
    const upd = db.prepare(
      `UPDATE retrieval_experience SET prompt_origin = ?, prompt_origin_rule = ? WHERE id = ?`,
    )
    db.transaction(() => {
      for (const r of rows) {
        const v = classifyPromptAuthorship(r.query_text)
        upd.run(v.author, v.rule, r.id)
      }
    })()
  } catch {
    /* annotation is best-effort — never block opening the store */
  }
}

/**
 * Open the retrieval-experience store at `dbPath` READ-ONLY for reporting. Unlike
 * {@link openExperienceStore} this never creates the file, never runs DDL/migrations, and never opens a
 * write-capable WAL handle — so a reporting command (`scns review weekly`, the reward report) cannot
 * materialise or checkpoint the live corpus merely by being run. Throws if the file does not exist.
 */
export function openExperienceStoreReadOnly(dbPath: string): ExperienceStore {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  return {
    db,
    close(): void {
      try {
        db.close()
      } catch {
        /* idempotent — already closed */
      }
    },
  }
}

/**
 * Open (creating if needed) the retrieval-experience store at `dbPath`. Mirrors {@link openMemoryDb}
 * (WAL unless in-memory, NORMAL sync, idempotent DDL). `dbPath` MUST be caller-provided — the live
 * broker passes `~/.scns/memory/experience.db`; verify/tests pass a tmpdir or `:memory:`.
 */
export function openExperienceStore(dbPath: string): ExperienceStore {
  const db = new Database(dbPath)
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(SCHEMA)
  migrateAdditiveColumns(db)
  db.exec(INTENT_TARGET_INDEX)
  db.exec(FOLLOWUP_REFUSAL_SCHEMA)
  return {
    db,
    close(): void {
      try {
        db.close()
      } catch {
        /* idempotent — already closed */
      }
    },
  }
}

/** The ONE classification point: coarse §9 family from the levers (magma iff any MAGMA mechanism ran). */
export function retrieverFamilyOf(levers: RetrievalLevers): Exclude<RetrieverFamily, 'full'> {
  return levers.intentRouting ||
    levers.fusion ||
    levers.traverse ||
    levers.synthesize ||
    levers.multiHop
    ? 'magma'
    : 'hybrid'
}

/**
 * THE ONE shared logger. INSERT exactly one retrieval-time row and return its id (the settle handle).
 * FAIL-SAFE: any error returns `-1` (retrieval is never affected). Called from BOTH prod entry points
 * with the SAME {@link RetrievalExperienceInput} shape — zero logic duplication. Retrieval-time fields
 * only; `gen_answer`/`judge_score`/`tokens` are settled later on the offline judged path.
 */
export function logRetrievalExperience(
  store: ExperienceStore,
  input: RetrievalExperienceInput,
): number {
  try {
    const retriever = retrieverFamilyOf(input.levers)
    const chunkIds = [...(input.retrievedChunkIds ?? [])]
    // magma_path = the ranked node-id path for magma arms (typed-edge trace DEFERRED to Phase C — the
    // beam is NOT modified in B-core); NULL for hybrid. It diverges from retrieved_chunk_ids once edges
    // + Stage-4 re-ordering land.
    const magmaPath = retriever === 'magma' ? JSON.stringify(chunkIds) : null
    const origin = classifyPromptAuthorship(input.queryText)
    const info = store.db
      .prepare(
        `INSERT INTO retrieval_experience
           (conversation_id, turn, query_text, query_embedding, retriever, magma_path,
            retrieved_chunk_ids, tokens, latency_ms, category, intent, explore_arm, propensity,
            target, flag_state, client_timeout_ms, stage_timings, prompt_origin, prompt_origin_rule)
         VALUES (@conversationId, @turn, @queryText, @queryEmbedding, @retriever, @magmaPath,
            @retrievedChunkIds, NULL, @latencyMs, @category, @intent, @exploreArm, @propensity,
            @target, @flagState, @clientTimeoutMs, @stageTimings, @promptOrigin, @promptOriginRule)`,
      )
      .run({
        conversationId: input.conversationId ?? null,
        turn: input.turn ?? null,
        queryText: input.queryText,
        queryEmbedding: input.queryEmbedding ? serializeEmbedding(input.queryEmbedding) : null,
        retriever,
        magmaPath,
        retrievedChunkIds: JSON.stringify(chunkIds),
        latencyMs: input.latencyMs ?? null,
        category: input.category ?? null,
        intent: input.intent ?? null,
        exploreArm: input.levers.exploreArm ?? null,
        propensity: input.propensity ?? input.levers.propensity ?? null,
        target: input.target ?? null,
        flagState: JSON.stringify(input.levers),
        clientTimeoutMs: input.clientTimeoutMs ?? null,
        stageTimings: input.stageTimings ?? null,
        promptOrigin: origin.author,
        promptOriginRule: origin.rule,
      })
    return Number(info.lastInsertRowid)
  } catch {
    return -1
  }
}

/**
 * Settle the post-hoc outcome (gen_answer / judge_score / dropped / tokens / latency) onto a row created
 * by {@link logRetrievalExperience}. OFFLINE judged path only. No-op on `id < 0` (a failed/skipped log).
 * FAIL-SAFE. `judge_score` is stored NULL when unscored/dropped — the -1 sentinel is applied ONLY by the
 * evaluator projection, keeping "no score" semantically distinct in the store (gate #2).
 */
export function settleRetrievalExperience(
  store: ExperienceStore,
  id: number,
  outcome: RetrievalOutcome,
): void {
  if (id < 0) return
  try {
    store.db
      .prepare(
        `UPDATE retrieval_experience
            SET gen_answer  = @genAnswer,
                judge_score = @judgeScore,
                dropped     = @dropped,
                tokens      = COALESCE(@tokens, tokens),
                latency_ms  = COALESCE(@latencyMs, latency_ms)
          WHERE id = @id`,
      )
      .run({
        id,
        genAnswer: outcome.genAnswer ?? null,
        judgeScore: outcome.judgeScore == null ? null : outcome.judgeScore,
        dropped: outcome.dropped ? 1 : 0,
        tokens: outcome.tokens ?? null,
        latencyMs: outcome.latencyMs ?? null,
      })
  } catch {
    /* fail-safe: settle is best-effort */
  }
}

/**
 * Phase D — settle the HUMAN accept-vs-waste outcome onto a retrieval row. `value` must sit on the
 * App-C.3-aligned 6-pt gradient scale [0,1] (1.0 accepted … 0.0 wasted — see human-outcome.ts for the
 * behavioral mapping). Returns true iff exactly one row was updated; false on invalid value, id<0, a
 * missing row, or any store error (FAIL-SAFE — an outcome write must never break the emitting surface).
 *
 * `answerSource` [FR-034/SC-009] is the label's PROVENANCE and is written in the SAME statement as the
 * label. This is the whole point: the previous shape settled first and annotated in a second,
 * error-swallowing statement, so a crash or a throw between the two produced a label whose source was
 * permanently NULL. A label of unknown provenance cannot be down-weighted, so a derived guess ends up
 * consumed as if it were an oracle-verified human verdict. One statement ⇒ label and provenance are
 * committed together or not at all, and a refused row (already settled, or machine-origin) gets neither.
 */
export function settleHumanOutcome(
  store: ExperienceStore,
  id: number,
  value: number,
  answerSource?: string,
): boolean {
  if (id < 0 || !Number.isFinite(value) || value < 0 || value > 1) return false
  try {
    // FIRST-SIGNAL-WINS (T022/T025 [US2]): a settled verdict is never overwritten — the second
    // signal is refused (returns false), keeping the audit trail stable per attempt id.
    // MACHINE-ORIGIN REFUSAL: a row captured from agent/sub-agent traffic is kept for harness analysis
    // but is NOT a human accept-or-waste signal, so it can never be settled. `prompt_origin IS NOT
    // 'machine'` also admits legacy NULL rows captured before the column existed (SQLite `IS NOT`
    // is null-safe), so this tightens the future without silently voiding the existing corpus.
    const source = answerSource?.trim() || null
    const info = store.db
      .prepare(
        `UPDATE retrieval_experience
            SET human_outcome = ?,
                answer_source = COALESCE(?, answer_source)
          WHERE id = ? AND human_outcome IS NULL AND prompt_origin IS NOT 'machine'`,
      )
      .run(value, source, id)
    if (info.changes !== 1) return false
    // RR5 (#17): a settled record no longer exists as WORK for the follow-up reader, so its durable
    // refusal record is cleared here — at the ONE seam every settle path flows through — which is
    // what keeps `followup_refusal` bounded by the unsettled frontier rather than by total history.
    clearFollowupRefusal(store, id)
    return true
  } catch {
    return false
  }
}

// ── Durable refusal back-off (#17, spec 003 US4, contracts/refusal-backoff.md) ───────────────────
// The follow-up reader is a bounded budget of expensive subprocess reads, and a refused pair keeps
// `human_outcome IS NULL` — so without a durable record the sweep re-bought the same refusals every
// hour. These functions are the whole policy surface: record a refusal, ask whether a pair is still
// deferred, clear the record when the pair settles. FAIL-SAFE in the fail-OPEN direction throughout:
// a bookkeeping error degrades to the pre-#17 behaviour (the old waste), never to skipping
// labellable work.

/** First retry window after one refusal. Deliberately ABOVE the sweep's hourly cadence — FR-007
 *  ("not re-offered on the immediately following run") depends on this ordering. */
export const FOLLOWUP_REFUSAL_BACKOFF_BASE_MS = 4 * 60 * 60 * 1000
/** Ceiling of the doubling schedule: a permanently-refusing pair decays to ~1 read per week —
 *  bounded and shrinking (FR-008), never zero (a seal) and never the old fixed 1/12 every hour. */
export const FOLLOWUP_REFUSAL_BACKOFF_CAP_MS = 7 * 24 * 60 * 60 * 1000

/** Exponential back-off window for a pair refused `attempts` times: base × 2^(attempts−1), capped. */
function followupBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0
  return Math.min(
    FOLLOWUP_REFUSAL_BACKOFF_BASE_MS * 2 ** (attempts - 1),
    FOLLOWUP_REFUSAL_BACKOFF_CAP_MS,
  )
}

export interface FollowupRefusalInput {
  readonly experienceId: number
  readonly conversationId: string
  /** The conversation's human-turn count when the reader refused — the new-evidence anchor: once
   *  the live count exceeds it, the conversation has moved on and the pair is re-eligible (FR-008). */
  readonly turnsAtRefusal: number
  /** The refusing run's logical clock; defaults to now. Injectable so back-off tests are exact. */
  readonly refusedAt?: Date
}

/**
 * Record that the reader was offered this pair and declined (FR-006). One row per pair: a repeat
 * refusal accumulates `attempts` (which drives the doubling window) and advances `last_refused_at`,
 * while `first_refused_at` stays put as the audit anchor. Never throws.
 */
export function recordFollowupRefusal(store: ExperienceStore, input: FollowupRefusalInput): void {
  try {
    const at = (input.refusedAt ?? new Date()).toISOString()
    store.db
      .prepare(
        `INSERT INTO followup_refusal
           (experience_id, conversation_id, first_refused_at, last_refused_at, attempts, turns_at_refusal)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(experience_id) DO UPDATE SET
           conversation_id  = excluded.conversation_id,
           last_refused_at  = excluded.last_refused_at,
           attempts         = followup_refusal.attempts + 1,
           turns_at_refusal = excluded.turns_at_refusal`,
      )
      .run(input.experienceId, input.conversationId, at, at, input.turnsAtRefusal)
  } catch {
    /* best-effort bookkeeping — never block the harvest */
  }
}

/**
 * Is this pair's refusal still holding it out of the reader's budget? False for a pair with no
 * refusal record; false the moment the conversation's turn count exceeds `turns_at_refusal` (new
 * evidence outranks the clock); false once the exponential window on `last_refused_at` has elapsed
 * (RR2 — recoverable, never a permanent seal); and false on any error, because the fail-open
 * direction here is the old waste, not a new starvation.
 */
export function isFollowupDeferred(
  store: ExperienceStore,
  input: { readonly experienceId: number; readonly currentTurnCount: number; readonly now?: Date },
): boolean {
  try {
    const row = store.db
      .prepare(
        `SELECT attempts, last_refused_at, turns_at_refusal
           FROM followup_refusal WHERE experience_id = ?`,
      )
      .get(input.experienceId) as
      | { attempts: number; last_refused_at: string; turns_at_refusal: number | null }
      | undefined
    if (!row || row.attempts <= 0) return false
    if (row.turns_at_refusal != null && input.currentTurnCount > row.turns_at_refusal) return false
    const lastMs = Date.parse(row.last_refused_at)
    if (!Number.isFinite(lastMs)) return false
    return (input.now ?? new Date()).getTime() - lastMs < followupBackoffMs(row.attempts)
  } catch {
    return false
  }
}

/** Drop the pair's refusal record — called when its experience row settles (RR5). Never throws. */
export function clearFollowupRefusal(store: ExperienceStore, experienceId: number): void {
  try {
    store.db.prepare(`DELETE FROM followup_refusal WHERE experience_id = ?`).run(experienceId)
  } catch {
    /* best-effort — a stale row is waste-accounting noise, not a correctness problem */
  }
}

/** Was this pair EVER refused? Distinguishes a retried read from a first read for the sweep's
 *  FR-011 accounting (`readsOnRetriedPairs` vs `readsOnNewPairs`). Fail-safe: false on error. */
export function hasFollowupRefusal(store: ExperienceStore, experienceId: number): boolean {
  try {
    return (
      store.db
        .prepare(`SELECT 1 AS one FROM followup_refusal WHERE experience_id = ?`)
        .get(experienceId) !== undefined
    )
  } catch {
    return false
  }
}

/**
 * Write the `full`-context token-reference row (retriever='full'): `tokens` populated;
 * `retrieved_chunk_ids`/`gen_answer`/`magma_path`/`query_embedding` NULL. Keeps the §9 enum faithful and
 * feeds the evaluator's token frontier without inventing a retrieval/answer. FAIL-SAFE → -1 on error.
 */
export function logFullContextBaseline(
  store: ExperienceStore,
  input: FullContextBaselineInput,
): number {
  try {
    const origin = classifyPromptAuthorship(input.queryText)
    const info = store.db
      .prepare(
        `INSERT INTO retrieval_experience
           (conversation_id, turn, query_text, retriever, retrieved_chunk_ids, tokens, category, flag_state,
            prompt_origin, prompt_origin_rule)
         VALUES (@conversationId, @turn, @queryText, 'full', NULL, @tokens, @category, @flagState,
            @promptOrigin, @promptOriginRule)`,
      )
      .run({
        conversationId: input.conversationId ?? null,
        turn: input.turn ?? null,
        queryText: input.queryText,
        tokens: input.tokens,
        category: input.category ?? null,
        flagState: JSON.stringify({ full: true }),
        promptOrigin: origin.author,
        promptOriginRule: origin.rule,
      })
    return Number(info.lastInsertRowid)
  } catch {
    return -1
  }
}

/**
 * Project a stored row to the evaluator's `ArmFrontierRow` shape (judge_score→score, tokens→contextTokens,
 * category passthrough). A dropped/unscored row maps to {@link NULL_JUDGE_SCORE} (-1) so the frontier
 * caller drops it exactly as it drops a raw {@link JudgeEvalRow} — letting the built evaluator consume the
 * accumulated store between phases with the SAME semantics.
 */
export function projectToArmFrontierRow(row: RetrievalExperienceRow): ArmFrontierRowProjection {
  const scored = row.dropped === 0 && row.judge_score != null
  return {
    category: row.category ?? -1,
    score: scored ? (row.judge_score as number) : NULL_JUDGE_SCORE,
    contextTokens: row.tokens ?? 0,
  }
}

/**
 * Count explored rows (explore_arm IS NOT NULL) logged in the trailing 24h — the 24h half of the
 * B-EXPLORE ε-router bound (§7b). FAIL-SAFE → 0 on error (a broken count must never unblock exploration
 * beyond the per-process cap). Uses SQLite `datetime('now','-1 day')` against the `created_at` default.
 *
 * `opts.arms` RESTRICTS the count to specific arms. The briefing path needs this: it records
 * `explore_arm` on EXPLOIT draws too (arm = the incumbent, propensity = 1−ε) so the off-policy dataset
 * has both arms, and counting those as "explorations" would trip the 24h cap after ~20 ordinary human
 * turns and silently switch exploration off. Omitted ⇒ the original all-arms count (the `search:` path).
 */
export function countExplorations24h(
  store: ExperienceStore,
  opts: { readonly arms?: readonly string[] } = {},
): number {
  try {
    const arms = opts.arms
    if (arms && arms.length === 0) return 0
    const filter = arms ? `AND explore_arm IN (${arms.map(() => '?').join(',')})` : ''
    const row = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM retrieval_experience
          WHERE explore_arm IS NOT NULL ${filter} AND created_at >= datetime('now','-1 day')`,
      )
      .get(...(arms ?? [])) as { n: number }
    return row.n
  } catch {
    return 0
  }
}

/**
 * The population an arm comparison is allowed to draw from — defined ONCE, consumed by the report and
 * by the learner, so the two can never describe different rows [FR-027/FR-027a/FR-027c, SC-003].
 *
 * Arm identity is `explore_arm` ALONE. The previous keying, `COALESCE(explore_arm, retriever)`, was
 * written three times (here twice, and once more in TypeScript as `r.explore_arm ?? r.retriever` in
 * `reward/kto-learner.ts`) and credited every row the policy never assigned to the coarse `retriever`
 * family — i.e. to the incumbent. Measured on the live corpus 2026-08-02: that fallback reported
 * magma 27 / multihop-iter 7, where keying on `explore_arm` alone reports magma 18 / multihop-iter 7.
 * Nine legacy unassigned rows were inflating the incumbent's sample by 50% against the very challenger
 * it was being compared with.
 *
 * `prompt_origin IS NOT 'machine'` is null-safe in SQLite, so rows captured before that column existed
 * are still admitted — this tightens the future without silently voiding the existing corpus.
 */
export const ARM_SAMPLE_SERVED_WHERE = `retriever != 'full' AND explore_arm IS NOT NULL AND prompt_origin IS NOT 'machine'`

/** The settled-side predicate: {@link ARM_SAMPLE_SERVED_WHERE} plus a recorded human outcome. */
export const ARM_SAMPLE_WHERE = `human_outcome IS NOT NULL AND ${ARM_SAMPLE_SERVED_WHERE}`

/**
 * The ONE arm-count query. Both the strict {@link readServedByArm}/{@link readSettledByArm} reads and
 * the fail-safe {@link countServedByArm}/{@link countSettledByArm} adapters project through it, so the
 * two surfaces can never drift into disagreeing about what an arm's sample IS (Constitution IV). The
 * only thing that differs between them is what they do with a thrown error — which is the entire point
 * of the split.
 *
 * Deliberately NOT error-handled here: the caller decides whether a failure is surfaced or swallowed.
 */
function selectCountsByArm(db: Database.Database, where: string): Map<string, number> {
  const out = new Map<string, number>()
  const rows = db
    .prepare(
      `SELECT explore_arm AS arm, COUNT(*) AS n
         FROM retrieval_experience
        WHERE ${where}
        GROUP BY arm`,
    )
    .all() as Array<{ arm: string; n: number }>
  for (const r of rows) out.set(r.arm, r.n)
  return out
}

/**
 * The three genuinely different things "no counts" can mean [FR-024, FR-026].
 *
 * Collapsing them is the #20 defect: `catch { return out }` turned an unreadable corpus into an empty
 * Map, which the review then rendered as `· magma: 0` — a fabricated fact presented with the same
 * confidence as a measurement. A reader cannot act on that, because the two states license opposite
 * next moves ("keep labelling" vs "fix the store"). `ok` with zero entries is a real, empty corpus and
 * is NOT an error.
 *
 * Contract: `specs/003-label-integrity-defects/contracts/evidence-counts.md`.
 */
export type EvidenceRead =
  | { readonly status: 'ok'; readonly counts: Map<string, number> }
  | { readonly status: 'absent'; readonly path: string }
  | { readonly status: 'failed'; readonly error: string }

/** The message a caught unknown carries, for the `failed` arm of {@link EvidenceRead}. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * STRICT read — the review consumes this. A read failure is REPORTED, never swallowed.
 *
 * Opened read-only (`fileMustExist`), so this can be pointed at the live corpus without writing to it.
 * The GROUP BY itself is the integrity probe: it touches `explore_arm`, `retriever` and `prompt_origin`
 * (and `human_outcome` on the settled side), so a store whose schema has drifted throws here rather
 * than quietly reporting a starved learner — a bare `SELECT COUNT(*)` would not.
 *
 * `absent` means ENOENT and NOTHING else. This used to gate on `existsSync`, which returns `false` for
 * ANY stat error — so a store that was present but unreadable (EACCES, ENOTDIR, EIO) rendered as
 * *"There is no experience store … the broker creates it on first retrieval … not a failure … the
 * cause is known and self-resolving."* That is the precise conflation FR-026 exists to prevent: the
 * two states are separated BECAUSE `absent` self-resolves and `failed` does not, and they license
 * opposite next moves. Found by the PR #24 review; reproduced with a store inside a `chmod 000`
 * directory, which reported `status = absent`.
 */
function readByArm(path: string, where: string): EvidenceRead {
  try {
    statSync(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { status: 'absent', path }
    // Reachable but unreadable: name the errno so the reader is pointed at the real problem
    // (a permission or mount fault) instead of at a fresh install that will fix itself.
    return { status: 'failed', error: `cannot stat ${path}: ${messageOf(err)}` }
  }
  let store: ExperienceStore | undefined
  try {
    store = openExperienceStoreReadOnly(path)
    return { status: 'ok', counts: selectCountsByArm(store.db, where) }
  } catch (err) {
    return { status: 'failed', error: messageOf(err) }
  } finally {
    try {
      store?.close()
    } catch {
      /* idempotent */
    }
  }
}

/** Strict SERVED-side read (the funnel denominator). See {@link EvidenceRead}. */
export function readServedByArm(path: string): EvidenceRead {
  return readByArm(path, ARM_SAMPLE_SERVED_WHERE)
}

/** Strict SETTLED-side read (the learner's actual evidence base). See {@link EvidenceRead}. */
export function readSettledByArm(path: string): EvidenceRead {
  return readByArm(path, ARM_SAMPLE_WHERE)
}

/**
 * SERVED-row counts keyed by `explore_arm`, settled or not.
 *
 * The weekly review needs the funnel, not just the numerator: an arm with many served rows and zero
 * settled ones is STARVED OF LABELS (nobody accepted or re-asked), which is a different problem from an
 * arm that was never tried. Reporting only the settled side made a live challenger invisible. Uses the
 * same population as {@link countSettledByArm} minus the outcome clause, so numerator and denominator
 * describe the same rows.
 *
 * FAIL-SAFE adapter [FR-025] → empty map on error. This is the form the LIVE SERVING path uses to pick
 * ε (`cli.ts:1265`), which must never acquire a throw site. Callers that need to TELL "unreadable"
 * apart from "empty" must use {@link readServedByArm} instead — that is why these are two functions.
 */
export function countServedByArm(store: ExperienceStore): Map<string, number> {
  try {
    return selectCountsByArm(store.db, ARM_SAMPLE_SERVED_WHERE)
  } catch {
    return new Map<string, number>()
  }
}

/**
 * The settled rows an arm comparison had to DROP, and why [FR-027c].
 *
 * An exclusion nobody can see is indistinguishable from a corpus that never had those rows. The two
 * categories are DISJOINT and, with the arm sample itself, partition every settled non-`full` row —
 * so `sum(countSettledByArm) + unassigned + machine` reconciles exactly against a hand count, which is
 * what makes SC-003 checkable rather than asserted.
 *
 * Read-only + FAIL-SAFE → zeros on error.
 */
export function countExcludedFromArmSample(store: ExperienceStore): {
  unassigned: number
  machine: number
} {
  try {
    const row = store.db
      .prepare(
        `SELECT
           SUM(CASE WHEN prompt_origin IS NOT 'machine' AND explore_arm IS NULL THEN 1 ELSE 0 END) AS unassigned,
           SUM(CASE WHEN prompt_origin = 'machine' THEN 1 ELSE 0 END) AS machine
         FROM retrieval_experience
        WHERE human_outcome IS NOT NULL AND retriever != 'full'`,
      )
      .get() as { unassigned: number | null; machine: number | null }
    return { unassigned: row.unassigned ?? 0, machine: row.machine ?? 0 }
  } catch {
    return { unassigned: 0, machine: 0 }
  }
}

/**
 * Settled-row counts keyed by `explore_arm` — the SAME arm identity the reward learner projects
 * (`kto-learner.ts loadRewardRows`), so the bootstrap-decay schedule and the learner agree on when an
 * arm has cleared `minN`.
 *
 * FAIL-SAFE adapter [FR-025] → an empty map on error, which keeps ε in bootstrap (the conservative
 * direction). Use {@link readSettledByArm} where a read failure must be visible.
 */
export function countSettledByArm(store: ExperienceStore): Map<string, number> {
  try {
    return selectCountsByArm(store.db, ARM_SAMPLE_WHERE)
  } catch {
    return new Map<string, number>()
  }
}
