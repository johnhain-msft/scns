import type { Evidence, SuggestionType } from '../types.js'

/** A suggestion candidate before confidence scoring */
export interface SuggestionCandidate {
  readonly type: SuggestionType
  readonly title: string
  readonly description: string
  readonly evidence: readonly Evidence[]
  readonly tags: readonly string[]
  readonly observationCount: number
  readonly windowDays: number
}

/** Combined pattern sources for extractors */
export interface PatternSources {
  readonly otel?: OtelPatternData
  readonly observations?: ObservationPatternData
  /**
   * Language-server ids already registered in Copilot CLI's `lsp-config.json`, so the LSP
   * extractor does not propose work that is already done. Carried here rather than read inside
   * the extractor to keep extractors pure functions of their inputs; the generator supplies it.
   * Absent ⇒ nothing known to be configured (fail-open).
   */
  readonly configuredLspServers?: readonly string[]
  /**
   * Extensions (UNDOTTED, e.g. `ts`) the TARGET repo actually contains — see
   * `collectRepoFileTypes`.
   *
   * `ObservationPatternData.fileTypeCounts` is a GLOBAL histogram folded across every watched
   * directory, but the candidates extractors build from it are dispatched against ONE working
   * directory. This index is the missing repo scope. Omitted or empty ⇒ no index available ⇒
   * no veto, preserving prior behavior.
   */
  readonly repoFileTypes?: ReadonlySet<string>
}

export interface OtelPatternData {
  readonly topTools: ReadonlyArray<{
    tool: string
    totalUses: number
    avgDurationMs: number | null
  }>
  readonly mcpServers: ReadonlyArray<{
    server: string
    sessionCount: number
  }>
  readonly skills: ReadonlyArray<{
    skill: string
    sessionCount: number
  }>
  readonly models: ReadonlyArray<{
    model: string
    totalCalls: number
    sessionCount: number
  }>
  readonly totalSessions: number
  readonly analyzedDays: number
}

export interface ObservationPatternData {
  readonly topApps: readonly string[]
  readonly appCounts: ReadonlyMap<string, number>
  readonly topRepos: readonly string[]
  readonly repoCounts: ReadonlyMap<string, number>
  readonly fileTypeCounts: ReadonlyMap<string, number>
  readonly recentFocus: string | null
  /**
   * Per-repo development-activity counts (basename-keyed): git commits PLUS
   * file-change events. Broader than `repoCounts` (git-only) so consumers can
   * detect a repo under active development even during a commit freeze. Optional
   * for backward compatibility; absent ⇒ fall back to `repoCounts`.
   */
  readonly repoActivityCounts?: ReadonlyMap<string, number>
}
