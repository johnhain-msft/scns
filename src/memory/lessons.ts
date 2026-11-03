/**
 * Scoped lessons — YAML-frontmatter markdown files that are loaded based on
 * a caller's context (cwd repo, agent role). Prevents PDF lessons leaking
 * into SCNS sessions and vice versa.
 *
 * Phase 13.12.11 — memory scoping + tagging.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { z } from 'zod'

// ── Types / schema ──────────────────────────────────────────────────────────

export const LessonScope = z.enum(['global', 'project', 'agent'])
export type LessonScope = z.infer<typeof LessonScope>

export const LessonFrontmatterSchema = z
  .object({
    id: z.string().min(1),
    scope: LessonScope,
    project: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    tags: z.array(z.string()).default([]),
    appliesTo: z.array(z.string()).default([]),
    createdAt: z.string().min(1),
  })
  .refine((v) => v.scope !== 'project' || !!v.project, {
    message: 'project is required when scope=project',
    path: ['project'],
  })
  .refine((v) => v.scope !== 'agent' || !!v.agent, {
    message: 'agent is required when scope=agent',
    path: ['agent'],
  })

export type LessonFrontmatter = z.infer<typeof LessonFrontmatterSchema>

export interface Lesson {
  readonly frontmatter: LessonFrontmatter
  readonly body: string
  /** Filename (relative to lessons root, e.g. "meta-lesson-foo.md"). */
  readonly path: string
}

export interface LessonContextFilter {
  readonly cwd?: string
  readonly agent?: string
  readonly project?: string
}

// ── YAML parse/serialize ────────────────────────────────────────────────────

/**
 * Minimal YAML parser for lesson frontmatter. Supports:
 *   key: value
 *   key: [a, b, c]   (inline array)
 *   key:             (array below)
 *     - a
 *     - b
 */
export function parseFrontmatterYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1 || /^\s*-\s/.test(line)) {
      i++
      continue
    }
    const key = line.slice(0, colonIdx).trim()
    const rest = line.slice(colonIdx + 1).trim()
    if (!key) {
      i++
      continue
    }
    if (rest === '') {
      // check for following array block
      const arr: string[] = []
      let j = i + 1
      while (j < lines.length && /^\s*-\s+/.test(lines[j]!)) {
        arr.push(lines[j]!.replace(/^\s*-\s+/, '').trim())
        j++
      }
      result[key] = arr
      i = j
      continue
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim()
      result[key] = inner === '' ? [] : inner.split(',').map((s) => s.trim()).filter(Boolean)
    } else {
      // strip surrounding quotes if present
      result[key] = rest.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    }
    i++
  }
  return result
}

export function serializeFrontmatter(fm: LessonFrontmatter): string {
  const lines: string[] = ['---']
  lines.push(`id: ${fm.id}`)
  lines.push(`scope: ${fm.scope}`)
  if (fm.project) lines.push(`project: ${fm.project}`)
  if (fm.agent) lines.push(`agent: ${fm.agent}`)
  lines.push(`tags: [${fm.tags.join(', ')}]`)
  if (fm.appliesTo.length > 0) lines.push(`appliesTo: [${fm.appliesTo.join(', ')}]`)
  lines.push(`createdAt: ${fm.createdAt}`)
  lines.push('---')
  return lines.join('\n')
}

export function parseLesson(raw: string, path: string): Lesson {
  const trimmed = raw.replace(/^\uFEFF/, '')
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(trimmed)
  if (!match) {
    throw new Error(`Lesson ${path} missing YAML frontmatter`)
  }
  const rawFm = parseFrontmatterYaml(match[1]!)
  const parsed = LessonFrontmatterSchema.safeParse(rawFm)
  if (!parsed.success) {
    throw new Error(
      `Lesson ${path} frontmatter invalid: ${parsed.error.issues.map((x) => x.message).join('; ')}`,
    )
  }
  return { frontmatter: parsed.data, body: (match[2] ?? '').trim(), path }
}

export function serializeLesson(fm: LessonFrontmatter, body: string): string {
  return `${serializeFrontmatter(fm)}\n${body.trim()}\n`
}

// ── Repo / context detection ────────────────────────────────────────────────

/** Detect the repo slug for a directory. Prefers `git rev-parse` basename, falls back to cwd basename. */
export function detectRepoSlug(cwd: string): string {
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
      .toString()
      .trim()
    if (top) return basename(top)
  } catch {
    /* not a git repo or git unavailable */
  }
  return basename(cwd) || 'unknown'
}

// ── Filtering ───────────────────────────────────────────────────────────────

export function lessonMatches(lesson: Lesson, filter: LessonContextFilter): boolean {
  const fm = lesson.frontmatter
  if (fm.scope === 'global') return true
  if (fm.scope === 'project') {
    const project = filter.project ?? (filter.cwd ? detectRepoSlug(filter.cwd) : undefined)
    return !!project && fm.project === project
  }
  if (fm.scope === 'agent') {
    return !!filter.agent && fm.agent === filter.agent
  }
  return false
}

// ── Store ───────────────────────────────────────────────────────────────────

export interface LessonStoreConfig {
  readonly rootDir: string
}

export interface CreateLessonInput {
  readonly id?: string
  readonly scope?: LessonScope
  readonly project?: string
  readonly agent?: string
  readonly tags?: readonly string[]
  readonly appliesTo?: readonly string[]
  readonly body: string
  /** If scope missing, default to 'project' with this cwd's repo slug. */
  readonly defaultCwd?: string
}

export function createLessonStore(config: LessonStoreConfig) {
  const { rootDir } = config

  function ensureDir(): void {
    mkdirSync(rootDir, { recursive: true })
  }

  function listAll(): Lesson[] {
    if (!existsSync(rootDir)) return []
    const results: Lesson[] = []
    for (const name of readdirSync(rootDir)) {
      if (!name.endsWith('.md')) continue
      const full = join(rootDir, name)
      const st = statSync(full)
      if (!st.isFile()) continue
      try {
        const raw = readFileSync(full, 'utf-8')
        results.push(parseLesson(raw, name))
      } catch {
        /* skip malformed */
      }
    }
    return results
  }

  function list(filter?: LessonContextFilter): Lesson[] {
    const all = listAll()
    if (!filter) return all
    return all.filter((l) => lessonMatches(l, filter))
  }

  function create(input: CreateLessonInput): Lesson {
    ensureDir()
    const id = input.id ?? randomUUID()
    let scope: LessonScope
    let project: string | undefined
    let agent: string | undefined
    if (input.scope) {
      scope = input.scope
      project = input.project
      agent = input.agent
    } else {
      scope = 'project'
      project = input.project ?? (input.defaultCwd ? detectRepoSlug(input.defaultCwd) : undefined)
    }
    if (scope === 'project' && !project) {
      throw new Error('createLesson: project required when scope=project')
    }
    if (scope === 'agent' && !agent) {
      throw new Error('createLesson: agent required when scope=agent')
    }
    const fm: LessonFrontmatter = {
      id,
      scope,
      ...(project ? { project } : {}),
      ...(agent ? { agent } : {}),
      tags: [...(input.tags ?? [])],
      appliesTo: [...(input.appliesTo ?? [])],
      createdAt: new Date().toISOString(),
    }
    const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '-')
    const path = `${safeId}.md`
    const full = join(rootDir, path)
    writeFileSync(full, serializeLesson(fm, input.body), 'utf-8')
    return { frontmatter: fm, body: input.body.trim(), path }
  }

  /** Group lessons by {global | <project> | agent:<role>} for dashboard display. */
  function groupByScope(lessons: readonly Lesson[]): Record<string, Lesson[]> {
    const out: Record<string, Lesson[]> = {}
    for (const l of lessons) {
      const key =
        l.frontmatter.scope === 'global'
          ? 'global'
          : l.frontmatter.scope === 'project'
            ? `project:${l.frontmatter.project}`
            : `agent:${l.frontmatter.agent}`
      ;(out[key] ??= []).push(l)
    }
    return out
  }

  return { list, listAll, create, groupByScope, rootDir }
}

export type LessonStore = ReturnType<typeof createLessonStore>

// ── Migration of legacy flat files ──────────────────────────────────────────

export interface LegacyMigrationRule {
  readonly match: (filename: string) => boolean
  readonly scope: LessonScope
  readonly project?: string
  readonly agent?: string
  readonly tags?: readonly string[]
}

/** Migration rules for the pre-13.12.11 lessons sitting in ~/.scns/memory/ root. */
export const DEFAULT_MIGRATION_RULES: readonly LegacyMigrationRule[] = [
  { match: (n) => n.startsWith('meta-lesson-'), scope: 'global', tags: ['meta-lesson'] },
  { match: (n) => n.startsWith('pdf-'), scope: 'project', project: 'pdf-skill', tags: ['pdf'] },
  {
    match: (n) => n.startsWith('cosmere-'),
    scope: 'project',
    project: 'cosmere-rpg',
    tags: ['cosmere'],
  },
]

export interface MigrationResult {
  readonly migrated: readonly {
    readonly from: string
    readonly to: string
    readonly scope: LessonScope
    readonly project?: string
  }[]
  readonly skipped: readonly { readonly file: string; readonly reason: string }[]
}

/**
 * Migrate legacy flat-file lessons (no frontmatter, no .md extension) sitting
 * in the memory root into the lessons/ subdirectory with frontmatter.
 *
 * Idempotent — skips files that already look like lessons, and skips
 * filenames that don't match any rule.
 */
export function migrateLegacyLessons(
  memoryRoot: string,
  lessonsDir: string,
  rules: readonly LegacyMigrationRule[] = DEFAULT_MIGRATION_RULES,
): MigrationResult {
  if (!existsSync(memoryRoot)) return { migrated: [], skipped: [] }
  mkdirSync(lessonsDir, { recursive: true })
  const migrated: {
    from: string
    to: string
    scope: LessonScope
    project?: string
  }[] = []
  const skipped: { file: string; reason: string }[] = []

  for (const entry of readdirSync(memoryRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (entry.name.startsWith('.')) continue
    if (entry.name.endsWith('.md')) continue // skip MEMORY.md, SOUL.md, USER.md, any .md
    if (entry.name.endsWith('.db') || entry.name.endsWith('.db-wal') || entry.name.endsWith('.db-shm')) continue

    const rule = rules.find((r) => r.match(entry.name))
    if (!rule) {
      skipped.push({ file: entry.name, reason: 'no matching rule' })
      continue
    }

    const src = join(memoryRoot, entry.name)
    const dst = join(lessonsDir, `${entry.name}.md`)
    if (existsSync(dst)) {
      skipped.push({ file: entry.name, reason: 'already migrated' })
      continue
    }

    const body = readFileSync(src, 'utf-8').trim()
    const fm: LessonFrontmatter = {
      id: entry.name,
      scope: rule.scope,
      ...(rule.project ? { project: rule.project } : {}),
      ...(rule.agent ? { agent: rule.agent } : {}),
      tags: [...(rule.tags ?? [])],
      appliesTo: [],
      createdAt: new Date(statSync(src).mtimeMs).toISOString(),
    }
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, serializeLesson(fm, body), 'utf-8')
    // Move original out of the way so subsequent runs don't re-migrate
    const archiveDir = join(memoryRoot, '.legacy-lessons')
    mkdirSync(archiveDir, { recursive: true })
    renameSync(src, join(archiveDir, entry.name))
    migrated.push({
      from: entry.name,
      to: `${entry.name}.md`,
      scope: rule.scope,
      ...(rule.project ? { project: rule.project } : {}),
    })
  }

  return { migrated, skipped }
}
