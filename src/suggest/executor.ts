/**
 * Executor — generates and executes implementation plans for approved suggestions.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { execSync } from 'node:child_process'
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from 'node:path'
import { homedir } from 'node:os'
import { resolveScnsHome } from '../shared/scns-home.js'
import type { Suggestion } from './types.js'
import { generateArtifact } from './artifact-generators.js'
import type { ArtifactOutput } from './artifact-generators.js'
import { ScnsError } from '../shared/errors.js'
import { parseLesson, serializeLesson } from '../memory/lessons.js'
import { createTaxonomyStore } from '../memory/taxonomy.js'
import {
  LSP_CONFIG_REL,
  SUGGESTED_INSTRUCTIONS_REL,
  lspConfigPath,
  suggestedInstructionsPath,
} from './artifact-targets.js'
import {
  lspServerConfigEntry,
  lspServerForTags,
  readConfiguredLspServerIds,
} from './lsp-servers.js'

export const StepAction = {
  CreateFile: 'create-file',
  ModifyFile: 'modify-file',
  RunCommand: 'run-command',
  InstallPackage: 'install-package',
  ConfigureAgent: 'configure-agent',
  /**
   * Phase 13.12.7: append a bullet to a managed block in a file.
   * `target` is the file path; `content` is the bullet text (one line, no
   * leading "- "). Executor reads the file, finds or creates the managed
   * block between `blockStart` / `blockEnd`, and appends the bullet if not
   * already present (idempotent).
   */
  AppendToBlock: 'append-to-block',
  /**
   * Phase 13.12.12: apply a tag to a set of lesson .md files by modifying
   * their YAML frontmatter `tags:` list. Idempotent — skips lessons that
   * already carry the tag. Also records the tag in the taxonomy registry.
   *
   * - `target`   : lessons root directory (e.g. `~/.scns/memory/lessons`)
   * - `content`  : JSON payload `{tagName, lessonIds, taxonomyPath, entry}`
   */
  ApplyTagToLessons: 'apply-tag-to-lessons',
  /**
   * Phase 13.12.18: spawn the bundled browser-automation skill runner.
   * `target` is the run directory under `~/.scns/browser-runs/<runId>/`;
   * `content` is the JSON plan that will be piped to the runner's stdin.
   * Gated to writable prefix `~/.scns/browser-runs/**`. Allowed at L2+.
   */
  RunBrowserPlan: 'run-browser-plan',
  /**
   * Register a language server in Copilot CLI's `lsp-config.json`.
   *
   * Distinct from `ConfigureAgent` because that action merges only at the TOP level: writing
   * `{lspServers: {python: …}}` through it would replace the whole `lspServers` object and silently
   * unregister every other language server. This action merges one level deeper, under `lspServers`,
   * so registering one server never deletes another.
   *
   * - `target`  : absolute path to `lsp-config.json`
   * - `content` : JSON `{ "<serverId>": { command, args, fileExtensions } }`
   */
  ConfigureLspServer: 'configure-lsp-server',
} as const

export type StepAction = (typeof StepAction)[keyof typeof StepAction]

export interface ExecutorOptions {
  readonly autonomyLevel?: number
  readonly skillsDir?: string
  readonly automationsDir?: string
  /** Base directory for config files (defaults to homedir). Tests should override to avoid writing to real config. */
  readonly configBaseDir?: string
  /** Phase 13.12.12: lessons root (defaults to `<configBaseDir>/.scns/memory/lessons`). */
  readonly lessonsDir?: string
  /** Phase 13.12.12: taxonomy YAML path (defaults to `<configBaseDir>/.scns/memory/.taxonomy.yml`). */
  readonly taxonomyPath?: string
  /**
   * Phase 13.12.18: root for browser-automation run artifacts
   * (defaults to `<configBaseDir>/.scns/browser-runs`).
   */
  readonly browserRunsDir?: string
  /**
   * Phase 13.12.18: absolute path to the bundled browser-automation runner
   * (defaults to `~/.copilot/skills/browser-automation/run.mjs`).
   */
  readonly browserRunnerPath?: string
  /**
   * Repository root for the two types that legitimately write into a working tree
   * (`github-action`, whose artifact is meaningless outside a repo). Defaults to `process.cwd()`.
   * Made explicit because these builders previously emitted a RELATIVE target that resolved
   * against whatever cwd the brain ran in, while their gate only permitted `configBaseDir` — so
   * they were gate-rejected no matter how the double repo-write opt-in was set.
   */
  readonly repoRoot?: string
}

export interface ImplementationStep {
  readonly order: number
  readonly action: StepAction
  readonly description: string
  readonly target?: string
  readonly content?: string
  /** Phase 13.12.7: AppendToBlock managed-block markers. */
  readonly blockStart?: string
  readonly blockEnd?: string
  /** Phase 13.12.7: optional heading rendered inside a new managed block. */
  readonly blockHeading?: string
}

export interface ImplementationPlan {
  readonly suggestionId: string
  readonly steps: readonly ImplementationStep[]
  readonly estimatedMinutes: number
  readonly requiresUserApproval: boolean
}

export interface ExecutionResult {
  readonly success: boolean
  readonly stepsCompleted: number
  readonly stepsTotal: number
  readonly errors: readonly string[]
  readonly filesCreated: readonly string[]
  /**
   * Phase 13.12.18: when non-null, the safety gate short-circuited execution
   * before any step ran. Callers (review workflow) use this to set the
   * suggestion status — `rejected` for out-of-gate paths, `needs-human`
   * for missing repo-write opt-ins.
   */
  readonly gateDecision?: GateDecision
}

const TYPE_ESTIMATED_MINUTES: Record<string, number> = {
  skill: 5,
  mcp: 10,
  automation: 15,
  workflow: 5,
  agent: 10,
  prompt: 2,
  extension: 10,
  lsp: 3,
  'github-action': 15,
  'agentic-workflow': 20,
  instruction: 2,
  'browser-automation': 10,
}

function buildSkillSteps(
  suggestion: Suggestion,
  skillsDir: string,
  configBaseDir: string,
): readonly ImplementationStep[] {
  const target = join(skillsDir, `${suggestion.id}.md`)
  const content = [
    `# ${suggestion.title}`,
    '',
    suggestion.description,
    '',
    `## Tags`,
    suggestion.tags.map((t) => `- ${t}`).join('\n'),
  ].join('\n')

  return [
    { order: 1, action: StepAction.CreateFile, description: `Create skill file`, target, content },
    {
      order: 2,
      action: StepAction.ConfigureAgent,
      description: `Register skill in agent config`,
      target: join(configBaseDir, '.scns', 'config', 'skills.json'),
      content: JSON.stringify({ [suggestion.id]: { title: suggestion.title, path: target } }),
    },
  ]
}

function buildMcpSteps(
  suggestion: Suggestion,
  configBaseDir: string,
): readonly ImplementationStep[] {
  // Phase 13.12.1: artifact-only. Actually installing the MCP server package
  // is an explicit action performed by the user (or an L3 follow-up), not by
  // the brain's auto-executor. This step just registers the intent in config.
  return [
    {
      order: 1,
      action: StepAction.ConfigureAgent,
      description: `Add MCP server to config`,
      target: join(configBaseDir, '.copilot', 'mcp-config.json'),
      content: JSON.stringify({
        [suggestion.id]: { title: suggestion.title, installed: false },
      }),
    },
  ]
}

function buildAutomationSteps(
  suggestion: Suggestion,
  automationsDir: string,
): readonly ImplementationStep[] {
  const target = join(automationsDir, `${suggestion.id}.sh`)
  const content = [
    `#!/usr/bin/env bash`,
    `# ${suggestion.title}`,
    `# ${suggestion.description}`,
    `set -euo pipefail`,
    '',
  ].join('\n')

  // Phase 13.12.1: artifact-only. CreateFile now writes with mode 0o755 so
  // the script is executable without a separate chmod RunCommand step (which
  // would be gated at L3+, causing the plan to permanently fail at L2).
  return [
    {
      order: 1,
      action: StepAction.CreateFile,
      description: `Create automation script`,
      target,
      content,
    },
  ]
}

// Phase 13.12.1 amendment: `buildWorkflowSteps` removed. Workflow-type
// suggestions describe a multi-step human process (not an artifact) and
// must be routed to a human planner. See `generatePlan` which throws
// ScnsError('NEEDS_HUMAN') for this type.

function buildAgentSteps(
  suggestion: Suggestion,
  skillsDir: string,
  configBaseDir: string,
): readonly ImplementationStep[] {
  const target = join(skillsDir, `${suggestion.id}-agent.md`)
  const content = [`# Agent: ${suggestion.title}`, '', suggestion.description].join('\n')

  return [
    {
      order: 1,
      action: StepAction.CreateFile,
      description: `Create agent config`,
      target,
      content,
    },
    {
      order: 2,
      action: StepAction.ConfigureAgent,
      description: `Register agent with broker`,
      target: join(configBaseDir, '.scns', 'config', 'agents.json'),
      content: JSON.stringify({ [suggestion.id]: { title: suggestion.title, path: target } }),
    },
  ]
}

function buildPromptSteps(
  suggestion: Suggestion,
  skillsDir: string,
): readonly ImplementationStep[] {
  const target = join(skillsDir, `${suggestion.id}-prompt.md`)
  const content = [
    `# Prompt: ${suggestion.title}`,
    '',
    suggestion.description,
    '',
    '## Usage',
    '',
    'Add to `.github/copilot-instructions.md` or `CLAUDE.md`.',
  ].join('\n')

  return [
    { order: 1, action: StepAction.CreateFile, description: `Create prompt file`, target, content },
  ]
}

function buildExtensionSteps(
  suggestion: Suggestion,
  configBaseDir: string,
): readonly ImplementationStep[] {
  const name = suggestion.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  // Absolute, and anchored to the same root the safety gate permits. This used to be the relative
  // string `.github/extensions/<name>.js`, which resolved against whatever `process.cwd()` the
  // brain happened to run in — so the gate rejected every plan this builder could produce, and on
  // the one cwd where it would have passed ($HOME) it wrote to a path nothing reads.
  const target = join(configBaseDir, '.github', 'extensions', `${name}.js`)
  const content = [
    `// Extension: ${suggestion.title}`,
    `// ${suggestion.description}`,
    '',
    'module.exports = {',
    `  name: '${name}',`,
    '  activate(context) {',
    '    // TODO: implement extension logic',
    '  },',
    '}',
  ].join('\n')

  return [
    {
      order: 1,
      action: StepAction.CreateFile,
      description: `Create extension skeleton`,
      target,
      content,
    },
  ]
}

/**
 * An `lsp` suggestion registers a real language server in Copilot CLI's `lsp-config.json`.
 *
 * Previously this returned a single `ModifyFile` step with NO `target`, which the executor treats
 * as a no-op placeholder — so the type could never do anything, and `lsp-extractor.ts` worked
 * around it by mislabelling LSP proposals as `instruction`. The server is resolved from the
 * suggestion's own tags so proposals already on disk stay executable.
 */
function buildLspSteps(
  suggestion: Suggestion,
  configBaseDir: string,
): readonly ImplementationStep[] {
  const spec = lspServerForTags(suggestion.tags)
  if (!spec) {
    // Refuse rather than write a guess: an unrecognised language has no launch command, and a
    // config naming a server that cannot start is worse than no config at all.
    throw new ScnsError(
      `no language-server spec for tags [${suggestion.tags.join(', ')}] — a human must name the server and its launch command`,
      'NEEDS_HUMAN',
    )
  }

  return [
    {
      order: 1,
      action: StepAction.ConfigureLspServer,
      description: `Register ${spec.lspName} for ${Object.keys(spec.fileExtensions).join(', ')} in ${LSP_CONFIG_REL}`,
      target: lspConfigPath(configBaseDir),
      content: JSON.stringify(lspServerConfigEntry(spec)),
    },
  ]
}

function buildGithubActionSteps(
  suggestion: Suggestion,
  repoRoot: string,
): readonly ImplementationStep[] {
  const name = suggestion.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  const target = join(repoRoot, '.github', 'workflows', `${name}.yml`)
  const content = [
    `# ${suggestion.title}`,
    `# ${suggestion.description}`,
    '',
    'name: ' + suggestion.title,
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '    branches: [main]',
    '',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: TODO',
    '        run: echo "Implement workflow steps"',
  ].join('\n')

  return [
    {
      order: 1,
      action: StepAction.CreateFile,
      description: `Create GitHub Actions workflow`,
      target,
      content,
    },
  ]
}

function buildAgenticWorkflowSteps(
  suggestion: Suggestion,
  skillsDir: string,
): readonly ImplementationStep[] {
  const target = join(skillsDir, `${suggestion.id}-agentic-workflow.md`)
  const content = [
    `# Agentic Workflow: ${suggestion.title}`,
    '',
    suggestion.description,
    '',
    '## Steps',
    '',
    '1. Observe context',
    '2. Decide action',
    '3. Execute step',
    '4. Validate result',
  ].join('\n')

  return [
    {
      order: 1,
      action: StepAction.CreateFile,
      description: `Create agentic workflow definition`,
      target,
      content,
    },
    {
      order: 2,
      action: StepAction.ConfigureAgent,
      description: `Register workflow with orchestrator`,
      target: join(skillsDir, 'workflows.json'),
      content: JSON.stringify({ [suggestion.id]: { title: suggestion.title } }),
    },
  ]
}

function buildTagProposalSteps(
  suggestion: Suggestion,
  lessonsDir: string,
  taxonomyPath: string,
): readonly ImplementationStep[] {
  const payload = suggestion.tagProposal
  if (!payload) {
    throw new ScnsError(
      `tag-proposal suggestion ${suggestion.id} missing tagProposal payload`,
      'INVALID_STATE',
    )
  }
  return [
    {
      order: 1,
      action: StepAction.ApplyTagToLessons,
      description: `Apply tag "${payload.tagName}" to ${payload.candidateLessonIds.length} lesson(s)`,
      target: lessonsDir,
      content: JSON.stringify({
        tagName: payload.tagName,
        lessonIds: payload.candidateLessonIds,
        taxonomyPath,
        entry: {
          name: payload.tagName,
          scope: payload.scope,
          project: payload.project,
          agent: payload.agent,
        },
      }),
    },
  ]
}

/**
 * Is `command` an executable on `PATH`? Used by the `lsp` preflight so the executor never writes a
 * language-server entry that cannot spawn. Absolute/relative paths are checked directly.
 */
function commandExistsOnPath(command: string): boolean {
  if (command.includes('/') || command.includes(sep)) {
    return existsSync(resolve(command))
  }
  const path = process.env.PATH ?? ''
  return path
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .some((dir) => existsSync(join(dir, command)))
}

export const SUGGESTED_INSTRUCTIONS_BLOCK_START = '<!-- SCNS:suggested-instructions:start -->'
export const SUGGESTED_INSTRUCTIONS_BLOCK_END = '<!-- SCNS:suggested-instructions:end -->'
export const SUGGESTED_INSTRUCTIONS_HEADING = '## SCNS — Suggested instructions'
/**
 * Re-exported from `artifact-targets.ts` — that module, not this one, owns where artifacts land,
 * so the sentence shown to John and the path written here cannot drift apart again.
 */
const SUGGESTED_INSTRUCTIONS_TARGET = SUGGESTED_INSTRUCTIONS_REL

/**
 * Phase 13.12.18 — executor safety gates.
 *
 * For each suggestion type, a list of allowed writable path prefixes. The
 * executor refuses to write outside these prefixes and marks the suggestion
 * `rejected` with an explanatory reason. `null` means "no file writes
 * expected" and every CreateFile/ModifyFile/AppendToBlock/ConfigureAgent
 * step for that type is rejected.
 *
 * Prefixes may contain the sentinel `<HOME>` which is replaced with the
 * process home dir at gate-resolution time, and `<CONFIG_BASE>` which is
 * replaced with the executor's configBaseDir.
 */
interface SafetyGate {
  /** Absolute-path prefixes (directories) that may be written to. */
  readonly writableDirs: readonly string[]
  /** If set, target path must match this exact file (prefix match not enough). */
  readonly exactFile?: string
  /** Optional pre-flight check that can force `needs-human` status. */
  readonly preflight?: (
    suggestion: Suggestion,
  ) => { ok: true } | { ok: false; reason: string; needsHuman?: boolean }
}

/**
 * `gateViolationReason` is what we surface back to the brain / operator when
 * the executor refuses to run a plan. Kept short and actionable.
 */
export interface GateDecision {
  readonly ok: boolean
  /** "rejected" | "needs-human" | "ok" */
  readonly status: 'ok' | 'rejected' | 'needs-human'
  readonly reason?: string
}

function resolveGates(
  type: string,
  configBaseDir: string,
  browserRunsDir: string,
  automationsDir: string,
  skillsDir: string,
  lessonsDir: string,
  taxonomyPath: string,
  repoRoot: string,
): SafetyGate {
  const configAbs = resolve(configBaseDir)
  const automationsAbs = resolve(automationsDir)
  const browserRunsAbs = resolve(browserRunsDir)
  const skillsAbs = resolve(skillsDir)
  const lessonsAbs = resolve(lessonsDir)
  const taxonomyAbs = resolve(taxonomyPath)

  switch (type) {
    case 'automation':
      return { writableDirs: [automationsAbs] }
    case 'browser-automation':
      return { writableDirs: [browserRunsAbs] }
    case 'instruction':
      return {
        writableDirs: [configAbs],
        exactFile: resolve(join(configAbs, SUGGESTED_INSTRUCTIONS_TARGET)),
      }
    case 'github-action':
      // A workflow file is inert outside a repository, so the permitted directory is the repo's
      // own `.github/workflows` — matching what the builder targets and what the human is told.
      // The two opt-ins below are what make that repo write deliberate rather than incidental.
      return {
        writableDirs: [resolve(join(repoRoot, '.github', 'workflows'))],
        preflight: (s) => {
          if (!s.allowRepoWrites) {
            return {
              ok: false,
              needsHuman: true,
              reason:
                'repo writes require explicit allow flag: set suggestion.allowRepoWrites=true',
            }
          }
          if (process.env.SCNS_ALLOW_REPO_WRITES !== '1') {
            return {
              ok: false,
              needsHuman: true,
              reason:
                'repo writes require explicit allow flag: env SCNS_ALLOW_REPO_WRITES=1 not set',
            }
          }
          return { ok: true }
        },
      }
    case 'skill':
    case 'agent':
    case 'prompt':
    case 'agentic-workflow':
      return { writableDirs: [skillsAbs, configAbs] }
    case 'mcp':
      return { writableDirs: [configAbs] }
    case 'extension':
      return { writableDirs: [resolve(join(configAbs, '.github', 'extensions'))] }
    case 'lsp':
      return {
        writableDirs: [configAbs],
        exactFile: resolve(lspConfigPath(configAbs)),
        // Writing a server into `lsp-config.json` whose executable is not installed produces a
        // config that fails to spawn on every future session — a silent, permanent regression of
        // the very capability the suggestion asked for. Escalate instead of writing a dead entry.
        preflight: (s) => {
          const spec = lspServerForTags(s.tags)
          if (!spec) {
            return {
              ok: false,
              needsHuman: true,
              reason: `no language-server spec for tags [${s.tags.join(', ')}]`,
            }
          }
          if (!commandExistsOnPath(spec.command)) {
            return {
              ok: false,
              needsHuman: true,
              reason: `${spec.lspName} is not installed — run \`${spec.installHint}\`, then re-approve`,
            }
          }
          // Suppressing the PROPOSAL (lsp-extractor.ts) only stops future generations. It cannot
          // retract a proposal already in the store, and it is blind to a server that became
          // configured by another route — a human editing `lsp-config.json`, a synced dotfile, or
          // an earlier approval of this very suggestion. Such a proposal clears both checks above
          // and then merges a key that already exists, reporting success for a write that changed
          // nothing. Re-reading here, through the same function the extractor uses, is what stops
          // a stale approval from spending a full implementer/QA cycle on a no-op.
          //
          // `rejected`, not `needs-human`: the requested work is already done, so there is no
          // decision to put in front of a person.
          if (readConfiguredLspServerIds(configAbs).has(spec.id)) {
            return {
              ok: false,
              reason: `${spec.lspName} is already registered as \`${spec.id}\` in ${LSP_CONFIG_REL} — nothing to do`,
            }
          }
          return { ok: true }
        },
      }
    case 'tag-proposal':
      return { writableDirs: [lessonsAbs, resolve(dirname(taxonomyAbs)), configAbs] }
    default:
      return { writableDirs: [] }
  }
}

function pathInsideAny(target: string, prefixes: readonly string[]): boolean {
  const abs = resolve(target)
  for (const p of prefixes) {
    if (abs === p) return true
    // `relative` instead of a string-prefix check: on win32 resolved paths use
    // `\` while a `p + '/'` prefix never matches, which silently rejected every
    // in-gate write (the same class of bug fixed at server.ts/registry.ts for
    // repo routing). `relative` also handles case-insensitive drives.
    const rel = relative(p, abs)
    if (rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return true
    }
  }
  return false
}

/**
 * Defence-in-depth boundary for the actions that write agent/LSP config.
 *
 * It shares its prefix rule with the safety gate (`pathInsideAny`) so the two can never disagree
 * about an ordinary directory, and adds ONE refusal the gate does not make: a base that resolves to
 * a filesystem root is not a boundary at all. A config write is never legitimately scoped to a whole
 * disk, so widening `configBaseDir` to `/` must not leave these actions with no boundary of their
 * own. The earlier spelling — `startsWith(allowedBase + '/')` — refused such writes only by
 * accident, because a root base produced the impossible prefix `//`. That accident was load-bearing:
 * with it removed and nothing in its place, the only thing refusing `/etc/evil-config.json` is the
 * operating system's own permissions, which is not a boundary this code can claim to enforce.
 */
function configWriteAllowed(target: string, configBaseDir: string): boolean {
  const allowedBase = resolve(configBaseDir)
  if (allowedBase === parsePath(allowedBase).root) return false
  return pathInsideAny(target, [allowedBase])
}

/**
 * Evaluate a plan against its safety gate. Returns:
 *   - ok          when every step with a `target` writes inside the gate;
 *   - needs-human when the gate requires an explicit opt-in (e.g. github-action);
 *   - rejected    when any step writes outside the gate.
 */
export function checkPlanGate(
  suggestion: Suggestion,
  plan: ImplementationPlan,
  gate: SafetyGate,
): GateDecision {
  if (gate.preflight) {
    const p = gate.preflight(suggestion)
    if (!p.ok) {
      return { ok: false, status: p.needsHuman ? 'needs-human' : 'rejected', reason: p.reason }
    }
  }
  for (const step of plan.steps) {
    if (!step.target) continue
    if (gate.writableDirs.length === 0) {
      return {
        ok: false,
        status: 'rejected',
        reason: `${suggestion.type} executor has no writable directories; step target ${step.target} is not allowed`,
      }
    }
    if (gate.exactFile && resolve(step.target) !== gate.exactFile) {
      return {
        ok: false,
        status: 'rejected',
        reason: `${suggestion.type} may only write ${gate.exactFile}; got ${step.target}`,
      }
    }
    if (!pathInsideAny(step.target, gate.writableDirs)) {
      return {
        ok: false,
        status: 'rejected',
        reason: `path ${resolve(step.target)} is outside the ${suggestion.type} safety gate (allowed: ${gate.writableDirs.join(', ')})`,
      }
    }
  }
  return { ok: true, status: 'ok' }
}

function buildBrowserAutomationSteps(
  suggestion: Suggestion,
  browserRunsDir: string,
  runnerPath: string,
): readonly ImplementationStep[] {
  const plan = suggestion.browserPlan ?? { steps: [] }
  const runDir = join(browserRunsDir, suggestion.id)
  const planPath = join(runDir, 'plan.json')
  const planJson = JSON.stringify(
    { runId: suggestion.id, title: suggestion.title, steps: plan.steps },
    null,
    2,
  )
  return [
    {
      order: 1,
      action: StepAction.CreateFile,
      description: `Stage browser plan at ${planPath}`,
      target: planPath,
      content: planJson,
    },
    {
      order: 2,
      action: StepAction.RunBrowserPlan,
      description: `Run browser-automation skill runner`,
      target: runDir,
      content: JSON.stringify({ runnerPath, planPath }),
    },
  ]
}

function buildInstructionSteps(
  suggestion: Suggestion,
  configBaseDir: string,
): readonly ImplementationStep[] {
  const target = suggestedInstructionsPath(configBaseDir)
  // Bullet body: a short actionable line. Prefer description if it's already
  // short; otherwise fall back to the title.
  const bullet = (suggestion.description || suggestion.title).trim().replace(/\s+/g, ' ')

  return [
    {
      order: 1,
      action: StepAction.AppendToBlock,
      description: `Append instruction to managed block in ${SUGGESTED_INSTRUCTIONS_TARGET}`,
      target,
      content: bullet,
      blockStart: SUGGESTED_INSTRUCTIONS_BLOCK_START,
      blockEnd: SUGGESTED_INSTRUCTIONS_BLOCK_END,
      blockHeading: SUGGESTED_INSTRUCTIONS_HEADING,
    },
  ]
}

/** Create an implementation executor */
export function createExecutor(options?: ExecutorOptions) {
  const autonomyLevel = options?.autonomyLevel ?? 0
  const skillsDir = options?.skillsDir ?? join(resolveScnsHome(), '.scns', 'skills')
  const automationsDir = options?.automationsDir ?? join(resolveScnsHome(), '.scns', 'automations')
  const configBaseDir = options?.configBaseDir ?? homedir()
  const repoRoot = options?.repoRoot ?? process.cwd()
  const lessonsDir = options?.lessonsDir ?? join(configBaseDir, '.scns', 'memory', 'lessons')
  const taxonomyPath =
    options?.taxonomyPath ?? join(configBaseDir, '.scns', 'memory', '.taxonomy.yml')
  const browserRunsDir = options?.browserRunsDir ?? join(configBaseDir, '.scns', 'browser-runs')
  const browserRunnerPath =
    options?.browserRunnerPath ??
    join(configBaseDir, '.copilot', 'skills', 'browser-automation', 'run.mjs')

  function generatePlan(suggestion: Suggestion): ImplementationPlan {
    let steps: readonly ImplementationStep[]

    switch (suggestion.type) {
      case 'skill':
        steps = buildSkillSteps(suggestion, skillsDir, configBaseDir)
        break
      case 'mcp':
        steps = buildMcpSteps(suggestion, configBaseDir)
        break
      case 'automation':
        steps = buildAutomationSteps(suggestion, automationsDir)
        break
      case 'workflow':
        // Phase 13.12.1 amendment: workflow is a multi-step human process, not
        // an artifact. Refuse to auto-generate a plan; caller marks status
        // `needs-human` so the brain doesn't retry every wake.
        throw new ScnsError('workflow-type needs human planner, not auto-execution', 'NEEDS_HUMAN')
      case 'arm-promotion':
        // A promotion changes which retrieval arm the human is actually served. That is a
        // judgement call about his own experience, not an artifact to generate, and the
        // statistical bound behind it is only nominal while propensities stay uniform
        // (Dudík et al. 2011). It therefore NEVER auto-executes at any autonomy level.
        throw new ScnsError(
          'arm-promotion needs a human decision, not auto-execution',
          'NEEDS_HUMAN',
        )
      case 'agent':
        steps = buildAgentSteps(suggestion, skillsDir, configBaseDir)
        break
      case 'prompt':
        steps = buildPromptSteps(suggestion, skillsDir)
        break
      case 'extension':
        steps = buildExtensionSteps(suggestion, configBaseDir)
        break
      case 'lsp':
        steps = buildLspSteps(suggestion, configBaseDir)
        break
      case 'github-action':
        steps = buildGithubActionSteps(suggestion, repoRoot)
        break
      case 'agentic-workflow':
        steps = buildAgenticWorkflowSteps(suggestion, skillsDir)
        break
      case 'instruction':
        steps = buildInstructionSteps(suggestion, configBaseDir)
        break
      case 'tag-proposal':
        steps = buildTagProposalSteps(suggestion, lessonsDir, taxonomyPath)
        break
      case 'browser-automation':
        steps = buildBrowserAutomationSteps(suggestion, browserRunsDir, browserRunnerPath)
        break
      default:
        throw new ScnsError(
          `No step builder for suggestion type: ${suggestion.type}`,
          'INVALID_STATE',
        )
    }

    return {
      suggestionId: suggestion.id,
      steps,
      estimatedMinutes: TYPE_ESTIMATED_MINUTES[suggestion.type] ?? 5,
      requiresUserApproval: autonomyLevel < 2,
    }
  }

  function canAutoExecute(): boolean {
    return autonomyLevel >= 2
  }

  function executeStep(step: ImplementationStep): {
    ok: boolean
    error?: string
    fileCreated?: string
  } {
    if (step.action === StepAction.CreateFile) {
      try {
        mkdirSync(dirname(step.target!), { recursive: true })
        writeFileSync(step.target!, step.content ?? '', 'utf-8')
        // Phase 13.12.1: shell scripts need the executable bit. This was
        // previously done via a separate RunCommand chmod step which failed
        // at autonomy L<3, permanently wedging automation-type plans.
        if (step.target!.endsWith('.sh')) {
          try {
            chmodSync(step.target!, 0o755)
          } catch {
            // Non-fatal — file still exists; caller can chmod manually.
          }
        }
        return { ok: true, fileCreated: step.target }
      } catch (err) {
        return {
          ok: false,
          error: `CreateFile failed for ${step.target}: ${(err as Error).message}`,
        }
      }
    }

    if (step.action === StepAction.ConfigureAgent) {
      if (!step.target || !step.content) {
        return { ok: false, error: 'ConfigureAgent requires target config path and content' }
      }
      try {
        // Resolve and validate path stays within allowed base directory
        const configPath = resolve(step.target)
        if (!configWriteAllowed(configPath, configBaseDir)) {
          return {
            ok: false,
            error: `ConfigureAgent refused: path ${configPath} is outside allowed directory`,
          }
        }
        mkdirSync(dirname(configPath), { recursive: true })
        // If config file exists, merge JSON objects (preserving existing keys)
        if (existsSync(configPath)) {
          try {
            const existing = JSON.parse(readFileSync(configPath, 'utf-8'))
            const incoming = JSON.parse(step.content)
            const merged = { ...existing, ...incoming }
            writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
          } catch {
            // Not JSON or parse error — overwrite
            writeFileSync(configPath, step.content, 'utf-8')
          }
        } else {
          writeFileSync(configPath, step.content, 'utf-8')
        }
        return { ok: true, fileCreated: configPath }
      } catch (err) {
        return { ok: false, error: `ConfigureAgent failed: ${(err as Error).message}` }
      }
    }

    if (step.action === StepAction.ConfigureLspServer) {
      if (!step.target || !step.content) {
        return { ok: false, error: 'ConfigureLspServer requires target config path and content' }
      }
      try {
        const configPath = resolve(step.target)
        if (!configWriteAllowed(configPath, configBaseDir)) {
          return {
            ok: false,
            error: `ConfigureLspServer refused: path ${configPath} is outside allowed directory`,
          }
        }
        const incoming = JSON.parse(step.content) as Record<string, unknown>

        let existing: Record<string, unknown> = {}
        if (existsSync(configPath)) {
          const raw = readFileSync(configPath, 'utf-8').trim()
          if (raw.length > 0) {
            // Refuse rather than overwrite: `lsp-config.json` is hand-editable, so a parse failure
            // most likely means a human is mid-edit. Clobbering it would delete their servers.
            try {
              existing = JSON.parse(raw) as Record<string, unknown>
            } catch (err) {
              return {
                ok: false,
                error: `ConfigureLspServer refused: ${configPath} is not valid JSON (${(err as Error).message}) — fix it by hand first`,
              }
            }
          }
        }

        const existingServers =
          typeof existing['lspServers'] === 'object' && existing['lspServers'] !== null
            ? (existing['lspServers'] as Record<string, unknown>)
            : {}
        // Merge one level deeper than ConfigureAgent so registering one server preserves the rest.
        const merged = {
          ...existing,
          lspServers: { ...existingServers, ...incoming },
        }
        mkdirSync(dirname(configPath), { recursive: true })
        writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
        return { ok: true, fileCreated: configPath }
      } catch (err) {
        return { ok: false, error: `ConfigureLspServer failed: ${(err as Error).message}` }
      }
    }

    if (step.action === StepAction.ModifyFile) {
      // ModifyFile is a placeholder — actual modification requires user review
      return { ok: true }
    }

    if (step.action === StepAction.AppendToBlock) {
      if (!step.target || !step.content || !step.blockStart || !step.blockEnd) {
        return {
          ok: false,
          error: 'AppendToBlock requires target, content, blockStart, blockEnd',
        }
      }
      try {
        // Path safety: target must be inside configBaseDir.
        const targetPath = resolve(step.target)
        if (!configWriteAllowed(targetPath, configBaseDir)) {
          return {
            ok: false,
            error: `AppendToBlock refused: path ${targetPath} is outside allowed directory`,
          }
        }
        mkdirSync(dirname(targetPath), { recursive: true })
        const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : ''
        const bullet = `- ${step.content.trim()}`

        const startIdx = existing.indexOf(step.blockStart)
        const endIdx = existing.indexOf(step.blockEnd)
        let finalContent: string

        if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
          // No block — create one at end of file.
          const blockBody = [step.blockStart, step.blockHeading ?? '', '', bullet, step.blockEnd]
            .filter((l) => l !== '')
            .join('\n')
          const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
          const trailingNl = existing === '' ? '\n' : ''
          finalContent = existing + sep + blockBody + '\n' + trailingNl
        } else {
          const before = existing.slice(0, startIdx)
          const blockInner = existing.slice(startIdx + step.blockStart.length, endIdx)
          const after = existing.slice(endIdx + step.blockEnd.length)
          // Dedupe: skip if a line matching the bullet text already exists in block.
          const lines = blockInner.split('\n')
          const already = lines.some((l) => l.trim() === bullet.trim())
          const newBlockInner = already
            ? blockInner
            : blockInner.replace(/\s*$/, '') + '\n' + bullet + '\n'
          finalContent = before + step.blockStart + newBlockInner + step.blockEnd + after
        }

        writeFileSync(targetPath, finalContent, 'utf-8')
        return { ok: true, fileCreated: targetPath }
      } catch (err) {
        return { ok: false, error: `AppendToBlock failed: ${(err as Error).message}` }
      }
    }

    if (step.action === StepAction.ApplyTagToLessons) {
      if (!step.target || !step.content) {
        return {
          ok: false,
          error: 'ApplyTagToLessons requires target (lessons dir) and content (JSON payload)',
        }
      }
      try {
        const payload = JSON.parse(step.content) as {
          tagName: string
          lessonIds: string[]
          taxonomyPath: string
          entry: {
            name: string
            scope: 'global' | 'project' | 'agent'
            project?: string
            agent?: string
          }
        }
        if (!payload.tagName || !Array.isArray(payload.lessonIds)) {
          return { ok: false, error: 'ApplyTagToLessons payload invalid' }
        }
        const lessonsDirResolved = resolve(step.target)
        let applied = 0
        let alreadyPresent = 0
        const missing: string[] = []
        for (const id of payload.lessonIds) {
          // Lesson files live at `<lessonsDir>/<safeId>.md`. Try both the raw
          // id and the sanitized form used by createLessonStore.create().
          const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '-')
          const candidates = [join(lessonsDirResolved, `${safeId}.md`)]
          if (safeId !== id) candidates.push(join(lessonsDirResolved, `${id}.md`))
          const path = candidates.find((p) => existsSync(p))
          if (!path) {
            missing.push(id)
            continue
          }
          const raw = readFileSync(path, 'utf-8')
          const lesson = parseLesson(raw, safeId + '.md')
          if (lesson.frontmatter.tags.includes(payload.tagName)) {
            alreadyPresent++
            continue
          }
          const updated = {
            ...lesson.frontmatter,
            tags: [...lesson.frontmatter.tags, payload.tagName],
          }
          writeFileSync(path, serializeLesson(updated, lesson.body), 'utf-8')
          applied++
        }
        // Register tag in taxonomy regardless (idempotent).
        const taxonomy = createTaxonomyStore({ path: payload.taxonomyPath })
        taxonomy.addTag({
          name: payload.entry.name,
          scope: payload.entry.scope,
          ...(payload.entry.project ? { project: payload.entry.project } : {}),
          ...(payload.entry.agent ? { agent: payload.entry.agent } : {}),
          createdAt: new Date().toISOString(),
        })
        if (missing.length === payload.lessonIds.length) {
          return {
            ok: false,
            error: `ApplyTagToLessons: no lesson files found for ids [${missing.join(', ')}]`,
          }
        }
        return {
          ok: true,
          fileCreated: `${applied} lesson(s) tagged "${payload.tagName}" (${alreadyPresent} already tagged${missing.length ? `, ${missing.length} missing` : ''})`,
        }
      } catch (err) {
        return { ok: false, error: `ApplyTagToLessons failed: ${(err as Error).message}` }
      }
    }

    if (step.action === StepAction.RunBrowserPlan) {
      if (autonomyLevel < 2) {
        return {
          ok: false,
          error: `RunBrowserPlan requires autonomy level 2; current ${autonomyLevel}`,
        }
      }
      if (!step.target || !step.content) {
        return {
          ok: false,
          error:
            'RunBrowserPlan requires target (run dir) and content (JSON {runnerPath, planPath})',
        }
      }
      try {
        const { runnerPath, planPath } = JSON.parse(step.content) as {
          runnerPath: string
          planPath: string
        }
        if (!existsSync(runnerPath)) {
          return {
            ok: false,
            error: `RunBrowserPlan: runner missing at ${runnerPath}. Install the browser-automation skill.`,
          }
        }
        if (!existsSync(planPath)) {
          return { ok: false, error: `RunBrowserPlan: plan missing at ${planPath}` }
        }
        mkdirSync(step.target, { recursive: true })
        const planJson = readFileSync(planPath, 'utf-8')
        execSync(`node ${JSON.stringify(runnerPath)}`, {
          cwd: step.target,
          input: planJson,
          timeout: 60_000,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, SCNS_BROWSER_RUN_DIR: step.target },
          windowsHide: true,
        })
        return { ok: true, fileCreated: step.target }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `RunBrowserPlan failed: ${msg.slice(0, 400)}` }
      }
    }

    if (step.action === StepAction.RunCommand) {
      if (autonomyLevel < 3) {
        return { ok: false, error: `RunCommand skipped at autonomy level ${autonomyLevel}` }
      }
      if (!step.content) {
        return { ok: false, error: 'RunCommand requires content (the command to run)' }
      }
      // Safety: block dangerous commands
      const cmd = step.content.trim()
      const dangerous = /\b(rm\s+-rf\s+\/|sudo|chmod\s+777|curl\s+.*\|\s*sh|eval|exec)\b/i
      if (dangerous.test(cmd)) {
        return { ok: false, error: `RunCommand blocked dangerous command: ${cmd}` }
      }
      try {
        const cwd = step.target ?? process.cwd()
        execSync(cmd, {
          cwd,
          timeout: 30_000,
          stdio: 'pipe',
          env: { ...process.env, NODE_ENV: 'production' },
          windowsHide: true,
        })
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `RunCommand failed: ${msg.slice(0, 200)}` }
      }
    }

    return { ok: true }
  }

  function execute(plan: ImplementationPlan, suggestion: Suggestion): ExecutionResult {
    if (!canAutoExecute()) {
      return {
        success: true,
        stepsCompleted: 0,
        stepsTotal: plan.steps.length,
        errors: [],
        filesCreated: [],
      }
    }

    // Phase 13.12.18 — pre-flight safety gate. The gate is derived from `suggestion.type`, so the
    // suggestion is a required argument: an optional one made the gate opt-in, and the artifact
    // application path in the quality-gate arbiter simply didn't opt in.
    {
      const gate = resolveGates(
        suggestion.type,
        configBaseDir,
        browserRunsDir,
        automationsDir,
        skillsDir,
        lessonsDir,
        taxonomyPath,
        repoRoot,
      )
      const decision = checkPlanGate(suggestion, plan, gate)
      if (!decision.ok) {
        return {
          success: false,
          stepsCompleted: 0,
          stepsTotal: plan.steps.length,
          errors: decision.reason ? [decision.reason] : ['safety gate rejected plan'],
          filesCreated: [],
          gateDecision: decision,
        }
      }
    }

    const errors: string[] = []
    const filesCreated: string[] = []
    let completed = 0

    for (const step of plan.steps) {
      const result = executeStep(step)
      if (result.ok) {
        completed++
        if (result.fileCreated) filesCreated.push(result.fileCreated)
      } else if (result.error) {
        errors.push(result.error)
      }
    }

    return {
      success: errors.length === 0,
      stepsCompleted: completed,
      stepsTotal: plan.steps.length,
      errors,
      filesCreated,
    }
  }

  /** Preview the artifact that would be generated for a suggestion */
  function generateArtifactPreview(suggestion: Suggestion): ArtifactOutput | null {
    return generateArtifact(suggestion)
  }

  return { generatePlan, execute, canAutoExecute, generateArtifactPreview }
}
