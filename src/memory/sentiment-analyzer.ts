/**
 * Sentiment Analyzer — strict heuristic-based negative sentiment detection.
 *
 * Designed for developer conversations. Uses co-occurring signals with
 * aggressive false-positive suppression (code block exclusion, question
 * detection, third-party reference filtering).
 *
 * This is the SECONDARY detection path. The primary path is the
 * `scns_report_negative_feedback` Copilot tool (LLM-detected).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type SentimentSignalType =
  | 'frustration'
  | 'correction'
  | 'prohibition'
  | 'quality-complaint'
  | 'behavior-complaint'

export type RecommendedTarget =
  | 'custom-instruction'
  | 'agent-profile'
  | 'skill'
  | 'workflow'
  | 'general'

export interface SentimentSignal {
  readonly type: SentimentSignalType
  readonly score: number
  readonly triggers: readonly string[]
}

export interface SentimentAnalysis {
  readonly isNegative: boolean
  readonly signals: readonly SentimentSignal[]
  readonly overallScore: number
  readonly subject: string
  readonly dontRule: string
  readonly recommendedTarget: RecommendedTarget
}

// ── Pattern definitions ──────────────────────────────────────────────────────

interface PatternDef {
  readonly regex: RegExp
  readonly weight: number
  readonly label: string
}

const FRUSTRATION_PATTERNS: readonly PatternDef[] = [
  { regex: /\bwhy would you\b/i, weight: 0.7, label: 'why would you' },
  { regex: /\bhow many times\b/i, weight: 0.6, label: 'how many times' },
  { regex: /\bthis is broken\b/i, weight: 0.7, label: 'this is broken' },
  { regex: /\bstill not working\b/i, weight: 0.7, label: 'still not working' },
  { regex: /\bnot working\b/i, weight: 0.5, label: 'not working' },
  {
    regex: /\bno longer (shows?|works?|displays?|functions?)\b/i,
    weight: 0.6,
    label: 'no longer works',
  },
  { regex: /\bcompletely (broke|wrong|useless|ignored)\b/i, weight: 0.7, label: 'completely X' },
  { regex: /\bI told you\b/i, weight: 0.5, label: 'I told you' },
  { regex: /\bwe broke\b/i, weight: 0.5, label: 'we broke' },
  { regex: /\byou messed\b/i, weight: 0.7, label: 'you messed' },
]

const CORRECTION_PATTERNS: readonly PatternDef[] = [
  {
    regex: /\bthat['']?s not what I (meant|asked|wanted)\b/i,
    weight: 0.7,
    label: "that's not what I meant",
  },
  { regex: /\bI didn['']?t ask (for|you to)\b/i, weight: 0.7, label: "I didn't ask for" },
  { regex: /\bno,?\s+I (wanted|need|meant)\b/i, weight: 0.6, label: 'no I wanted' },
  {
    regex: /\binstead of .{3,30} you (should|need to)\b/i,
    weight: 0.7,
    label: 'instead of... you should',
  },
  { regex: /\bjust fix\b/i, weight: 0.4, label: 'just fix' },
]

const PROHIBITION_PATTERNS: readonly PatternDef[] = [
  { regex: /\bnever (do|claim|say|assume|make|lie|skip)\b/i, weight: 0.8, label: 'never do X' },
  {
    regex: /\bstop (doing|making|saying|lying|claiming|ignoring|skipping)\b/i,
    weight: 0.8,
    label: 'stop doing X',
  },
  { regex: /\bdo not (ever|again)\b/i, weight: 0.7, label: 'do not ever' },
  { regex: /\bcan['']?t be ignored\b/i, weight: 0.5, label: "can't be ignored" },
  { regex: /\bmust not\b/i, weight: 0.6, label: 'must not' },
]

const QUALITY_PATTERNS: readonly PatternDef[] = [
  {
    regex: /\b(terrible|awful|garbage|useless|pathetic)\b/i,
    weight: 0.6,
    label: 'strong negative adj',
  },
  {
    regex: /\boutput is (bad|wrong|incorrect|terrible|garbage)\b/i,
    weight: 0.7,
    label: 'output is X',
  },
  {
    regex: /\bcode quality is (terrible|bad|awful|poor)\b/i,
    weight: 0.7,
    label: 'code quality is X',
  },
]

const BEHAVIOR_PATTERNS: readonly PatternDef[] = [
  { regex: /\byou (should|need to) have\b/i, weight: 0.7, label: 'you should have' },
  {
    regex: /\byou (forgot|missed|ignored|skipped|lied)\b/i,
    weight: 0.8,
    label: 'you forgot/missed',
  },
  {
    regex: /\byou didn['']?t (actually|even|really)\b/i,
    weight: 0.8,
    label: "you didn't actually",
  },
  { regex: /\bwhy would you (lie|skip|ignore|claim)\b/i, weight: 0.8, label: 'why would you lie' },
  { regex: /\byou (just|simply) (said|claimed)\b/i, weight: 0.6, label: 'you just said' },
  { regex: /\byou need to (actually|really)\b/i, weight: 0.7, label: 'you need to actually' },
]

// ── Suppression patterns (reduce false positives) ────────────────────────────

const CODE_BLOCK_RE = /```[\s\S]*?```/g
const INLINE_CODE_RE = /`[^`]+`/g
/** Detect if the text is primarily asking a question (not expressing frustration) */
function isQuestion(text: string): boolean {
  // Rhetorical questions directed at the agent are NOT filtered
  if (/\byou\b/i.test(text) && /\bwhy\b/i.test(text)) return false
  if (/\byou\b/i.test(text) && /\bhow\b/i.test(text) && /\bcould\b/i.test(text)) return false

  const sentences = text.split(/[.!]\s+/)
  const questionCount = sentences.filter((s) => s.trim().endsWith('?')).length
  const totalSentences = sentences.filter((s) => s.trim().length > 0).length
  return totalSentences > 0 && questionCount / totalSentences > 0.7
}

/** Detect if the text is about third-party/external issues (not agent behavior) */
function isThirdPartyReference(text: string): boolean {
  const thirdPartyIndicators = [
    /\b(upstream|external|third[- ]party|their)\s+(API|server|service|code)\b/i,
    /\b(the|an?)\s+(API|server|service|library)\s+(is|returns|throws|gives)\b/i,
  ]
  const agentIndicators = [/\byou\b/i, /\byour\b/i, /\byou['']?(re|ve|d|ll)\b/i]
  const hasThirdParty = thirdPartyIndicators.some((r) => r.test(text))
  const hasAgent = agentIndicators.some((r) => r.test(text))
  return hasThirdParty && !hasAgent
}

/**
 * Detect agent bootstrap / orchestration / handoff prompts (NOT user corrections).
 *
 * The `user-prompt` hook also fires on the session's *opening instructions* to the agent.
 * Those standing directives are dense with imperative/prohibition vocabulary ("ALWAYS
 * quote…", "never claim…", "HARD-STOP") that trips the prohibition/behavior patterns, but
 * they are the agent's own marching orders — not interactive feedback. Scraping them into
 * negative memory mints garbage "don't" rules (issue #5 family). The heuristic detector is
 * the SECONDARY path (the LLM `scns_report_negative_feedback` tool is primary), so we bias
 * toward suppressing anything that is clearly an instruction document rather than a user
 * utterance: a single strong orchestration marker, or two weaker dev/handoff tokens.
 */
function isAgentInstructionPrompt(text: string): boolean {
  // Strong markers: orchestration/handoff vocabulary that essentially never appears in a
  // genuine interactive correction. A single hit classifies the text as instructions.
  const strongMarkers: readonly RegExp[] = [
    /\bhard[- ]stops?\b/i,
    /\bgo[- ]live\b/i,
    /\[\[\s*(?:plan|task)\s*\]\]/i,
    /\bstanding model\b/i,
    /\bouter orchestrator\b/i,
    /\bsub-?agents?\b/i,
    /\bread first\b/i,
    /\bre-?verify\b/i,
    /\bsession-state\b/i,
    /\bclaude-(?:opus|sonnet|haiku)\b/i,
    /(?:^|\n)\s*you are (?:the|an?) [^.\n]{0,60}?\bagent\b/i,
  ]
  if (strongMarkers.some((re) => re.test(text))) return true

  // Weak markers: developer/handoff tokens that can occur individually in genuine messages;
  // require two or more co-occurring to classify the text as an instruction document.
  const weakMarkers: readonly RegExp[] = [
    /\bground truth\b/i,
    /\bhand-?off(?:\.md)?\b/i,
    /\bdefault-o(?:ff|n)\b/i,
    /\bkickstart\b/i,
    /\bplan\.md\b/i,
    /\bTDD\b/,
    /\b(?:npx |npm run )?vitest\b/i,
    /\btsc\b/i,
    /\beslint\b/i,
    /--noEmit/i,
    /\/Users\//,
    /\/tmp\//,
    /\.copilot\//,
    /\bquote (?:a )?real\b/i,
    /\bpriority order\b/i,
    /\bcommitted? locally\b/i,
  ]
  let weakHits = 0
  for (const re of weakMarkers) {
    if (re.test(text) && (weakHits += 1) >= 2) return true
  }
  return false
}

// ── Core analysis ────────────────────────────────────────────────────────────

function stripCodeBlocks(text: string): string {
  return text.replace(CODE_BLOCK_RE, ' ').replace(INLINE_CODE_RE, ' ')
}

function matchSignals(
  text: string,
  patterns: readonly PatternDef[],
  type: SentimentSignalType,
): SentimentSignal | null {
  const triggers: string[] = []
  let maxWeight = 0

  for (const p of patterns) {
    if (p.regex.test(text)) {
      triggers.push(p.label)
      maxWeight = Math.max(maxWeight, p.weight)
    }
  }

  if (triggers.length === 0) return null

  // Score = max weight, boosted slightly by additional matches
  const multiMatchBoost = Math.min(0.15, (triggers.length - 1) * 0.05)
  const score = Math.min(1, maxWeight + multiMatchBoost)
  return { type, score, triggers }
}

function extractSubject(text: string): string {
  // Try to extract the main complaint subject
  const patterns = [
    /you (?:didn['']?t|forgot to|ignored|skipped|lied about) (.{5,100}?)(?:\.|,|$)/i,
    /(?:stop|never|don['']?t) (.{5,100}?)(?:\.|,|$)/i,
    /(?:this is|the .{3,30} is) (broken|wrong|terrible|not working)/i,
    /(?:I wanted|I asked for|I need) (.{5,100}?)(?:\.|,|$)/i,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match?.[1]) {
      return match[1].trim().slice(0, 200)
    }
  }

  // Fallback: first sentence, truncated
  const firstSentence = text.split(/[.!?]/)[0]?.trim() ?? ''
  return firstSentence.slice(0, 200)
}

function synthesizeDontRule(signals: readonly SentimentSignal[], text: string): string {
  // If there's a prohibition signal, the text itself is likely a rule
  const prohibition = signals.find((s) => s.type === 'prohibition')
  if (prohibition) {
    // Extract the prohibition clause
    const prohibitionPatterns = [
      /\b(never .{5,200}?)(?:\.|$)/i,
      /\b(stop .{5,200}?)(?:\.|$)/i,
      /\b(do not .{5,200}?)(?:\.|$)/i,
      /\b(must not .{5,200}?)(?:\.|$)/i,
    ]
    for (const p of prohibitionPatterns) {
      const match = p.exec(text)
      if (match?.[1]) return match[1].trim().slice(0, 300)
    }
  }

  // For behavior complaints, convert to a "Don't" rule
  const behavior = signals.find((s) => s.type === 'behavior-complaint')
  if (behavior) {
    const subject = extractSubject(text)
    if (subject) return `Do not ${subject.toLowerCase()}`
  }

  // For corrections, extract what was wrong
  const correction = signals.find((s) => s.type === 'correction')
  if (correction) {
    const subject = extractSubject(text)
    if (subject) return `Avoid: ${subject}`
  }

  // Fallback
  const subject = extractSubject(text)
  return subject ? `Avoid: ${subject}` : ''
}

function classifyTarget(text: string): RecommendedTarget {
  if (/\b(agent|model|personality|behavior|tone)\b/i.test(text)) return 'agent-profile'
  if (/\b(skill|command|tool|plugin)\b/i.test(text)) return 'skill'
  if (/\b(workflow|process|pipeline|CI|deploy)\b/i.test(text)) return 'workflow'
  if (/\b(format|style|response|output|instruction|template)\b/i.test(text))
    return 'custom-instruction'
  return 'general'
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze text for negative sentiment using strict co-occurring signal detection.
 *
 * Designed to minimize false positives on developer text:
 * - Code blocks are stripped before analysis
 * - Pure questions are not flagged
 * - Third-party references (not about the agent) are not flagged
 * - Requires multiple co-occurring signals OR a single very strong signal (>= 0.75)
 */
export function analyzeSentiment(text: string): SentimentAnalysis {
  const empty: SentimentAnalysis = {
    isNegative: false,
    signals: [],
    overallScore: 0,
    subject: '',
    dontRule: '',
    recommendedTarget: 'general',
  }

  if (!text.trim()) return empty

  // Strip code blocks to avoid false positives from code content
  const cleaned = stripCodeBlocks(text)
  if (!cleaned.trim()) return empty

  // Suppress: pure questions
  if (isQuestion(cleaned)) return empty

  // Suppress: third-party references without agent-directed language
  if (isThirdPartyReference(cleaned)) return empty

  // Suppress: agent bootstrap / orchestration / handoff prompts. These arrive on the
  // user-prompt hook as the session's standing instructions (dense with "ALWAYS…/never…/
  // HARD-STOP") but are NOT interactive user corrections — scraping them mints garbage
  // "don't" rules (issue #5 family). Check the raw text so markers survive code stripping.
  if (isAgentInstructionPrompt(text)) return empty

  // Detect signals
  const signals: SentimentSignal[] = []
  const frustration = matchSignals(cleaned, FRUSTRATION_PATTERNS, 'frustration')
  if (frustration) signals.push(frustration)
  const correction = matchSignals(cleaned, CORRECTION_PATTERNS, 'correction')
  if (correction) signals.push(correction)
  const prohibition = matchSignals(cleaned, PROHIBITION_PATTERNS, 'prohibition')
  if (prohibition) signals.push(prohibition)
  const quality = matchSignals(cleaned, QUALITY_PATTERNS, 'quality-complaint')
  if (quality) signals.push(quality)
  const behavior = matchSignals(cleaned, BEHAVIOR_PATTERNS, 'behavior-complaint')
  if (behavior) signals.push(behavior)

  if (signals.length === 0) return empty

  // Compute overall score: weighted average of signal scores, boosted by co-occurrence
  const maxScore = Math.max(...signals.map((s) => s.score))
  const avgScore = signals.reduce((sum, s) => sum + s.score, 0) / signals.length
  const coOccurrenceBoost = Math.min(0.3, (signals.length - 1) * 0.15)
  // Use max of strongest single signal and average + boost
  const overallScore = Math.min(1, Math.max(maxScore, avgScore + coOccurrenceBoost))

  // Threshold: strong single signal (>= 0.7) OR multiple co-occurring signals
  const isNegative = overallScore >= 0.7 || (signals.length >= 2 && overallScore >= 0.5)

  if (!isNegative) return { ...empty, signals, overallScore }

  const subject = extractSubject(cleaned)
  const dontRule = synthesizeDontRule(signals, cleaned)
  const recommendedTarget = classifyTarget(cleaned)

  return {
    isNegative,
    signals,
    overallScore,
    subject,
    dontRule,
    recommendedTarget,
  }
}
