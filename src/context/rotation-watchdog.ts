/**
 * Watchdog daemon — thin wrapper around the rotation controller.
 * Manages a setInterval loop that delegates to controller.tick().
 */

import type { RotationController, RotationResult } from './rotation-controller.js'

// ── Public interface ────────────────────────────────────────────────────────

export interface WatchdogDaemon {
  start(): void
  stop(): void
  isRunning(): boolean
  forceCheck(): Promise<readonly RotationResult[]>
  getLastCheckAt(): string | null
  getCheckCount(): number
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createWatchdogDaemon(
  controller: RotationController,
  options?: { intervalMs?: number },
): WatchdogDaemon {
  const intervalMs = options?.intervalMs ?? 60_000
  let timer: ReturnType<typeof setInterval> | null = null
  let lastCheckAt: string | null = null
  let checkCount = 0

  async function runCheck(): Promise<readonly RotationResult[]> {
    const results = await controller.tick()
    lastCheckAt = new Date().toISOString()
    checkCount++
    return results
  }

  return {
    start(): void {
      if (timer !== null) return
      timer = setInterval(() => {
        void runCheck()
      }, intervalMs)
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },

    isRunning(): boolean {
      return timer !== null
    },

    async forceCheck(): Promise<readonly RotationResult[]> {
      return runCheck()
    },

    getLastCheckAt(): string | null {
      return lastCheckAt
    },

    getCheckCount(): number {
      return checkCount
    },
  }
}
