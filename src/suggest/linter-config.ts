/**
 * LINTER CONFIG READ-BACK — what the working tree ALREADY lints.
 *
 * WHY THIS MODULE EXISTS (defect, 2026-09-21). `generateAutomationSuggestions` proposed
 * "Create <ext> linting automation" from `fileTypeCounts` alone. Nothing ever read the repo, so
 * this very repository — which has `eslint.config.js` at its root, `lint` / `lint:fix` scripts and
 * `eslint` in devDependencies — was told to go build JavaScript linting. The proposal was approved
 * and spun up an implementer/QA team to create something already on disk.
 *
 * This is the same shape as the LSP defect that `readConfiguredLspServerIds` fixed: a proposal
 * derived from activity counts, with no read-back of the state it proposes to create. The registry
 * below is the read-back half for linting.
 *
 * TWO PROPERTIES ARE LOAD-BEARING:
 *
 *  1. EXTENSION-SCOPED, never a blanket "this repo has a linter" mute. An ESLint config is evidence
 *     about JavaScript and TypeScript and about nothing else, so a dominant `.py` must remain
 *     proposable in a repo that lints only JS. Each entry therefore declares the exact extension
 *     set it speaks for.
 *
 *  2. FAILS OPEN. A missing, unreadable or malformed config yields no coverage, so a broken file
 *     suppresses nothing. A proposal that turns out to be redundant costs one review; a proposal
 *     silently swallowed because a config failed to parse is invisible forever.
 *
 * DELIBERATELY NOT A SIGNAL: an npm `lint` script, or `eslint` sitting in devDependencies. Both say
 * that *some* linting exists while naming no extensions, and this module's entire job is to answer
 * a per-extension question. Guessing coverage from an extension-less signal would suppress
 * proposals for languages the repo genuinely does not lint — the one failure mode that cannot be
 * seen from the dashboard. Detection is keyed on config files, which map to a known tool with a
 * known extension set.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A TOML table whose presence configures a linter, e.g. `[tool.ruff]` in `pyproject.toml`. */
export interface TomlTableMarker {
  /** Repo-root-relative file to inspect. */
  readonly file: string
  /** Dotted table path. Sub-tables count too: `tool.ruff` matches `[tool.ruff.lint]`. */
  readonly table: string
}

/** A linter we can recognise on disk, and the extensions it speaks for. */
export interface LinterSpec {
  readonly id: string
  readonly name: string
  /** Repo-root-relative config filenames whose existence means this linter is set up. */
  readonly configFiles: readonly string[]
  /** Top-level `package.json` keys that also configure this linter. */
  readonly packageJsonKeys: readonly string[]
  /** TOML tables that also configure this linter. */
  readonly tomlTables: readonly TomlTableMarker[]
  /** Undotted, lowercase extensions this linter checks. */
  readonly extensions: readonly string[]
}

/** The family a single JS/TS linter covers — shared so entries cannot drift apart. */
const JS_TS_EXTENSIONS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'] as const

export const LINTERS: readonly LinterSpec[] = [
  {
    id: 'eslint',
    name: 'ESLint',
    configFiles: [
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
      'eslint.config.mts',
      'eslint.config.cts',
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.cjs',
      '.eslintrc.mjs',
      '.eslintrc.json',
      '.eslintrc.yml',
      '.eslintrc.yaml',
    ],
    packageJsonKeys: ['eslintConfig'],
    tomlTables: [],
    extensions: [...JS_TS_EXTENSIONS],
  },
  {
    id: 'biome',
    name: 'Biome',
    configFiles: ['biome.json', 'biome.jsonc'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: [...JS_TS_EXTENSIONS, 'json'],
  },
  {
    id: 'oxlint',
    name: 'oxlint',
    configFiles: ['.oxlintrc.json'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: [...JS_TS_EXTENSIONS],
  },
  {
    id: 'ruff',
    name: 'Ruff',
    configFiles: ['ruff.toml', '.ruff.toml'],
    packageJsonKeys: [],
    tomlTables: [{ file: 'pyproject.toml', table: 'tool.ruff' }],
    extensions: ['py', 'pyi', 'pyw'],
  },
  {
    id: 'flake8',
    name: 'Flake8',
    configFiles: ['.flake8'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['py', 'pyi', 'pyw'],
  },
  {
    id: 'pylint',
    name: 'Pylint',
    configFiles: ['.pylintrc', 'pylintrc'],
    packageJsonKeys: [],
    tomlTables: [{ file: 'pyproject.toml', table: 'tool.pylint' }],
    extensions: ['py', 'pyi', 'pyw'],
  },
  {
    id: 'rubocop',
    name: 'RuboCop',
    configFiles: ['.rubocop.yml', '.rubocop.yaml'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['rb'],
  },
  {
    id: 'golangci-lint',
    name: 'golangci-lint',
    configFiles: ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['go'],
  },
  {
    id: 'clippy',
    name: 'Clippy',
    configFiles: ['clippy.toml', '.clippy.toml'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['rs'],
  },
  {
    id: 'shellcheck',
    name: 'ShellCheck',
    configFiles: ['.shellcheckrc'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['sh', 'bash', 'zsh'],
  },
  {
    id: 'stylelint',
    name: 'Stylelint',
    configFiles: [
      '.stylelintrc',
      '.stylelintrc.json',
      '.stylelintrc.js',
      '.stylelintrc.cjs',
      '.stylelintrc.yml',
      '.stylelintrc.yaml',
      'stylelint.config.js',
      'stylelint.config.cjs',
      'stylelint.config.mjs',
    ],
    packageJsonKeys: ['stylelint'],
    tomlTables: [],
    extensions: ['css', 'scss', 'sass', 'less'],
  },
  {
    id: 'yamllint',
    name: 'yamllint',
    configFiles: ['.yamllint', '.yamllint.yml', '.yamllint.yaml'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['yaml', 'yml'],
  },
  {
    id: 'swiftlint',
    name: 'SwiftLint',
    configFiles: ['.swiftlint.yml', '.swiftlint.yaml'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['swift'],
  },
  {
    id: 'detekt',
    name: 'detekt',
    configFiles: ['detekt.yml', 'detekt.yaml'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['kt', 'kts'],
  },
  {
    id: 'phpcs',
    name: 'PHP_CodeSniffer',
    configFiles: ['phpcs.xml', 'phpcs.xml.dist', '.php-cs-fixer.php', '.php-cs-fixer.dist.php'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['php'],
  },
  {
    id: 'sqlfluff',
    name: 'SQLFluff',
    configFiles: ['.sqlfluff'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['sql'],
  },
  {
    id: 'luacheck',
    name: 'Luacheck',
    configFiles: ['.luacheckrc'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['lua'],
  },
  {
    id: 'htmlhint',
    name: 'HTMLHint',
    configFiles: ['.htmlhintrc'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['html'],
  },
  {
    id: 'clang-tidy',
    name: 'clang-tidy',
    configFiles: ['.clang-tidy'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['c', 'cc', 'cpp', 'h', 'hpp'],
  },
  {
    id: 'checkstyle',
    name: 'Checkstyle',
    configFiles: ['checkstyle.xml'],
    packageJsonKeys: [],
    tomlTables: [],
    extensions: ['java'],
  },
]

/** Read a repo-root file, or `null` when it is missing or unreadable. Never throws. */
function readIfPresent(repoDir: string, relPath: string): string | null {
  try {
    return readFileSync(join(repoDir, relPath), 'utf8')
  } catch {
    return null
  }
}

/** Top-level keys of `package.json`, or an empty set when absent or malformed. */
function packageJsonKeys(repoDir: string): ReadonlySet<string> {
  const raw = readIfPresent(repoDir, 'package.json')
  if (raw === null) return new Set()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Set()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Set()
  return new Set(Object.keys(parsed as Record<string, unknown>))
}

/** Whether `[<table>]` or any `[<table>.*]` sub-table appears in `contents`. */
function hasTomlTable(contents: string, table: string): boolean {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^[ \\t]*\\[[ \\t]*${escaped}(\\.[^\\]]*)?[ \\t]*\\]`, 'm').test(contents)
}

/**
 * The undotted, lowercase file extensions `repoDir` already has a linter configured for.
 *
 * Keyed by extension because that is exactly the granularity the proposal is made at: the
 * automation lever asks "should I propose linting for `.js`?", so the answer it needs is "is `.js`
 * already linted here?" — not "does this repo lint anything?".
 *
 * Fails open in every direction: a missing directory, an unreadable file and a malformed config all
 * contribute no coverage. See the module note for why over-suppression is the worse failure.
 */
export function readConfiguredLintExtensions(repoDir: string): ReadonlySet<string> {
  const covered = new Set<string>()
  const pkgKeys = packageJsonKeys(repoDir)
  const tomlCache = new Map<string, string | null>()

  for (const linter of LINTERS) {
    const byConfigFile = linter.configFiles.some((f) => {
      try {
        return existsSync(join(repoDir, f))
      } catch {
        return false
      }
    })

    const byPackageJson = linter.packageJsonKeys.some((k) => pkgKeys.has(k))

    const byTomlTable = linter.tomlTables.some((marker) => {
      if (!tomlCache.has(marker.file)) {
        tomlCache.set(marker.file, readIfPresent(repoDir, marker.file))
      }
      const contents = tomlCache.get(marker.file)
      return contents != null && hasTomlTable(contents, marker.table)
    })

    if (!byConfigFile && !byPackageJson && !byTomlTable) continue
    for (const ext of linter.extensions) covered.add(ext.toLowerCase())
  }

  return covered
}
