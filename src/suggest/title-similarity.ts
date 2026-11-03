/**
 * Title similarity, shared by the store's generation-time dedup and the triage pass's
 * sibling check. Extracted so there is ONE algorithm — the two call sites use different
 * thresholds, which is a policy difference, not a reason to keep two copies.
 */

/** Lowercase, strip punctuation, split to a word set. `CI/CD` becomes `cicd`. */
export function normalizeTitle(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 0),
  )
}

/** Jaccard similarity of two word sets. 0 when both are empty. */
export function wordOverlap(a: Set<string>, b: Set<string>): number {
  let intersectionSize = 0
  for (const word of a) {
    if (b.has(word)) intersectionSize++
  }
  const unionSize = new Set([...a, ...b]).size
  if (unionSize === 0) return 0
  return intersectionSize / unionSize
}

export function titleSimilarity(a: string, b: string): number {
  return wordOverlap(normalizeTitle(a), normalizeTitle(b))
}

/** Below this many shared words a subset relation is meaningless ("Fix it" ⊂ "Fix it now"). */
const MIN_SUBSUME_TOKENS = 3

/**
 * True when two titles describe the SAME proposal, one merely qualified.
 *
 * Deliberately NOT a similarity threshold. Jaccard scored "CI/CD with test workflow for
 * hermes-agent" against "…for lethe" at 0.750 and silently deleted BOTH — the project name is one
 * token among eight, so a distinct SUBJECT cannot outvote shared boilerplate. Requiring one token
 * set to CONTAIN the other means a differing subject always blocks the collapse, because the
 * differing token is missing from the other side.
 */
export function subsumes(a: string, b: string): boolean {
  const sa = normalizeTitle(a)
  const sb = normalizeTitle(b)
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa]
  if (small.size < MIN_SUBSUME_TOKENS) return false
  for (const w of small) if (!large.has(w)) return false
  return true
}
