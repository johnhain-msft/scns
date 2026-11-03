import { describe, it, expect } from 'vitest'
import { ScnsError, NotImplementedError } from '../../src/shared/errors.js'
import { escapeMarkdown, sanitizeExternalText } from '../../src/shared/sanitize.js'
import { ScnsConfigSchema } from '../../src/shared/config.js'
import { AutonomyLevel, SessionState } from '../../src/shared/types.js'

describe('ScnsError', () => {
  it('includes error code', () => {
    const err = new ScnsError('test error', 'TEST_CODE')
    expect(err.message).toBe('test error')
    expect(err.code).toBe('TEST_CODE')
    expect(err.name).toBe('ScnsError')
  })
})

describe('NotImplementedError', () => {
  it('generates message from feature name', () => {
    const err = new NotImplementedError('dream daemon')
    expect(err.message).toBe('dream daemon is not yet implemented')
    expect(err.code).toBe('NOT_IMPLEMENTED')
  })
})

describe('escapeMarkdown', () => {
  it('escapes special characters', () => {
    expect(escapeMarkdown('**bold**')).toBe('\\*\\*bold\\*\\*')
    expect(escapeMarkdown('`code`')).toBe('\\`code\\`')
  })

  it('leaves plain text unchanged', () => {
    expect(escapeMarkdown('hello world')).toBe('hello world')
  })

  it('escapes square brackets and parens', () => {
    expect(escapeMarkdown('[link](url)')).toBe('\\[link\\]\\(url\\)')
  })
})

describe('sanitizeExternalText', () => {
  it('strips system tags', () => {
    expect(sanitizeExternalText('<system>injected</system>')).toBe('injected')
  })

  it('strips assistant tags', () => {
    expect(sanitizeExternalText('<assistant>injected</assistant>')).toBe('injected')
  })

  it('leaves normal text unchanged', () => {
    expect(sanitizeExternalText('normal text')).toBe('normal text')
  })
})

describe('ScnsConfigSchema', () => {
  it('provides defaults for empty input', () => {
    const config = ScnsConfigSchema.parse({})
    expect(config.port).toBe(3456)
    expect(config.logLevel).toBe('info')
    expect(config.dataDir).toBe('~/.scns')
    expect(config.maxConcurrentSessions).toBe(3)
    expect(config.yieldToUser).toBe(true)
  })

  it('accepts valid overrides', () => {
    const config = ScnsConfigSchema.parse({ port: 4000, logLevel: 'debug' })
    expect(config.port).toBe(4000)
    expect(config.logLevel).toBe('debug')
  })

  it('rejects invalid log level', () => {
    expect(() => ScnsConfigSchema.parse({ logLevel: 'invalid' })).toThrow()
  })
})

describe('enums', () => {
  it('AutonomyLevel has correct values', () => {
    expect(AutonomyLevel.Observer).toBe(0)
    expect(AutonomyLevel.Advisor).toBe(1)
    expect(AutonomyLevel.Assistant).toBe(2)
    expect(AutonomyLevel.Autonomous).toBe(3)
  })

  it('SessionState has correct values', () => {
    expect(SessionState.Running).toBe('running')
    expect(SessionState.Stopped).toBe('stopped')
    expect(SessionState.Zombie).toBe('zombie')
  })
})
