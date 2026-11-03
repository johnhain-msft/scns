/**
 * CLI command: scns setup-hooks
 *
 * Generates .github/hooks/hooks.json with shell-script hooks
 * that forward lifecycle events to the SCNS broker via curl.
 * For CI/CD and environments where extensions don't run.
 */

import { join } from 'node:path'
import {
  mkdirSync as fsMkdirSync,
  writeFileSync as fsWriteFileSync,
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
} from 'node:fs'
import { validateBrokerUrl } from '../copilot-extension/extension-template.js'

export interface HooksFsOps {
  mkdirSync(path: string, options: { recursive: boolean }): void
  writeFileSync(path: string, content: string, encoding: string): void
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: string): string
}

const defaultFs: HooksFsOps = {
  mkdirSync: fsMkdirSync as HooksFsOps['mkdirSync'],
  writeFileSync: fsWriteFileSync as HooksFsOps['writeFileSync'],
  existsSync: fsExistsSync,
  readFileSync: fsReadFileSync as HooksFsOps['readFileSync'],
}

export interface SetupHooksOptions {
  readonly brokerUrl?: string
  readonly projectDir?: string
  readonly fs?: HooksFsOps
}

export interface HooksConfig {
  readonly hooks: Record<string, { readonly command: string }>
}

export interface SetupResult {
  readonly created: boolean
  readonly path: string
  readonly updated: boolean
  readonly message: string
}

const HOOK_EVENTS = [
  'session-start',
  'session-end',
  'tool-use',
  'pre-compact',
  'user-prompt',
  'error',
  'pre-tool-use',
  'post-tool-use',
] as const

/** Generate a shell command that curls the broker for a given event */
function generateHookCommand(event: string, brokerUrl: string): string {
  // brokerUrl is already validated by generateHooksConfig; escape for shell safety
  const safeUrl = brokerUrl.replace(/'/g, "'\\''")
  const envSessionId = '$COPILOT_SESSION_ID'
  return `curl -s -m 1 -X POST '${safeUrl}/api/hooks/${event}' -H 'Content-Type: application/json' -d "{\\"event\\":\\"${event}\\",\\"sessionId\\":\\"${envSessionId}\\",\\"timestamp\\":\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\"}" > /dev/null 2>&1 || true`
}

/** Generate the hooks.json configuration */
export function generateHooksConfig(brokerUrl: string): HooksConfig {
  const validatedUrl = validateBrokerUrl(brokerUrl)
  const hooks: Record<string, { command: string }> = {}

  for (const event of HOOK_EVENTS) {
    hooks[event] = { command: generateHookCommand(event, validatedUrl) }
  }

  return { hooks }
}

/** Setup hooks.json in the project */
export function setupHooks(options: SetupHooksOptions = {}): SetupResult {
  const fs = options.fs ?? defaultFs
  const brokerUrl = options.brokerUrl ?? 'http://localhost:3456'
  const projectDir = options.projectDir ?? process.cwd()
  const hooksDir = join(projectDir, '.github', 'hooks')
  const hooksPath = join(hooksDir, 'scns-hooks.json')

  const config = generateHooksConfig(brokerUrl)
  const content = JSON.stringify(config, null, 2) + '\n'

  let updated = false
  if (fs.existsSync(hooksPath)) {
    const existing = fs.readFileSync(hooksPath, 'utf-8')
    if (existing === content) {
      return {
        created: true,
        path: hooksPath,
        updated: false,
        message: 'Hooks config already up to date',
      }
    }
    updated = true
  }

  fs.mkdirSync(hooksDir, { recursive: true })
  fs.writeFileSync(hooksPath, content, 'utf-8')

  return {
    created: true,
    path: hooksPath,
    updated,
    message: updated
      ? `Hooks config updated at ${hooksPath}`
      : `Hooks config created at ${hooksPath}`,
  }
}
