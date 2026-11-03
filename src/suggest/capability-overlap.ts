/**
 * CAPABILITY OVERLAP — establish whether a proposal is actually new, BEFORE anyone writes prose
 * about it.
 *
 * John's constraint, and the reason this module exists at all:
 *
 *   "make sure however we create this that we aren't prompting the llm to explain why its unique if
 *    it isn't. *if* the proposal is unique it should explain why. if it isn't we can make the
 *    recommendation rejected by machine/duplicate so that it doesn't pop up again"
 *
 * Ask a model to justify a conclusion and it will produce a plausible justification whether or not
 * the conclusion holds. So uniqueness is DETERMINED first and prose is generated second — never the
 * other way round.
 *
 * The critical honesty in here is the third verdict. A disk scan can only see ARTIFACTS we built. It
 * cannot see that the host tool already edits files natively — which is precisely why "Create
 * file-management extension" was unreviewable ("copilot llm already has the ability to edit files,
 * write files, etc. what *is* a file-management extension?"). So a clean scan yields
 * `inconclusive`, NEVER `novel`: absence of a matching artifact is not evidence of novelty. Only the
 * built-in-capability check (a separate, deliberately NEUTRAL question) may promote a proposal to
 * `novel`.
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Suggestion } from './types.js'

/** An artifact that already exists — the raw material for the duplicate check. */
export interface ExistingCapability {
  /** The suggestion type this artifact corresponds to (`skill`, `extension`, …). */
  readonly kind: string
  readonly name: string
  readonly path: string
}

/** Where to look for artifacts of a given kind. */
export interface CapabilityScanSpec {
  readonly kind: string
  readonly dir: string
}

export type OverlapVerdict = 'duplicate' | 'inconclusive' | 'novel'

export interface OverlapAssessment {
  readonly verdict: OverlapVerdict
  /** The artifacts this proposal collides with. Empty unless `verdict === 'duplicate'`. */
  readonly duplicates: readonly ExistingCapability[]
  /** Everything that was checked — so a downstream neutral question is built from real data. */
  readonly considered: readonly ExistingCapability[]
  readonly reason: string
}

/** Suffix words that describe the artifact KIND rather than its identity. */
const KIND_SUFFIXES = new Set([
  'helper',
  'skill',
  'extension',
  'agent',
  'prompt',
  'workflow',
  'automation',
  'mcp',
  'lsp',
  'instruction',
  'action',
  'proposal',
  'tool',
  'integration',
])

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The identity of the artifact a proposal wants to create — "file-management", "facetime".
 * Prefers the title (`Create X <kind>`), falls back to the first tag that isn't the type itself.
 */
export function artifactNameFor(suggestion: Suggestion): string {
  const fromTitle = suggestion.title.match(/^\s*(?:create|add|build)\s+(.*)$/i)?.[1]
  if (fromTitle) {
    const tokens = fromTitle.trim().split(/\s+/)
    while (tokens.length > 0 && KIND_SUFFIXES.has(normalize(tokens[tokens.length - 1] ?? ''))) {
      tokens.pop()
    }
    if (tokens.length > 0) return normalize(tokens.join('-'))
  }
  const tag = suggestion.tags.find((t) => normalize(t) !== normalize(suggestion.type))
  return tag ? normalize(tag) : normalize(suggestion.title)
}

/** List artifacts already on disk. Missing directories are simply empty, never an error. */
export function scanExistingCapabilities(
  specs: readonly CapabilityScanSpec[],
): readonly ExistingCapability[] {
  const found: ExistingCapability[] = []
  for (const spec of specs) {
    if (!existsSync(spec.dir)) continue
    let entries: string[]
    try {
      entries = readdirSync(spec.dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const ext = extname(entry)
      const name = ext ? basename(entry, ext) : entry
      found.push({ kind: spec.kind, name, path: join(spec.dir, entry) })
    }
  }
  return found
}

/**
 * Capabilities the system has ALREADY BUILT, read from its own history: every suggestion in
 * `implemented/` is an artifact that exists. The directory scan alone missed these whenever the
 * artifact is an ENTRY INSIDE a file rather than a file of its own — the proven case being lsp
 * suggestion ca64e7a1 (2026-09-14), a twin of 73e80eb6 (implemented 2026-04-17): the TypeScript
 * server entry lives inside `lsp-config.json`, the scan saw only the directory, the proposal
 * surfaced as "novelty unverified", John approved it, and the doomed implementation attempts
 * burned a full retry budget for an artifact that already existed. A system that keeps its own
 * implementation record and does not consult it is not learning from it.
 */
export function capabilitiesFromImplementedSuggestions(
  implemented: readonly Suggestion[],
): readonly ExistingCapability[] {
  return implemented.map((s) => ({
    kind: s.type,
    name: artifactNameFor(s),
    path: `implemented suggestion ${s.id} ("${s.title}")`,
  }))
}

/**
 * Registered language servers parsed OUT of `lsp-config.json` — one `lsp`-kind capability per
 * server key (`typescript`, `python`, …), matching what `artifactNameFor` derives from an lsp
 * suggestion's tags. Complements the history check above: it also catches entries that were
 * written manually or by an older pipeline, where no implemented suggestion survives to tell
 * the story. Malformed or absent config yields no capabilities — absence of evidence only.
 */
export function lspCapabilitiesFromConfig(configPath: string): readonly ExistingCapability[] {
  if (!existsSync(configPath)) return []
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      readonly lspServers?: Record<string, unknown>
    }
    return Object.keys(parsed.lspServers ?? {}).map((name) => ({
      kind: 'lsp',
      name,
      path: configPath,
    }))
  } catch {
    return []
  }
}

/**
 * The deterministic half. Same-kind artifact-name collision ⇒ `duplicate`. Anything else ⇒
 * `inconclusive` — see the module note on why a clean scan can never mean `novel`.
 */
export function assessOverlap(
  suggestion: Suggestion,
  existing: readonly ExistingCapability[],
): OverlapAssessment {
  const target = artifactNameFor(suggestion)
  const duplicates = existing.filter(
    (e) => normalize(e.kind) === normalize(suggestion.type) && normalize(e.name) === target,
  )

  if (duplicates.length > 0) {
    return {
      verdict: 'duplicate',
      duplicates,
      considered: existing,
      reason: `a ${suggestion.type} named "${duplicates[0]!.name}" already exists at ${duplicates[0]!.path}`,
    }
  }

  return {
    verdict: 'inconclusive',
    duplicates: [],
    considered: existing,
    reason:
      `no existing ${suggestion.type} artifact is named "${target}", but an artifact scan cannot ` +
      `see capability that is built into the host tool — novelty is still unproven`,
  }
}
