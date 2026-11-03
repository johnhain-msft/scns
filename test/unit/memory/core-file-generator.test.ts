import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createVault } from '../../../src/memory/vault.js'
import { generateCoreFiles } from '../../../src/memory/core-file-generator.js'

describe('core-file-generator', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scns-core-test-'))
    mkdirSync(join(tempDir, 'daily'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('generates SOUL.md with system identity', () => {
    const vault = createVault({ rootDir: tempDir })
    const result = generateCoreFiles({ vault })

    expect(result.soulUpdated).toBe(true)
    const soul = readFileSync(join(tempDir, 'SOUL.md'), 'utf-8')
    expect(soul).toContain('SOUL')
    expect(soul).toContain('Second Central Nervous System')
    expect(soul).toContain('Observation')
    expect(soul).toContain('Memory')
  })

  it('generates USER.md with preferences from MEMORY.md', () => {
    const vault = createVault({ rootDir: tempDir })
    // Write a MEMORY.md with entries
    const memoryContent = `---
name: Follow TDD Workflow
description: Always follow TDD
type: feedback
---
Always follow Test-Driven Development

---
name: Never Skip Tests
description: Do not skip manual testing
type: prohibition
---
Do not skip manual testing

---
name: User Prefers TypeScript
description: User prefers TypeScript
type: user
---
User prefers TypeScript over JavaScript`

    vault.write('MEMORY.md', memoryContent)
    const result = generateCoreFiles({ vault })

    expect(result.userUpdated).toBe(true)
    expect(result.userPreferences).toBeGreaterThan(0)

    const user = readFileSync(join(tempDir, 'USER.md'), 'utf-8')
    expect(user).toContain('USER')
    expect(user).toContain('Workflow Requirements')
    expect(user).toContain('Things To Avoid')
    expect(user).toContain('Preferences')
  })

  it('includes observed patterns from daily logs', () => {
    const vault = createVault({ rootDir: tempDir })
    // Create some daily logs with timestamps
    writeFileSync(
      join(tempDir, 'daily', '2026-04-15.md'),
      '## 14:00:00\n\nSome work\n\n## 15:30:00\n\nMore work\n',
    )
    writeFileSync(
      join(tempDir, 'daily', '2026-04-16.md'),
      '## 14:15:00\n\nAnother day\n\n## 22:00:00\n\nLate work\n',
    )

    const result = generateCoreFiles({ vault })

    expect(result.userPatterns).toBeGreaterThan(0)
    const user = readFileSync(join(tempDir, 'USER.md'), 'utf-8')
    expect(user).toContain('Observed Patterns')
    expect(user).toContain('days of observed activity')
  })

  it('generates USER.md with empty vault gracefully', () => {
    const vault = createVault({ rootDir: tempDir })
    const result = generateCoreFiles({ vault })

    expect(result.userUpdated).toBe(true)
    expect(result.userPreferences).toBe(0)
    expect(existsSync(join(tempDir, 'USER.md'))).toBe(true)
  })

  it('SOUL.md includes dynamic file counts', () => {
    const vault = createVault({ rootDir: tempDir })
    writeFileSync(join(tempDir, 'daily', '2026-04-15.md'), '## 14:00\n\nWork\n')

    mkdirSync(join(tempDir, 'weekly'), { recursive: true })
    writeFileSync(join(tempDir, 'weekly', '2026-W16.md'), 'Weekly summary')

    const result = generateCoreFiles({ vault })
    expect(result.soulUpdated).toBe(true)

    const soul = readFileSync(join(tempDir, 'SOUL.md'), 'utf-8')
    // Should contain at least 1 daily and 1 weekly
    expect(soul).toMatch(/\d+ files/)
  })
})
