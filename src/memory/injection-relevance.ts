/**
 * Prompt-relevance scoring for the per-prompt injection blocks (issue #75).
 *
 * `POST /api/extension/context` injects three blocks. The memory briefing is ranked against
 * the user's prompt by the retrieval stack; the pending-suggestions and negative-rules
 * blocks used to inject in store order regardless of topic, so a styling prompt could carry
 * scheduler suggestions and ten unrelated "don't" rules on every request. This module
 * supplies the missing signal for those two blocks.
 *
 * LEXICAL by design — this runs on the hot per-prompt path, which already spends its
 * synchronous embedding budget on the briefing, so the scorer must cost nothing: pure
 * string work over the shared `normalizeTitle` word-set normalization (title-similarity.ts
 * stays the single normalization algorithm).
 *
 * NOT Jaccard (`wordOverlap`) — a prompt is long and an injected item is short, so
 * symmetric Jaccard divides by the union and caps a perfect five-word match against a
 * fifty-word prompt near 0.1. What matters here is COVERAGE of the item: matched content
 * words over the item's content words. Stopwords are excluded on both sides so "the/in/a"
 * overlap can never make an off-topic item look relevant, and at least two shared content
 * words are required (unless the item only has one) so a single generic verb ("add",
 * "fix") cannot carry an item in.
 */

import { normalizeTitle } from '../suggest/title-similarity.js'

/**
 * Flip-back lever: `SCNS_INJECTION_RELEVANCE=0` restores the unfiltered store-order
 * injection for BOTH blocks (byte-identical to the pre-#75 behavior). Default is ON,
 * matching the house convention for relevance levers (SCNS_ENTITY_RELEVANCE et al.).
 */
export const INJECTION_RELEVANCE_ENV = 'SCNS_INJECTION_RELEVANCE'

export function injectionRelevanceEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[INJECTION_RELEVANCE_ENV] !== '0'
}

/**
 * Function words plus the negation/imperative boilerplate every negative rule opens with
 * ("never …", "do not …", "avoid …"). The boilerplate words are stopwords because they
 * appear in nearly every rule — shared boilerplate must never count as topical overlap.
 * Deliberately NO domain verbs beyond that: the two-shared-words minimum already stops a
 * lone "add"/"fix" match, and guessing which verbs are "too generic" is a rabbit hole.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'else',
  'when',
  'while',
  'for',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'into',
  'onto',
  'about',
  'over',
  'under',
  'up',
  'down',
  'out',
  'off',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'am',
  'do',
  'does',
  'did',
  'doing',
  'done',
  'have',
  'has',
  'had',
  'having',
  'will',
  'would',
  'can',
  'could',
  'should',
  'shall',
  'may',
  'might',
  'must',
  'not',
  'no',
  'never',
  'always',
  'avoid',
  'dont',
  'ensure',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'they',
  'them',
  'their',
  'we',
  'our',
  'you',
  'your',
  'i',
  'my',
  'me',
  'he',
  'she',
  'his',
  'her',
  'as',
  'so',
  'than',
  'too',
  'very',
  'just',
  'only',
  'also',
  'any',
  'all',
  'some',
  'each',
  'every',
  'both',
  'few',
  'more',
  'most',
  'other',
  'such',
  'own',
  'same',
  'how',
  'what',
  'which',
  'who',
  'whom',
  'why',
  'where',
  'there',
  'here',
  'again',
  'once',
  'before',
  'after',
  'above',
  'below',
  'between',
  'during',
  'without',
  'within',
  'please',
])

/** An item needs this many content words shared with the prompt (or all of them, if fewer). */
const MIN_SHARED_CONTENT_WORDS = 2

/**
 * Poor-man's singularizer so "secrets" matches "secret" and "queries" matches "query".
 * Approximate on purpose — a real stemmer is not worth its weight for word-SET matching,
 * where an occasional over-strip only risks a match, never a crash or an exclusion cascade.
 */
function singularize(word: string): string {
  if (word.length >= 5 && word.endsWith('ies')) return word.slice(0, -3) + 'y'
  if (word.length >= 5 && word.endsWith('es') && /(s|x|z|ch|sh)es$/.test(word)) {
    return word.slice(0, -2)
  }
  if (word.length >= 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

function contentWords(text: string): Set<string> {
  const words = new Set<string>()
  for (const w of normalizeTitle(text)) {
    // Check BOTH forms against the stopword list: "avoids"/"ensures" must not leak past a
    // list that stops "avoid"/"ensure" — boilerplate never counts as topical overlap.
    const s = singularize(w)
    if (STOPWORDS.has(w) || STOPWORDS.has(s)) continue
    words.add(s)
  }
  return words
}

/**
 * Scores one injectable item's text against the prompt the scorer was built for.
 * Returns 0 for "not relevant"; positive scores order by tightness of the match.
 */
export type PromptRelevanceScorer = (itemText: string) => number

/**
 * Build a scorer bound to one prompt. The prompt's content-word set is computed ONCE here
 * and reused for every item — the handler scores every pending suggestion and every
 * eligible negative rule against the same prompt, so per-call re-normalization of the
 * (long) prompt would be the only measurable cost in this file.
 *
 * Score: |item ∩ prompt| / |item| over stopword-free, singularized word sets — 0 when the
 * item shares fewer than {@link MIN_SHARED_CONTENT_WORDS} content words with the prompt
 * (or fewer than ALL of them, for a one-word item), else the item's coverage in (0, 1].
 * An item with no content words at all scores 0: it carries no topical signal to match on
 * (the negative-rule floor, not the scorer, decides whether such an item still injects).
 */
export function makePromptRelevanceScorer(prompt: string): PromptRelevanceScorer {
  const promptWords = contentWords(prompt)
  return (itemText: string): number => {
    const itemWords = contentWords(itemText)
    if (itemWords.size === 0) return 0
    let matched = 0
    for (const w of itemWords) {
      if (promptWords.has(w)) matched++
    }
    if (matched < Math.min(MIN_SHARED_CONTENT_WORDS, itemWords.size)) return 0
    return matched / itemWords.size
  }
}
