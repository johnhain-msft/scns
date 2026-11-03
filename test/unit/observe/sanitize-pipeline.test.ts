import { describe, it, expect } from 'vitest'
import { createPrivacyFilter } from '../../../src/observe/privacy-filter.js'
import type { PrivacyConfig } from '../../../src/observe/privacy-filter.js'
import { createSecretSanitizer } from '../../../src/observe/secret-sanitizer.js'
import { createSanitizePipeline } from '../../../src/observe/sanitize-pipeline.js'

describe('createSanitizePipeline', () => {
  const baseConfig: PrivacyConfig = {
    excludeApps: [],
    excludePaths: [],
    excludeUrls: [],
    sanitizeSecrets: true,
  }

  it('returns null for filtered observations', () => {
    const filter = createPrivacyFilter({ config: { ...baseConfig, excludeApps: ['Slack'] } })
    const sanitizer = createSecretSanitizer()
    const pipeline = createSanitizePipeline(filter, sanitizer)

    expect(pipeline.process({ type: 'active-app', appName: 'Slack' }, 'content')).toBeNull()
  })

  it('returns sanitized content for allowed observations', () => {
    const filter = createPrivacyFilter({ config: baseConfig })
    const sanitizer = createSecretSanitizer()
    const pipeline = createSanitizePipeline(filter, sanitizer)

    const result = pipeline.process(
      { type: 'active-app', appName: 'VSCode' },
      'token: Bearer abc123def456',
    )
    expect(result).toBe('token: [REDACTED]')
  })

  it('strips secrets from allowed content', () => {
    const filter = createPrivacyFilter({ config: baseConfig })
    const sanitizer = createSecretSanitizer()
    const pipeline = createSanitizePipeline(filter, sanitizer)

    const result = pipeline.process(
      { type: 'file-change', filePath: '/src/app.ts' },
      'password=supersecret',
    )
    expect(result).toBe('[REDACTED]')
  })

  it('combines filter + sanitization correctly', () => {
    const config: PrivacyConfig = {
      ...baseConfig,
      excludeApps: ['Slack'],
      excludePaths: ['*.log'],
    }
    const filter = createPrivacyFilter({ config })
    const sanitizer = createSecretSanitizer()
    const pipeline = createSanitizePipeline(filter, sanitizer)

    // Filtered → null
    expect(pipeline.process({ type: 'active-app', appName: 'Slack' }, 'data')).toBeNull()
    expect(pipeline.process({ type: 'file-change', filePath: 'error.log' }, 'data')).toBeNull()

    // Allowed + sanitized
    const result = pipeline.process(
      { type: 'active-app', appName: 'VSCode' },
      'key: AKIAIOSFODNN7EXAMPLE',
    )
    expect(result).toBe('key: [REDACTED]')
  })

  it('passes through clean content unchanged', () => {
    const filter = createPrivacyFilter({ config: baseConfig })
    const sanitizer = createSecretSanitizer()
    const pipeline = createSanitizePipeline(filter, sanitizer)

    const result = pipeline.process(
      { type: 'active-app', appName: 'VSCode' },
      'normal activity log',
    )
    expect(result).toBe('normal activity log')
  })

  it('handles empty content', () => {
    const filter = createPrivacyFilter({ config: baseConfig })
    const sanitizer = createSecretSanitizer()
    const pipeline = createSanitizePipeline(filter, sanitizer)

    expect(pipeline.process({ type: 'git-activity' }, '')).toBe('')
  })

  it('returns null for filtered observation even with secrets', () => {
    const filter = createPrivacyFilter({ config: { ...baseConfig, excludeApps: ['Slack'] } })
    const sanitizer = createSecretSanitizer()
    const pipeline = createSanitizePipeline(filter, sanitizer)

    expect(
      pipeline.process({ type: 'active-app', appName: 'Slack' }, 'Bearer secret123'),
    ).toBeNull()
  })

  it('filters terminal when not opted in', () => {
    const filter = createPrivacyFilter({ config: baseConfig })
    const sanitizer = createSecretSanitizer()
    const pipeline = createSanitizePipeline(filter, sanitizer)

    expect(pipeline.process({ type: 'terminal-history' }, 'ls -la')).toBeNull()
  })

  it('filters browser when not opted in', () => {
    const filter = createPrivacyFilter({ config: baseConfig })
    const sanitizer = createSecretSanitizer()
    const pipeline = createSanitizePipeline(filter, sanitizer)

    expect(pipeline.process({ type: 'browser-tab', url: 'https://example.com' }, 'page')).toBeNull()
  })

  it('sanitizes allowed terminal content', () => {
    const filter = createPrivacyFilter({ config: { ...baseConfig, terminalHistoryOptIn: true } })
    const sanitizer = createSecretSanitizer()
    const pipeline = createSanitizePipeline(filter, sanitizer)

    const result = pipeline.process({ type: 'terminal-history' }, 'export SECRET_KEY=abc123')
    expect(result).toBe('[REDACTED]')
  })
})
