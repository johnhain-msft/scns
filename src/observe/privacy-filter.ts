/**
 * Privacy filter — checks observations against exclusion rules.
 */

import type { PrivacyConfig } from './types.js'

export interface PrivacyFilterOptions {
  readonly config: PrivacyConfig
}

export interface FilterContext {
  readonly type: string
  readonly appName?: string
  readonly filePath?: string
  readonly url?: string
}

/**
 * Simple glob matcher (no external deps).
 * Supports `*` (any chars except `/`), `**` (any chars), `?` (single char).
 * Case-insensitive.
 */
export function matchGlob(pattern: string, value: string): boolean {
  let regex = ''
  let i = 0
  const len = pattern.length

  while (i < len) {
    const ch = pattern[i]!
    const next = i + 1 < len ? pattern[i + 1] : undefined

    if (ch === '*' && next === '*') {
      if (pattern[i + 2] === '/') {
        regex += '(.+/)?'
        i += 3
      } else {
        regex += '.*'
        i += 2
      }
    } else if (ch === '*') {
      regex += '[^/]*'
      i++
    } else if (ch === '?') {
      regex += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regex += '\\' + ch
      i++
    } else {
      regex += ch
      i++
    }
  }

  return new RegExp(`^${regex}$`, 'i').test(value)
}

/** Create a privacy filter from a PrivacyConfig. */
export function createPrivacyFilter(options: PrivacyFilterOptions) {
  const { config } = options

  function matchesAny(patterns: readonly string[], value: string): boolean {
    return patterns.some((p) => matchGlob(p, value))
  }

  const isAppExcluded = (appName: string): boolean => matchesAny(config.excludeApps, appName)

  // Glob patterns are canonically forward-slash; normalize win32 paths so
  // '/project/secret/**' also excludes '\project\secret\keys.env'.
  const isPathExcluded = (filePath: string): boolean =>
    matchesAny(config.excludePaths, filePath.replaceAll('\\', '/'))

  const isUrlExcluded = (url: string): boolean => matchesAny(config.excludeUrls, url)

  const isTerminalAllowed = (): boolean => config.terminalHistoryOptIn === true

  const isBrowserAllowed = (): boolean => config.browserTabsOptIn === true

  function shouldFilter(context: FilterContext): boolean {
    if (context.type === 'terminal-history' && !isTerminalAllowed()) return true
    if (context.type === 'browser-tab' && !isBrowserAllowed()) return true
    if (context.appName && isAppExcluded(context.appName)) return true
    if (context.filePath && isPathExcluded(context.filePath)) return true
    if (context.url && isUrlExcluded(context.url)) return true
    return false
  }

  return {
    isAppExcluded,
    isPathExcluded,
    isUrlExcluded,
    isTerminalAllowed,
    isBrowserAllowed,
    shouldFilter,
  }
}
