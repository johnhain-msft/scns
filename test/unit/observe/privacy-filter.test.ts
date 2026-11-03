import { describe, it, expect } from 'vitest'
import { createPrivacyFilter, matchGlob } from '../../../src/observe/privacy-filter.js'
import type { PrivacyConfig } from '../../../src/observe/privacy-filter.js'

describe('matchGlob', () => {
  it('matches exact string', () => {
    expect(matchGlob('Slack', 'Slack')).toBe(true)
  })

  it('is case insensitive', () => {
    expect(matchGlob('Slack', 'slack')).toBe(true)
    expect(matchGlob('slack', 'SLACK')).toBe(true)
  })

  it('matches * wildcard within a path segment', () => {
    expect(matchGlob('Sl*', 'Slack')).toBe(true)
    expect(matchGlob('*ack', 'Slack')).toBe(true)
    expect(matchGlob('*.ts', 'index.ts')).toBe(true)
  })

  it('does not match * across path separators', () => {
    expect(matchGlob('*.ts', 'src/index.ts')).toBe(false)
  })

  it('matches ** across path separators', () => {
    expect(matchGlob('**/*.ts', 'src/index.ts')).toBe(true)
    expect(matchGlob('**/*.ts', 'src/deep/nested/index.ts')).toBe(true)
    expect(matchGlob('**/*.ts', 'index.ts')).toBe(true)
  })

  it('matches ? for a single character', () => {
    expect(matchGlob('Sl?ck', 'Slack')).toBe(true)
    expect(matchGlob('Sl?ck', 'Slick')).toBe(true)
    expect(matchGlob('Sl?ck', 'Sck')).toBe(false)
  })

  it('handles complex glob patterns', () => {
    expect(matchGlob('/home/**/secret*', '/home/user/secret-file')).toBe(true)
    expect(matchGlob('**/node_modules/**', 'project/node_modules/pkg/index.js')).toBe(true)
  })

  it('returns false for non-matching strings', () => {
    expect(matchGlob('foo', 'bar')).toBe(false)
    expect(matchGlob('*.js', 'index.ts')).toBe(false)
  })
})

describe('createPrivacyFilter', () => {
  const defaultConfig: PrivacyConfig = {
    excludeApps: [],
    excludePaths: [],
    excludeUrls: [],
    sanitizeSecrets: true,
  }

  describe('isAppExcluded', () => {
    it('excludes exact match', () => {
      const f = createPrivacyFilter({ config: { ...defaultConfig, excludeApps: ['Slack'] } })
      expect(f.isAppExcluded('Slack')).toBe(true)
    })

    it('excludes via glob pattern', () => {
      const f = createPrivacyFilter({ config: { ...defaultConfig, excludeApps: ['*Chat*'] } })
      expect(f.isAppExcluded('Discord Chat')).toBe(true)
    })

    it('is case insensitive', () => {
      const f = createPrivacyFilter({ config: { ...defaultConfig, excludeApps: ['slack'] } })
      expect(f.isAppExcluded('Slack')).toBe(true)
      expect(f.isAppExcluded('SLACK')).toBe(true)
    })

    it('returns false when not excluded', () => {
      const f = createPrivacyFilter({ config: { ...defaultConfig, excludeApps: ['Slack'] } })
      expect(f.isAppExcluded('VSCode')).toBe(false)
    })

    it('handles empty exclusion list', () => {
      const f = createPrivacyFilter({ config: defaultConfig })
      expect(f.isAppExcluded('AnyApp')).toBe(false)
    })
  })

  describe('isPathExcluded', () => {
    it('excludes exact path', () => {
      const f = createPrivacyFilter({ config: { ...defaultConfig, excludePaths: ['/etc/passwd'] } })
      expect(f.isPathExcluded('/etc/passwd')).toBe(true)
    })

    it('excludes with ** glob (recursive)', () => {
      const f = createPrivacyFilter({
        config: { ...defaultConfig, excludePaths: ['**/node_modules/**'] },
      })
      expect(f.isPathExcluded('/project/node_modules/pkg/index.js')).toBe(true)
    })

    it('excludes with * glob (single level only)', () => {
      const f = createPrivacyFilter({ config: { ...defaultConfig, excludePaths: ['*.log'] } })
      expect(f.isPathExcluded('error.log')).toBe(true)
      expect(f.isPathExcluded('src/error.log')).toBe(false)
    })

    it('excludes nested paths', () => {
      const f = createPrivacyFilter({
        config: { ...defaultConfig, excludePaths: ['/home/**/secret*'] },
      })
      expect(f.isPathExcluded('/home/user/secret-file.txt')).toBe(true)
      expect(f.isPathExcluded('/home/deep/nested/secret.key')).toBe(true)
    })

    it('returns false when not excluded', () => {
      const f = createPrivacyFilter({ config: { ...defaultConfig, excludePaths: ['*.log'] } })
      expect(f.isPathExcluded('src/index.ts')).toBe(false)
    })
  })

  describe('isUrlExcluded', () => {
    it('excludes exact URL', () => {
      const f = createPrivacyFilter({
        config: { ...defaultConfig, excludeUrls: ['https://private.example.com'] },
      })
      expect(f.isUrlExcluded('https://private.example.com')).toBe(true)
    })

    it('excludes with glob pattern', () => {
      const f = createPrivacyFilter({
        config: { ...defaultConfig, excludeUrls: ['*://private.*'] },
      })
      expect(f.isUrlExcluded('https://private.example.com')).toBe(true)
      expect(f.isUrlExcluded('http://private.internal.net')).toBe(true)
    })

    it('respects protocol in pattern', () => {
      const f = createPrivacyFilter({
        config: { ...defaultConfig, excludeUrls: ['https://*.internal.com/**'] },
      })
      expect(f.isUrlExcluded('https://api.internal.com/v1/data')).toBe(true)
      expect(f.isUrlExcluded('http://api.internal.com/v1/data')).toBe(false)
    })

    it('returns false when not excluded', () => {
      const f = createPrivacyFilter({
        config: { ...defaultConfig, excludeUrls: ['*://private.*'] },
      })
      expect(f.isUrlExcluded('https://public.example.com')).toBe(false)
    })
  })

  describe('opt-in checks', () => {
    it('allows terminal when opted in', () => {
      const f = createPrivacyFilter({ config: { ...defaultConfig, terminalHistoryOptIn: true } })
      expect(f.isTerminalAllowed()).toBe(true)
    })

    it('disallows terminal by default', () => {
      const f = createPrivacyFilter({ config: defaultConfig })
      expect(f.isTerminalAllowed()).toBe(false)
    })

    it('allows browser when opted in', () => {
      const f = createPrivacyFilter({ config: { ...defaultConfig, browserTabsOptIn: true } })
      expect(f.isBrowserAllowed()).toBe(true)
    })

    it('disallows browser by default', () => {
      const f = createPrivacyFilter({ config: defaultConfig })
      expect(f.isBrowserAllowed()).toBe(false)
    })
  })

  describe('shouldFilter', () => {
    it('filters excluded app', () => {
      const f = createPrivacyFilter({ config: { ...defaultConfig, excludeApps: ['Slack'] } })
      expect(f.shouldFilter({ type: 'active-app', appName: 'Slack' })).toBe(true)
    })

    it('allows non-excluded app', () => {
      const f = createPrivacyFilter({ config: { ...defaultConfig, excludeApps: ['Slack'] } })
      expect(f.shouldFilter({ type: 'active-app', appName: 'VSCode' })).toBe(false)
    })

    it('filters excluded path', () => {
      const f = createPrivacyFilter({
        config: { ...defaultConfig, excludePaths: ['**/secret/**'] },
      })
      expect(f.shouldFilter({ type: 'file-change', filePath: '/home/user/secret/data.txt' })).toBe(
        true,
      )
    })

    it('filters excluded URL', () => {
      const f = createPrivacyFilter({
        config: { ...defaultConfig, excludeUrls: ['*://private.*'], browserTabsOptIn: true },
      })
      expect(f.shouldFilter({ type: 'browser-tab', url: 'https://private.example.com' })).toBe(true)
    })

    it('filters terminal when not opted in', () => {
      const f = createPrivacyFilter({ config: defaultConfig })
      expect(f.shouldFilter({ type: 'terminal-history' })).toBe(true)
    })

    it('allows terminal when opted in', () => {
      const f = createPrivacyFilter({ config: { ...defaultConfig, terminalHistoryOptIn: true } })
      expect(f.shouldFilter({ type: 'terminal-history' })).toBe(false)
    })

    it('filters browser when not opted in', () => {
      const f = createPrivacyFilter({ config: defaultConfig })
      expect(f.shouldFilter({ type: 'browser-tab', url: 'https://example.com' })).toBe(true)
    })

    it('combines multiple exclusion types', () => {
      const f = createPrivacyFilter({
        config: {
          ...defaultConfig,
          excludeApps: ['Slack'],
          excludePaths: ['*.log'],
          excludeUrls: ['*://private.*'],
        },
      })
      expect(f.shouldFilter({ type: 'active-app', appName: 'Slack' })).toBe(true)
      expect(f.shouldFilter({ type: 'file-change', filePath: 'error.log' })).toBe(true)
      expect(f.shouldFilter({ type: 'active-app', appName: 'VSCode' })).toBe(false)
    })

    it('does not filter with empty exclusion lists', () => {
      const f = createPrivacyFilter({ config: defaultConfig })
      expect(f.shouldFilter({ type: 'active-app', appName: 'AnyApp' })).toBe(false)
      expect(f.shouldFilter({ type: 'file-change', filePath: '/any/path' })).toBe(false)
    })

    it('handles undefined optional fields gracefully', () => {
      const f = createPrivacyFilter({ config: { ...defaultConfig, excludeApps: ['Slack'] } })
      expect(f.shouldFilter({ type: 'active-app' })).toBe(false)
    })
  })
})
