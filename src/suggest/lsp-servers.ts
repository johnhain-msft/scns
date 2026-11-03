/**
 * LSP SERVER REGISTRY — the executable half of an `lsp` suggestion.
 *
 * WHY (defect, 2026-08-05). `SuggestionType.Lsp` existed but was DEAD in both directions:
 * `resolveGates` gave it `writableDirs: []` (so any write was refused) and `buildLspSteps` emitted
 * a `ModifyFile` step with no `target` at all (so there was nothing to write). Rather than fix
 * that, `lsp-extractor.ts` shipped its LSP proposals as `type: 'instruction'` — which routed a
 * request to *configure a language server* into "append one sentence of prose to a markdown file".
 * John approved exactly such a proposal ("Configure Python LSP") and got a bullet, not an LSP.
 *
 * The fix is that an `lsp` suggestion now carries a REAL launch spec through to a REAL write into
 * Copilot CLI's `lsp-config.json`. The registry below is the single source of that spec: the
 * extractor proposes from it, and the executor resolves from it via the suggestion's own tags —
 * so proposals already sitting on disk (which carry `tags: [lsp, <language>, …]`) execute
 * correctly without a schema migration.
 *
 * INVARIANT — every entry must have a real, canonical stdio launch command. Java and C# were
 * deliberately dropped from the previous prose-only mapping list: neither has a single canonical
 * stdio command that can be written into a config file unattended, and proposing work the executor
 * cannot perform is precisely the defect this module exists to remove.
 *
 * SECOND DEFECT FIXED HERE (2026-09-21). The registry could say what to write but nothing could
 * read back what was ALREADY written, so `lsp-extractor.ts` proposed from file-change counts
 * alone. With `typescript` long since registered in `lsp-config.json`, it re-emitted "Configure
 * TypeScript LSP (typescript-language-server)" — which was approved and spun up a full
 * implementer/QA team to perform a write that was already on disk.
 * {@link readConfiguredLspServerIds} is the inverse of {@link lspServerConfigEntry} and reads the
 * SAME path the executor writes, so the proposal and the write cannot disagree.
 */
import { readFileSync } from 'node:fs'
import { lspConfigPath } from './artifact-targets.js'

/** A language server Copilot CLI can spawn, in the shape `lsp-config.json` expects. */
export interface LspServerSpec {
  /** Key under `lspServers` in `lsp-config.json`. */
  readonly id: string
  /** The tag the extractor stamps on the suggestion, used to resolve this entry at execute time. */
  readonly tag: string
  /** Human-facing language name. */
  readonly language: string
  /** Human-facing server name. */
  readonly lspName: string
  /** Executable Copilot CLI spawns. */
  readonly command: string
  /** Arguments that put the server in stdio mode. */
  readonly args: readonly string[]
  /** Extension → LSP language id. Also the set the extractor counts activity across. */
  readonly fileExtensions: Readonly<Record<string, string>>
  /** How a human installs `command` when it is absent. Surfaced instead of writing a dead config. */
  readonly installHint: string
  /** One-line description used in the proposal body. */
  readonly description: string
}

export const LSP_SERVERS: readonly LspServerSpec[] = [
  {
    id: 'typescript',
    tag: 'typescript',
    language: 'TypeScript',
    lspName: 'typescript-language-server',
    command: 'typescript-language-server',
    args: ['--stdio'],
    fileExtensions: {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
    },
    installHint: 'npm install -g typescript typescript-language-server',
    description:
      'Type errors, path resolution and symbol lookup from the project tsconfig, served to the agent while it edits.',
  },
  {
    id: 'python',
    tag: 'python',
    language: 'Python',
    lspName: 'Pyright',
    command: 'pyright-langserver',
    args: ['--stdio'],
    fileExtensions: { '.py': 'python', '.pyi': 'python', '.pyw': 'python' },
    installHint: 'npm install -g pyright',
    description:
      'Type checking, import resolution and symbol lookup from the project virtualenv, served to the agent while it edits.',
  },
  {
    id: 'rust',
    tag: 'rust',
    language: 'Rust',
    lspName: 'rust-analyzer',
    command: 'rust-analyzer',
    args: [],
    fileExtensions: { '.rs': 'rust' },
    installHint: 'rustup component add rust-analyzer',
    description:
      'cargo check diagnostics, clippy findings and symbol lookup, served to the agent while it edits.',
  },
  {
    id: 'go',
    tag: 'go',
    language: 'Go',
    lspName: 'gopls',
    command: 'gopls',
    args: ['serve'],
    fileExtensions: { '.go': 'go' },
    installHint: 'go install golang.org/x/tools/gopls@latest',
    description:
      'Static analysis, auto-imports and symbol lookup from the module graph, served to the agent while it edits.',
  },
  {
    id: 'ruby',
    tag: 'ruby',
    language: 'Ruby',
    lspName: 'Solargraph',
    command: 'solargraph',
    args: ['stdio'],
    fileExtensions: { '.rb': 'ruby' },
    installHint: 'gem install solargraph',
    description:
      'Type inference, documentation and gem-aware symbol lookup, served to the agent while it edits.',
  },
]

/**
 * Resolve the server an `lsp` suggestion is about from the tags it already carries.
 *
 * Tag-based rather than payload-based on purpose: proposals written before this fix are on disk
 * with `tags: ['lsp', '<language>', 'codebase-improvement']` and must stay executable. Returns
 * `undefined` when no tag matches, which the caller turns into a refusal rather than a guess.
 */
export function lspServerForTags(tags: readonly string[]): LspServerSpec | undefined {
  const set = new Set(tags.map((t) => t.toLowerCase()))
  return LSP_SERVERS.find((s) => set.has(s.tag))
}

/**
 * The server ids already registered under `lspServers` in Copilot CLI's `lsp-config.json`.
 *
 * Keyed by id because that is exactly the granularity the executor merges at
 * (`{...existingServers, ...incoming}`): an id present here means an approval would rewrite a key
 * that already exists, i.e. there is no work to do.
 *
 * FAILS OPEN — a missing, unreadable or malformed config yields an empty set, so a broken file
 * suppresses nothing. Proposing a server that turns out to be configured is a wasted review;
 * silently suppressing every proposal because the config failed to parse would be invisible.
 */
export function readConfiguredLspServerIds(configBaseDir: string): ReadonlySet<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(lspConfigPath(configBaseDir), 'utf8'))
  } catch {
    return new Set()
  }

  if (typeof parsed !== 'object' || parsed === null) return new Set()
  const servers = (parsed as Record<string, unknown>)['lspServers']
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return new Set()

  return new Set(Object.keys(servers as Record<string, unknown>))
}

/** The `lspServers` fragment for one spec, ready to merge into `lsp-config.json`. */
export function lspServerConfigEntry(spec: LspServerSpec): Record<string, unknown> {
  return {
    [spec.id]: {
      command: spec.command,
      args: [...spec.args],
      fileExtensions: { ...spec.fileExtensions },
    },
  }
}
