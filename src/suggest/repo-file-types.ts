/**
 * Repo file-type presence index.
 *
 * `ProjectFocusPattern.fileTypeCounts` is a GLOBAL histogram: `pattern-detector.ts` folds every
 * file observation from every watched directory into one map, with no repo scoping. Suggestions
 * built from it, however, are dispatched against ONE working directory. That gap let
 * "Create py linting automation — File type '.py' changed 2753 times" be aimed at a repo holding
 * zero Python files.
 *
 * This module supplies the missing half: which extensions the TARGET repo actually contains.
 */
import { execFileSync } from 'node:child_process'

/**
 * Extensions present among the repo's TRACKED files.
 *
 * Tracked-only (`git ls-files`) is the load-bearing choice, not an optimization. A plain recursive
 * walk would find `node_modules/flatted/python/flatted.py` and "confirm" that a TypeScript repo is
 * a Python repo — re-emitting the exact suggestion this index exists to suppress. Vendored
 * dependencies and build output are gitignored, so asking git is what distinguishes *code this
 * repo owns* from *code it merely downloaded*.
 *
 * Fails OPEN: an unreadable or non-git path yields an empty set, which callers treat as "no index
 * available, do not veto". A partial index would be worse than none — it would silently suppress
 * legitimate suggestions.
 *
 * @param repoRoot Directory to index. Defaults to `process.cwd()`, matching the `repoRoot` option
 *   convention already used by `executor.ts` and `triage-wiring.ts`.
 */
export function collectRepoFileTypes(repoRoot: string = process.cwd()): ReadonlySet<string> {
  let stdout: string
  try {
    stdout = execFileSync('git', ['ls-files', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      // The whole file list is required: a truncated listing would drop real extensions and
      // produce false vetoes. If the repo is large enough to overflow this, the catch below
      // fails open rather than indexing a prefix.
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Required of every src/ child_process call (windows-hide-scan.test.ts): a
      // console-less parent on Windows must never let a child allocate a visible console.
      windowsHide: true,
    })
  } catch {
    return new Set()
  }

  const types = new Set<string>()
  for (const path of stdout.split('\0')) {
    if (path.length === 0) continue
    const slash = path.lastIndexOf('/')
    const name = slash === -1 ? path : path.slice(slash + 1)
    const dot = name.lastIndexOf('.')
    // `dot > 0` skips dotfiles (`.gitignore` is not a "gitignore" file type).
    if (dot > 0) {
      types.add(name.slice(dot + 1).toLowerCase())
    }
  }
  return types
}
