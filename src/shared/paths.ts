/**
 * Platform-parameterized path helpers for project-root routing (W5) and
 * absolute-path validation.
 *
 * Every function takes an optional `node:path` platform module and defaults to
 * the HOST module, so runtime behavior on macOS/Linux is byte-for-byte what it
 * was before these helpers existed. Tests inject `path.win32` to exercise the
 * native-Windows branch from any host; on a real Windows machine the host
 * default IS win32, so the tested branch is the one that runs.
 *
 * Windows comparisons are case-insensitive (NTFS default) and tolerate mixed
 * `/` and `\` separators; posix comparisons are case-sensitive and exact.
 */
import path from 'node:path'

export type PlatformPath = path.PlatformPath

const isWindowsPath = (pp: PlatformPath): boolean => pp.sep === '\\'

/** `pp.isAbsolute`, defaulting to host-platform semantics. */
export function isAbsolutePath(p: string, pp: PlatformPath = path): boolean {
  return pp.isAbsolute(p)
}

/** Normalize + strip trailing separators (never below the filesystem root). */
function canonicalize(p: string, pp: PlatformPath): string {
  let out = pp.normalize(p)
  const root = pp.parse(out).root
  while (out.length > root.length && out.endsWith(pp.sep)) {
    out = out.slice(0, -1)
  }
  return isWindowsPath(pp) ? out.toLowerCase() : out
}

/**
 * True when `candidate` is `root` itself or a descendant of it, comparing per
 * whole path segment (a sibling sharing a name prefix never matches).
 */
export function isPathWithinRoot(
  root: string,
  candidate: string,
  pp: PlatformPath = path,
): boolean {
  const a = canonicalize(root, pp)
  const b = canonicalize(candidate, pp)
  if (a === b) return true
  const prefix = a.endsWith(pp.sep) ? a : a + pp.sep
  return b.startsWith(prefix)
}

/**
 * Index of the DEEPEST root in `roots` that contains `candidate`, or -1.
 * Deepest = longest canonical form, so nested roots resolve to the inner one.
 */
export function resolveDeepestRootIndex(
  roots: ReadonlyArray<string>,
  candidate: string,
  pp: PlatformPath = path,
): number {
  let best = -1
  let bestLen = -1
  for (let i = 0; i < roots.length; i++) {
    if (!isPathWithinRoot(roots[i]!, candidate, pp)) continue
    const len = canonicalize(roots[i]!, pp).length
    if (len > bestLen) {
      best = i
      bestLen = len
    }
  }
  return best
}
