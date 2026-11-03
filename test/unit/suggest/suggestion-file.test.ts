import { describe, it, expect } from 'vitest'
import {
  serializeSuggestion,
  parseSuggestion,
  parseFrontmatter,
  serializeFrontmatter,
} from '../../../src/suggest/suggestion-file.js'
import type { Suggestion } from '../../../src/suggest/types.js'

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'skill',
    title: 'Create git-commit helper skill',
    description: 'You frequently run the same git commit pattern.',
    status: 'pending',
    confidence: 0.85,
    evidence: [
      {
        source: 'tool-frequency',
        detail: 'Git used 45 times in last 7 days',
        observedAt: '2025-01-15T10:00:00Z',
        weight: 0.8,
      },
      {
        source: 'work-schedule',
        detail: 'Commits peak at 2PM daily',
        observedAt: '2025-01-15T10:00:00Z',
        weight: 0.6,
      },
    ],
    tags: ['git', 'automation'],
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:00:00Z',
    ...overrides,
  }
}

describe('parseFrontmatter', () => {
  it('extracts key-value pairs', () => {
    const content = '---\ntitle: Hello\nstatus: pending\n---\nBody text'
    const result = parseFrontmatter(content)
    expect(result.frontmatter['title']).toBe('Hello')
    expect(result.frontmatter['status']).toBe('pending')
    expect(result.body).toBe('Body text')
  })

  it('handles quoted strings', () => {
    const content = '---\ntitle: "Hello World"\nid: "abc-123"\n---\nBody'
    const result = parseFrontmatter(content)
    expect(result.frontmatter['title']).toBe('Hello World')
    expect(result.frontmatter['id']).toBe('abc-123')
  })

  it('handles numbers', () => {
    const content = '---\nconfidence: 0.85\ncount: 42\n---\n'
    const result = parseFrontmatter(content)
    expect(result.frontmatter['confidence']).toBe(0.85)
    expect(result.frontmatter['count']).toBe(42)
  })

  it('handles booleans', () => {
    const content = '---\nenabled: true\ndisabled: false\n---\n'
    const result = parseFrontmatter(content)
    expect(result.frontmatter['enabled']).toBe(true)
    expect(result.frontmatter['disabled']).toBe(false)
  })

  it('handles inline arrays', () => {
    const content = '---\ntags: [git, automation, cli]\n---\n'
    const result = parseFrontmatter(content)
    expect(result.frontmatter['tags']).toEqual(['git', 'automation', 'cli'])
  })

  it('handles inline arrays with quoted elements', () => {
    const content = '---\ntags: ["git tools", "my automation"]\n---\n'
    const result = parseFrontmatter(content)
    expect(result.frontmatter['tags']).toEqual(['git tools', 'my automation'])
  })

  it('handles ISO date strings', () => {
    const content = '---\ncreatedAt: "2025-01-15T10:00:00Z"\n---\n'
    const result = parseFrontmatter(content)
    expect(result.frontmatter['createdAt']).toBe('2025-01-15T10:00:00Z')
  })

  it('handles empty body', () => {
    const content = '---\ntitle: Test\n---\n'
    const result = parseFrontmatter(content)
    expect(result.frontmatter['title']).toBe('Test')
    expect(result.body).toBe('')
  })

  it('throws on missing frontmatter delimiters', () => {
    expect(() => parseFrontmatter('no frontmatter here')).toThrow()
  })

  it('handles empty inline arrays', () => {
    const content = '---\ntags: []\n---\n'
    const result = parseFrontmatter(content)
    expect(result.frontmatter['tags']).toEqual([])
  })
})

describe('serializeFrontmatter', () => {
  it('produces valid frontmatter format', () => {
    const data = { title: 'Hello', status: 'pending' }
    const result = serializeFrontmatter(data, 'Body text')
    expect(result).toContain('---')
    expect(result).toContain('title: "Hello"')
    expect(result).toContain('status: "pending"')
    expect(result).toContain('Body text')
  })

  it('serializes numbers without quotes', () => {
    const data = { confidence: 0.85 }
    const result = serializeFrontmatter(data, '')
    expect(result).toContain('confidence: 0.85')
  })

  it('serializes booleans without quotes', () => {
    const data = { enabled: true }
    const result = serializeFrontmatter(data, '')
    expect(result).toContain('enabled: true')
  })

  it('serializes arrays in inline format', () => {
    const data = { tags: ['git', 'automation'] }
    const result = serializeFrontmatter(data, '')
    expect(result).toContain('tags: [git, automation]')
  })
})

describe('serializeSuggestion', () => {
  it('produces valid markdown with frontmatter', () => {
    const suggestion = makeSuggestion()
    const result = serializeSuggestion(suggestion)
    expect(result).toContain('---')
    expect(result).toContain('id: "550e8400-e29b-41d4-a716-446655440000"')
    expect(result).toContain('type: "skill"')
    expect(result).toContain('title: "Create git-commit helper skill"')
    expect(result).toContain('status: "pending"')
    expect(result).toContain('confidence: 0.85')
    expect(result).toContain('## Description')
    expect(result).toContain('You frequently run the same git commit pattern.')
  })

  it('includes evidence section with formatted entries', () => {
    const suggestion = makeSuggestion()
    const result = serializeSuggestion(suggestion)
    expect(result).toContain('## Evidence')
    expect(result).toContain(
      '- **tool-frequency**: Git used 45 times in last 7 days (weight: 0.8, observed: 2025-01-15T10:00:00Z)',
    )
    expect(result).toContain(
      '- **work-schedule**: Commits peak at 2PM daily (weight: 0.6, observed: 2025-01-15T10:00:00Z)',
    )
  })

  it('includes implementation plan section when available', () => {
    const suggestion = makeSuggestion({
      implementationPlan: 'Step 1: Create the skill file',
    })
    const result = serializeSuggestion(suggestion)
    expect(result).toContain('## Implementation Plan')
    expect(result).toContain('Step 1: Create the skill file')
  })

  it('omits implementation plan section when not available', () => {
    const suggestion = makeSuggestion()
    const result = serializeSuggestion(suggestion)
    expect(result).not.toContain('## Implementation Plan')
  })

  it('omits evidence section for empty evidence array', () => {
    const suggestion = makeSuggestion({ evidence: [] })
    const result = serializeSuggestion(suggestion)
    expect(result).not.toContain('## Evidence')
  })
})

describe('parseSuggestion', () => {
  it('parses serialized suggestion back correctly', () => {
    const original = makeSuggestion()
    const serialized = serializeSuggestion(original)
    const parsed = parseSuggestion(serialized)
    expect(parsed.id).toBe(original.id)
    expect(parsed.type).toBe(original.type)
    expect(parsed.title).toBe(original.title)
    expect(parsed.description).toBe(original.description)
    expect(parsed.status).toBe(original.status)
    expect(parsed.confidence).toBe(original.confidence)
    expect(parsed.tags).toEqual(original.tags)
    expect(parsed.createdAt).toBe(original.createdAt)
    expect(parsed.updatedAt).toBe(original.updatedAt)
  })

  it('round-trips evidence correctly', () => {
    const original = makeSuggestion()
    const serialized = serializeSuggestion(original)
    const parsed = parseSuggestion(serialized)
    expect(parsed.evidence).toHaveLength(2)
    expect(parsed.evidence[0]!.source).toBe('tool-frequency')
    expect(parsed.evidence[0]!.detail).toBe('Git used 45 times in last 7 days')
    expect(parsed.evidence[0]!.weight).toBe(0.8)
    expect(parsed.evidence[0]!.observedAt).toBe('2025-01-15T10:00:00Z')
    expect(parsed.evidence[1]!.source).toBe('work-schedule')
    expect(parsed.evidence[1]!.observedAt).toBe('2025-01-15T10:00:00Z')
  })

  it('round-trips with implementation plan', () => {
    const original = makeSuggestion({
      implementationPlan: 'Step 1: Create the skill\nStep 2: Test it',
    })
    const serialized = serializeSuggestion(original)
    const parsed = parseSuggestion(serialized)
    expect(parsed.implementationPlan).toBe('Step 1: Create the skill\nStep 2: Test it')
  })

  it('round-trips with optional review fields', () => {
    const original = makeSuggestion({
      reviewedAt: '2025-01-16T10:00:00Z',
      reviewReason: 'Approved because useful',
    })
    const serialized = serializeSuggestion(original)
    const parsed = parseSuggestion(serialized)
    expect(parsed.reviewedAt).toBe('2025-01-16T10:00:00Z')
    expect(parsed.reviewReason).toBe('Approved because useful')
  })

  it('handles missing optional fields gracefully', () => {
    const suggestion = makeSuggestion({ evidence: [] })
    const serialized = serializeSuggestion(suggestion)
    const parsed = parseSuggestion(serialized)
    expect(parsed.evidence).toEqual([])
    expect(parsed.implementationPlan).toBeUndefined()
    expect(parsed.reviewedAt).toBeUndefined()
    expect(parsed.reviewReason).toBeUndefined()
  })

  it('throws on malformed frontmatter', () => {
    expect(() => parseSuggestion('no frontmatter')).toThrow()
  })
})

describe('parseEvidenceSection (via parseSuggestion)', () => {
  function bodyWithEvidence(evidenceLines: string): string {
    return [
      '---',
      'id: "550e8400-e29b-41d4-a716-446655440099"',
      'type: "skill"',
      'title: "Test"',
      'status: "pending"',
      'confidence: 0.5',
      'tags: []',
      'createdAt: "2025-01-15T10:00:00Z"',
      'updatedAt: "2025-01-15T10:00:00Z"',
      '---',
      '## Description',
      'desc',
      '',
      '## Evidence',
      evidenceLines,
      '',
    ].join('\n')
  }

  it('parses strict-format evidence lines into structured objects', () => {
    const content = bodyWithEvidence(
      '- **tool-frequency**: Git used 45 times (weight: 0.8, observed: 2025-01-15T10:00:00Z)',
    )
    const parsed = parseSuggestion(content)
    expect(parsed.evidence).toHaveLength(1)
    expect(parsed.evidence[0]!.source).toBe('tool-frequency')
    expect(parsed.evidence[0]!.detail).toBe('Git used 45 times')
    expect(parsed.evidence[0]!.weight).toBe(0.8)
    expect(parsed.evidence[0]!.observedAt).toBe('2025-01-15T10:00:00Z')
  })

  it('falls back to a loose evidence object for plain `- text` bullets', () => {
    const content = bodyWithEvidence('- plain observation without metadata')
    const parsed = parseSuggestion(content)
    expect(parsed.evidence).toHaveLength(1)
    expect(parsed.evidence[0]!.source).toBe('file')
    expect(parsed.evidence[0]!.detail).toBe('plain observation without metadata')
    expect(parsed.evidence[0]!.weight).toBe(0.5)
    expect(typeof parsed.evidence[0]!.observedAt).toBe('string')
    expect(parsed.evidence[0]!.observedAt.length).toBeGreaterThan(0)
  })

  it('handles a mix of strict and loose lines in the same section', () => {
    const content = bodyWithEvidence(
      [
        '- **tool-frequency**: structured entry (weight: 0.9, observed: 2025-02-01T00:00:00Z)',
        '- loose bullet one',
        '- loose bullet two',
      ].join('\n'),
    )
    const parsed = parseSuggestion(content)
    expect(parsed.evidence).toHaveLength(3)
    expect(parsed.evidence[0]!.source).toBe('tool-frequency')
    expect(parsed.evidence[0]!.weight).toBe(0.9)
    expect(parsed.evidence[1]!.source).toBe('file')
    expect(parsed.evidence[1]!.detail).toBe('loose bullet one')
    expect(parsed.evidence[2]!.detail).toBe('loose bullet two')
  })

  it('skips blank lines and non-bullet lines', () => {
    const content = bodyWithEvidence(
      ['', 'not a bullet — ignore', '- actual bullet', '   ', ''].join('\n'),
    )
    const parsed = parseSuggestion(content)
    expect(parsed.evidence).toHaveLength(1)
    expect(parsed.evidence[0]!.detail).toBe('actual bullet')
  })
})
