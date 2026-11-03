/**
 * HOP-SHAPE SIGNALS — the deterministic detectors behind `hop-shape.ts`.
 *
 * Each detector reads the query's STRUCTURE (what it references, how those references are joined,
 * whether it asks for causes, change over time, or a roll-up) and reports a typed reason. Nothing
 * here is learned, and nothing reads GATE / the intent interpreter — hop-shape is a narrower question
 * ("how many things must retrieval chain?") than intent ("what does the human want?"), and John was
 * explicit that the two stay decoupled.
 *
 * Tuned to the LIVE corpus's prompt shapes — typo-laden, conversational coding-assistant traffic —
 * not to textbook QA. Every pattern is a plain regular expression so the classifier stays auditable
 * and versioned (`HOP_SHAPE_CLASSIFIER_VERSION` in `hop-shape.ts`); a revision that changes any
 * pattern bumps the version.
 */

/**
 * Path / branch / filename shapes. Anchored with a LOOKBEHIND (`(?<![\w.-])`) rather than `\b`:
 * `.` and `-` are non-word characters, so `\b` matches at every internal transition of a
 * `[\w.-]+` run and the engine rescans the rest of the run from each of them — measured O(n²)
 * (`'a.'.repeat(10000)` took ~15 s). The lookbehind lets a match start only at the head of a run, so
 * each run is scanned once. Shared by the referent list and the file-directive check.
 */
const PATH_PATTERN = /(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+/g
const BRANCH_PATTERN = /(?<![\w.-])[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*\b/g
const FILE_EXTENSIONS = 'md|ts|tsx|js|mjs|cjs|json|py|sh|yml|yaml|toml|sql|txt|log|plist'
const FILENAME_PATTERN = new RegExp(`(?<![\\w.-])[\\w.-]+\\.(?:${FILE_EXTENSIONS})\\b`, 'gi')

/** Explicit artefact references: things retrieval can look up by name. */
const REFERENT_PATTERNS: readonly RegExp[] = [
  // PR #26, issue 17, bug #3, ticket 42, bare #16
  /\b(?:prs?|pull requests?|issues?|bugs?|tickets?)\s*#?\s*\d+\b/gi,
  /(?:^|\s)#\d+\b/g,
  // paths with ≥ 2 segments (~/x/y, /a/b, ./a/b, src/memory/x.ts) and branch-like a/b tokens
  PATH_PATTERN,
  BRANCH_PATTERN,
  // bare filenames
  FILENAME_PATTERN,
  // spec / task / requirement ids: T045, FR-034, SC-019, US2, RC-1, C2, F1, M1, D1
  /\b(?:T|FR|SC|US|RC|C|F|M|D)-?\d{1,3}[a-z]?\b/g,
  // spec dirs + phase/spec/step/move numbers
  /\b00\d-[a-z][\w-]*/gi,
  /\b(?:phase|spec|step|move|part|option)[- ]\d+[a-z]?\b/gi,
  // backticked code and double-quoted strings
  /`[^`]{1,80}`/g,
  /"[^"]{2,60}"/g,
  // identifiers: snake_case, camelCase, ALL_CAPS_WITH_UNDERSCORE_OR_DIGIT
  /\b[a-z]+_[a-z_]+\b/g,
  /\b[a-z]+[A-Z][A-Za-z]+\b/g,
  /\b[A-Z]{2,}[_-][A-Z0-9_]+\b/g,
]

/** Temporal referents: dates, weekdays, relative days, clock times. */
const TEMPORAL_REFERENT_PATTERNS: readonly RegExp[] = [
  /\b20\d\d-\d\d-\d\d\b/g,
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|yesterday|tonight)\b/gi,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/gi,
  /\b\d{1,2}(?::\d\d)?\s*(?:am|pm)\b/gi,
]

/**
 * Anaphora that must be resolved against something else before retrieval can proceed: plural
 * demonstratives ("these bugs"), demonstrative + a work noun ("that handoff"), and "the X we VERB"
 * ("the fix we need"). Bounded noun list on purpose — "this is", "that's" are not references.
 */
const WORK_NOUN =
  '(?:prs?|issues?|bugs?|fix(?:es)?|branch(?:es)?|handoffs?|specs?|plans?|tasks?|features?|files?|' +
  'sessions?|pieces?|parts?|changes?|errors?|tests?|suites?|reports?|reviews?|proposals?|items?|' +
  'steps?|phases?|approach(?:es)?|questions?|problems?|defects?|commits?|merges?|agents?|skills?|' +
  'scripts?|workflows?|pipelines?|jobs?|runs?|prompts?|docs?|documents?|designs?|decisions?|' +
  'verdicts?|labels?|arms?|tools?|modules?|functions?|commands?|outputs?|results?|findings?|' +
  'directives?|suggestions?|recommendations?|numbers?|figures?|metrics?|logs?|alerts?|messages?)'
const ANAPHORA_PATTERNS: readonly RegExp[] = [
  /\b(?:these|those)\s+[a-z]+/gi,
  new RegExp(`\\bth(?:is|at)\\s+(?:same\\s+)?${WORK_NOUN}\\b`, 'gi'),
  /\bthe\s+\w+\s+(?:we|you|i|they)(?:'ve|'d|'re)?\s+(?:need|made|did|fixed|built|wrote|created|added|found|discussed|mentioned|proposed|removed|merged|opened|closed|ran|used|had|have|just|already|were|are|talked)\b/gi,
]

const RELATION =
  /\b(?:between|against|versus|vs\.?|relat(?:e|es|ed|ion|ionship)s?|fits?\s+in(?:to)?|depend(?:s|ent|ency|encies)?\s+on|affects?|impacts?|in\s+tandem|along\s+with|together\s+with|connects?\s+to|links?\s+to|tied\s+to|conflicts?\s+with|maps?\s+(?:to|onto|against)|reconcile|cross-?reference|in\s+light\s+of|given\s+that|based\s+on|w\.?r\.?t\.?|with\s+respect\s+to|plugs?\s+in(?:to)?)\b/i

const COMPARISON =
  /\b(?:compar(?:e|es|ed|ison)|difference[s]?\s+between|\bbetween\b.{0,40}\band\b|differs?\s+from|vs\.?|versus|instead\s+of|in\s+lieu\s+of|rather\s+than|better\s+than|worse\s+than|same\s+as|which\s+(?:one|is\s+better|should\s+we))\b/i

const CAUSAL =
  /\bwhy\b|\bwhy'?s\b|\broot[- ]cause|\brca\b|what\s+went\s+wrong|\bhow\s+(?:could|did|come)\b|\bbecause\s+of\b|\bcaused?\s+(?:by|of|the|this|that|it)\b|\bcausing\b|\bdiagnos|\breason\s+(?:for|that|why|it|this|behind)\b|is\s+there\s+a\s+reason|\bexplain\s+(?:why|how)\b|\bwhat\s+happened\b/i

const TEMPORAL =
  /\bsince\b|left\s+off|been\s+a\s+(?:few|couple|while)|\bso\s+far\b|\bhistory\b|what(?:'s|\s+has|\s+have)?\s+changed|\bchanged\s+since|\bbefore\s+and\s+after\b|\bpreviously\b|\bprevious\s+(?:session|run|week|attempt|version)|\blast\s+(?:session|week|time|run|night|attempt|month|sprint)\b|\bover\s+time\b|\btimeline\b|\bup\s+to\s+now\b|\bto\s+date\b|\bstandup\b|\bcatch\s+me\s+up\b|\brecap\b|\bwhere\s+(?:we|things|did\s+we)\s+(?:are|were|left|stand)|\bpick\s+(?:back\s+)?up\s+where|\bafter\s+that\b|\bearlier\b|\bago\b|\bfor\s+days\b|\bnon-?stop\b|\b(?:seems|appears|looks)\s+to\s+be\s+a\s+pattern\b|\brecurring\b|\bkeeps?\s+happening\b|\bhappen(?:ed|ing|s)?\s+again\b|\bagain\s+and\s+again\b/i

const AGGREGATION =
  /\boverall\b|\bsummar(?:y|ize|ise)\b|\beverything\s+(?:we|you|that)\b|\bbig\s+picture\b|\bstate\s+of\s+(?:the|things|play|development)\b|\bwhere\s+are\s+we\b|\bwhere\s+we\s+are\b|\bstatus\s+(?:of\s+everything|overall|report)\b|\bin\s+total\b|\bhow(?:'re|\s+are)\s+we\s+(?:looking|doing)\b|\blist\s+(?:all|every)\b|\bwhat(?:'ve|\s+have)\s+we\s+done\b|\bhow\s+far\s+along\b|\bprogress\b|\btake\s+stock\b|\borient\s+me\b|\bcurrent\s+state\b/i

const SEQUENCE =
  /\bthen\b|\bafter\s+(?:that|it'?s?\s+done|which)\b|\bonce\s+\w+\s+(?:is|are|has|have|lands?)\b|\bso\s+(?:that|they|it)\s+(?:can|could|will|would)\b|\bwhich\s+means\b|\bfollowed\s+by\b/i

const IMPERATIVE_OPENER =
  /^(?:(?:please|pls|now|just|ok(?:ay)?|yes|yeah|yep|sure|fine|great|good|cool|alright)[,\s-]*\s+|lets?\s+|let's\s+|go\s+ahead\s+(?:and\s+)?)?(?:continue|try|analy[sz]e|plan|create|run|fix|implement|commit|push|merge|read|execute|do|go|proceed|finali[sz]e|ship|deploy|test|check|verify|retry|rerun|restart|build|lint|format|open|close|start|stop|resume|update|add|remove|delete|revert|rebase|install|apply|use|review|approve|reject|show|list|print|describe|write|draft|refactor|clean|wrap|tackle|address|handle|investigate|look|take|make|send|generate|prepare|kick|spin|cat|follow|load|see|grade|summari[sz]e|triage|explain|answer|report|move|pick|keep|hold|wait|cancel|kill|clear|reset|set|save|copy|paste|render|compile|type|typecheck|migrate|scaffold|bootstrap|configure|enable|disable|toggle|switch|flip|bump|tag|release|publish|post|reply|respond|ping|nudge|remind|schedule|register|wire|hook|patch|backfill|dedupe|prune|archive)\b/i

const YES_NO_OPENER =
  /^(?:(?:so|and|but|ok(?:ay)?|hmm|wait|also|now|then|to\s+clarify|to\s+clariify|to\s+confirm)[,\s-]+)?(?:is|are|was|were|did|does|do|has|have|had|can|could|should|will|would|am)\b(?!\s+not\b)/i

const FILE_DIRECTIVE_OPENER =
  /^(?:(?:please|pls|now|just|ok(?:ay)?|yes|yeah|yep|sure|fine|great|good|cool|alright)[,\s-]*\s+)?(?:read|cat|open|execute|run|implement|follow|apply|use|load|review|check|look\s+at|see|grade)\b/i

const PATH_LIKE = new RegExp(`${PATH_PATTERN.source}|${FILENAME_PATTERN.source}`, 'i')

export interface HopShapeSignals {
  readonly wordCount: number
  readonly questionMarks: number
  /** Distinct explicit artefact references (paths, PR/issue numbers, ids, code, identifiers). */
  readonly referents: number
  /** Distinct work-noun lemmas outside explicit referents ("the fix", "the tasks") — nominal entities. */
  readonly workNouns: number
  /** Distinct temporal referents (dates, weekdays, clock times). */
  readonly temporalReferents: number
  /** Anaphoric references that need resolving against something else. */
  readonly anaphora: number
  readonly relation: boolean
  readonly comparison: boolean
  readonly causal: boolean
  readonly temporal: boolean
  readonly aggregation: boolean
  readonly sequence: boolean
  readonly imperativeOpener: boolean
  readonly yesNoOpener: boolean
  /** An imperative opener whose single explicit referent is a path or filename. */
  readonly fileDirective: boolean
}

interface Span {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** Every match of every pattern, as spans. Fresh RegExp per call: shared /g regexes carry `lastIndex`. */
function matchSpans(text: string, patterns: readonly RegExp[]): Span[] {
  const out: Span[] = []
  for (const p of patterns) {
    const re = new RegExp(p.source, p.flags)
    for (const m of text.matchAll(re)) {
      const raw = m[0]
      const lead = raw.length - raw.trimStart().length
      const trimmed = raw.trim()
      if (trimmed.length === 0) continue
      const start = (m.index ?? 0) + lead
      out.push({ start, end: start + trimmed.length, text: trimmed.toLowerCase() })
    }
  }
  return out
}

/**
 * Distinct referents, with CONTAINMENT dedupe: a match that sits entirely inside another match is the
 * same referent seen by a narrower pattern (`/var/x/y/tmp.md` ⊃ `y/tmp.md` ⊃ `tmp.md`; `PR #26` ⊃
 * `#26`), not a second entity. Without this a single path counted as three.
 */
function countDistinctReferents(text: string, patterns: readonly RegExp[]): number {
  const spans = matchSpans(text, patterns)
  const kept = spans.filter(
    (a) =>
      !spans.some(
        (b) => b !== a && b.start <= a.start && b.end >= a.end && b.end - b.start > a.end - a.start,
      ),
  )
  return new Set(kept.map((k) => k.text)).size
}

function countDistinct(text: string, patterns: readonly RegExp[]): number {
  return new Set(matchSpans(text, patterns).map((s) => s.text)).size
}

/** Blank out explicit referents so a work noun inside one (`PR #26` → "pr") is not counted twice. */
function withoutReferents(text: string): string {
  let out = text
  for (const p of REFERENT_PATTERNS)
    out = out.replace(new RegExp(p.source, p.flags), (m) => ' '.repeat(m.length))
  return out
}

/** bugs → bug, fixes → fix, branches → branch, issues → issue, changes → change (never `issu`). */
function lemma(noun: string): string {
  const w = noun.toLowerCase()
  if (/(?:ch|sh|x|s|z)es$/.test(w)) return w.slice(0, -2)
  if (/s$/.test(w)) return w.slice(0, -1)
  return w
}

/** Distinct work-noun LEMMAS outside explicit referents. Fresh RegExp per call (no shared /g state). */
function countWorkNouns(text: string): number {
  const seen = new Set<string>()
  const re = new RegExp(`\\b${WORK_NOUN}\\b`, 'gi')
  for (const m of withoutReferents(text).matchAll(re)) seen.add(lemma(m[0]))
  return seen.size
}

/** Normalise once: NFKC, strip control chars, collapse whitespace, cap length (a bound, not the O(n) argument — see PATH_PATTERN). */
export function normaliseQuery(query: string): string {
  return (query ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20_000)
}

/** Extract every structural signal the classifier scores. Pure. */
export function extractHopShapeSignals(query: string): HopShapeSignals {
  const text = normaliseQuery(query)
  const lower = text.toLowerCase()
  const words = lower.length === 0 ? [] : lower.split(' ')
  const referents = countDistinctReferents(text, REFERENT_PATTERNS)
  const onlyPath = referents === 1 && PATH_LIKE.test(text)
  return {
    wordCount: words.length,
    questionMarks: (text.match(/\?/g) ?? []).length,
    referents,
    workNouns: countWorkNouns(text),
    temporalReferents: countDistinct(text, TEMPORAL_REFERENT_PATTERNS),
    anaphora: countDistinct(text, ANAPHORA_PATTERNS),
    relation: RELATION.test(lower),
    comparison: COMPARISON.test(lower),
    causal: CAUSAL.test(lower),
    temporal: TEMPORAL.test(lower),
    aggregation: AGGREGATION.test(lower),
    sequence: SEQUENCE.test(lower),
    imperativeOpener: IMPERATIVE_OPENER.test(lower),
    yesNoOpener: YES_NO_OPENER.test(lower),
    fileDirective: onlyPath && FILE_DIRECTIVE_OPENER.test(lower),
  }
}
