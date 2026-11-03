import { execFile } from 'node:child_process'
import { platform } from 'node:os'

export interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface CommandExecutor {
  execute(command: string, args?: readonly string[]): Promise<CommandResult>
}

export function createSystemExecutor(): CommandExecutor {
  return {
    execute(command: string, args?: readonly string[]): Promise<CommandResult> {
      return new Promise((resolve) => {
        // `windowsHide` is required: observers shell out on timers (activeApp
        // every 30s, terminalHistory every 60s) and without it EVERY poll flashes
        // a console window onto the user's desktop on win32.
        const options = { windowsHide: true }
        execFile(command, args as string[] | undefined, options, (error, stdout, stderr) => {
          // `execFile` reports the child's exit status on `error.code` as a NUMBER. The same
          // field carries a STRING (`ENOENT`, `EACCES`) when the process never launched, and is
          // absent when the child was killed by a signal — both of which mean "no exit code", so
          // they collapse to 1. Reading `error.status` here instead is a `spawnSync`-ism: it is
          // always `undefined` on an `execFile` error, which silently flattened every non-zero
          // exit to 1 (#57).
          const code = (error as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: error ? (typeof code === 'number' ? code : 1) : 0,
          })
        })
      })
    },
  }
}

export function isDarwin(): boolean {
  return platform() === 'darwin'
}
