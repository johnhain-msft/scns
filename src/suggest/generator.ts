// Suggestion generator — creates suggestions from detected observation patterns

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { readConfiguredLspServerIds } from './lsp-servers.js'
import { readConfiguredLintExtensions } from './linter-config.js'
import type { createConfidenceScorer } from './confidence.js'
import type { createEvidenceGatherer } from './evidence.js'
import type { createSuggestionStore } from './suggestion-store.js'
import type { Suggestion, Evidence, SuggestionType } from './types.js'
import type {
  DetectedPatterns,
  ToolFrequencyPattern,
  ProjectFocusPattern,
  WorkSchedulePattern,
} from '../observe/pattern-detector.js'
import type { ExtractedPatterns } from '../otel/pattern-extractor.js'
import type {
  PatternSources,
  OtelPatternData,
  ObservationPatternData,
  SuggestionCandidate,
} from './extractors/types.js'
import { extractPromptSuggestions } from './extractors/prompt-extractor.js'
import { extractExtensionSuggestions } from './extractors/extension-extractor.js'
import { extractLspSuggestions } from './extractors/lsp-extractor.js'
import { extractGithubActionSuggestions } from './extractors/github-action-extractor.js'
import { extractAgenticWorkflowSuggestions } from './extractors/agentic-workflow-extractor.js'
import { extractInstructionSuggestions } from './extractors/instruction-extractor.js'
import { extractSelfImprovementSuggestions } from './extractors/self-improvement-extractor.js'
import { extractTagProposals } from './extractors/tag-suggestion-extractor.js'
import { isFamilyDedupped } from './dedup-policy.js'
import { assignRole } from '../brain/classifier-utils.js'
import { RESEARCHER_ROLE } from '../shared/role-bridge.js'
import {
  selectMemoryDerivedSeeds,
  type MemorySeedReaders,
  type MemorySeedSelection,
} from './memory-self-improvement.js'
import { evaluateIdeationGate, type FamilyStat } from '../selfopt/ideation-gate.js'

type ExtractorFn = (sources: PatternSources) => readonly SuggestionCandidate[]

// ── Public interfaces ────────────────────────────────────────────────

export interface GeneratorOptions {
  readonly minimumConfidence?: number
  readonly maxSuggestionsPerCycle?: number
  /**
   * P8 (2026-06-03): time-windowed dedup. When undefined / 0 the
   * legacy lifetime dedup behavior is preserved. When set to a positive
   * N, terminal (archive/implemented/failed) suggestions older than N
   * days no longer block re-surfacing — active and rejected are still
   * respected forever. See {@link isFamilyDedupped} for the full policy.
   * Env: `SCNS_SUGGEST_DEDUP_WINDOW_DAYS`.
   */
  readonly dedupWindowDays?: number
  /**
   * Extensions the TARGET repo actually contains (see `collectRepoFileTypes`).
   *
   * `ProjectFocusPattern.fileTypeCounts` is a GLOBAL histogram — `pattern-detector.ts` folds every
   * file observation from every watched directory into one map — but the suggestions built from it
   * are dispatched against ONE working directory. Without this index, a dominant extension earned
   * in another project produces a confident suggestion to lint a language the target repo does not
   * contain ("Create py linting automation — File type '.py' changed 2753 times", aimed at a repo
   * with zero tracked `.py` files).
   *
   * Omitted or empty ⇒ no index available ⇒ no veto (prior behavior preserved).
   */
  readonly repoFileTypes?: ReadonlySet<string>
  /**
   * Route investigation suggestions to a first-class RESEARCHER team. A
   * suggestion whose title/description reads as investigation work (per the
   * brain classifier's {@link assignRole}) is emitted with
   * `suggestedRoles=[scns-researcher]` + `estimatedComplexity='team'`, so the
   * brain's suggestion→team path auto-forms a researcher (findings-only, judged
   * by the QG claim-evidence branch). This is the brain-auto invocation surface
   * for the on-demand researcher capability — ENABLED by default; pass `false`
   * only to suppress it (e.g. in a focused unit test).
   */
  readonly researchRoleEmission?: boolean
  /**
   * Base dir for Copilot CLI user-scope config, used to read which language servers are already
   * registered in `lsp-config.json` so the LSP extractor does not propose configured servers.
   * Defaults to `homedir()` — the same default `executeSuggestion` uses, so the file that is
   * CHECKED is always the file that would be WRITTEN. Overridable for tests.
   */
  readonly configBaseDir?: string
  /**
   * Working tree consulted to see which extensions ALREADY have a linter configured, so the
   * automation lever does not propose linting a language the repo is provably already linting.
   * Defaults to `process.cwd()` — the same default `executeSuggestion` gives `repoRoot`, so the
   * tree that is CHECKED is the tree an approval would be acted on. Overridable for tests.
   */
  readonly repoDir?: string
}

export interface GeneratorDeps {
  readonly scorer: ReturnType<typeof createConfidenceScorer>
  readonly evidenceGatherer: ReturnType<typeof createEvidenceGatherer>
  readonly store: ReturnType<typeof createSuggestionStore>
  /** Phase 13.12.12: lesson corpus source for the tag-suggestion extractor. */
  readonly lessonStore?: {
    readonly listAll: () => ReadonlyArray<import('../memory/lessons.js').Lesson>
  }
  /** Phase 13.12.12: tag-rejection log source. */
  readonly tagRejectionStore?: {
    readonly signatures: () => Set<string>
  }
  /** Phase 13.12.12: taxonomy registry source. */
  readonly taxonomyStore?: {
    readonly load: () => { tags: ReadonlyArray<{ name: string }> }
  }
  /**
   * D2a (design-m1.md §6): memory-derived self-improvement ideation source. When
   * `enabled`, the self-improvement proposals are SELECTED from the live memory
   * graph + outcome history (`readers`) instead of the static seed menu. Absent or
   * `enabled:false` ⇒ byte-identical to the static path. Env opt-in lives at the
   * call site (cli.ts reads `SCNS_IDEATE_MEMORY`).
   */
  readonly selfImprovementMemory?: {
    readonly enabled: boolean
    readonly readers: MemorySeedReaders
    /**
     * D2 outcome-gate (default-OFF). When `enforce`, the memory-derived selection is
     * downgraded back to the static menu if its expected landing rate regresses below
     * the static baseline given `familyStats`. See {@link evaluateIdeationGate}.
     */
    readonly gate?: {
      readonly enforce: boolean
      readonly familyStats: () => ReadonlyMap<string, FamilyStat>
    }
    /**
     * D2 retrieval signal sink ("use it or lose it", SIBLING milestone). Invoked once
     * per entity actually surfaced by a memory-derived read, so the maintenance phase
     * can decay entities ideation never retrieves. Optional + best-effort.
     */
    readonly onAccess?: (entity: string) => void
  }
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_MINIMUM_CONFIDENCE = 0.4
const DEFAULT_MAX_PER_CYCLE = 5
const MINIMUM_APP_COUNT = 20
// Phase 13.12.25: 120 was too sensitive (any 2h+ average fired
// "Add session rotation at 124 minutes" as low-value noise). Require a
// genuinely long-running pattern (>4h avg) before the rotation suggestion.
const LONG_SESSION_THRESHOLD = 240

/**
 * Phase 13.12.25: only emit "Create X linting automation" when the dominant
 * file type is a real source-code extension. Non-source artifacts (images,
 * logs, build caches, lockfiles) were producing pure noise
 * ("Create png linting automation", "Create tsbuildinfo linting automation").
 */
const LINTABLE_SOURCE_EXTS = new Set<string>([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'pyw',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'cs',
  'swift',
  'php',
  'lua',
  'sh',
  'bash',
  'zsh',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'yaml',
  'json',
  'toml',
  'html',
  'css',
  'scss',
  'sql',
])

/**
 * Phase 13.12.25: advisory (`actionable:false`) suggestions strictly below
 * this confidence floor are suppressed — the dashboard was accumulating
 * low-value workflow hints ("Add session rotation at 124 minutes" at 0.70).
 */
const ADVISORY_MIN_CONFIDENCE = 0.7

const IDE_APPS = new Set([
  'VSCode',
  'Cursor',
  'Xcode',
  'IntelliJ',
  'WebStorm',
  'Sublime Text',
  'Atom',
  'Neovim',
])
const TERMINAL_APPS = new Set(['Terminal', 'iTerm', 'iTerm2', 'Warp', 'Alacritty'])
const DB_CLIENTS = new Set([
  'TablePlus',
  'DBeaver',
  'pgAdmin',
  'DataGrip',
  'Sequel Pro',
  'MongoDB Compass',
])
const CLOUD_CONSOLES = new Set(['AWS Console', 'GCP Console', 'Azure Portal'])

// ── Helpers ──────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString()
}

function makeSuggestion(
  type: SuggestionType,
  title: string,
  description: string,
  confidence: number,
  evidence: readonly Evidence[],
  tags: readonly string[],
  actionable: boolean,
  estimatedComplexity: 'solo' | 'team' | 'complex',
  suggestedRoles?: readonly string[],
): Suggestion {
  const ts = now()
  return {
    id: randomUUID(),
    type,
    title,
    description,
    status: 'pending',
    confidence,
    evidence: [...evidence],
    tags: [...tags],
    createdAt: ts,
    updatedAt: ts,
    actionable,
    estimatedComplexity,
    // Only attach when provided so default (OFF) output stays byte-identical.
    ...(suggestedRoles ? { suggestedRoles: [...suggestedRoles] } : {}),
    attemptCount: 0,
    lastError: null,
    lastAttemptAt: null,
    nextRetryAt: null,
    allowRepoWrites: false,
    inflightTeamId: null,
  }
}

/**
 * Phase 13.2 / P8: collapse time-like suffixes so "Schedule heavy tasks for 22:00"
 * and "Schedule heavy tasks for 3:00" share a template family. Logic now lives
 * in ./dedup-policy.ts (templateFamily export) — this local definition is kept
 * for backwards-compat with any external consumers that may have imported it
 * via internal reference.
 *
 * Rules:
 * - HH:MM patterns → `<time>`
 * - standalone integer runs → `<n>`
 * - case-insensitive, whitespace-normalized
 */
function templateFamily(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b\d{1,2}:\d{2}\b/g, '<time>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

// Reference templateFamily here to silence "unused" — it's intentionally
// kept as a private export shim for any future re-introduction of an
// inline policy override that bypasses dedup-policy.ts.
void templateFamily

/**
 * Phase 13.2: map suggestion type → (actionable, estimatedComplexity) defaults.
 * Workflow (scheduling/rotation/breaks) is advisory; everything else concrete.
 */
function actionableShape(type: SuggestionType): {
  actionable: boolean
  estimatedComplexity: 'solo' | 'team' | 'complex'
} {
  switch (type) {
    case 'workflow':
      return { actionable: false, estimatedComplexity: 'solo' }
    case 'agentic-workflow':
    case 'agent':
      return { actionable: true, estimatedComplexity: 'team' }
    default:
      return { actionable: true, estimatedComplexity: 'solo' }
  }
}

function titleMatchesRejected(title: string, rejectedTitles: readonly string[]): boolean {
  const titleLower = title.toLowerCase()
  return rejectedTitles.some((r) => r.toLowerCase() === titleLower)
}

function getAllExtractors(): readonly ExtractorFn[] {
  return [
    extractPromptSuggestions,
    extractExtensionSuggestions,
    extractLspSuggestions,
    extractGithubActionSuggestions,
    extractAgenticWorkflowSuggestions,
    extractInstructionSuggestions,
    // NOTE: self-improvement is handled by the dedicated `generateSelfImprovement`
    // path (D2a) so it can branch static-vs-memory-derived without double-emitting.
  ]
}

function toOtelPatternData(extracted: ExtractedPatterns): OtelPatternData {
  const fromMs = new Date(extracted.analyzedFrom).getTime()
  const toMs = new Date(extracted.analyzedTo).getTime()
  const analyzedDays = Math.max(1, Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)))

  return {
    topTools: extracted.tools.topTools.map((t) => ({
      tool: t.tool,
      totalUses: t.totalUses,
      avgDurationMs: t.avgDurationMs,
    })),
    mcpServers: [...extracted.tools.mcpServers],
    skills: [...extracted.tools.skills],
    models: extracted.models.models.map((m) => ({
      model: m.model,
      totalCalls: m.totalCalls,
      sessionCount: m.sessionCount,
    })),
    totalSessions: extracted.totalSessions,
    analyzedDays,
  }
}

function toObservationData(detected: DetectedPatterns): ObservationPatternData | undefined {
  if (detected.toolFrequency == null && detected.projectFocus == null) {
    return undefined
  }

  // Normalize fileTypeCounts keys to dotted format (e.g., 'ts' → '.ts')
  // Pattern detector strips dots from extensions; extractors expect dotted keys.
  const rawCounts = detected.projectFocus?.fileTypeCounts ?? new Map()
  const normalizedCounts = new Map<string, number>()
  for (const [key, count] of rawCounts) {
    const normalizedKey = key.startsWith('.') ? key : `.${key}`
    normalizedCounts.set(normalizedKey, (normalizedCounts.get(normalizedKey) ?? 0) + count)
  }

  return {
    topApps: detected.toolFrequency?.topApps ?? [],
    appCounts: detected.toolFrequency?.appCounts ?? new Map(),
    topRepos: detected.projectFocus?.topRepos ?? [],
    repoCounts: detected.projectFocus?.repoCounts ?? new Map(),
    fileTypeCounts: normalizedCounts,
    recentFocus: detected.projectFocus?.recentFocus ?? null,
    repoActivityCounts: detected.projectFocus?.repoActivityCounts ?? new Map(),
  }
}

// ── Factory ──────────────────────────────────────────────────────────

export function createSuggestionGenerator(deps: GeneratorDeps, options?: GeneratorOptions) {
  const { scorer, evidenceGatherer, store, lessonStore, tagRejectionStore, taxonomyStore } = deps
  const selfImprovementMemory = deps.selfImprovementMemory
  const minConfidence = options?.minimumConfidence ?? DEFAULT_MINIMUM_CONFIDENCE
  const maxPerCycle = options?.maxSuggestionsPerCycle ?? DEFAULT_MAX_PER_CYCLE
  const dedupWindowDays = options?.dedupWindowDays ?? 0
  const researchRoleEmission = options?.researchRoleEmission ?? true
  const repoDir = options?.repoDir ?? process.cwd()
  const repoFileTypes = options?.repoFileTypes

  /**
   * Does the target repo actually contain this file type?
   *
   * Fails OPEN: with no index (absent or empty — e.g. the generator ran outside a git repo)
   * there is no evidence of absence, so emission proceeds as it did before this gate existed.
   */
  function repoContainsFileType(ext: string): boolean {
    if (repoFileTypes === undefined || repoFileTypes.size === 0) return true
    return repoFileTypes.has(ext)
  }

  function shouldSkip(title: string, type: SuggestionType): boolean {
    if (store.findSimilar(title, type) != null) return true
    if (titleMatchesRejected(title, store.getRejectedTitles())) return true
    // Phase 13.2 + P8: dedup by template family using the windowed
    // policy. dedupWindowDays=0 preserves legacy lifetime behavior;
    // positive N lets old terminal suggestions re-surface.
    return isFamilyDedupped({
      title,
      type,
      stored: store.list(),
      nowMs: Date.now(),
      dedupWindowDays,
    })
  }

  function tryEmit(
    type: SuggestionType,
    title: string,
    description: string,
    observationCount: number,
    windowDays: number,
    evidence: readonly Evidence[],
    tags: readonly string[],
    results: Suggestion[],
  ): void {
    if (shouldSkip(title, type)) return

    const scores = scorer.score({
      type,
      observationCount,
      windowDays,
    })

    if (scores.composite < minConfidence) return

    const { actionable, estimatedComplexity } = actionableShape(type)

    // Phase 13.12.25: noise floor for advisory suggestions. Below 0.75 and
    // non-actionable, the signal is weak enough that persisting it just
    // pollutes the dashboard.
    if (!actionable && scores.composite < ADVISORY_MIN_CONFIDENCE) return

    // Brain-auto researcher surface (ENABLED): route investigation suggestions
    // to a first-class RESEARCHER team. Reuses the brain classifier's assignRole
    // (single source of truth for the researcher regex) rather than a duplicate
    // classifier. A 'team' hint + a non-empty role is required for the brain's
    // suggestion→team path to spawn a researcher (agent-loop wantsTeam); the
    // canonical broker role resolves to buildResearcherPrompt + the QG
    // claim-evidence branch via the role bridge.
    let effectiveComplexity = estimatedComplexity
    let effectiveActionable = actionable
    let suggestedRoles: readonly string[] | undefined
    if (researchRoleEmission && assignRole(`${title} ${description}`) === 'researcher') {
      effectiveComplexity = 'team'
      suggestedRoles = [RESEARCHER_ROLE]
      // Investigation work is actionable (it spawns a researcher), even if the
      // source type's default shape was advisory.
      effectiveActionable = true
    }

    const suggestion = makeSuggestion(
      type,
      title,
      description,
      scores.composite,
      evidence,
      tags,
      effectiveActionable,
      effectiveComplexity,
      suggestedRoles,
    )
    store.save(suggestion)
    results.push(suggestion)
  }

  function generateSkillSuggestions(
    toolFrequency: ToolFrequencyPattern,
    windowDays: number,
  ): readonly Suggestion[] {
    const results: Suggestion[] = []

    for (const app of toolFrequency.topApps) {
      const count = toolFrequency.appCounts.get(app) ?? 0
      if (count <= MINIMUM_APP_COUNT) continue

      const isIde = IDE_APPS.has(app)
      const isTerminal = TERMINAL_APPS.has(app)

      let title: string
      let description: string

      if (isIde) {
        title = `Create ${app} workflow skill`
        description = `You use ${app} frequently (${count} times in ${windowDays} days). A workflow skill could automate common IDE patterns.`
      } else if (isTerminal) {
        title = `Create ${app} helper skill`
        description = `You use ${app} frequently (${count} times in ${windowDays} days). A helper skill could wrap common CLI patterns.`
      } else {
        title = `Create ${app} helper skill`
        description = `You use ${app} frequently (${count} times in ${windowDays} days). A helper skill could automate common patterns.`
      }

      const evidence = evidenceGatherer.gatherToolEvidence(toolFrequency)
      tryEmit(
        'skill',
        title,
        description,
        count,
        windowDays,
        evidence,
        ['skill', app.toLowerCase()],
        results,
      )
    }

    return results
  }

  function generateMcpSuggestions(
    toolFrequency: ToolFrequencyPattern,
    windowDays: number,
  ): readonly Suggestion[] {
    const results: Suggestion[] = []

    for (const app of toolFrequency.topApps) {
      const count = toolFrequency.appCounts.get(app) ?? 0
      if (count <= MINIMUM_APP_COUNT) continue

      const isDb = DB_CLIENTS.has(app)
      const isCloud = CLOUD_CONSOLES.has(app)

      let title: string
      let description: string

      if (isDb) {
        title = `Install ${app} MCP server`
        description = `You use ${app} frequently (${count} times in ${windowDays} days). An MCP server could provide database access directly in your workflow.`
      } else if (isCloud) {
        title = `Install ${app} MCP server`
        description = `You use ${app} frequently (${count} times in ${windowDays} days). An MCP server could provide cloud resource access directly in your workflow.`
      } else {
        title = `Install ${app} MCP integration`
        description = `You use ${app} frequently (${count} times in ${windowDays} days). An MCP integration could streamline your workflow.`
      }

      const evidence = evidenceGatherer.gatherToolEvidence(toolFrequency)
      tryEmit(
        'mcp',
        title,
        description,
        count,
        windowDays,
        evidence,
        ['mcp', app.toLowerCase()],
        results,
      )
    }

    return results
  }

  function generateAutomationSuggestions(
    projectFocus: ProjectFocusPattern,
    windowDays: number,
  ): readonly Suggestion[] {
    const results: Suggestion[] = []

    // High-commit repos → build/deploy automation
    for (const repo of projectFocus.topRepos) {
      const count = projectFocus.repoCounts.get(repo) ?? 0
      if (count <= 0) continue

      const title = `Create build/deploy automation for ${repo}`
      const description = `Repo '${repo}' had ${count} commits in ${windowDays} days. Automating build/deploy could save time.`
      const evidence = evidenceGatherer.gatherProjectEvidence(projectFocus)
      tryEmit(
        'automation',
        title,
        description,
        count,
        windowDays,
        evidence,
        ['automation', repo],
        results,
      )
    }

    // Dominant file type → linting automation
    const topFileType = [...projectFocus.fileTypeCounts.entries()].sort((a, b) => b[1] - a[1])[0]
    if (topFileType && topFileType[1] > 0) {
      const [rawExt, count] = topFileType
      // File type keys may be stored with or without a leading dot (the
      // generator normalizes to dotted form). Strip for the lookup.
      const ext = rawExt.replace(/^\.+/, '').toLowerCase()
      // Phase 13.12.25: only emit for real source-code extensions.
      // 2026-09-21: and only when the repo is not ALREADY linting that extension. Read per call
      // rather than per generator so a linter added between cycles takes effect immediately.
      // Presence gate (2026-09-28): `fileTypeCounts` is global across every watched directory,
      // but this suggestion targets one repo. Require the dominant type to exist HERE before
      // proposing work on it — a dominant extension earned in another watched project must not
      // aim a lint automation at a repo with zero files of that language. Deliberately no
      // fallback to the next-ranked type: the description's "changed N times" belongs to the
      // dominant type, so promoting a runner-up would attach a true count to the wrong claim.
      if (
        LINTABLE_SOURCE_EXTS.has(ext) &&
        repoContainsFileType(ext) &&
        !readConfiguredLintExtensions(repoDir).has(ext)
      ) {
        const title = `Create ${ext} linting automation`
        const description = `File type '.${ext}' changed ${count} times. A linting automation could enforce standards.`
        const evidence = evidenceGatherer.gatherProjectEvidence(projectFocus)
        tryEmit(
          'automation',
          title,
          description,
          count,
          windowDays,
          evidence,
          ['automation', 'lint', ext],
          results,
        )
      }
    }

    // Recent focus → workflow suggestion
    if (projectFocus.recentFocus != null) {
      const title = `Create workflow for ${projectFocus.recentFocus}`
      const description = `You're currently focused on ${projectFocus.recentFocus}. A dedicated workflow could help organize tasks.`
      const evidence = evidenceGatherer.gatherProjectEvidence(projectFocus)
      const count = projectFocus.repoCounts.get(projectFocus.recentFocus) ?? 1
      tryEmit(
        'automation',
        title,
        description,
        count,
        windowDays,
        evidence,
        ['automation', 'workflow', projectFocus.recentFocus],
        results,
      )
    }

    return results
  }

  function generateWorkflowSuggestions(
    workSchedule: WorkSchedulePattern,
    windowDays: number,
  ): readonly Suggestion[] {
    const results: Suggestion[] = []
    const evidence = evidenceGatherer.gatherScheduleEvidence(workSchedule)
    const obsCount = workSchedule.activeHours.length * windowDays

    // Peak hour → scheduling suggestion
    {
      const title = `Schedule heavy tasks for ${workSchedule.peakHour}:00`
      const description = `Your peak productivity is at ${workSchedule.peakHour}:00. Scheduling demanding work at this time could boost output.`
      tryEmit(
        'workflow',
        title,
        description,
        obsCount,
        windowDays,
        evidence,
        ['workflow', 'scheduling'],
        results,
      )
    }

    // Long sessions → rotation suggestion
    if (workSchedule.averageSessionMinutes > LONG_SESSION_THRESHOLD) {
      const title = `Add session rotation at ${workSchedule.averageSessionMinutes} minutes`
      const description = `Your average session is ${workSchedule.averageSessionMinutes} minutes. Session rotation could help maintain focus.`
      tryEmit(
        'workflow',
        title,
        description,
        obsCount,
        windowDays,
        evidence,
        ['workflow', 'rotation'],
        results,
      )
    }

    // Regular breaks → reminder suggestion
    if (workSchedule.breakGaps.length > 0) {
      const title = 'Configure break reminders'
      const description = `You take regular breaks (${workSchedule.breakGaps.length} detected). Configuring reminders could make them more consistent.`
      tryEmit(
        'workflow',
        title,
        description,
        obsCount,
        windowDays,
        evidence,
        ['workflow', 'breaks'],
        results,
      )
    }

    return results
  }

  function generateTagProposals(): readonly Suggestion[] {
    const results: Suggestion[] = []
    if (!lessonStore) return results
    const lessons = lessonStore.listAll()
    if (lessons.length === 0) return results
    const knownTags = new Set<string>()
    if (taxonomyStore) {
      for (const t of taxonomyStore.load().tags) knownTags.add(t.name.toLowerCase())
    }
    for (const l of lessons) {
      for (const t of l.frontmatter.tags) knownTags.add(t.toLowerCase())
    }
    const rejected = tagRejectionStore ? tagRejectionStore.signatures() : new Set<string>()
    const candidates = extractTagProposals(lessons, {
      knownTags,
      rejectedSignatures: rejected,
    })
    const ts = now()
    for (const c of candidates) {
      const title = `Tag ${c.candidateLessonIds.length} lessons as "${c.tagName}"`
      // Dedup: skip if a tag-proposal with the same signature is already
      // in the store (pending/approved/etc.) — compare payload rather than
      // title (which uses a shared template family).
      let duplicate = false
      for (const existing of store.list()) {
        if (existing.type !== 'tag-proposal' || !existing.tagProposal) continue
        const sigExisting = `${existing.tagProposal.tagName.toLowerCase()}::${[...existing.tagProposal.candidateLessonIds].sort().join(',')}`
        const sigNew = `${c.tagName.toLowerCase()}::${[...c.candidateLessonIds].sort().join(',')}`
        if (sigExisting === sigNew) {
          duplicate = true
          break
        }
      }
      if (duplicate) continue
      const suggestion: Suggestion = {
        id: randomUUID(),
        type: 'tag-proposal',
        title,
        description: c.rationale,
        status: 'pending',
        confidence: Math.min(1, 0.5 + c.strength),
        evidence: c.candidateLessonIds.map((id) => ({
          source: 'lesson',
          detail: id,
          observedAt: ts,
          weight: 1 / Math.max(1, c.candidateLessonIds.length),
        })),
        tags: ['tag-proposal', c.tagName],
        createdAt: ts,
        updatedAt: ts,
        actionable: true,
        estimatedComplexity: 'solo',
        attemptCount: 0,
        lastError: null,
        lastAttemptAt: null,
        nextRetryAt: null,
        allowRepoWrites: false,
        inflightTeamId: null,
        tagProposal: {
          tagName: c.tagName,
          scope: c.scope,
          ...(c.project ? { project: c.project } : {}),
          ...(c.agent ? { agent: c.agent } : {}),
          candidateLessonIds: [...c.candidateLessonIds],
          rationale: c.rationale,
        },
      }
      store.save(suggestion)
      results.push(suggestion)
    }
    return results
  }

  function generate(patterns: DetectedPatterns): readonly Suggestion[] {
    return generateFromAllSources(patterns)
  }

  /** Convert a memory-derived selection into a self-improvement candidate. */
  function toMemoryCandidate(sel: MemorySeedSelection): SuggestionCandidate {
    const ts = now()
    return {
      type: 'agentic-workflow',
      title: sel.seed.title,
      description: sel.seed.description,
      evidence: [
        {
          source: 'memory-graph',
          detail:
            `entity '${sel.entity}' is active in memory (${sel.activity} neighborhood chunks); ` +
            `family '${sel.family}' has ${sel.landed} landed / ${sel.failed} failed prior outcomes — ` +
            `prioritised by D2a from the live graph`,
          observedAt: ts,
          weight: Math.min(1, sel.activity / 20),
        },
      ],
      tags: ['self-improvement', 'scns-self-improvement', sel.entity, sel.family],
      observationCount: sel.activity,
      windowDays: 7,
    }
  }

  /**
   * D2a: self-improvement proposals. The hardcoded extractor encodes the SCNS-active
   * trigger (empty ⇒ SCNS not under active development ⇒ nothing). When the memory
   * source is enabled AND the live graph yields selections, those memory-derived
   * proposals REPLACE the static menu (no double-emit); a cold graph falls back to
   * the static seeds. Disabled/absent ⇒ exactly the static path.
   */
  function generateSelfImprovement(sources: PatternSources): readonly Suggestion[] {
    const results: Suggestion[] = []
    const hardcoded = extractSelfImprovementSuggestions(sources)
    if (hardcoded.length === 0) return results // SCNS not active — same as today

    let candidates: readonly SuggestionCandidate[] = hardcoded
    if (selfImprovementMemory?.enabled) {
      const selections = selectMemoryDerivedSeeds(selfImprovementMemory.readers)
      if (selections.length > 0) {
        // D2 outcome-gate (default-OFF): only keep the memory-derived path if its
        // expected landing rate does not regress below the static menu's baseline.
        const gate = selfImprovementMemory.gate
        let useMemory = true
        if (gate?.enforce) {
          const verdict = evaluateIdeationGate({
            baselineFamilies: hardcoded.map((c) => c.tags[c.tags.length - 1] ?? ''),
            candidateFamilies: selections.map((s) => s.family),
            familyStats: gate.familyStats(),
          })
          if (verdict.regressed) useMemory = false
        }
        if (useMemory) {
          candidates = selections.map(toMemoryCandidate)
          // D2 retrieval signal: record that ideation actually surfaced these entities.
          if (selfImprovementMemory.onAccess) {
            for (const sel of selections) {
              try {
                selfImprovementMemory.onAccess(sel.entity)
              } catch {
                /* best-effort signal — never break ideation */
              }
            }
          }
        }
      }
      // selections empty (cold graph) ⇒ keep the static fallback already in `candidates`
    }

    for (const c of candidates) {
      tryEmit(
        c.type,
        c.title,
        c.description,
        c.observationCount,
        c.windowDays,
        c.evidence,
        c.tags,
        results,
      )
    }
    return results
  }

  function generateFromAllSources(
    patterns: DetectedPatterns,
    otelPatterns?: ExtractedPatterns,
  ): readonly Suggestion[] {
    const all: Suggestion[] = []
    const windowMs =
      new Date(patterns.windowEnd).getTime() - new Date(patterns.windowStart).getTime()
    const windowDays = Math.max(1, Math.round(windowMs / (24 * 60 * 60 * 1000)))

    // Existing observation-based generators
    if (patterns.toolFrequency != null) {
      all.push(...generateSkillSuggestions(patterns.toolFrequency, windowDays))
      all.push(...generateMcpSuggestions(patterns.toolFrequency, windowDays))
    }

    if (patterns.projectFocus != null) {
      all.push(...generateAutomationSuggestions(patterns.projectFocus, windowDays))
    }

    if (patterns.workSchedule != null) {
      all.push(...generateWorkflowSuggestions(patterns.workSchedule, windowDays))
    }

    // New extractor-based generators
    const sources: PatternSources = {
      otel: otelPatterns != null ? toOtelPatternData(otelPatterns) : undefined,
      observations: toObservationData(patterns),
      configuredLspServers: [...readConfiguredLspServerIds(options?.configBaseDir ?? homedir())],
      // Scope the global file-type histogram to this repo: extractors that pick work by
      // dominant extension (LSP) would otherwise target a language earned elsewhere.
      ...(repoFileTypes ? { repoFileTypes } : {}),
    }

    for (const extractor of getAllExtractors()) {
      const candidates = extractor(sources)
      for (const candidate of candidates) {
        tryEmit(
          candidate.type,
          candidate.title,
          candidate.description,
          candidate.observationCount,
          candidate.windowDays,
          candidate.evidence,
          candidate.tags,
          all,
        )
      }
    }

    // D2a: self-improvement (memory-derived when enabled, else the static seed menu).
    all.push(...generateSelfImprovement(sources))

    // Phase 13.12.12: tag proposals run on the lesson corpus rather than
    // OTel/observation patterns, so they go through a dedicated path.
    try {
      all.push(...generateTagProposals())
    } catch {
      /* extractor failure must not break the rest of the generator */
    }

    return all.slice(0, maxPerCycle)
  }

  return {
    generate,
    generateFromAllSources,
    generateSkillSuggestions,
    generateAutomationSuggestions,
    generateWorkflowSuggestions,
    generateMcpSuggestions,
    generateTagProposals,
    generateSelfImprovement,
  }
}
