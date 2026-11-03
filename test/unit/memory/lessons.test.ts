import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseFrontmatterYaml,
  parseLesson,
  serializeLesson,
  LessonFrontmatterSchema,
  lessonMatches,
  createLessonStore,
  migrateLegacyLessons,
  type LessonFrontmatter,
} from '../../../src/memory/lessons.js'

describe('parseFrontmatterYaml', () => {
  it('parses simple key/value', () => {
    expect(parseFrontmatterYaml('id: foo\nscope: global')).toEqual({ id: 'foo', scope: 'global' })
  })

  it('parses inline arrays', () => {
    expect(parseFrontmatterYaml('tags: [a, b, c]')).toEqual({ tags: ['a', 'b', 'c'] })
  })

  it('parses empty inline array', () => {
    expect(parseFrontmatterYaml('tags: []')).toEqual({ tags: [] })
  })

  it('parses block arrays', () => {
    const out = parseFrontmatterYaml('tags:\n  - a\n  - b')
    expect(out).toEqual({ tags: ['a', 'b'] })
  })

  it('strips surrounding quotes', () => {
    expect(parseFrontmatterYaml('id: "foo"')).toEqual({ id: 'foo' })
  })
})

describe('LessonFrontmatterSchema', () => {
  it('accepts valid global lesson', () => {
    const r = LessonFrontmatterSchema.safeParse({
      id: 'x',
      scope: 'global',
      tags: [],
      appliesTo: [],
      createdAt: '2026-01-01T00:00:00Z',
    })
    expect(r.success).toBe(true)
  })

  it('rejects project scope without project field', () => {
    const r = LessonFrontmatterSchema.safeParse({
      id: 'x',
      scope: 'project',
      tags: [],
      appliesTo: [],
      createdAt: '2026-01-01T00:00:00Z',
    })
    expect(r.success).toBe(false)
  })

  it('rejects agent scope without agent field', () => {
    const r = LessonFrontmatterSchema.safeParse({
      id: 'x',
      scope: 'agent',
      tags: [],
      appliesTo: [],
      createdAt: '2026-01-01T00:00:00Z',
    })
    expect(r.success).toBe(false)
  })

  it('applies empty-array defaults for tags / appliesTo', () => {
    const r = LessonFrontmatterSchema.parse({
      id: 'x',
      scope: 'global',
      createdAt: '2026-01-01T00:00:00Z',
    })
    expect(r.tags).toEqual([])
    expect(r.appliesTo).toEqual([])
  })
})

describe('parseLesson / serializeLesson round-trip', () => {
  it('round-trips a lesson', () => {
    const fm: LessonFrontmatter = {
      id: 'lesson-1',
      scope: 'project',
      project: 'scns',
      tags: ['verification', 'perf'],
      appliesTo: [],
      createdAt: '2026-04-18T00:00:00Z',
    }
    const body = 'Some lesson body.\n\nMultiple lines.'
    const raw = serializeLesson(fm, body)
    const parsed = parseLesson(raw, 'lesson-1.md')
    expect(parsed.frontmatter).toMatchObject(fm)
    expect(parsed.body).toBe(body)
  })

  it('throws on missing frontmatter', () => {
    expect(() => parseLesson('no frontmatter here', 'bad.md')).toThrow(/missing YAML frontmatter/)
  })
})

describe('lessonMatches', () => {
  const base = {
    tags: [] as string[],
    appliesTo: [] as string[],
    createdAt: '2026-04-18T00:00:00Z',
  }

  it('includes global regardless of filter', () => {
    const l = { frontmatter: { id: 'g', scope: 'global' as const, ...base }, body: '', path: 'g.md' }
    expect(lessonMatches(l, {})).toBe(true)
    expect(lessonMatches(l, { project: 'foo', agent: 'bar' })).toBe(true)
  })

  it('includes project when project matches', () => {
    const l = {
      frontmatter: { id: 'p', scope: 'project' as const, project: 'scns', ...base },
      body: '',
      path: 'p.md',
    }
    expect(lessonMatches(l, { project: 'scns' })).toBe(true)
    expect(lessonMatches(l, { project: 'other' })).toBe(false)
  })

  it('excludes project when no project supplied', () => {
    const l = {
      frontmatter: { id: 'p', scope: 'project' as const, project: 'scns', ...base },
      body: '',
      path: 'p.md',
    }
    expect(lessonMatches(l, {})).toBe(false)
  })

  it('includes agent when agent matches', () => {
    const l = {
      frontmatter: { id: 'a', scope: 'agent' as const, agent: 'brain', ...base },
      body: '',
      path: 'a.md',
    }
    expect(lessonMatches(l, { agent: 'brain' })).toBe(true)
    expect(lessonMatches(l, { agent: 'qa' })).toBe(false)
    expect(lessonMatches(l, {})).toBe(false)
  })
})

describe('createLessonStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lessons-'))
  })

  it('creates and lists lessons', () => {
    const store = createLessonStore({ rootDir: dir })
    const l = store.create({ scope: 'global', body: 'hello', tags: ['x'] })
    expect(l.frontmatter.scope).toBe('global')
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.frontmatter.tags).toEqual(['x'])
  })

  it('defaults to project scope with cwd repo when scope missing', () => {
    const store = createLessonStore({ rootDir: dir })
    const l = store.create({ body: 'b', project: 'explicit-project' })
    expect(l.frontmatter.scope).toBe('project')
    expect(l.frontmatter.project).toBe('explicit-project')
  })

  it('throws when scope=project but no project', () => {
    const store = createLessonStore({ rootDir: dir })
    expect(() => store.create({ scope: 'project', body: 'b' })).toThrow(/project required/)
  })

  it('filters by context', () => {
    const store = createLessonStore({ rootDir: dir })
    store.create({ scope: 'global', body: 'g' })
    store.create({ scope: 'project', project: 'scns', body: 'p-scns' })
    store.create({ scope: 'project', project: 'pdf-skill', body: 'p-pdf' })
    store.create({ scope: 'agent', agent: 'brain', body: 'a-brain' })

    const forScnsBrain = store.list({ project: 'scns', agent: 'brain' })
    const scopes = forScnsBrain.map((l) => l.frontmatter.scope).sort()
    expect(scopes).toEqual(['agent', 'global', 'project'])
    // pdf-skill lesson excluded
    expect(forScnsBrain.some((l) => l.frontmatter.project === 'pdf-skill')).toBe(false)
  })

  it('groups by scope for dashboard', () => {
    const store = createLessonStore({ rootDir: dir })
    store.create({ scope: 'global', body: 'g' })
    store.create({ scope: 'project', project: 'scns', body: 'p-scns' })
    store.create({ scope: 'project', project: 'pdf-skill', body: 'p-pdf' })
    store.create({ scope: 'agent', agent: 'brain', body: 'a-brain' })
    const g = store.groupByScope(store.list())
    expect(Object.keys(g).sort()).toEqual([
      'agent:brain',
      'global',
      'project:pdf-skill',
      'project:scns',
    ])
  })
})

describe('migrateLegacyLessons', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'migrate-'))
  })

  it('migrates legacy flat files into lessons dir with frontmatter', () => {
    writeFileSync(join(root, 'meta-lesson-foo'), 'meta body', 'utf-8')
    writeFileSync(join(root, 'pdf-bar'), 'pdf body', 'utf-8')
    writeFileSync(join(root, 'cosmere-baz'), 'cosmere body', 'utf-8')
    writeFileSync(join(root, 'MEMORY.md'), 'should skip', 'utf-8')
    writeFileSync(join(root, 'unrelated'), 'no rule', 'utf-8')
    const lessonsDir = join(root, 'lessons')
    const result = migrateLegacyLessons(root, lessonsDir)
    expect(result.migrated).toHaveLength(3)
    const byFile = new Map(result.migrated.map((m) => [m.from, m]))
    expect(byFile.get('meta-lesson-foo')!.scope).toBe('global')
    expect(byFile.get('pdf-bar')!.project).toBe('pdf-skill')
    expect(byFile.get('cosmere-baz')!.project).toBe('cosmere-rpg')
    // unrelated skipped
    expect(result.skipped.some((s) => s.file === 'unrelated')).toBe(true)
    // .md files not picked up
    expect(result.migrated.some((m) => m.from === 'MEMORY.md')).toBe(false)

    // files written with frontmatter
    const pdfFile = readFileSync(join(lessonsDir, 'pdf-bar.md'), 'utf-8')
    expect(pdfFile).toContain('scope: project')
    expect(pdfFile).toContain('project: pdf-skill')
    expect(pdfFile).toContain('pdf body')

    // legacy moved aside
    expect(existsSync(join(root, 'meta-lesson-foo'))).toBe(false)
    expect(existsSync(join(root, '.legacy-lessons', 'meta-lesson-foo'))).toBe(true)
  })

  it('is idempotent — second run is a no-op', () => {
    writeFileSync(join(root, 'meta-lesson-foo'), 'meta body', 'utf-8')
    const lessonsDir = join(root, 'lessons')
    const first = migrateLegacyLessons(root, lessonsDir)
    expect(first.migrated).toHaveLength(1)
    const second = migrateLegacyLessons(root, lessonsDir)
    expect(second.migrated).toHaveLength(0)
    // only one file present
    expect(readdirSync(lessonsDir).filter((f) => f.endsWith('.md'))).toEqual(['meta-lesson-foo.md'])
  })
})
