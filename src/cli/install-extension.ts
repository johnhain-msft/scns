/**
 * CLI command: scns install-extension
 *
 * Generates and installs the SCNS Copilot CLI extension to ~/.copilot/extensions/scns/.
 * Idempotent — safe to run multiple times.
 */

import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveScnsHome } from '../shared/scns-home.js'
import {
  mkdirSync as fsMkdirSync,
  writeFileSync as fsWriteFileSync,
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  rmSync as fsRmSync,
} from 'node:fs'
import { generateExtensionSource } from '../copilot-extension/extension-template.js'
import type {
  ExtensionTemplateConfig,
  ExtensionReconcileConfig,
} from '../copilot-extension/extension-template.js'

export interface FsOps {
  mkdirSync(path: string, options: { recursive: boolean }): void
  writeFileSync(path: string, content: string, encoding: string): void
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: string): string
  rmSync?(path: string, options: { recursive: boolean; force: boolean }): void
}

const defaultFs: FsOps = {
  mkdirSync: fsMkdirSync as FsOps['mkdirSync'],
  writeFileSync: fsWriteFileSync as FsOps['writeFileSync'],
  existsSync: fsExistsSync,
  readFileSync: fsReadFileSync as FsOps['readFileSync'],
  rmSync: fsRmSync as FsOps['rmSync'],
}

export interface InstallExtensionOptions {
  readonly brokerUrl?: string
  readonly extensionDir?: string
  readonly timeoutMs?: number
  readonly contextInjection?: boolean
  /**
   * WI-2b — broker auth token to embed. Resolution order: this option, then
   * the BROKER_TOKEN env var, then the internal-token file at `tokenPath`.
   * Pass null to force a tokenless install. Tokenless setups generate the
   * same unauthenticated requests as before (backward compatible).
   */
  readonly brokerToken?: string | null
  /** Override the internal-token file location (tests). */
  readonly tokenPath?: string
  /**
   * #61 — session-start reconciliation. Defaults ON when a broker entry script
   * can be resolved; pass false to install the pre-#61 extension.
   */
  readonly reconcile?: boolean
  /**
   * Entry script the extension starts when the stack is dead. Defaults to this
   * checkout's `dist/cli.js`; `null` disables reconciliation outright.
   */
  readonly brokerEntry?: string | null
  /** Interpreter used to run `brokerEntry`. Defaults to the current Node. */
  readonly execPath?: string
  /** Broker port the supervision root should own. Defaults to 3456. */
  readonly port?: number
  /** SCNS_HOME override (tests). */
  readonly scnsHome?: string
  readonly fs?: FsOps
}

export interface InstallResult {
  readonly installed: boolean
  readonly path: string
  readonly updated: boolean
  readonly message: string
}

/**
 * WI-2b — resolve the token the generated extension should present.
 * Explicit option > BROKER_TOKEN env > internal-token file > none.
 */
function resolveBrokerToken(options: InstallExtensionOptions, fs: FsOps): string | null {
  if (options.brokerToken !== undefined) return options.brokerToken
  const fromEnv = process.env.BROKER_TOKEN
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()
  const tokenPath = options.tokenPath ?? join(resolveScnsHome(), '.scns', '.internal-token')
  try {
    if (fs.existsSync(tokenPath)) {
      const fromFile = fs.readFileSync(tokenPath, 'utf-8').trim()
      if (fromFile !== '') return fromFile
    }
  } catch {
    // unreadable token file → install tokenless, same as before WI-2b
  }
  return null
}

/**
 * #61 — resolve the entry script the extension should start when the stack is
 * dead. `dist/cli.js`, relative to this compiled module. Returns null when it
 * cannot be found, which disables reconciliation rather than baking in a path
 * that spawns nothing.
 */
function resolveDefaultBrokerEntry(fs: FsOps): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(dirname(here), 'cli.js'), // dist/cli/install-extension.js -> dist/cli.js
    join(dirname(dirname(here)), 'dist', 'cli.js'), // running from src/
  ]
  return candidates.find((c) => fs.existsSync(c)) ?? null
}

/**
 * #61 — build the reconcile config. What it starts is the WATCHDOG, not the
 * broker: starting a bare broker from a Copilot session would reproduce the
 * defect this closes (a root process with nothing above it). The watchdog
 * brings the broker up immediately and keeps supervising it afterwards.
 */
function buildReconcileConfig(
  options: InstallExtensionOptions,
  fs: FsOps,
): ExtensionReconcileConfig | null {
  if (options.reconcile === false) return null
  const brokerEntry =
    options.brokerEntry === undefined ? resolveDefaultBrokerEntry(fs) : options.brokerEntry
  if (!brokerEntry) return null

  const port = options.port ?? 3456
  const scnsHome = options.scnsHome ?? resolveScnsHome()
  return {
    enabled: true,
    startCommand: {
      command: options.execPath ?? process.execPath,
      args: [brokerEntry, 'watchdog', 'run', '--port', String(port), '--broker-entry', brokerEntry],
    },
    lockPath: join(scnsHome, '.scns', 'run', 'session-reconcile.lock'),
  }
}

/** Install the SCNS extension for Copilot CLI */
export function installExtension(options: InstallExtensionOptions = {}): InstallResult {
  const fs = options.fs ?? defaultFs
  const brokerUrl = options.brokerUrl ?? 'http://localhost:3456'
  const extensionDir = options.extensionDir ?? join(homedir(), '.copilot', 'extensions', 'scns')
  const extensionPath = join(extensionDir, 'extension.mjs')

  const reconcile = buildReconcileConfig(options, fs)
  const templateConfig: ExtensionTemplateConfig = {
    brokerUrl,
    brokerToken: resolveBrokerToken(options, fs),
    // 5000 is the Jul-25 delivery cutover: at the old 1500 the extension
    // aborted before the broker's 2–4.5 s GATE emission, so the human never
    // saw the clarifying question. A reinstall must not regress it.
    timeoutMs: options.timeoutMs ?? 5000,
    contextInjection: options.contextInjection ?? false,
    reconcile,
  }

  const source = generateExtensionSource(templateConfig)

  // Check if already installed with same content
  let updated = false
  if (fs.existsSync(extensionPath)) {
    const existing = fs.readFileSync(extensionPath, 'utf-8')
    // Compare ignoring the Generated timestamp line
    const normalize = (s: string) => s.replace(/^\/\/ Generated: .+$/m, '')
    if (normalize(existing) === normalize(source)) {
      return {
        installed: true,
        path: extensionPath,
        updated: false,
        message: 'Extension already up to date',
      }
    }
    updated = true
  }

  // Create directory and write extension
  fs.mkdirSync(extensionDir, { recursive: true })
  fs.writeFileSync(extensionPath, source, 'utf-8')

  return {
    installed: true,
    path: extensionPath,
    updated,
    message: updated
      ? `Extension updated at ${extensionPath}`
      : `Extension installed at ${extensionPath}`,
  }
}

/** Uninstall the SCNS extension */
export function uninstallExtension(
  options: {
    extensionDir?: string
    fs?: Pick<FsOps, 'existsSync'> & {
      rmSync(path: string, options: { recursive: boolean; force: boolean }): void
    }
  } = {},
): { removed: boolean; path: string; message: string } {
  const fs =
    options.fs ??
    (defaultFs as Pick<FsOps, 'existsSync'> & { rmSync: NonNullable<FsOps['rmSync']> })
  const extensionDir = options.extensionDir ?? join(homedir(), '.copilot', 'extensions', 'scns')

  if (!fs.existsSync(extensionDir)) {
    return { removed: false, path: extensionDir, message: 'Extension not installed' }
  }

  fs.rmSync(extensionDir, { recursive: true, force: true })
  return { removed: true, path: extensionDir, message: `Extension removed from ${extensionDir}` }
}
