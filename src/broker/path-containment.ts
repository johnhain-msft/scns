import { posix as pathPosix, win32 as pathWin32 } from 'node:path'

/**
 * True when `candidate` is `root` itself or a descendant of it.
 *
 * Used by the child-broker guard that refuses a session whose working
 * directory belongs to a different project. Ports are reassigned whenever the
 * meta-broker restarts, so a session pinned to a stale port can otherwise
 * register itself into another project's database — the cross-project
 * contamination the per-project brokers exist to prevent.
 *
 * Boundary-safe: `/repo/ab` is NOT inside `/repo/a`, and a sibling whose name
 * merely starts with dots (`..foo`) is not mistaken for a `..` traversal.
 * Case-insensitive on win32, where `C:\Repo` and `c:\repo` are one directory.
 *
 * The path flavor is chosen from `platform`, not from the host, so the rules
 * are deterministic and testable on any machine.
 */
export function isPathInside(
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!candidate || !root) return false

  const isWindows = platform === 'win32'
  const p = isWindows ? pathWin32 : pathPosix

  let resolvedRoot: string
  let resolvedCandidate: string
  try {
    resolvedRoot = p.resolve(root)
    resolvedCandidate = p.resolve(candidate)
  } catch {
    return false
  }

  if (isWindows) {
    resolvedRoot = resolvedRoot.toLowerCase()
    resolvedCandidate = resolvedCandidate.toLowerCase()
  }

  const rel = p.relative(resolvedRoot, resolvedCandidate)
  if (rel === '') return true
  // A different drive (win32) makes `relative` return an absolute path.
  if (p.isAbsolute(rel)) return false
  // Compare whole segments so `..foo` is a sibling name, not a traversal.
  return rel.split(p.sep)[0] !== '..'
}
