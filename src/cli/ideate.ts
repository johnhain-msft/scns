/**
 * CLI runner for `scns ideate` (Ideation wedge, D1).
 *
 * DEFAULT-OFF + advisory-first + double-gated:
 *   - With no `--spawn` it is a DRY RUN: it gathers real signals, builds the
 *     ideation prompt, and PRINTS it. No agent is spawned, nothing is written.
 *   - With `--spawn` it performs the real, isolated, deny-all Copilot ACP
 *     ideation call — but ONLY when `SCNS_IDEATION=1` (the master gate). The
 *     proposals land in `~/.scns/ideation/` for human review; they are NEVER
 *     auto-spawned in D1.
 *
 * `runIdeate` takes injected deps (sources / worktree / backend factories) so
 * the dry-run and gated-spawn logic is unit-tested without ever spawning a real
 * `copilot` process. `runIdeateCommand` wires the real deps for production use.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveScnsHome } from '../shared/scns-home.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  gatherIdeationSignals,
  buildIdeationPrompt,
  runIdeation,
  ideationEnabledFromEnv,
  synthEnabledFromEnv,
  memGapsEnabledFromEnv,
  createIdeationInbox,
  createDefaultIdeationBackend,
  createSynthIdeationBackend,
  deriveOpenGaps,
  readCodebaseSignal,
  summarizeRecentOutcomes,
  telemetrySignalFromPatterns,
  feedbackEnabledFromEnv,
  applyLinkedOutcomes,
  buildPriorOutcomes,
} from '../ideate/index.js'
import type {
  IdeationSignalSources,
  IdeationBackend,
  GapSignal,
  TelemetrySignal,
  PriorProposalOutcome,
} from '../ideate/index.js'

/** One-line orientation for the agent about what SCNS is. */
const PROJECT_DESCRIPTION =
  'SCNS (Second Central Nervous System) — an autonomous, self-improving multi-agent ' +
  'system that observes the user, consolidates memory, and proposes and implements its ' +
  'own improvements. Written in TypeScript; a long-running broker spawns Copilot agents.'

/** Known open gaps fed into the prompt (static in D1; D2 may pull live issues). */
export const DEFAULT_OPEN_GAPS: readonly GapSignal[] = [
  {
    source: 'github-issue-5',
    detail:
      'The auto-merger refuses to merge when the live working tree is dirty, and the ' +
      'dream daemon dirties it by writing uncommitted negative-memory edits.',
  },
]

export interface IdeateOptions {
  readonly k: number
  readonly spawn: boolean
  readonly json: boolean
  readonly model?: string
}

export type MakeWorktree = (
  projectRoot: string,
  env: NodeJS.ProcessEnv,
) => { cwd: string; cleanup: () => void }

export type MakeBackend = (cwd: string, model?: string) => IdeationBackend

export interface IdeateDeps {
  readonly sources: IdeationSignalSources
  readonly inboxDir: string
  readonly projectRoot: string
  readonly env: NodeJS.ProcessEnv
  readonly print: (line: string) => void
  /** Spawn-path seam; defaults injected by {@link runIdeateCommand}. */
  readonly makeWorktree?: MakeWorktree
  /** Spawn-path seam; defaults injected by {@link runIdeateCommand}. */
  readonly makeBackend?: MakeBackend
}

export interface IdeateResult {
  readonly mode: 'dry-run' | 'refused' | 'spawned'
  readonly reason?: string
  readonly promptChars: number
  readonly received: number
  readonly dropped: number
  readonly written: number
  readonly inboxDir: string
  readonly worktree?: string
}

/**
 * Run the ideate command. Pure orchestration over injected deps — the only IO
 * is the caller-supplied `print`, the inbox writes (a temp dir in tests), and,
 * on the gated spawn path, the injected worktree/backend factories.
 */
export async function runIdeate(deps: IdeateDeps, opts: IdeateOptions): Promise<IdeateResult> {
  const signals = gatherIdeationSignals(deps.sources)
  const prompt = buildIdeationPrompt(signals, { k: opts.k })

  // ── DRY RUN (default): print the prompt, spawn nothing, write nothing. ──
  if (!opts.spawn) {
    const result: IdeateResult = {
      mode: 'dry-run',
      promptChars: prompt.length,
      received: 0,
      dropped: 0,
      written: 0,
      inboxDir: deps.inboxDir,
    }
    if (opts.json) {
      deps.print(JSON.stringify({ ...result, prompt }, null, 2))
    } else {
      deps.print(prompt)
      deps.print('')
      deps.print(
        '── DRY RUN — no agent spawned, nothing written. Re-run with `--spawn` and ' +
          '`SCNS_IDEATION=1` to generate real proposals into ' +
          deps.inboxDir +
          ' ──',
      )
    }
    return result
  }

  // ── SYNTH: deterministic, evidence-first synthesizer (no ACP, no network). ──
  // Opt-in via SCNS_IDEATE_SYNTH=1 + --spawn. Writes advisory proposals from real
  // signals with zero spawn — the safe novelty path when a real agent isn't wanted.
  if (synthEnabledFromEnv(deps.env)) {
    const inbox = createIdeationInbox(deps.inboxDir)
    const backend = createSynthIdeationBackend(signals, { k: opts.k })
    const res = await runIdeation(
      { sources: deps.sources, backend, inbox, model: 'synth', source: 'synth-ideation' },
      { enabled: true, k: opts.k },
    )
    const summary: IdeateResult = {
      mode: 'spawned',
      reason: res.skipReason,
      promptChars: res.promptChars,
      received: res.received,
      dropped: res.dropped,
      written: res.written.length,
      inboxDir: deps.inboxDir,
    }
    if (opts.json) {
      deps.print(JSON.stringify({ ...summary, ids: res.written.map((r) => r.id) }, null, 2))
    } else {
      deps.print(
        `✅ synth ideation — ${res.written.length} evidence-first proposal(s) written to ${deps.inboxDir} ` +
          `(received ${res.received}, dropped ${res.dropped}, no agent spawned).`,
      )
      for (const r of res.written) deps.print(`  • [${r.id}] ${r.title}`)
    }
    return summary
  }

  // ── SPAWN: gated on the SCNS_IDEATION master flag. ──
  if (!ideationEnabledFromEnv(deps.env)) {
    const reason =
      'real ideation spawn refused: set SCNS_IDEATION=1 to enable the first real ' +
      'copilot --acp ideation call (default-OFF master gate).'
    deps.print(opts.json ? JSON.stringify({ mode: 'refused', reason }) : `⛔ ${reason}`)
    return {
      mode: 'refused',
      reason,
      promptChars: prompt.length,
      received: 0,
      dropped: 0,
      written: 0,
      inboxDir: deps.inboxDir,
    }
  }

  const makeWorktree = deps.makeWorktree
  const makeBackend = deps.makeBackend
  if (makeWorktree == null || makeBackend == null) {
    throw new Error('runIdeate spawn path requires makeWorktree + makeBackend deps')
  }

  const worktree = makeWorktree(deps.projectRoot, deps.env)
  try {
    const backend = makeBackend(worktree.cwd, opts.model)
    const inbox = createIdeationInbox(deps.inboxDir)
    const res = await runIdeation(
      { sources: deps.sources, backend, inbox, model: opts.model ?? '' },
      { enabled: true, k: opts.k },
    )

    // Always persist the raw agent response for inspection/diagnostics.
    if (res.raw !== '') {
      try {
        mkdirSync(deps.inboxDir, { recursive: true })
        writeFileSync(join(deps.inboxDir, '.last-response.txt'), res.raw, 'utf-8')
      } catch {
        // best-effort diagnostics only
      }
    }

    const summary = {
      mode: 'spawned' as const,
      reason: res.skipReason,
      promptChars: res.promptChars,
      received: res.received,
      dropped: res.dropped,
      written: res.written.length,
      inboxDir: deps.inboxDir,
      worktree: worktree.cwd,
    }
    if (opts.json) {
      deps.print(JSON.stringify({ ...summary, ids: res.written.map((r) => r.id) }, null, 2))
    } else if (res.ran && res.written.length > 0) {
      deps.print(
        `✅ ideation complete — ${res.written.length} proposal(s) written to ${deps.inboxDir} ` +
          `(received ${res.received}, dropped ${res.dropped}). Review the JSON files under that dir.`,
      )
      for (const r of res.written) deps.print(`  • [${r.id}] ${r.title}`)
    } else if (res.ran) {
      // Ran but produced nothing usable — surface the raw response so the
      // outcome is debuggable rather than a silent zero.
      deps.print(
        `⚠️  ideation ran but parsed 0 usable proposals (received ${res.received}, ` +
          `dropped ${res.dropped}). Raw agent response saved to ${join(deps.inboxDir, '.last-response.txt')}.`,
      )
      const preview = res.raw.trim().slice(0, 1200)
      deps.print(preview === '' ? '  (the agent returned an empty response)' : `── raw preview ──\n${preview}`)
    } else {
      deps.print(`⚠️  ideation did not run (${res.skipReason ?? 'unknown'})${res.error ? `: ${res.error}` : ''}`)
    }
    return summary
  } finally {
    worktree.cleanup()
  }
}

// ── Real-deps wrapper (production) ───────────────────────────────────

async function computeTelemetrySignal(dbPath: string): Promise<TelemetrySignal | null> {
  try {
    const { default: Database } = await import('better-sqlite3')
    const { extractSessionSummaries } = await import('../otel/session-extractor.js')
    const { extractPatterns } = await import('../otel/pattern-extractor.js')
    // READONLY: never migrate/mutate the live broker DB (it is in active use by
    // the running broker). Matches the selfopt commands' readonly access.
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      const summaries = extractSessionSummaries(db, { limit: 500 })
      return telemetrySignalFromPatterns(extractPatterns(summaries))
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

async function buildRealSources(args: {
  projectRoot: string
  dbPath: string
  scnsDir: string
  env: NodeJS.ProcessEnv
}): Promise<IdeationSignalSources> {
  const telemetry = await computeTelemetrySignal(args.dbPath)
  const { createSuggestionStore } = await import('../suggest/suggestion-store.js')
  const failedTitles = (): string[] => {
    try {
      const store = createSuggestionStore({ rootDir: join(args.scnsDir, 'suggestions') })
      return store.list().filter((s) => s.status === 'failed').map((s) => s.title)
    } catch {
      return []
    }
  }
  // DEFAULT-OFF: only derive gaps from the corpus when SCNS_IDEATE_MEMGAPS=1; the
  // static seeds stay the base so the fallback path is unchanged. Read-only.
  const openGaps = memGapsEnabledFromEnv(args.env)
    ? deriveOpenGaps({
        negativeMemories: await loadNegMemThemes(args.scnsDir),
        failed: failedTitles(),
        seeds: DEFAULT_OPEN_GAPS,
      })
    : [...DEFAULT_OPEN_GAPS]
  // D2 feedback (default-OFF: SCNS_IDEATE_FEEDBACK=1). Link inbox proposals to
  // realized suggestion fates, then feed those outcomes back so the prompt/synth
  // learn — a landed idea is never re-proposed. Best-effort, advisory, read-only
  // apart from stamping the inbox's own records.
  let priorOutcomes: PriorProposalOutcome[] = []
  if (feedbackEnabledFromEnv(args.env)) {
    try {
      const inbox = createIdeationInbox(join(args.scnsDir, 'ideation'))
      const store = createSuggestionStore({ rootDir: join(args.scnsDir, 'suggestions') })
      const all = store.list()
      const byStatus = (s: string) => all.filter((x) => x.status === s).map((x) => x.title)
      applyLinkedOutcomes(inbox, {
        implemented: byStatus('implemented'),
        rejected: byStatus('rejected'),
        failed: byStatus('failed'),
      })
      priorOutcomes = buildPriorOutcomes(inbox.list())
    } catch {
      priorOutcomes = []
    }
  }
  return {
    telemetry: () => telemetry,
    codebase: () => readCodebaseSignal(join(args.projectRoot, 'src'), PROJECT_DESCRIPTION),
    recentOutcomes: () => {
      try {
        const store = createSuggestionStore({ rootDir: join(args.scnsDir, 'suggestions') })
        return summarizeRecentOutcomes(
          store.list().map((s) => ({ title: s.title, status: s.status })),
        )
      } catch {
        return { implemented: [], rejected: [], failed: [], pendingCount: 0 }
      }
    },
    openGaps: () => openGaps,
    priorProposalOutcomes: () => priorOutcomes,
  }
}

/** Read eligible negative-memory themes from the vault (read-only; [] on any failure). */
async function loadNegMemThemes(scnsDir: string) {
  try {
    const { createVault } = await import('../memory/vault.js')
    const { createNegativeMemoryStore } = await import('../memory/negative-memory-store.js')
    const vault = createVault({ rootDir: join(scnsDir, 'memory') })
    const store = createNegativeMemoryStore(vault)
    return store.list({ limit: 1000 }).map((m) => ({
      dontRule: m.dontRule,
      category: m.category,
      confidence: m.confidence,
      pinned: m.pinned ?? false,
      criticStatus: m.criticVerdict?.status ?? null,
    }))
  } catch {
    return []
  }
}

/** Build production deps (broker config, stores, isolated worktree) and run. */
export async function runIdeateCommand(opts: IdeateOptions): Promise<void> {
  const scnsDir = join(resolveScnsHome(), '.scns')
  const inboxDir = join(scnsDir, 'ideation')

  let projectRoot = process.cwd()
  let dbPath = join(homedir(), '.session-broker', 'data.db')
  try {
    const { loadConfig } = await import('../broker/config.js')
    const cfg = loadConfig()
    projectRoot = cfg.projectRoot
    dbPath = cfg.dbPath
  } catch {
    // fall back to cwd + default broker db path
  }

  const sources = await buildRealSources({ projectRoot, dbPath, scnsDir, env: process.env })
  const { createDetachedWorktree } = await import('../selfopt/shadow-eval-runner.js')

  await runIdeate(
    {
      sources,
      inboxDir,
      projectRoot,
      env: process.env,
      print: (line) => console.log(line),
      makeWorktree: (root, env) => createDetachedWorktree(root, env),
      makeBackend: (cwd, model) =>
        createDefaultIdeationBackend({ cwd, ...(model ? { model } : {}) }),
    },
    opts,
  )
}
