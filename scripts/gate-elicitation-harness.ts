/**
 * GATE offline capability harness — the MEASURE-ONCE, GATE-faithful grade (arXiv:2310.11589 App-D
 * model-model design). Certifies the mechanism on two controls:
 *
 *   POSITIVE (ambiguous ⇒ ask HELPS): each task has an ambiguous prompt hiding a discrete LATENT intent.
 *     - BLIND: an LLM predicts the latent decision from the prompt ALONE (no elicitation).
 *     - GATE : generate a real clarifying question (deny-all ACP) → a fixed oracle answer reveals the
 *              latent → the LLM predicts the decision from prompt + question + answer.
 *     Alignment = prediction matches the gold decision. GATE alignment should EXCEED blind alignment —
 *     the elicited answer is the task specification `s` that raises human–predictor alignment A(f, f̂(s)).
 *   NEGATIVE (clear ⇒ asking WASTES): clearly-specific prompts must NOT trigger a question (false-ask=0).
 *
 * All ACP spawns are isolated (tmp cwd) + deny-all + bounded + fail-safe. No vault, no experience.db.
 * Run: npx tsx scripts/gate-elicitation-harness.ts   (prints a JSON verdict block for an independent grader)
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAcpClient, createDenyAllPermissionPolicy } from '../src/broker/services/acp-client.js'
import { createAcpGateQuestionProvider } from '../src/memory/gate-question-acp.js'
import { shouldElicit } from '../src/memory/gate-trigger.js'

interface PosTask {
  readonly id: string
  readonly ambiguousPrompt: string
  readonly oracleAnswer: string
  readonly decisionQuestion: string
  readonly options: readonly [string, string]
  readonly gold: string
}

interface NegTask {
  readonly id: string
  readonly clearPrompt: string
}

// Ambiguous prompts (blind cannot know the latent) with a discrete gold the answer reveals. The latent
// is deliberately the NON-default choice — the case GATE exists for: where a blind guess misgeneralizes
// to the obvious default and only asking recovers the human's actual intent (GATE's edge-case rationale).
const POS_TASKS: readonly PosTask[] = [
  {
    id: 'optimize',
    ambiguousPrompt: 'optimize it',
    oracleAnswer: 'The process keeps getting OOM-killed in CI — I care about memory usage, not speed.',
    decisionQuestion: 'Should the change reduce MEMORY usage or improve SPEED?',
    options: ['MEMORY', 'SPEED'],
    gold: 'MEMORY',
  },
  {
    id: 'readability',
    ambiguousPrompt: 'improve the code',
    oracleAnswer: 'The code is hard to read — add comments and clearer names. Performance is already fine.',
    decisionQuestion: 'Should the change prioritize READABILITY or SPEED?',
    options: ['READABILITY', 'SPEED'],
    gold: 'READABILITY',
  },
  {
    id: 'tests',
    ambiguousPrompt: 'make the tests better',
    oracleAnswer: 'We keep shipping bugs the tests should have caught — add missing cases. Speed is fine.',
    decisionQuestion: 'Should the work improve test COVERAGE or test SPEED?',
    options: ['COVERAGE', 'SPEED'],
    gold: 'COVERAGE',
  },
  {
    id: 'output',
    ambiguousPrompt: 'clean up the output',
    oracleAnswer: 'The output is a monochrome wall of text; add color coding so it is scannable. Length is fine.',
    decisionQuestion: 'Should the change reduce VERBOSITY or add COLOR?',
    options: ['VERBOSITY', 'COLOR'],
    gold: 'COLOR',
  },
]

// Clearly-specific prompts — a clarifying question here would waste the human's time.
const NEG_TASKS: readonly NegTask[] = [
  {
    id: 'neg-returnbudget',
    clearPrompt:
      'Add a returnBudget option to adaptiveTraversalSearch in src/memory/adaptive-traversal.ts so Stage-4 sees all visited nodes',
  },
  { id: 'neg-orphans', clearPrompt: 'Explain why chunk_embeddings accumulates orphans in src/memory/db.ts' },
  {
    id: 'neg-detail',
    clearPrompt:
      'Set the magma max token budget to 3400 in the live briefing config and revert to hybrid when the env var is set',
  },
]

function isolatedCwd(): string {
  return mkdtempSync(join(tmpdir(), 'scns-gate-harness-'))
}

/** ONE bounded deny-all ACP turn predicting a discrete decision; returns the matched option or ''. */
async function predictDecision(
  context: string,
  decisionQuestion: string,
  options: readonly [string, string],
): Promise<string> {
  const client = createAcpClient({
    cwd: isolatedCwd(),
    allowAllTools: false,
    permissionPolicy: createDenyAllPermissionPolicy(),
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const prompt =
      `You are helping decide a single design question based only on the information given.\n\n` +
      `Information:\n${context}\n\n` +
      `Question: ${decisionQuestion}\n` +
      `Answer with EXACTLY one word — either ${options[0]} or ${options[1]} — and nothing else.`
    const run = (async (): Promise<string> => {
      await client.initialize()
      const sid = await client.createSession(isolatedCwd())
      return (await client.sendPrompt(sid, prompt)).output
    })()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('predict timeout')), 90_000)
    })
    const raw = (await Promise.race([run, timeout])).toUpperCase()
    // robust parse: which option appears (first-wins on ties by index)
    const i0 = raw.indexOf(options[0].toUpperCase())
    const i1 = raw.indexOf(options[1].toUpperCase())
    if (i0 === -1 && i1 === -1) return ''
    if (i0 === -1) return options[1]
    if (i1 === -1) return options[0]
    return i0 <= i1 ? options[0] : options[1]
  } catch {
    return ''
  } finally {
    if (timer) clearTimeout(timer)
    await client.close().catch(() => {})
  }
}

async function main(): Promise<void> {
  const questionProvider = createAcpGateQuestionProvider({ cwd: isolatedCwd(), attemptTimeoutMs: 90_000 })

  // NEGATIVE control (trigger-level, no LLM): a clear prompt must NOT ask.
  const negResults = NEG_TASKS.map((t) => {
    const d = shouldElicit({ prompt: t.clearPrompt, maxPriorSimilarity: null })
    return { id: t.id, asked: d.ask, reason: d.reason }
  })
  const falseAsks = negResults.filter((r) => r.asked).length

  // POSITIVE control: trigger fires + the elicited answer raises alignment vs blind.
  const posResults: Array<Record<string, unknown>> = []
  let blindHits = 0
  let gateHits = 0
  for (const t of POS_TASKS) {
    const trig = shouldElicit({ prompt: t.ambiguousPrompt, maxPriorSimilarity: null })
    const question = await questionProvider.generate({ taskDescription: t.ambiguousPrompt })
    const blind = await predictDecision(`User request: "${t.ambiguousPrompt}"`, t.decisionQuestion, t.options)
    const gateContext =
      `User request: "${t.ambiguousPrompt}"\n` +
      `Clarifying question asked: ${question}\n` +
      `User's answer: ${t.oracleAnswer}`
    const gate = await predictDecision(gateContext, t.decisionQuestion, t.options)
    const blindOk = blind === t.gold
    const gateOk = gate === t.gold
    if (blindOk) blindHits++
    if (gateOk) gateHits++
    posResults.push({
      id: t.id,
      triggered: trig.ask,
      question,
      gold: t.gold,
      blind,
      blindOk,
      gate,
      gateOk,
    })
    console.error(`[pos:${t.id}] triggered=${trig.ask} blind=${blind}(${blindOk}) gate=${gate}(${gateOk})`)
  }

  const n = POS_TASKS.length
  const verdict = {
    gate_offline_capability: {
      n_pos: n,
      n_neg: NEG_TASKS.length,
      trigger_fired_on_ambiguous: posResults.filter((r) => r.triggered).length,
      false_asks_on_clear: falseAsks,
      blind_alignment: +(blindHits / n).toFixed(3),
      gate_alignment: +(gateHits / n).toFixed(3),
      alignment_delta: +((gateHits - blindHits) / n).toFixed(3),
      pos: posResults,
      neg: negResults,
    },
  }
  // Write to a FILE (the ACP client logs to stdout, which would corrupt a piped JSON capture).
  const outPath = process.env.GATE_HARNESS_OUT ?? '.copilot-scratch/gate-harness-result.json'
  writeFileSync(outPath, JSON.stringify(verdict, null, 2))
  console.error(`\n=== VERDICT written to ${outPath} ===`)
  console.error(JSON.stringify(verdict.gate_offline_capability, null, 2).slice(0, 1200))
}

main().catch((e) => {
  console.error('HARNESS FAILED:', e)
  process.exit(1)
})
