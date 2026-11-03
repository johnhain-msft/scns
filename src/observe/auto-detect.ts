/**
 * Auto-detection for observer directories and git repositories.
 *
 * Discovers project directories and git repos from candidate paths
 * (e.g., recent session working dirs, user home code folders).
 */

import { existsSync, statSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

// ── Project directory detection ────────────────────────────────────

const PROJECT_MARKERS = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'Gemfile',
  'pom.xml',
  'build.gradle',
]
const EXCLUDED_SEGMENTS = ['node_modules', '.git', 'dist', 'build', '.cache', 'vendor']

function isProjectDir(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    if (!statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)))
}

function isExcluded(dir: string): boolean {
  // Split on both separators — resolved paths use `\` on win32.
  const segments = dir.split(/[\\/]/)
  return segments.some((s) => EXCLUDED_SEGMENTS.includes(s))
}

export function autoDetectProjectDirs(candidates: string[]): string[] {
  const seen = new Set<string>()
  const results: string[] = []

  for (const raw of candidates) {
    const dir = resolve(raw)
    if (seen.has(dir)) continue
    seen.add(dir)
    if (isExcluded(dir)) continue
    if (isProjectDir(dir)) results.push(dir)
  }

  return results
}

// ── Git repo detection ─────────────────────────────────────────────

function isGitRepo(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    if (!statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  return existsSync(join(dir, '.git'))
}

export function autoDetectGitRepos(candidates: string[]): string[] {
  const seen = new Set<string>()
  const results: string[] = []

  for (const raw of candidates) {
    const dir = resolve(raw)
    if (seen.has(dir)) continue
    seen.add(dir)
    if (isGitRepo(dir)) results.push(dir)
  }

  return results
}

// ── Candidate source: common code directories ─────────────────────

export function getCommonCodeDirs(): string[] {
  const home = homedir()
  const candidates = [
    'Coding_Projects',
    'Projects',
    'code',
    'Code',
    'src',
    'dev',
    'workspace',
    'repos',
  ]
  const result: string[] = []

  for (const name of candidates) {
    const dir = join(home, name)
    if (existsSync(dir)) {
      result.push(dir)
      // Also add immediate children (common pattern: ~/Code/project-a, ~/Code/project-b)
      try {
        const children = readdirSync(dir, { withFileTypes: true })
        for (const child of children) {
          if (child.isDirectory() && !child.name.startsWith('.')) {
            result.push(join(dir, child.name))
          }
        }
      } catch {
        // Ignore permission errors
      }
    }
  }

  return result
}
