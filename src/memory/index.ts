// Memory Vault + Hybrid Search — Phase 1
export { openMemoryDb, closeMemoryDb, EMBEDDING_DIMENSIONS } from './db.js'
export {
  createVault,
  type Vault,
  type VaultConfig,
  type VaultFile,
  type CoreFileName,
} from './vault.js'
export { chunkText, estimateTokens, type Chunk, type ChunkConfig } from './chunker.js'
export {
  generateEmbedding,
  generateEmbeddingsBatch,
  serializeEmbedding,
  deserializeEmbedding,
  resetEmbeddingClient,
  type EmbeddingResult,
} from './embeddings.js'
export {
  indexVault,
  indexVaultSync,
  backfillEmbeddings,
  backfillFactNodes,
  countFactBackfillEligible,
  pruneOrphanedEmbeddings,
  type IndexStats,
  type EntityIndexOptions,
  type FactBackfillOptions,
  type FactBackfillStats,
} from './indexer.js'
export {
  hybridSearch,
  keywordSearch,
  keywordOnlySearch,
  escapeFts5Query,
  type SearchConfig,
  type SearchResult,
} from './search.js'
export {
  SCNS_GAZETTEER,
  matchEntities,
  canonicalize,
  type GazetteerEntry,
  type EntityKind,
  type EntityMatch,
} from './entities/gazetteer.js'
export { rebuildMemoryEdges, type EdgeRebuildStats } from './entities/edges.js'
export {
  buildSemanticEdges,
  DEFAULT_SEMANTIC_TOP_N,
  DEFAULT_SEMANTIC_MAX_DISTANCE,
  type SemanticEdgeOptions,
  type SemanticEdgeStats,
} from './semantic-edges.js'
export {
  semanticNeighborhood,
  type SemanticNeighbor,
  type SemanticNeighborOptions,
} from './semantic-neighborhood.js'
export {
  entityNeighborhood,
  type NeighborhoodChunk,
  type NeighborhoodOptions,
} from './entities/neighborhood.js'
export {
  causalNeighborhood,
  formatCausalChain,
  type CausalChain,
  type CausalNeighborhoodOptions,
} from './causal-neighborhood.js'
export { classifyIntent, type QueryIntent } from './intent.js'
export {
  intentAwareSearch,
  parseFusionWeights,
  type BaseSearch,
  type IntentSearchOptions,
  type FusionWeights,
} from './intent-search.js'
export {
  reciprocalRankFusion,
  fusedResultsToSearchResults,
  DEFAULT_RRF_K,
  type RankedItem,
  type FusionSource,
  type FusionOptions,
  type FusedResult,
} from './fusion.js'
export {
  cosineSimilarity,
  scoreSemanticRelevance,
  makeSemanticRelevanceScorer,
  type SemanticRelevanceScorer,
} from './semantic-relevance.js'
export {
  temporalTimeline,
  type TimelineOptions,
  type TimelineBaseSearch,
} from './temporal-timeline.js'
export {
  retrieveContext,
  formatRetrievedContext,
  makeHybridBaseSearch,
  RETRIEVED_CONTEXT_HEADER,
  DEFAULT_RETRIEVAL_TOPK,
  DEFAULT_RETRIEVAL_MAX_CHARS,
  type RetrievalContextConfig,
  type RetrievalContextDeps,
  type RetrievedContext,
} from './retrieval-context.js'
export {
  multiHopIterativeSearch,
  bridgeEntityFollowups,
  DEFAULT_MULTIHOP_MAX_ROUNDS,
  DEFAULT_MULTIHOP_MAX_FOLLOWUPS,
  DEFAULT_MULTIHOP_ROUND_DECAY,
  type MultiHopOptions,
  type FollowupProposer,
} from './multihop-iterative.js'
export {
  routeQueryArm,
  shouldSkipRetrieval,
  ROUTER_ARMS,
  DEFAULT_ROUTER_LAMBDA,
  ROUTER_DEEP_LAMBDA_CUTOFF,
  type RouterArm,
  type RouteDecision,
  type QueryRouteFeatures,
} from './arm-router.js'
export {
  HUMAN_OUTCOME_GRADIENT,
  humanOutcomeOfVerdict,
  humanOutcomeOfCue,
  settleHumanOutcomeForAttempt,
  settleHumanOutcomeForEntity,
  type ImplicitCue,
  type SettleForEntityOptions,
} from './human-outcome.js'
export {
  commitRoutingPolicy,
  readCommittedRoutingPolicy,
  type RoutingPolicyCommit,
  type RoutingPolicyEvidence,
  type CommitResult,
} from './routing-policy.js'
export {
  reinforceEdgesForPath,
  decayEdgeWeightsTowardNeutral,
  applyExperienceReinforcement,
  DEFAULT_REINFORCE_ETA,
  DEFAULT_WEIGHT_MIN,
  DEFAULT_WEIGHT_MAX,
  DEFAULT_DECAY_RATE,
  type ReinforcePathOptions,
  type ReinforceResult,
  type ApplyReinforcementResult,
} from './edge-reinforcement.js'
export {
  openExperienceStore,
  logRetrievalExperience,
  settleRetrievalExperience,
  settleHumanOutcome,
  logFullContextBaseline,
  projectToArmFrontierRow,
  retrieverFamilyOf,
  countExplorations24h,
  type ExperienceStore,
  type RetrievalLevers,
  type EpisodeContext,
  type RetrievalExperienceInput,
  type RetrievalOutcome,
  type FullContextBaselineInput,
  type ArmFrontierRowProjection,
  type RetrievalExperienceRow,
} from './experience-store.js'
export {
  NULL_CAUSAL_PROVIDER,
  isNullCausalProvider,
  buildCausalUserPrompt,
  parseCausalResponse,
  CAUSAL_SYSTEM_PROMPT,
  type CausalProvider,
  type CausalCandidate,
  type CausalEdge,
  type CausalInferRequest,
} from './causal-provider.js'
export {
  causalKey,
  isCuratedTierPath,
  buildCausalCandidates,
  persistCausalEdges,
  type PersistCausalStats,
  type PersistCausalOptions,
} from './causal-edges.js'
export {
  buildOutcomeCausalCandidates,
  type OutcomeCandidatesOptions,
} from './outcome-causal-candidates.js'
export {
  runCausalEdgeInference,
  createAcpCausalProvider,
  CAUSAL_ACP_ENV,
  type CausalRunDeps,
  type CausalRunResult,
} from './causal-runner.js'
