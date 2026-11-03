import { describe, it, expect } from 'vitest'
import {
  createDailyLogWriter,
  formatObservation,
  type LogWriter,
} from '../../../src/observe/daily-log-writer.js'
import { ObservationType } from '../../../src/observe/types.js'
import type { Observation } from '../../../src/observe/types.js'

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: ObservationType.ActiveApp,
    timestamp: '2025-01-15T10:30:00Z',
    source: 'Chrome',
    content: 'Switched to Chrome — "GitHub - scns"',
    tags: ['app:chrome', 'category:browsing'],
    ...overrides,
  }
}

describe('formatObservation', () => {
  it('formats active-app observation', () => {
    const obs = makeObservation()
    const result = formatObservation(obs)
    expect(result).toContain('**[active-app]**')
    expect(result).toContain('Switched to Chrome — "GitHub - scns"')
    expect(result).toContain('app:chrome')
    expect(result).toContain('category:browsing')
  })

  it('formats file-change observation', () => {
    const obs = makeObservation({
      type: ObservationType.FileChange,
      source: 'VSCode',
      content: 'Modified src/observe/types.ts',
      tags: ['type:file-change', 'source:vscode'],
    })
    const result = formatObservation(obs)
    expect(result).toContain('**[file-change]**')
    expect(result).toContain('Modified src/observe/types.ts')
  })

  it('formats git-activity observation', () => {
    const obs = makeObservation({
      type: ObservationType.GitActivity,
      source: 'git',
      content: 'Committed: feat: add observer types',
      tags: ['type:git-activity', 'action:commit'],
    })
    const result = formatObservation(obs)
    expect(result).toContain('**[git-activity]**')
    expect(result).toContain('Committed: feat: add observer types')
  })

  it('formats terminal-history observation', () => {
    const obs = makeObservation({
      type: ObservationType.TerminalHistory,
      source: 'zsh',
      content: 'npm run test',
      tags: ['type:terminal-history', 'source:zsh'],
    })
    const result = formatObservation(obs)
    expect(result).toContain('**[terminal-history]**')
  })

  it('formats browser-tab observation', () => {
    const obs = makeObservation({
      type: ObservationType.BrowserTab,
      source: 'Chrome',
      content: 'Viewing: https://github.com/scns',
      tags: ['type:browser-tab', 'source:chrome'],
    })
    const result = formatObservation(obs)
    expect(result).toContain('**[browser-tab]**')
  })

  it('formats session-hook observation', () => {
    const obs = makeObservation({
      type: ObservationType.SessionHook,
      source: 'scns',
      content: 'Session started: coding-session-1',
      tags: ['type:session-hook', 'source:scns'],
    })
    const result = formatObservation(obs)
    expect(result).toContain('**[session-hook]**')
  })

  it('handles empty content', () => {
    const obs = makeObservation({ content: '' })
    const result = formatObservation(obs)
    expect(result).toContain('**[active-app]**')
  })

  it('includes tags in formatted output', () => {
    const obs = makeObservation({ tags: ['project:scns', 'action:focus'] })
    const result = formatObservation(obs)
    expect(result).toContain('project:scns')
    expect(result).toContain('action:focus')
  })

  it('handles observation with no tags', () => {
    const obs = makeObservation({ tags: [] })
    const result = formatObservation(obs)
    expect(result).toContain('**[active-app]**')
    expect(result).not.toContain('Tags:')
  })
})

describe('createDailyLogWriter', () => {
  function createMockWriter(): LogWriter & { calls: Array<{ entry: string; date?: Date }> } {
    const calls: Array<{ entry: string; date?: Date }> = []
    return {
      calls,
      appendDailyLog(entry: string, date?: Date): void {
        calls.push({ entry, date })
      },
    }
  }

  it('write() calls appendDailyLog with formatted string', () => {
    const mock = createMockWriter()
    const logWriter = createDailyLogWriter(mock)
    const obs = makeObservation()

    logWriter.write(obs)

    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0]!.entry).toContain('**[active-app]**')
    expect(mock.calls[0]!.entry).toContain('Switched to Chrome')
  })

  it('write() passes correct date from timestamp', () => {
    const mock = createMockWriter()
    const logWriter = createDailyLogWriter(mock)
    const obs = makeObservation({ timestamp: '2025-01-15T10:30:00Z' })

    logWriter.write(obs)

    expect(mock.calls[0]!.date).toEqual(new Date('2025-01-15T10:30:00Z'))
  })

  it('writeBatch() writes all observations', () => {
    const mock = createMockWriter()
    const logWriter = createDailyLogWriter(mock)
    const obs1 = makeObservation({ content: 'First observation' })
    const obs2 = makeObservation({
      type: ObservationType.GitActivity,
      content: 'Second observation',
    })
    const obs3 = makeObservation({
      type: ObservationType.FileChange,
      content: 'Third observation',
    })

    logWriter.writeBatch([obs1, obs2, obs3])

    expect(mock.calls).toHaveLength(3)
    expect(mock.calls[0]!.entry).toContain('First observation')
    expect(mock.calls[1]!.entry).toContain('Second observation')
    expect(mock.calls[2]!.entry).toContain('Third observation')
  })

  it('writeBatch() handles empty array', () => {
    const mock = createMockWriter()
    const logWriter = createDailyLogWriter(mock)

    logWriter.writeBatch([])

    expect(mock.calls).toHaveLength(0)
  })

  it('writeBatch() extracts correct date for each observation', () => {
    const mock = createMockWriter()
    const logWriter = createDailyLogWriter(mock)
    const obs1 = makeObservation({ timestamp: '2025-01-15T10:00:00Z' })
    const obs2 = makeObservation({ timestamp: '2025-01-16T14:00:00Z' })

    logWriter.writeBatch([obs1, obs2])

    expect(mock.calls[0]!.date).toEqual(new Date('2025-01-15T10:00:00Z'))
    expect(mock.calls[1]!.date).toEqual(new Date('2025-01-16T14:00:00Z'))
  })

  it('write() invokes onObservation callback with the observation', () => {
    const mock = createMockWriter()
    const buffered: Observation[] = []
    const logWriter = createDailyLogWriter(mock, (obs) => buffered.push(obs))
    const obs = makeObservation()

    logWriter.write(obs)

    expect(buffered).toHaveLength(1)
    expect(buffered[0]!.id).toBe(obs.id)
  })

  it('writeBatch() invokes onObservation callback for each observation', () => {
    const mock = createMockWriter()
    const buffered: Observation[] = []
    const logWriter = createDailyLogWriter(mock, (obs) => buffered.push(obs))
    const obs1 = makeObservation({ id: '00000000-0000-0000-0000-000000000001', content: 'A' })
    const obs2 = makeObservation({ id: '00000000-0000-0000-0000-000000000002', content: 'B' })

    logWriter.writeBatch([obs1, obs2])

    expect(buffered).toHaveLength(2)
    expect(buffered[0]!.content).toBe('A')
    expect(buffered[1]!.content).toBe('B')
  })

  it('works without onObservation callback (backward compatible)', () => {
    const mock = createMockWriter()
    const logWriter = createDailyLogWriter(mock)
    const obs = makeObservation()

    logWriter.write(obs)
    logWriter.writeBatch([obs])

    expect(mock.calls).toHaveLength(2)
  })
})
