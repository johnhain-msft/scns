/**
 * Session discovery has never worked on Windows.
 *
 * `defaultPsProvider` shells out to `ps -ww -eo pid,args`, which does not exist
 * on win32, and the failure is swallowed by `catch { return '' }`. Verified on
 * this machine (2026-09-14):
 *   - `cmd /c "ps -ww -eo pid,args"` -> exit 1, "'ps' is not recognized"
 *   - `lsof` -> not on PATH
 *   - Git's bundled ps.exe -> rejects `-ww`, and its COMMAND column never
 *     contains `--resume`, so the parser could not match even via PATH
 *   - across all 7 project databases, sessions with purpose='discovered' = 0
 *
 * The poller therefore burned a subprocess every 15s and discovered nothing.
 */
import { describe, it, expect } from 'vitest'
import {
  buildProcessListCommand,
  parseCopilotProcesses,
} from '../../../src/broker/session-discovery.js'

describe('buildProcessListCommand', () => {
  it('uses ps on macOS and Linux', () => {
    expect(buildProcessListCommand('darwin')).toContain('ps -ww -eo pid,args')
    expect(buildProcessListCommand('linux')).toContain('ps -ww -eo pid,args')
  })

  it('does not use ps on win32, where the binary does not exist', () => {
    expect(buildProcessListCommand('win32')).not.toContain('ps -ww')
  })

  it('queries Win32_Process via PowerShell on win32', () => {
    const cmd = buildProcessListCommand('win32')
    expect(cmd).toContain('Win32_Process')
    // -NoProfile keeps a user profile from injecting output into the listing.
    expect(cmd).toContain('-NoProfile')
    expect(cmd).toContain('-NonInteractive')
  })

  // `exec` routes through cmd.exe, so the script is wrapped in double quotes.
  // Any double quote inside would terminate that wrapper and break the command.
  it('emits a win32 script containing no double quotes to survive cmd.exe', () => {
    const cmd = buildProcessListCommand('win32')
    const inner = cmd.slice(cmd.indexOf('"') + 1, cmd.lastIndexOf('"'))
    expect(inner.length).toBeGreaterThan(0)
    expect(inner).not.toContain('"')
  })
})

describe('parseCopilotProcesses — Windows output shape', () => {
  // Real shape emitted by the CIM provider: PID, then a quoted exe path
  // containing spaces, then the args.
  const WINDOWS_OUTPUT = [
    '21296 "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\msedgewebview2.exe" --webview-exe-name=copilot',
    '33520 "C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\@github\\copilot\\index.js" --resume 19fc9e43-1964-4c6e-9d6e-a15ce3f935b7',
    '41696 "C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\@github\\copilot\\index.js" --resume=47ed0eff-553a-40b1-9807-8714127c388a',
  ].join('\r\n')

  it('extracts pid and session id from Windows-style lines', () => {
    const procs = parseCopilotProcesses(WINDOWS_OUTPUT)
    expect(procs).toEqual([
      { pid: 33520, sessionId: '19fc9e43-1964-4c6e-9d6e-a15ce3f935b7' },
      { pid: 41696, sessionId: '47ed0eff-553a-40b1-9807-8714127c388a' },
    ])
  })

  it('ignores copilot-adjacent processes with no --resume', () => {
    expect(parseCopilotProcesses(WINDOWS_OUTPUT.split('\r\n')[0]!)).toEqual([])
  })
})
