/**
 * Tag suggestion extractor — clusters the lesson corpus by shared vocabulary
 * and proposes new tags for untagged / orphan lessons.
 *
 * Phase 13.12.12 — tag suggestion + taxonomy learning.
 *
 * Inputs:
 *   - Corpus of lessons (already scope-filtered by the caller if needed).
 *   - Known tag signatures (from rejection log) to avoid re-proposing.
 *   - Existing taxonomy so we don't propose a tag that's already registered.
 *
 * Output: `TagProposalCandidate[]` — each becomes a `tag-proposal` suggestion.
 */

import type { Lesson, LessonScope } from '../../memory/lessons.js'
import { rejectionSignature } from '../../memory/tag-rejections.js'

export interface TagProposalCandidate {
  readonly tagName: string
  readonly scope: LessonScope
  readonly project?: string
  readonly agent?: string
  readonly candidateLessonIds: readonly string[]
  readonly rationale: string
  /** Aggregate confidence signal for the generator. */
  readonly strength: number
}

export interface ExtractTagProposalsOptions {
  /** Minimum number of untagged/weakly-tagged lessons sharing a token before it becomes a candidate. */
  readonly minClusterSize?: number
  /** Tags already in the taxonomy (lowercased) — we never propose these. */
  readonly knownTags?: ReadonlySet<string>
  /** Rejection signatures to skip (`<tag>::<sortedIds>` from tag-rejections store). */
  readonly rejectedSignatures?: ReadonlySet<string>
}

const DEFAULT_MIN_CLUSTER = 3

// Conservative English stopword list — keeps the extractor simple and
// hermetic (no external NLP dep).
const STOPWORDS = new Set<string>([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'like',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'out',
  'over',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'too',
  'under',
  'up',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'also',
  'any',
  'each',
  'here',
  'more',
  'much',
  'one',
  'some',
  'than',
  'very',
  'about',
  'after',
  'before',
  'because',
  'only',
  'other',
  'should',
  'should',
  'such',
  'through',
  'while',
  'again',
  'always',
  'never',
  'must',
  'need',
  'needs',
  'make',
  'take',
  'used',
  'uses',
  'using',
  'into',
  'over',
  'under',
  'upon',
  'consider',
  'often',
  'then',
  'thus',
  'like',
  'work',
  'works',
  'well',
  'even',
  'onto',
  'lesson',
  'lessons',
  // Generic form/UI vocabulary — shows up incidentally in prose ("a field
  // that's 3 points off", "each field", "form fields") but is too generic
  // to function as a useful semantic tag. Blocking here prevents the
  // tag-suggestion extractor from proposing it as a new global/project tag.
  'field',
  'fields',
  'form',
  'forms',
  'page',
  'pages',
  // Generic verification vocabulary — "check" / "checks" / "checking" /
  // "checked" show up incidentally in quality and verification prose
  // ("double-check", "check if", "sanity check") but are too generic to
  // carry semantic meaning as tags. Blocking here prevents the
  // tag-suggestion extractor from proposing "check" as a new tag.
  'check',
  'checks',
  'checked',
  'checking',
  // Generic prompting vocabulary — "prompt" / "prompts" / "prompting" /
  // "prompted" show up in PDF/meta lessons in their generic English sense
  // ("PROMPTING META-LESSON:" headers, "the user had to prompt me twice").
  // Too polysemous to function as a cohesive semantic tag. Blocking here
  // prevents the tag-suggestion extractor from proposing "prompt" as a new
  // global/project tag from incidental prose.
  'prompt',
  'prompts',
  'prompted',
  'prompting',
])

/**
 * Phase 13.12.25: light morphological stemming so "cache" and "caching" do
 * not emit as separate tag proposals. Applies a sequence of suffix strips
 * with a minimum stem length of 4 so we never collapse tiny roots. Order
 * matters: longer suffixes first.
 */
export function stemToken(token: string): string {
  let t = token.toLowerCase()
  const tryStrip = (suffix: string, minLen: number): boolean => {
    if (t.length >= suffix.length + 4 && t.endsWith(suffix) && t.length >= minLen) {
      const stripped = t.slice(0, -suffix.length)
      if (stripped.length >= 4) {
        t = stripped
        return true
      }
    }
    return false
  }
  if (!tryStrip('ings', 8)) {
    if (!tryStrip('ing', 7)) {
      if (!tryStrip('ed', 6)) {
        if (!tryStrip('es', 6)) {
          // Only strip singular -s if not part of -ss (e.g. "class")
          if (t.length >= 6 && t.endsWith('s') && !t.endsWith('ss')) {
            const stripped = t.slice(0, -1)
            if (stripped.length >= 4) t = stripped
          }
        }
      }
    }
  }
  // Final pass: collapse a trailing silent -e so "cache" and "caching"
  // (→ "cach") converge. Guarded by min-length 4 so we don't blow up short
  // roots like "fire" (stays "fire").
  if (t.length >= 5 && t.endsWith('e')) {
    t = t.slice(0, -1)
  }
  return t
}

/** Tokenize: lowercase, a-z only, length ≥4, non-stopword. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of text.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []) {
    const t = raw.replace(/^-+|-+$/g, '')
    if (t.length < 4) continue
    if (STOPWORDS.has(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/**
 * Extract candidate tag proposals from a corpus of lessons.
 * Looks for tokens that appear (as a lesson-level signal) in >= minClusterSize
 * lessons where the token is NOT already one of the lesson's tags.
 */
export function extractTagProposals(
  lessons: readonly Lesson[],
  options: ExtractTagProposalsOptions = {},
): readonly TagProposalCandidate[] {
  const minCluster = options.minClusterSize ?? DEFAULT_MIN_CLUSTER
  const knownTags = options.knownTags ?? new Set<string>()
  const rejected = options.rejectedSignatures ?? new Set<string>()
  // Phase 13.12.25: stem existing tags so a lesson already tagged "cache"
  // prevents a new "caching" → "cach" proposal from sneaking through.
  const knownStems = new Set<string>()
  for (const t of knownTags) knownStems.add(stemToken(t))

  // For each token, collect the set of lesson ids where it appears AND it's
  // not already a tag on that lesson (match by stem so "cache" suppresses
  // "caching" and vice versa).
  const tokenToLessons = new Map<string, Set<string>>()
  for (const lesson of lessons) {
    const existingStems = new Set(
      lesson.frontmatter.tags.map((t) => stemToken(t.toLowerCase())),
    )
    const haystack = `${lesson.frontmatter.id} ${lesson.body}`
    const tokens = new Set(tokenize(haystack))
    for (const tok of tokens) {
      if (existingStems.has(stemToken(tok))) continue
      if (!tokenToLessons.has(tok)) tokenToLessons.set(tok, new Set())
      tokenToLessons.get(tok)!.add(lesson.frontmatter.id)
    }
  }

  // Phase 13.12.25: merge raw tokens that share a stem (e.g. "cache" and
  // "caching") into one cluster. Pick the shortest raw form as the
  // representative tag name; UNION the lesson-id sets.
  const stemGroups = new Map<string, { rep: string; ids: Set<string> }>()
  for (const [tok, ids] of tokenToLessons) {
    const stem = stemToken(tok)
    const existing = stemGroups.get(stem)
    if (!existing) {
      stemGroups.set(stem, { rep: tok, ids: new Set(ids) })
    } else {
      for (const id of ids) existing.ids.add(id)
      if (tok.length < existing.rep.length) existing.rep = tok
    }
  }

  const byId = new Map(lessons.map((l) => [l.frontmatter.id, l] as const))

  // Rank groups by cluster size (desc), then take non-overlapping clusters.
  const ranked = [...stemGroups.values()]
    .map(({ rep, ids }) => [rep, ids] as const)
    .filter(([tok, ids]) =>
      ids.size >= minCluster && !knownTags.has(tok) && !knownStems.has(stemToken(tok)),
    )
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))

  const out: TagProposalCandidate[] = []
  const claimed = new Set<string>() // lesson ids already assigned to a proposal

  for (const [tok, idSet] of ranked) {
    // Filter out lessons already claimed by an earlier (stronger) proposal so
    // the same lesson doesn't get tagged with multiple weakly-correlated tokens.
    const ids = [...idSet].filter((id) => !claimed.has(id))
    if (ids.length < minCluster) continue

    // Dominant scope among the cluster's lessons drives the proposal's scope.
    const scopeCounts: Record<string, number> = {}
    const projectCounts: Record<string, number> = {}
    const agentCounts: Record<string, number> = {}
    for (const id of ids) {
      const l = byId.get(id)!
      scopeCounts[l.frontmatter.scope] = (scopeCounts[l.frontmatter.scope] ?? 0) + 1
      if (l.frontmatter.project) {
        projectCounts[l.frontmatter.project] = (projectCounts[l.frontmatter.project] ?? 0) + 1
      }
      if (l.frontmatter.agent) {
        agentCounts[l.frontmatter.agent] = (agentCounts[l.frontmatter.agent] ?? 0) + 1
      }
    }
    const dominant = <T extends string>(m: Record<string, number>): T | undefined => {
      const e = Object.entries(m).sort((a, b) => b[1] - a[1])[0]
      return e ? (e[0] as T) : undefined
    }
    const scope = (dominant<LessonScope>(scopeCounts) ?? 'global') as LessonScope
    const project = scope === 'project' ? dominant<string>(projectCounts) : undefined
    const agent = scope === 'agent' ? dominant<string>(agentCounts) : undefined

    const sortedIds = [...ids].sort()
    const sig = rejectionSignature(tok, sortedIds)
    if (rejected.has(sig)) continue

    out.push({
      tagName: tok,
      scope,
      ...(project ? { project } : {}),
      ...(agent ? { agent } : {}),
      candidateLessonIds: sortedIds,
      rationale: `Token "${tok}" appears in ${ids.length} untagged or weakly-tagged lessons across ${Object.keys(scopeCounts).length} scope(s); proposing "${tok}" as a new ${scope} tag.`,
      strength: ids.length / Math.max(1, lessons.length),
    })

    for (const id of ids) claimed.add(id)
  }

  return out
}
