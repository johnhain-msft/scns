/**
 * WS-2 Phase B3 — conversational event/outcome ingestion MEASUREMENT ARM (thin orchestrator).
 *
 * Arm A (baseline) vs Arm B (B3 event + causal-live) over the LoCoMo DEV slice, reusing the ALREADY
 * unit-tested pieces:
 *   Arm A — `retrieveContext({intentRouting:false})` (the honest hybrid baseline; 0.3817/0.3683, 184 tok).
 *   Arm B — `ingestConversationEventNodes` (segment conversation → `writeEventNodes` →
 *           `runCausalEdgeInference` w/ the REAL deny-all ACP judge → materialize) then
 *           `retrieveContext({intentRouting:true})` (the entity-anchored WHY read over the new edges).
 * Plus the B3.6★ NODE-QUALITY DIAGNOSTIC: event-sourced (decision→outcome) vs turn-adjacency
 * (chunk-pair) causal-candidate counts + a sample of the persisted-edge rationales — the independent
 * check that B3 fixed the §B2.1 "goodbye→goodbye" problem, regardless of the ruler delta.
 *
 * ★ B3.4 GOTCHA: the WHY read (`causalNeighborhood WHERE entity=?`) is ENTITY-ANCHORED, so event-node
 * entities AND the WHY query are tagged/run against the ORACLE/SPEAKER gazetteer (LoCoMo people),
 * held CONSTANT across both arms — else the WHY read anchors nothing (the prod SCNS gaz won't match
 * "Caroline").
 *
 * GUARDS (absolute): the live vault `~/.scns/memory/vault.db` is NEVER opened (mtime asserted
 * unchanged at start+end); every built vault + ISO dir is `rmSync`'d (zero pollution); real spawns
 * are gated behind BOTH `SCNS_CONVERSATION_EVENTS=1` (extractor) AND `SCNS_DREAM_CAUSAL_ACP=1`
 * (causal judge) — a DRY run (either flag absent) spawns NOTHING, downloads NOTHING, builds NO vault,
 * and exits 0. Each spawn is deny-all + bounded + `close()`d in the seam + isolated `cwd=mktemp`.
 *
 * NOTE (deferred): the ANSWER-accuracy scoring (App C.2 generator → C.3 judge) is produced by
 * `locomo-judge-harness.ts`; `armA.text` / `armB.text` here are the EXACT retrieved-context inputs
 * that harness's generator consumes, so the two arms slot straight into the validated ruler.
 *
 * USAGE (the DEFERRED go-live run — a SEPARATE fresh context; NOT this TDD build phase):
 *   npm run build
 *   export SCNS_HOME=$(mktemp -d) SCNS_EMBED_WORKER_PATH=dist/memory/embedding-worker.js
 *   export SCNS_CONVERSATION_EVENTS=1 SCNS_DREAM_CAUSAL_ACP=1
 *   npx tsx scripts/locomo-event-arm.ts /tmp/locomo10.json
 */
import { rmSync, existsSync, statSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { retrieveContext, makeHybridBaseSearch } from '../src/memory/retrieval-context.js'
import { makeSemanticRelevanceScorer } from '../src/memory/semantic-relevance.js'
import { resetEmbeddingClient } from '../src/memory/embeddings.js'
import { ingestConversationEventNodes } from '../src/memory/conversation-segmenter.js'
import {
  createAcpConversationEventExtractor,
  isConversationEventExtractEnabled,
  CONVERSATION_EVENT_ACP_ENV,
} from '../src/memory/conversation-event-extractor-acp.js'
import { createAcpCausalProvider, CAUSAL_ACP_ENV } from '../src/memory/causal-runner.js'
import { listEventNodes } from '../src/memory/event-nodes.js'
import {
  LIVE_VAULT,
  DEFAULT_DATA,
  refuseIfLive,
  extractTurns,
  oracleGazetteer,
  buildVault,
  loadLocomoSamples,
  type LocomoSample,
  type Vault,
} from './locomo-corpus.js'

/** DEV slice size (conversations 1..DEV). Overridable via SCNS_EVENT_ARM_DEV. */
const DEV = Number(process.env['SCNS_EVENT_ARM_DEV'] ?? '2')
/** Model held CONSTANT across the extractor + causal judge (session model by default). */
const MODEL = process.env['SCNS_EVENT_ARM_MODEL'] || undefined

interface ArmResult {
  readonly text: string
  readonly intent: string
  readonly nResults: number
  readonly chars: number
}

async function retrieve(
  db: Vault['db'],
  query: string,
  intentRouting: boolean,
  gazetteer: ReturnType<typeof oracleGazetteer>,
): Promise<ArmResult> {
  const r = await retrieveContext(
    db,
    query,
    { intentRouting },
    {
      gazetteer,
      baseSearch: makeHybridBaseSearch(db),
      makeSemanticRelevanceScorer: (qq) => makeSemanticRelevanceScorer(db, qq),
    },
  )
  return { text: r.text, intent: r.intent, nResults: r.nResults, chars: r.text.length }
}

/** One conversation: build the vault, run both arms + the node-quality diagnostic. */
async function measureConversation(sample: LocomoSample, isoDir: string): Promise<unknown> {
  const turns = extractTurns(sample.conversation, 0)
  const gaz = oracleGazetteer(sample, turns) // ORACLE gaz, held constant across arms (B3.4)
  const vault = await buildVault(turns, gaz)
  // A WHY probe naming the conversation's primary speaker (entity-anchored read).
  const speaker = String((sample.conversation['speaker_a'] as string) || 'they').trim()
  const whyQuery = `Why did things change for ${speaker} over time?`

  try {
    const armA = await retrieve(vault.db, whyQuery, false, gaz)

    const extractor = createAcpConversationEventExtractor({
      cwd: mkIso(isoDir),
      ...(MODEL ? { model: MODEL } : {}),
    })
    const ingest = await ingestConversationEventNodes(vault.db, sample.conversation, {
      extractor,
      gazetteer: gaz,
      rebuildEdges: true,
      env: { [CAUSAL_ACP_ENV]: '1' },
      makeAcpProvider: () =>
        createAcpCausalProvider({ cwd: mkIso(isoDir), ...(MODEL ? { model: MODEL } : {}) }),
      minConfidence: 0.7,
    })
    const armB = await retrieve(vault.db, whyQuery, true, gaz)

    const rationales = listEventNodes(vault.db, 6).map((n) => n.content)
    return {
      sampleId: sample.sample_id,
      speaker,
      armA,
      armB,
      nodeQuality: {
        segmented: ingest.segmented,
        datedEpisodes: ingest.datedEpisodes,
        eventCausalCandidates: ingest.eventCausalCandidates, // decision→outcome (event-sourced)
        chunkCausalCandidates: ingest.chunkCausalCandidates, // turn-adjacency (chunk-pair)
        persisted: ingest.causal.persisted,
        materialized: ingest.causal.materialized,
        sampleEventNodes: rationales,
      },
    }
  } finally {
    rmSync(vault.root, { recursive: true, force: true })
  }
}

/** A fresh isolated deny-all session cwd under the run's ISO dir (never the checkout). */
function mkIso(base: string): string {
  return mkdtempSync(join(base, 'iso-'))
}

async function main(): Promise<void> {
  const dataPath = process.argv[2] || DEFAULT_DATA
  refuseIfLive(dataPath)

  // DEFAULT-OFF: a dry run (either gate absent) spawns nothing, downloads nothing, builds no vault.
  if (!isConversationEventExtractEnabled(process.env) || process.env[CAUSAL_ACP_ENV] !== '1') {
    console.log(
      `[locomo-event-arm] DRY RUN (default-OFF): set ${CONVERSATION_EVENT_ACP_ENV}=1 and ${CAUSAL_ACP_ENV}=1 ` +
        `(plus SCNS_HOME + SCNS_EMBED_WORKER_PATH) to run the real Arm A vs Arm B measurement. ` +
        `No spawn / no network / no vault built.`,
    )
    return
  }

  const liveMtimeStart = existsSync(LIVE_VAULT) ? statSync(LIVE_VAULT).mtimeMs : null
  const isoDir = mkdtempSync(join(tmpdir(), 'scns-event-arm-'))
  try {
    const samples = await loadLocomoSamples(dataPath, { maxConv: DEV })
    const out: unknown[] = []
    for (const s of samples) {
      out.push(await measureConversation(s, isoDir))
      resetEmbeddingClient()
    }
    console.log(JSON.stringify({ dev: DEV, model: MODEL ?? 'session-default', results: out }, null, 2))
  } finally {
    rmSync(isoDir, { recursive: true, force: true })
    const liveMtimeEnd = existsSync(LIVE_VAULT) ? statSync(LIVE_VAULT).mtimeMs : null
    if (liveMtimeStart !== liveMtimeEnd) {
      throw new Error(`LIVE VAULT MUTATED: mtime ${liveMtimeStart} → ${liveMtimeEnd} (must never change)`)
    }
  }
}

void main()
