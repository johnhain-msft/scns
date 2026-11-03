import { describe, it, expect } from 'vitest'
import { buildTags, formatTag, parseTag } from '../../../src/observe/tags.js'
import { ObservationType } from '../../../src/observe/types.js'

describe('formatTag', () => {
  it('creates proper category:value format', () => {
    expect(formatTag('app', 'chrome')).toBe('app:chrome')
  })

  it('lowercases the value', () => {
    expect(formatTag('app', 'Chrome')).toBe('app:chrome')
  })

  it('lowercases the category', () => {
    expect(formatTag('App', 'chrome')).toBe('app:chrome')
  })
})

describe('parseTag', () => {
  it('parses a valid tag', () => {
    const result = parseTag('app:chrome')
    expect(result).toEqual({ category: 'app', value: 'chrome' })
  })

  it('handles tags with multiple colons', () => {
    const result = parseTag('url:https://example.com')
    expect(result).toEqual({ category: 'url', value: 'https://example.com' })
  })

  it('returns null for malformed tag without colon', () => {
    expect(parseTag('nocolon')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseTag('')).toBeNull()
  })

  it('returns null for tag with empty category', () => {
    expect(parseTag(':value')).toBeNull()
  })

  it('returns null for tag with empty value', () => {
    expect(parseTag('category:')).toBeNull()
  })

  it('round-trips with formatTag', () => {
    const tag = formatTag('project', 'scns')
    const parsed = parseTag(tag)
    expect(parsed).toEqual({ category: 'project', value: 'scns' })
  })
})

describe('buildTags', () => {
  it('includes type tag for active-app', () => {
    const tags = buildTags(ObservationType.ActiveApp, 'Chrome')
    expect(tags).toContain('type:active-app')
    expect(tags).toContain('source:chrome')
  })

  it('includes type tag for file-change', () => {
    const tags = buildTags(ObservationType.FileChange, 'VSCode')
    expect(tags).toContain('type:file-change')
    expect(tags).toContain('source:vscode')
  })

  it('includes type tag for git-activity', () => {
    const tags = buildTags(ObservationType.GitActivity, 'git')
    expect(tags).toContain('type:git-activity')
    expect(tags).toContain('source:git')
  })

  it('includes type tag for terminal-history', () => {
    const tags = buildTags(ObservationType.TerminalHistory, 'zsh')
    expect(tags).toContain('type:terminal-history')
    expect(tags).toContain('source:zsh')
  })

  it('includes type tag for browser-tab', () => {
    const tags = buildTags(ObservationType.BrowserTab, 'Chrome')
    expect(tags).toContain('type:browser-tab')
    expect(tags).toContain('source:chrome')
  })

  it('includes type tag for session-hook', () => {
    const tags = buildTags(ObservationType.SessionHook, 'scns')
    expect(tags).toContain('type:session-hook')
    expect(tags).toContain('source:scns')
  })

  it('includes metadata-based tags when provided', () => {
    const tags = buildTags(ObservationType.GitActivity, 'git', {
      action: 'commit',
      project: 'scns',
      branch: 'main',
    })
    expect(tags).toContain('action:commit')
    expect(tags).toContain('project:scns')
    expect(tags).toContain('branch:main')
  })

  it('skips non-string metadata values', () => {
    const tags = buildTags(ObservationType.ActiveApp, 'Chrome', {
      windowId: 42,
      project: 'scns',
    })
    expect(tags).toContain('project:scns')
    expect(tags).not.toContain('windowId:42')
  })

  it('returns all tags in lowercase', () => {
    const tags = buildTags(ObservationType.ActiveApp, 'Chrome', { project: 'SCNS' })
    for (const tag of tags) {
      expect(tag).toBe(tag.toLowerCase())
    }
  })
})
