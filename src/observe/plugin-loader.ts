import type { ObserverPlugin } from './plugin.js'
import { logger } from '../shared/logger.js'
import { readdir, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export type RuntimeMode = 'src' | 'dist'

export interface PluginLoaderOptions {
  readonly pluginDirs: readonly string[]
  /** Runtime mode hint. If omitted, detected from import.meta.url. */
  readonly mode?: RuntimeMode
}

/** Detect whether we're running from a compiled `dist/` tree or `src/` (dev). */
export function detectRuntimeMode(metaUrl: string): RuntimeMode {
  // Normalize to a path for matching; works with file:// URLs. fileURLToPath
  // is strict about host-valid paths (a posix-style file:/// URL throws
  // "File URL path must be absolute" on win32) — fall back to matching the
  // raw string, which carries the same /dist/ marker.
  let path = metaUrl
  if (metaUrl.startsWith('file://')) {
    try {
      path = fileURLToPath(metaUrl)
    } catch {
      path = metaUrl
    }
  }
  return path.includes(`${'/'}dist${'/'}`) || path.includes(`\\dist\\`) ? 'dist' : 'src'
}

/**
 * Given the loader module's import.meta.url, resolve the default plugin
 * directories alongside the current runtime tree.
 * - In dist mode: `<root>/dist/observe/plugins`
 * - In src mode:  `<root>/src/observe/plugins`
 */
export function resolveDefaultPluginDirs(metaUrl: string): readonly string[] {
  const dir = dirname(fileURLToPath(metaUrl))
  // dir is e.g. `<root>/dist/observe` or `<root>/src/observe`
  return [join(dir, 'plugins')]
}

/** Load observer plugins from filesystem directories */
export function createPluginLoader(options: PluginLoaderOptions) {
  const log = logger.child({ module: 'plugin-loader' })
  const mode: RuntimeMode = options.mode ?? detectRuntimeMode(import.meta.url)
  // In dist mode we only load compiled .js; in src/dev we also load .ts sources.
  const extensions: readonly string[] = mode === 'dist' ? ['.js'] : ['.js', '.ts']
  const isLoadableEntry = (name: string): boolean => {
    if (name.endsWith('.d.ts')) return false
    return extensions.some((ext) => name.endsWith(ext))
  }

  function validatePlugin(
    mod: unknown,
  ): mod is { default: () => ObserverPlugin } | { createPlugin: () => ObserverPlugin } {
    if (mod == null || typeof mod !== 'object') return false
    const m = mod as Record<string, unknown>
    if (typeof m['default'] === 'function') return true
    if (typeof m['createPlugin'] === 'function') return true
    return false
  }

  function validatePluginInstance(instance: unknown): instance is ObserverPlugin {
    if (instance == null || typeof instance !== 'object') return false
    const obj = instance as Record<string, unknown>
    const requiredMethods = [
      'start',
      'stop',
      'isRunning',
      'configure',
      'healthCheck',
      'getConfigSchema',
    ]
    for (const method of requiredMethods) {
      if (typeof obj[method] !== 'function') return false
    }
    const requiredProps = ['type', 'name', 'metadata', 'capabilities', 'state']
    for (const prop of requiredProps) {
      if (obj[prop] === undefined) return false
    }
    if (typeof obj['metadata'] !== 'object' || obj['metadata'] == null) return false
    const meta = obj['metadata'] as Record<string, unknown>
    if (typeof meta['name'] !== 'string') return false
    if (typeof meta['version'] !== 'string') return false
    if (typeof meta['source'] !== 'string') return false
    return true
  }

  function extractPlugin(mod: unknown): ObserverPlugin | null {
    if (!validatePlugin(mod)) return null

    const m = mod as Record<string, unknown>
    const factory =
      typeof m['createPlugin'] === 'function'
        ? (m['createPlugin'] as () => ObserverPlugin)
        : (m['default'] as () => ObserverPlugin)

    try {
      const instance = factory()
      if (!validatePluginInstance(instance)) {
        log.warn('Plugin factory returned an invalid instance')
        return null
      }
      return instance
    } catch (err) {
      log.warn({ err }, 'Plugin factory threw an error')
      return null
    }
  }

  return {
    /** Scan plugin directories and load all valid plugin modules */
    async discover(): Promise<readonly ObserverPlugin[]> {
      const plugins: ObserverPlugin[] = []

      for (const dir of options.pluginDirs) {
        try {
          await access(dir)
        } catch {
          log.debug({ dir }, 'Plugin directory does not exist, skipping')
          continue
        }

        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch (err) {
          log.warn({ err, dir }, 'Failed to read plugin directory')
          continue
        }

        for (const entry of entries) {
          if (!entry.isFile() || !isLoadableEntry(entry.name)) continue

          const filePath = join(dir, entry.name)
          const plugin = await this.loadPlugin(filePath)
          if (plugin) {
            plugins.push(plugin)
          }
        }
      }

      return plugins
    },

    /** Load a single plugin from a file path */
    async loadPlugin(filePath: string): Promise<ObserverPlugin | null> {
      try {
        const mod: unknown = await import(filePath)
        const plugin = extractPlugin(mod)
        if (plugin) {
          log.info({ filePath, source: plugin.metadata.source }, 'Loaded plugin')
        } else {
          log.warn({ filePath }, 'File does not export a valid plugin factory')
        }
        return plugin
      } catch (err) {
        log.warn({ err, filePath }, 'Failed to load plugin')
        return null
      }
    },

    /** Validate that a module exports a valid plugin factory */
    validatePlugin,

    /** Validate that an object is a valid ObserverPlugin instance */
    validatePluginInstance,
  }
}
