import { describe, it, expect } from 'vitest'
import { synthesizeEntry, fixTypos } from '../../../src/dream/extraction.js'

describe('fixTypos', () => {
  it('corrects common user typos', () => {
    expect(fixTypos('ii want to buiilid this')).toBe('I want to build this')
    expect(fixTypos('teh regressoin si broken')).toBe('the regression is broken')
    expect(fixTypos('iimplementation si doone')).toBe('implementation is done')
  })

  it('preserves correctly spelled text', () => {
    expect(fixTypos('Follow TDD workflow')).toBe('Follow TDD workflow')
  })

  it('handles multiple typos in one string', () => {
    const result = fixTypos('ii diid teh testnig')
    expect(result).toBe('I did the testing')
  })
})

describe('synthesizeEntry', () => {
  it('synthesizes TDD-related prompts into actionable lessons', () => {
    const result = synthesizeEntry('follow TDD and do manual tests', 'feedback')
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Follow TDD Workflow')
    expect(result!.description).toContain('Test-Driven Development')
  })

  it('synthesizes production quality prompts', () => {
    const result = synthesizeEntry(
      'telling me it works is like pushing to prod -- production ready',
      'feedback',
    )
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Production Quality Standard')
    expect(result!.description).toContain('production-ready')
  })

  it('synthesizes quality-gate prompts', () => {
    const result = synthesizeEntry('run quality-gate on it before you are done', 'feedback')
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Run Quality Gate Before Completion')
  })

  it('synthesizes emotional prohibition prompts about testing', () => {
    const result = synthesizeEntry(
      'why would you lie about testing? this is broken',
      'prohibition',
    )
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Never Fabricate Test Results')
    expect(result!.description).toContain('Never claim tests pass')
  })

  it('synthesizes "stop doing" prompts about testing', () => {
    const result = synthesizeEntry(
      'stop skipping the tests AGAIN! I told you this is broken',
      'prohibition',
    )
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Never Skip Required Testing')
  })

  it('synthesizes "stop ignoring" prompts', () => {
    const result = synthesizeEntry('stop ignoring what I say', 'prohibition')
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Always Follow User Instructions')
  })

  it('cleans up non-matching prohibition entries', () => {
    const result = synthesizeEntry(
      'you keep making mistakes without checking the output',
      'prohibition',
    )
    expect(result).not.toBeNull()
    // Should be cleaned (no typos, normalized) but not rule-matched
    expect(result!.content).not.toContain('??')
  })

  it('returns null for very short entries', () => {
    const result = synthesizeEntry('ok', 'feedback')
    expect(result).toBeNull()
  })

  it('fixes typos in non-matching entries', () => {
    const result = synthesizeEntry(
      'ii want teh build to be fast and reliable for teh team',
      'user',
    )
    expect(result).not.toBeNull()
    expect(result!.content).toContain('the build')
    expect(result!.content).not.toContain('teh')
    expect(result!.content).toContain('I want')
  })

  it('synthesizes manual+automated testing prompts', () => {
    const result = synthesizeEntry(
      'you need manual and automated tests before saying done',
      'feedback',
    )
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Require Both Manual And Automated Testing')
  })
})
