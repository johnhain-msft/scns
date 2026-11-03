import type { SuggestionCandidate, PatternSources } from './types.js'
import type { Evidence } from '../types.js'
import { LSP_SERVERS } from '../lsp-servers.js'

// Phase 13.12.25: 10 was far too sensitive (14 .ts changes in a TS repo is
// baseline, not a signal). Require sustained activity before emitting an
// LSP suggestion.
const MIN_FILE_CHANGES = 50

/**
 * The languages we can propose an LSP for are exactly the ones {@link LSP_SERVERS} can launch.
 * Deriving the list from the registry rather than restating it in prose is what stops this file
 * proposing work the executor has no launch command for — the defect that made LSP proposals ship
 * as `type: 'instruction'` and turn into a markdown bullet instead of a language server.
 */
const LSP_MAPPINGS = LSP_SERVERS.map((spec) => ({
  spec,
  extensions: Object.keys(spec.fileExtensions),
}))

export function extractLspSuggestions(sources: PatternSources): readonly SuggestionCandidate[] {
  const { observations } = sources
  if (!observations) {
    return []
  }

  const repoFileTypes = sources.repoFileTypes

  /**
   * Does the target repo actually contain any file this language server would serve?
   *
   * `fileExtensions` keys are dotted (`.py`) but the presence index is undotted (`py`), so the
   * leading dot is stripped before lookup — without that, nothing would ever match and every
   * language would be vetoed.
   *
   * Fails OPEN: no index (absent or empty) means no evidence of absence, so emission proceeds
   * exactly as it did before this gate existed.
   */
  function repoHasLanguage(extensions: readonly string[]): boolean {
    if (repoFileTypes === undefined || repoFileTypes.size === 0) return true
    return extensions.some((ext) => repoFileTypes.has(ext.replace(/^\.+/, '').toLowerCase()))
  }

  const candidates: SuggestionCandidate[] = []
  const now = new Date().toISOString()
  const emittedTags = new Set<string>()
  // Already registered in `lsp-config.json` ⇒ there is nothing to write. Without this the
  // extractor proposed from file-change counts alone and re-emitted "Configure TypeScript LSP"
  // for a server that had been configured for weeks, which cost a full approval + team cycle.
  const configured = new Set(sources.configuredLspServers ?? [])

  for (const mapping of LSP_MAPPINGS) {
    if (emittedTags.has(mapping.spec.tag)) continue
    if (configured.has(mapping.spec.id)) continue

    // Presence gate: `fileTypeCounts` is global across every watched directory, but this
    // suggestion is dispatched against one repo — and an LSP candidate is executable, so a
    // false positive installs and registers a language server for a language that is not here.
    if (!repoHasLanguage(mapping.extensions)) continue

    // Sum all matching extensions for this language
    let totalChanges = 0
    for (const ext of mapping.extensions) {
      totalChanges += observations.fileTypeCounts.get(ext) ?? 0
    }

    if (totalChanges < MIN_FILE_CHANGES) continue

    const evidence: Evidence[] = [
      {
        source: 'observation-file-types',
        detail: `${totalChanges} file changes in ${mapping.extensions.join('/')} files`,
        observedAt: now,
        weight: Math.min(1, totalChanges / 50),
      },
    ]

    if (observations.recentFocus) {
      evidence.push({
        source: 'observation-project-focus',
        detail: `recent focus on ${observations.recentFocus}`,
        observedAt: now,
        weight: 0.4,
      })
    }

    // `lsp`, NOT `instruction`. Typing this as an instruction routed a request to configure a
    // language server into "append one sentence to a markdown file" — it read as done while the
    // LSP was never configured. The tags carry the language so the executor can resolve the
    // launch spec back out of the suggestion at approve time.
    candidates.push({
      type: 'lsp',
      title: `Configure ${mapping.spec.language} LSP (${mapping.spec.lspName})`,
      description: `${mapping.spec.description} Registers \`${[mapping.spec.command, ...mapping.spec.args].join(' ')}\` for ${mapping.extensions.join('/')} in Copilot CLI's lsp-config.json. (Detected ${totalChanges} ${mapping.spec.language} file changes in your workflow.)`,
      evidence,
      tags: ['lsp', mapping.spec.tag, 'codebase-improvement'],
      observationCount: totalChanges,
      windowDays: 7,
    })

    emittedTags.add(mapping.spec.tag)
  }

  return candidates
}
