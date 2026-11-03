/**
 * Issue #61 — broker pidfile.
 *
 * On macOS the supervisor knows the broker's identity because launchd owns the
 * process. On Windows the external watchdog is a separate, unrelated process:
 * to restart a *hung* broker it must first stop it, and to stop it, it has to
 * know which pid it is. Nothing recorded that.
 *
 * These tests pin the record format, the staleness rules, and the two failure
 * modes that matter — an unreadable/garbage pidfile and a recycled pid.
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  brokerPidfilePath,
  writeBrokerPidfile,
  readBrokerPidfile,
  removeBrokerPidfile,
  isProcessAlive,
  readLiveBrokerPid,
  type BrokerPidRecord,
} from '../../../../src/broker/services/broker-pidfile.js'

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'scns-pidfile-'))
}

const RECORD: BrokerPidRecord = {
  pid: 4242,
  port: 3456,
  startedAt: 1_700_000_000_000,
  execPath: 'C:\\node\\node.exe',
}

describe('brokerPidfilePath', () => {
  it('lives under <scnsHome>/.scns/run and is namespaced by port', () => {
    const p = brokerPidfilePath('/home/x', 3456)
    expect(p).toContain(`.scns${sep}run`)
    expect(p).toContain('3456')
  })

  it('gives different ports different files (child brokers must not collide)', () => {
    expect(brokerPidfilePath('/home/x', 3456)).not.toBe(brokerPidfilePath('/home/x', 3457))
  })
})

describe('write/read/remove round-trip', () => {
  it('round-trips a record through a real file', () => {
    const home = tmpHome()
    try {
      const p = brokerPidfilePath(home, 3456)
      writeBrokerPidfile(p, RECORD)
      expect(existsSync(p)).toBe(true)
      expect(readBrokerPidfile(p)).toEqual(RECORD)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('creates the parent directory rather than throwing', () => {
    const home = tmpHome()
    try {
      const p = join(home, 'deep', 'nested', 'broker.pid')
      writeBrokerPidfile(p, RECORD)
      expect(JSON.parse(readFileSync(p, 'utf-8')).pid).toBe(4242)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('removeBrokerPidfile is idempotent on a missing file', () => {
    const home = tmpHome()
    try {
      const p = brokerPidfilePath(home, 3456)
      expect(() => removeBrokerPidfile(p)).not.toThrow()
      writeBrokerPidfile(p, RECORD)
      removeBrokerPidfile(p)
      expect(existsSync(p)).toBe(false)
      expect(() => removeBrokerPidfile(p)).not.toThrow()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns null for a missing pidfile', () => {
    expect(readBrokerPidfile(join(tmpdir(), 'scns-does-not-exist-61.pid'))).toBeNull()
  })

  it('returns null for garbage rather than throwing', () => {
    const home = tmpHome()
    try {
      const p = join(home, 'broker.pid')
      writeFileSync(p, 'not json at all', 'utf-8')
      expect(readBrokerPidfile(p)).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns null for JSON missing a usable pid', () => {
    const home = tmpHome()
    try {
      const p = join(home, 'broker.pid')
      for (const body of ['{}', '{"pid":0}', '{"pid":-1}', '{"pid":"abc"}', 'null', '[]']) {
        writeFileSync(p, body, 'utf-8')
        expect(readBrokerPidfile(p)).toBeNull()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('never throws when the write itself fails (best-effort bookkeeping)', () => {
    expect(() =>
      writeBrokerPidfile('/definitely/not/writable\u0000/broker.pid', RECORD),
    ).not.toThrow()
  })
})

describe('isProcessAlive', () => {
  it('is true for this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('is false when the probe throws ESRCH (no such process)', () => {
    const kill = vi.fn(() => {
      const e = new Error('kill ESRCH') as NodeJS.ErrnoException
      e.code = 'ESRCH'
      throw e
    })
    expect(isProcessAlive(9_999_999, kill)).toBe(false)
  })

  it('is TRUE when the probe throws EPERM — the process exists, we just cannot signal it', () => {
    const kill = vi.fn(() => {
      const e = new Error('kill EPERM') as NodeJS.ErrnoException
      e.code = 'EPERM'
      throw e
    })
    expect(isProcessAlive(1, kill)).toBe(true)
  })

  it('rejects non-positive pids without probing', () => {
    const kill = vi.fn()
    expect(isProcessAlive(0, kill)).toBe(false)
    expect(isProcessAlive(-5, kill)).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })
})

describe('readLiveBrokerPid', () => {
  it('returns the pid when the recorded process is alive', () => {
    const home = tmpHome()
    try {
      const p = brokerPidfilePath(home, 3456)
      writeBrokerPidfile(p, RECORD)
      const alive = vi.fn() // signal 0 returns cleanly => process exists
      expect(readLiveBrokerPid(p, alive)).toBe(RECORD.pid)
      expect(alive).toHaveBeenCalledWith(RECORD.pid, 0)
      expect(existsSync(p)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns null and REMOVES a stale pidfile whose process is gone', () => {
    const home = tmpHome()
    try {
      const p = brokerPidfilePath(home, 3456)
      writeBrokerPidfile(p, RECORD)
      const kill = vi.fn(() => {
        const e = new Error('kill ESRCH') as NodeJS.ErrnoException
        e.code = 'ESRCH'
        throw e
      })
      expect(readLiveBrokerPid(p, kill)).toBeNull()
      expect(existsSync(p)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns null when there is no pidfile at all', () => {
    expect(readLiveBrokerPid(join(tmpdir(), 'scns-absent-61.pid'))).toBeNull()
  })

  it('never returns our OWN pid — that would make a restarter kill itself', () => {
    const home = tmpHome()
    try {
      const p = brokerPidfilePath(home, 3456)
      writeBrokerPidfile(p, { ...RECORD, pid: process.pid })
      expect(readLiveBrokerPid(p, undefined, process.pid)).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
