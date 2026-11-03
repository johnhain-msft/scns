/**
 * WS-2 Phase R — WHY-EVAL question set (the causal-subspace answer-value probe).
 *
 * M2 was an honest NEGATIVE: the 38 auto-selected LoCoMo Qs classified WHEN14/ENTITY24/**WHY0**, so the
 * entity-anchored `causalNeighborhood` WHY-read (`intent-search.ts` WHY branch) NEVER fired — the causal
 * subspace was measured only by its non-activation. This module supplies 20 hand-authored, corpus-grounded
 * "Why …" questions that DO trigger the WHY route, so the SAME Arm A (hybrid) vs Arm B (event+causal)
 * LLM-as-a-Judge ruler can measure whether the genuine decision→outcome causal edges have ANSWER-VALUE.
 *
 * Every stem starts with "Why" ⇒ `classifyIntent` returns WHY (precedence WHY→WHEN→ENTITY, causal marker
 * checked first) and names its anchor person ⇒ `matchEntities(query, oracleGaz)` hits, so the WHERE entity=?
 * causal read is anchored. Gold answers are grounded + gradeable (evidence = raw-turn dia_ids, verified vs
 * /tmp/locomo10.json). `category:1` (non-adversarial multi-hop) ⇒ the blind judge grades answer-vs-gold.
 *
 * DEV slice = first 2 conversations = conv-26 (Caroline/Melanie) + conv-30 (Jon/Gina); these 4 speakers are
 * the COMPLETE set of acting-person anchors on the slice. 5 Qs per anchor, evenly spread.
 *
 * PURE + measurement-only: no `src/**` I/O; the only imports are the read-only `classifyIntent` +
 * `matchEntities` used by the build-time validator ({@link validateWhyEvalQuestions}) so a stem that would
 * NOT classify WHY or would NOT match its anchor FAILS the build (anti-mistesting guard).
 */
import { classifyIntent } from '../src/memory/intent.js'
import { matchEntities, type GazetteerEntry } from '../src/memory/entities/gazetteer.js'

/** One hand-authored WHY-route probe: a corpus-grounded causal question + gradeable gold. */
export interface WhyEvalQuestion {
  /** LoCoMo sample_id the anchor lives in ('conv-26' | 'conv-30'). Groups items onto their vault. */
  readonly sampleId: string
  /** Acting-person anchor (gazetteer canonical): 'Caroline' | 'Melanie' | 'Jon' | 'Gina'. */
  readonly anchor: string
  /** The question — MUST start with "Why" (⇒ WHY intent) and name {@link anchor} (⇒ matchEntities hit). */
  readonly question: string
  /** Grounded, gradeable reference answer (App C.3 gold). */
  readonly gold: string
  /** Raw-turn provenance tags `conv-id · speaker · dia_id` (verified vs /tmp/locomo10.json). */
  readonly evidence: readonly string[]
  /** LoCoMo category — 1 (non-adversarial) for every WHY item (blind judge grades answer-vs-gold). */
  readonly category: number
}

/**
 * The 20 WHY-eval questions — 5 per anchor across the 4 DEV-slice speakers. Each gold + anchor + evidence
 * dia_id was verified against the raw LoCoMo turns (/tmp/locomo10.json). If a run's per-anchor edge dump
 * shows an anchor got 0 persisted edges, its 5 Qs fall back (Arm B == Arm A) and are reported honestly +
 * excluded from the fired-subset Δ — NOT padded or replaced (per the durable plan's sparsity rule).
 */
export const WHY_EVAL_QUESTIONS: readonly WhyEvalQuestion[] = [
  // ── conv-26 · Caroline (counseling career, adoption, support-group courage, art/transition) ──
  {
    sampleId: 'conv-26',
    anchor: 'Caroline',
    question: 'Why did Caroline decide to pursue a career in counseling and mental health?',
    gold: 'Because her own struggles with mental health and the support/counseling she received helped her so much that she wanted to help others going through the same things.',
    evidence: ['conv-26 · Caroline · D4:15', 'conv-26 · Caroline · D7:7'],
    category: 1,
  },
  {
    sampleId: 'conv-26',
    anchor: 'Caroline',
    question: 'Why did Caroline start researching adoption agencies?',
    gold: 'Because it had long been her dream to have a family and give a loving home to children who need one (she plans to adopt as a single parent).',
    evidence: ['conv-26 · Caroline · D2:8', 'conv-26 · Caroline · D2:10', 'conv-26 · Caroline · D2:14'],
    category: 1,
  },
  {
    sampleId: 'conv-26',
    anchor: 'Caroline',
    question: 'Why did the support group matter so much to Caroline?',
    gold: 'Because it made her feel accepted and gave her the courage to embrace / be herself.',
    evidence: ['conv-26 · Caroline · D1:3', 'conv-26 · Caroline · D1:7'],
    category: 1,
  },
  {
    sampleId: 'conv-26',
    anchor: 'Caroline',
    question: 'Why did Caroline choose that particular adoption agency?',
    gold: 'Because it helps/supports LGBTQ+ people with adoption — its inclusivity and support spoke to her.',
    evidence: ['conv-26 · Caroline · D2:12'],
    category: 1,
  },
  {
    sampleId: 'conv-26',
    anchor: 'Caroline',
    question: 'Why did Caroline take up painting and drawing?',
    gold: 'Because creating art helped her express her feelings and understand/accept herself during her gender transition.',
    evidence: ['conv-26 · Caroline · D16:9'],
    category: 1,
  },

  // ── conv-26 · Melanie (charity race → self-care, me-time, pottery, running) ──
  {
    sampleId: 'conv-26',
    anchor: 'Melanie',
    question: 'Why did Melanie start carving out daily me-time for herself?',
    gold: 'So she can refresh herself and stay present for her family — self-care she practices through running, reading, or playing violin.',
    evidence: ['conv-26 · Melanie · D2:5'],
    category: 1,
  },
  {
    sampleId: 'conv-26',
    anchor: 'Melanie',
    question: 'Why did Melanie take up a pottery class?',
    gold: 'Because pottery is like therapy for her — it lets her express her emotions and is calming and creative.',
    evidence: ['conv-26 · Melanie · D5:4', 'conv-26 · Melanie · D5:10'],
    category: 1,
  },
  {
    sampleId: 'conv-26',
    anchor: 'Melanie',
    question: 'Why did Melanie start running longer distances?',
    gold: 'To de-stress and clear her mind / for her mental headspace.',
    evidence: ['conv-26 · Melanie · D7:20', 'conv-26 · Melanie · D7:22'],
    category: 1,
  },
  {
    sampleId: 'conv-26',
    anchor: 'Melanie',
    question: 'Why did Melanie have to take a break from pottery?',
    gold: 'Because she got hurt / injured (the previous month).',
    evidence: ['conv-26 · Melanie · D17:8'],
    category: 1,
  },
  {
    sampleId: 'conv-26',
    anchor: 'Melanie',
    question: 'Why did running a charity race change how Melanie thinks about self-care?',
    gold: 'The mental-health charity race was thought-provoking and made her realize self-care is important — looking after herself lets her better look after her family.',
    evidence: ['conv-26 · Melanie · D2:1', 'conv-26 · Melanie · D2:3'],
    category: 1,
  },

  // ── conv-30 · Jon (lost banker job → own business, dance passion → studio, Marley flooring, hosting) ──
  {
    sampleId: 'conv-30',
    anchor: 'Jon',
    question: 'Why did Jon decide to start his own dance studio?',
    gold: 'Because dancing has been his lifelong passion and escape and he wanted to teach others the joy it brings him; losing his banker job gave him the push.',
    evidence: ['conv-30 · Jon · D1:6', 'conv-30 · Jon · D11:3'],
    category: 1,
  },
  {
    sampleId: 'conv-30',
    anchor: 'Jon',
    question: 'Why did Jon start his own business?',
    gold: 'Because he lost his job as a banker, so he decided to take a shot at starting his own business (a dance studio).',
    evidence: ['conv-30 · Jon · D1:2', 'conv-30 · Jon · D11:3'],
    category: 1,
  },
  {
    sampleId: 'conv-30',
    anchor: 'Jon',
    question: 'Why did Jon want Marley flooring for his dance studio?',
    gold: "Because it's grippy yet still lets you move, and it's durable and easy to keep clean — the flooring dance studios usually use.",
    evidence: ['conv-30 · Jon · D2:8'],
    category: 1,
  },
  {
    sampleId: 'conv-30',
    anchor: 'Jon',
    question: 'Why was Jon hosting a dance competition at his studio?',
    gold: 'To showcase local talent and bring more attention to his studio.',
    evidence: ['conv-30 · Jon · D8:13', 'conv-30 · Jon · D8:17'],
    category: 1,
  },
  {
    sampleId: 'conv-30',
    anchor: 'Jon',
    question: 'Why is dancing so meaningful to Jon?',
    gold: "Because it's been his passion and escape since he was a kid and it makes him happy / lets him live as his true self and share it with others.",
    evidence: ['conv-30 · Jon · D1:6', 'conv-30 · Jon · D9:5'],
    category: 1,
  },

  // ── conv-30 · Gina (lost DoorDash → clothing store, fashion+dance blend, promotions, artist collab) ──
  {
    sampleId: 'conv-30',
    anchor: 'Gina',
    question: 'Why did Gina start her own online clothing store?',
    gold: "Because she's passionate about fashion trends / unique pieces and wanted to blend her love of dance and fashion.",
    evidence: ['conv-30 · Gina · D6:6', 'conv-30 · Gina · D6:8'],
    category: 1,
  },
  {
    sampleId: 'conv-30',
    anchor: 'Gina',
    question: 'Why did Gina combine her clothing business with dance?',
    gold: "Because she's passionate about both dance and fashion; combining them lets her express her creativity and share what she loves.",
    evidence: ['conv-30 · Gina · D8:6', 'conv-30 · Gina · D8:8'],
    category: 1,
  },
  {
    sampleId: 'conv-30',
    anchor: 'Gina',
    question: 'Why did Gina run new offers and promotions on her store?',
    gold: 'To bring in new customers and grow her customer base.',
    evidence: ['conv-30 · Gina · D8:4', 'conv-30 · Gina · D8:10'],
    category: 1,
  },
  {
    sampleId: 'conv-30',
    anchor: 'Gina',
    question: 'Why did Gina team up with a local artist for her designs?',
    gold: "To offer unique/different designs and stay ahead of the game — she saw there wasn't much like it around.",
    evidence: ['conv-30 · Gina · D5:5', 'conv-30 · Gina · D5:7'],
    category: 1,
  },
  {
    sampleId: 'conv-30',
    anchor: 'Gina',
    question: 'Why did Gina design her store space to feel cozy and inviting?',
    gold: 'Because she wanted it to reflect her own style and make her customers feel cozy/comfortable while browsing the trendy pieces.',
    evidence: ['conv-30 · Gina · D3:4', 'conv-30 · Gina · D3:6'],
    category: 1,
  },
]

/** One question's validation failure: its index/anchor + the specific problems found. */
export interface WhyEvalIssue {
  readonly index: number
  readonly anchor: string
  readonly problems: readonly string[]
}

/**
 * PURE build-time validator (anti-mistesting): returns the list of questions that FAIL any invariant, so
 * an empty result ⇒ every question is well-formed. Each question must satisfy all four:
 *   1. non-empty gold (trimmed),
 *   2. category ≠ 5 (WHY items are non-adversarial),
 *   3. `classifyIntent(question, gaz) === 'WHY'` (the route actually fires), and
 *   4. `matchEntities(question, gaz)` includes the declared `anchor` (the WHERE entity=? read is anchored).
 *
 * `gaz` MUST contain the anchor speakers (the per-conversation ORACLE gazetteer, or a 4-speaker test gaz) —
 * there is no default, because the LoCoMo speakers are not in the curated SCNS gazetteer.
 */
export function validateWhyEvalQuestions(
  qs: readonly WhyEvalQuestion[],
  gaz: readonly GazetteerEntry[],
): WhyEvalIssue[] {
  const issues: WhyEvalIssue[] = []
  qs.forEach((q, index) => {
    const problems: string[] = []
    if (!q.gold || q.gold.trim() === '') problems.push('empty gold')
    if (q.category === 5) problems.push('category 5 (adversarial) not allowed for a WHY item')
    if (classifyIntent(q.question, gaz) !== 'WHY') {
      problems.push(`does not classify as WHY (got '${classifyIntent(q.question, gaz)}')`)
    }
    const matched = matchEntities(q.question, gaz).map((m) => m.canonical)
    if (!matched.includes(q.anchor)) {
      problems.push(`anchor '${q.anchor}' not matched by matchEntities (matched: ${matched.join(',') || 'none'})`)
    }
    if (problems.length > 0) issues.push({ index, anchor: q.anchor, problems })
  })
  return issues
}

/**
 * PURE: group WHY questions by their `sampleId` (declaration order preserved within each group), so the
 * harness can attach each item to its per-conversation isolated vault + oracle gazetteer.
 */
export function groupWhyQuestionsBySample(
  qs: readonly WhyEvalQuestion[],
): Map<string, WhyEvalQuestion[]> {
  const bySample = new Map<string, WhyEvalQuestion[]>()
  for (const q of qs) {
    const arr = bySample.get(q.sampleId)
    if (arr) arr.push(q)
    else bySample.set(q.sampleId, [q])
  }
  return bySample
}
