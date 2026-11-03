# Observer Plugin System

SCNS ships with a set of built-in observers (active-app, file-changes, git-activity, terminal-history, browser-tabs, session-hooks, config-changes). The **plugin system** lets you extend SCNS with custom observers without modifying core code.

Plugins are standalone JavaScript/TypeScript modules that implement the `ObserverPlugin` interface. Drop one into `~/.scns/observers/` and SCNS discovers and loads it automatically.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Plugin Interface](#plugin-interface)
3. [Capabilities](#capabilities)
4. [Configuration](#configuration)
5. [Event Format](#event-format)
6. [Lifecycle](#lifecycle)
7. [Testing Plugins](#testing-plugins)
8. [Built-in Adapters](#built-in-adapters)
9. [Example: Chronicle Plugin](#example-chronicle-plugin)
10. [API Reference](#api-reference)

---

## Quick Start

**1. Create a plugin file**

```typescript
// ~/.scns/observers/my-observer.js
import { z } from 'zod'

const ConfigSchema = z.object({
  watchPath: z.string(),
  intervalMs: z.number().default(5000),
})

export const plugin = {
  type: 'custom',
  name: 'my-observer',
  metadata: {
    name: 'my-observer',
    version: '1.0.0',
    source: 'custom/my-observer',
    description: 'Watches a custom data source',
  },
  capabilities: ['custom'],
  state: 'idle',

  start() {
    this.state = 'running'
    // Begin polling or watching
  },

  stop() {
    this.state = 'idle'
    // Clean up timers, watchers, connections
  },

  isRunning() {
    return this.state === 'running'
  },

  configure(config) {
    const parsed = ConfigSchema.parse(config)
    this._config = parsed
  },

  getConfigSchema() {
    return ConfigSchema
  },

  async healthCheck() {
    return {
      healthy: true,
      message: 'OK',
      lastCheck: new Date().toISOString(),
    }
  },
}
```

**2. Drop the file into the plugins directory**

```bash
mkdir -p ~/.scns/observers
cp my-observer.js ~/.scns/observers/
```

**3. Restart SCNS**

```bash
scns stop && scns start
```

SCNS discovers your plugin on startup. Check it's loaded:

```bash
scns observe status
```

---

## Plugin Interface

Every plugin must satisfy `ObserverPlugin`, which extends the base `Observer` interface:

```typescript
import type { z } from 'zod'

/** Lifecycle state for an observer */
type ObserverState = 'idle' | 'running' | 'stopping' | 'error'

/** Capability categories a plugin can declare */
type PluginCapability =
  | 'sessions'  // Monitors coding sessions
  | 'tools'     // Monitors tool/CLI usage
  | 'files'     // Monitors file system activity
  | 'system'    // Monitors system-level activity
  | 'network'   // Monitors network activity
  | 'custom'    // Custom / uncategorized

/** Metadata describing a plugin */
interface PluginMetadata {
  readonly name: string
  readonly version: string
  readonly source: string
  readonly description: string
  readonly author?: string
  readonly homepage?: string
}

/** Health check result */
interface HealthCheckResult {
  readonly healthy: boolean
  readonly message: string
  readonly lastCheck: string
  readonly details?: Record<string, unknown>
}

/** Base observer interface (from src/observe/observer.ts) */
interface Observer {
  readonly type: ObservationType
  readonly name: string
  start(): void
  stop(): void
  isRunning(): boolean
}

/**
 * ObserverPlugin — extended observer with metadata, capabilities,
 * configuration, and health checking.
 */
interface ObserverPlugin extends Observer {
  /** Plugin metadata (name, version, source, description) */
  readonly metadata: PluginMetadata

  /** Declared capabilities of this plugin */
  readonly capabilities: readonly PluginCapability[]

  /** Current lifecycle state */
  state: ObserverState

  /**
   * Apply configuration to this plugin.
   * Called before start() with values from the SCNS config file or defaults.
   */
  configure(config: Record<string, unknown>): void

  /**
   * Return the Zod schema that validates this plugin's configuration.
   * Used by the registry to validate config before passing it to configure().
   */
  getConfigSchema(): z.ZodType

  /**
   * Perform a health check. Called periodically by the registry.
   * Return { healthy: true } when operational,
   * or { healthy: false, message: '...' } on degraded/failed state.
   */
  healthCheck(): Promise<HealthCheckResult>
}
```

### Required exports

A plugin module must export one of:

- **`plugin`** — a single `ObserverPlugin` object (named export)
- **`default`** — a default export of an `ObserverPlugin` object

```typescript
// Named export (preferred)
export const plugin: ObserverPlugin = { /* ... */ }

// Or default export
export default { /* ... */ } satisfies ObserverPlugin
```

---

## Capabilities

Capabilities declare what kind of data a plugin observes. The registry uses them for filtering and display. A plugin may declare multiple capabilities.

| Capability | Description | Example |
|------------|-------------|---------|
| `sessions` | Monitors coding sessions (IDE, terminal, agent) | Session hooks, Claude Code activity |
| `tools` | Monitors tool and CLI usage | Command history, build tool invocations |
| `files` | Monitors file system changes | File watcher, git diff tracker |
| `system` | Monitors system-level activity | Active app, screen time, hardware events |
| `network` | Monitors network activity | API calls, DNS queries, connection tracking |
| `custom` | Custom or uncategorized observations | Anything else — use this as default |

### Filtering by capability

```typescript
// Get all plugins that monitor files
const filePlugins = registry.list().filter(p =>
  p.capabilities.includes('files')
)
```

---

## Configuration

### Global plugin configuration

Plugins are configured in the SCNS config file (`~/.scns/config.json` or via environment variables):

```json
{
  "observers": {
    "plugins": {
      "my-observer": {
        "enabled": true,
        "watchPath": "/home/user/data",
        "intervalMs": 10000
      }
    }
  }
}
```

### Per-plugin config schemas

Each plugin declares its own config schema via `getConfigSchema()`. The registry validates incoming config against this schema before calling `configure()`.

```typescript
import { z } from 'zod'

const ConfigSchema = z.object({
  watchPath: z.string().describe('Directory to watch for changes'),
  intervalMs: z.number().min(1000).default(5000).describe('Poll interval in ms'),
  patterns: z.array(z.string()).default(['**/*']).describe('Glob patterns to match'),
})

export const plugin = {
  // ...
  getConfigSchema() {
    return ConfigSchema
  },

  configure(config) {
    // config is already validated by the registry
    this._watchPath = config.watchPath
    this._intervalMs = config.intervalMs
    this._patterns = config.patterns
  },
}
```

### Config validation flow

```
config.json  →  registry reads plugin section
             →  getConfigSchema() returns Zod schema
             →  schema.parse(config) validates
             →  configure(validatedConfig) applies
             →  start() begins observation
```

If validation fails, the plugin is not started and a warning is logged.

---

## Event Format

All observations flow through a standardized `ObservationEvent` envelope:

```typescript
interface ObservationEvent {
  /** Unique event ID (UUID v4) */
  readonly id: string

  /** Observation type (matches the plugin's `type` field) */
  readonly type: ObservationType

  /** ISO 8601 timestamp of when the observation occurred */
  readonly timestamp: string

  /** Source identifier (typically plugin name or source path) */
  readonly source: string

  /** Human-readable content of the observation */
  readonly content: string

  /** Searchable tags for classification */
  readonly tags: readonly string[]

  /** Optional structured metadata */
  readonly metadata?: Record<string, unknown>

  /** Plugin that emitted this event */
  readonly pluginName?: string
}
```

### Emitting events from a plugin

Plugins emit observations by writing to the daily log via the observation pipeline. The standard pattern is:

```typescript
import { randomUUID } from 'node:crypto'

function createObservation(content, metadata = {}) {
  return {
    id: randomUUID(),
    type: 'custom',
    timestamp: new Date().toISOString(),
    source: 'my-observer',
    content,
    tags: ['custom', 'my-observer'],
    metadata,
    pluginName: 'my-observer',
  }
}
```

Events flow through the privacy filter and secret sanitizer before being persisted, so sensitive data is automatically scrubbed.

---

## Lifecycle

Plugins follow a deterministic lifecycle managed by the `PluginRegistry`:

```
                    ┌─────────────────────────────────────────┐
                    │              Plugin Lifecycle            │
                    └─────────────────────────────────────────┘

  ┌─────────┐   register()   ┌──────────┐  configure()  ┌──────────────┐
  │Discovered├──────────────►│  idle     ├──────────────►│  configured  │
  └─────────┘                └──────────┘                └──────┬───────┘
                                  ▲                            │
                                  │                       start()
                              stop()                           │
                                  │                            ▼
                             ┌────┴─────┐                ┌──────────┐
                             │ stopping │◄───────────────┤ running  │
                             └──────────┘    stop()      └────┬─────┘
                                                              │
                                                        healthCheck()
                                                         (periodic)
                                                              │
                                                              ▼
                                                        ┌──────────┐
                                                        │  error   │
                                                        └──────────┘
                                                     (on failure, can
                                                      be restarted)
```

### Lifecycle methods

| Method | When called | Expected behavior |
|--------|------------|-------------------|
| `configure(config)` | After registration, before start | Store config, validate prerequisites |
| `start()` | When the observation manager starts | Begin polling/watching, set state to `running` |
| `stop()` | On SCNS shutdown or plugin unload | Clean up resources, set state to `idle` |
| `healthCheck()` | Periodically by the registry | Return current health status |
| `isRunning()` | Any time | Return `true` if actively observing |

### Startup sequence

1. **Discovery** — `PluginLoader` scans `~/.scns/observers/` for `.js`/`.ts` files
2. **Load** — Each file is dynamically imported, `plugin` or `default` export is extracted
3. **Validate** — Plugin shape is validated against the `ObserverPlugin` interface
4. **Register** — Plugin is added to the `PluginRegistry`
5. **Configure** — Config from `~/.scns/config.json` is validated and applied
6. **Start** — `plugin.start()` is called; state transitions to `running`
7. **Monitor** — Health checks run periodically

### Shutdown sequence

1. `registry.stopAll()` is called
2. Each plugin's `stop()` is called in reverse registration order
3. Plugins are unregistered
4. Resources are released

---

## Testing Plugins

Test your plugin using Vitest, consistent with the SCNS test conventions.

### Unit test example

```typescript
// test/unit/observe/my-observer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Import your plugin
const createMyPlugin = () => ({
  type: 'custom' as const,
  name: 'my-observer',
  metadata: {
    name: 'my-observer',
    version: '1.0.0',
    source: 'custom/my-observer',
    description: 'Test plugin',
  },
  capabilities: ['custom'] as const,
  state: 'idle' as 'idle' | 'running' | 'stopping' | 'error',
  _interval: undefined as ReturnType<typeof setInterval> | undefined,

  start() {
    this.state = 'running'
    this._interval = setInterval(() => {}, 5000)
  },

  stop() {
    if (this._interval) clearInterval(this._interval)
    this._interval = undefined
    this.state = 'idle'
  },

  isRunning() {
    return this.state === 'running'
  },

  configure(_config: Record<string, unknown>) {},

  getConfigSchema() {
    const { z } = await import('zod')
    return z.object({})
  },

  async healthCheck() {
    return {
      healthy: this.state === 'running',
      message: this.state === 'running' ? 'OK' : 'Not running',
      lastCheck: new Date().toISOString(),
    }
  },
})

describe('my-observer plugin', () => {
  let plugin: ReturnType<typeof createMyPlugin>

  beforeEach(() => {
    plugin = createMyPlugin()
  })

  it('starts in idle state', () => {
    expect(plugin.state).toBe('idle')
    expect(plugin.isRunning()).toBe(false)
  })

  it('transitions to running on start', () => {
    plugin.start()
    expect(plugin.state).toBe('running')
    expect(plugin.isRunning()).toBe(true)
    plugin.stop()
  })

  it('transitions back to idle on stop', () => {
    plugin.start()
    plugin.stop()
    expect(plugin.state).toBe('idle')
    expect(plugin.isRunning()).toBe(false)
  })

  it('reports healthy when running', async () => {
    plugin.start()
    const result = await plugin.healthCheck()
    expect(result.healthy).toBe(true)
    expect(result.message).toBe('OK')
    plugin.stop()
  })

  it('reports unhealthy when stopped', async () => {
    const result = await plugin.healthCheck()
    expect(result.healthy).toBe(false)
  })

  it('has required metadata', () => {
    expect(plugin.metadata.name).toBe('my-observer')
    expect(plugin.metadata.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(plugin.metadata.source).toBeTruthy()
  })

  it('declares capabilities', () => {
    expect(plugin.capabilities).toContain('custom')
  })
})
```

### Testing with the registry

```typescript
import { describe, it, expect } from 'vitest'
// Assuming createPluginRegistry is available from src/observe
// import { createPluginRegistry } from '../../src/observe/plugin-registry.js'

describe('plugin registration', () => {
  it('registers and starts a custom plugin', async () => {
    const registry = createPluginRegistry()
    const plugin = createMyPlugin()

    registry.register(plugin)
    expect(registry.list()).toHaveLength(1)

    await registry.startAll()
    expect(plugin.isRunning()).toBe(true)

    await registry.stopAll()
    expect(plugin.isRunning()).toBe(false)
  })

  it('runs health checks on all plugins', async () => {
    const registry = createPluginRegistry()
    const plugin = createMyPlugin()

    registry.register(plugin)
    plugin.start()

    const results = await registry.healthCheck()
    expect(results.get('my-observer')?.healthy).toBe(true)

    plugin.stop()
  })
})
```

---

## Built-in Adapters

Existing SCNS observers (active-app, file-changes, git-activity, etc.) are wrapped with `BuiltinObserverAdapter` so they satisfy the `ObserverPlugin` interface. This lets the plugin registry manage both built-in and custom observers uniformly.

### How it works

```typescript
/**
 * BuiltinObserverAdapter wraps an existing Observer to satisfy ObserverPlugin.
 *
 * - metadata is derived from the observer's name and type
 * - capabilities are inferred from the observation type
 * - configure() is a no-op (built-ins use ObservationConfig)
 * - getConfigSchema() returns z.object({}) (no custom config)
 * - healthCheck() checks isRunning() and returns status
 */
```

### Capability mapping

Built-in observers are mapped to capabilities automatically:

| Observer | Capability |
|----------|------------|
| `active-app` | `system` |
| `file-changes` | `files` |
| `git-activity` | `files` |
| `terminal-history` | `tools` |
| `browser-tabs` | `system` |
| `session-hooks` | `sessions` |
| `config-changes` | `system` |

### Example adapter usage

```typescript
import { createGitActivityObserver } from './observers/git-activity.js'

// Existing observer
const gitObserver = createGitActivityObserver({ /* options */ })

// Wrap it as a plugin
const adapted = createBuiltinObserverAdapter(gitObserver, {
  version: '1.0.0',
  capabilities: ['files'],
})

// Now it satisfies ObserverPlugin
registry.register(adapted)
```

---

## Example: Chronicle Plugin

A conceptual plugin that reads data from [Chronicle](https://github.com/user/chronicle) — a local activity journaling system.

```typescript
// ~/.scns/observers/chronicle-observer.js
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

const ConfigSchema = z.object({
  chroniclePath: z.string().default('~/.chronicle/journal.jsonl'),
  intervalMs: z.number().min(1000).default(30000),
})

let _interval
let _config
let _lastOffset = 0

export const plugin = {
  type: 'custom',
  name: 'chronicle-observer',
  metadata: {
    name: 'chronicle-observer',
    version: '1.0.0',
    source: 'custom/chronicle',
    description: 'Reads activity entries from Chronicle journal',
  },
  capabilities: ['sessions', 'tools'],
  state: 'idle',

  configure(config) {
    _config = ConfigSchema.parse(config)
  },

  getConfigSchema() {
    return ConfigSchema
  },

  start() {
    if (this.state === 'running') return
    this.state = 'running'

    const poll = async () => {
      try {
        const path = _config.chroniclePath.replace('~', process.env.HOME)
        if (!existsSync(path)) return

        const content = await readFile(path, 'utf-8')
        const lines = content.split('\n').filter(Boolean)
        const newLines = lines.slice(_lastOffset)
        _lastOffset = lines.length

        for (const line of newLines) {
          const entry = JSON.parse(line)
          // Emit observation (would be wired to the observation pipeline)
          const observation = {
            id: randomUUID(),
            type: 'custom',
            timestamp: entry.timestamp ?? new Date().toISOString(),
            source: 'chronicle',
            content: entry.summary ?? entry.content ?? '',
            tags: ['chronicle', ...(entry.tags ?? [])],
            metadata: { raw: entry },
            pluginName: 'chronicle-observer',
          }
          // observation would be passed to the daily log writer
        }
      } catch (err) {
        // Log error, don't crash
      }
    }

    void poll()
    _interval = setInterval(poll, _config?.intervalMs ?? 30000)
  },

  stop() {
    if (_interval) {
      clearInterval(_interval)
      _interval = undefined
    }
    this.state = 'idle'
  },

  isRunning() {
    return this.state === 'running'
  },

  async healthCheck() {
    const path = (_config?.chroniclePath ?? '').replace('~', process.env.HOME)
    const fileExists = existsSync(path)
    return {
      healthy: this.state === 'running' && fileExists,
      message: fileExists ? 'OK' : 'Chronicle journal file not found',
      lastCheck: new Date().toISOString(),
      details: { chroniclePath: path, entriesRead: _lastOffset },
    }
  },
}
```

---

## API Reference

### Types

| Type | Description |
|------|-------------|
| `Observer` | Base observer interface (`type`, `name`, `start`, `stop`, `isRunning`) |
| `ObserverPlugin` | Extended observer with metadata, capabilities, config, health |
| `ObserverState` | `'idle' \| 'running' \| 'stopping' \| 'error'` |
| `PluginCapability` | `'sessions' \| 'tools' \| 'files' \| 'system' \| 'network' \| 'custom'` |
| `PluginMetadata` | `{ name, version, source, description, author?, homepage? }` |
| `HealthCheckResult` | `{ healthy, message, lastCheck, details? }` |
| `ObservationEvent` | Standardized event envelope for all observations |
| `Observation` | Core observation record (`id`, `type`, `timestamp`, `source`, `content`, `tags`, `metadata?`) |

### PluginRegistry

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `(plugin: ObserverPlugin) => void` | Register a plugin with the registry |
| `unregister` | `(name: string) => void` | Remove a plugin by name |
| `list` | `() => readonly ObserverPlugin[]` | List all registered plugins |
| `get` | `(name: string) => ObserverPlugin \| undefined` | Get a plugin by name |
| `startAll` | `() => Promise<void>` | Start all registered plugins |
| `stopAll` | `() => Promise<void>` | Stop all plugins (reverse order) |
| `healthCheck` | `() => Promise<Map<string, HealthCheckResult>>` | Run health checks on all plugins |

### PluginLoader

| Method | Signature | Description |
|--------|-----------|-------------|
| `discover` | `(dir?: string) => Promise<string[]>` | Scan directory for plugin files |
| `load` | `(filePath: string) => Promise<ObserverPlugin>` | Load and validate a single plugin |
| `loadAll` | `(dir?: string) => Promise<ObserverPlugin[]>` | Discover and load all plugins |

Default plugin directory: `~/.scns/observers/`

### BuiltinObserverAdapter

| Method | Signature | Description |
|--------|-----------|-------------|
| `createBuiltinObserverAdapter` | `(observer: Observer, opts: { version: string, capabilities: PluginCapability[] }) => ObserverPlugin` | Wrap an existing observer as a plugin |

### Observation (existing type from `src/observe/types.ts`)

```typescript
{
  id: string          // UUID v4
  type: ObservationType
  timestamp: string   // ISO 8601
  source: string
  content: string
  tags: string[]
  metadata?: Record<string, unknown>
}
```
