import { describe, it, expect } from 'vitest'
import {
  parseDailyLog,
  classifyEntry,
  extractFromLog,
  extractFromMultipleLogs,
  generateEntryName,
} from '../../../src/dream/extraction.js'
import type { DailyLogEntry } from '../../../src/dream/extraction.js'

// ---------------------------------------------------------------------------
// Sample daily log content
// ---------------------------------------------------------------------------

const singleSessionLog = `## 2026-04-05

### 14:30 — Session abc123
- Working on SCNS project
- Decided to use Express 5 instead of Fastify
- User prefers TypeScript over JavaScript always
`

const multiSessionLog = `## 2026-04-05

### 14:30 — Session abc123
- Working on SCNS project
- Decided to use Express 5 instead of Fastify
- User prefers TypeScript over JavaScript always

### 16:45 — Session def456
- Reviewed PR for real estate analysis
- PostgreSQL queries optimized with EXPLAIN ANALYZE
- User wants conventional commits enforced
`

const noSessionIdLog = `## 2026-04-05

### 09:00
- Morning standup notes
- Remember to always run lint before commit
`

const realisticLog = `## 2026-04-05

### 14:30 — Session abc123
- Working on SCNS project
- Decided to use Express 5 instead of Fastify
- User prefers TypeScript over JavaScript always
- Dashboard at https://grafana.example.com

### 16:45 — Session def456
- Reviewed PR for real estate analysis
- User dislikes tabs, prefers spaces
- Remember to always run lint before commit
- Docs at https://docs.example.com/api
`

// ---------------------------------------------------------------------------
// parseDailyLog
// ---------------------------------------------------------------------------

describe('parseDailyLog', () => {
  it('should parse a single session entry with time and session ID', () => {
    const entries = parseDailyLog(singleSessionLog, '2026-04-05')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual<DailyLogEntry>({
      date: '2026-04-05',
      time: '14:30',
      sessionId: 'abc123',
      lines: [
        'Working on SCNS project',
        'Decided to use Express 5 instead of Fastify',
        'User prefers TypeScript over JavaScript always',
      ],
    })
  })

  it('should parse multiple session entries in one log', () => {
    const entries = parseDailyLog(multiSessionLog, '2026-04-05')
    expect(entries).toHaveLength(2)
    expect(entries[0]!.sessionId).toBe('abc123')
    expect(entries[0]!.time).toBe('14:30')
    expect(entries[1]!.sessionId).toBe('def456')
    expect(entries[1]!.time).toBe('16:45')
  })

  it('should parse entry without session ID (just time header)', () => {
    const entries = parseDailyLog(noSessionIdLog, '2026-04-05')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.sessionId).toBeNull()
    expect(entries[0]!.time).toBe('09:00')
    expect(entries[0]!.lines).toEqual([
      'Morning standup notes',
      'Remember to always run lint before commit',
    ])
  })

  it('should return empty array for empty content', () => {
    expect(parseDailyLog('', '2026-04-05')).toEqual([])
    expect(parseDailyLog('   \n\n  ', '2026-04-05')).toEqual([])
  })

  it('should handle malformed headers gracefully', () => {
    const malformed = `## 2026-04-05

###Not a valid header
- Some content

### 14:30 — Session abc123
- Valid entry
`
    const entries = parseDailyLog(malformed, '2026-04-05')
    // The malformed header should be skipped; valid entry remains
    expect(entries.length).toBeGreaterThanOrEqual(1)
    const validEntry = entries.find((e) => e.time === '14:30')
    expect(validEntry).toBeDefined()
    expect(validEntry!.sessionId).toBe('abc123')
  })

  it('should extract bullet points correctly', () => {
    const entries = parseDailyLog(multiSessionLog, '2026-04-05')
    expect(entries[0]!.lines).toHaveLength(3)
    expect(entries[0]!.lines[0]).toBe('Working on SCNS project')
    // Lines should not include the leading "- "
    for (const line of entries[0]!.lines) {
      expect(line).not.toMatch(/^- /)
    }
  })

  it('should include non-bullet text (paragraphs) as lines', () => {
    const withParagraph = `## 2026-04-05

### 10:00 — Session xyz
- First bullet
Some paragraph text here
- Second bullet
`
    const entries = parseDailyLog(withParagraph, '2026-04-05')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.lines).toContain('Some paragraph text here')
    expect(entries[0]!.lines).toContain('First bullet')
    expect(entries[0]!.lines).toContain('Second bullet')
  })
})

// ---------------------------------------------------------------------------
// classifyEntry
// ---------------------------------------------------------------------------

describe('classifyEntry', () => {
  it('should classify "User prefers TypeScript" as user type', () => {
    const result = classifyEntry('User prefers TypeScript')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('user')
    expect(result!.confidence).toBeGreaterThanOrEqual(0.6)
  })

  it('should classify "Decided to use Express 5" as project type', () => {
    const result = classifyEntry('Decided to use Express 5')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('project')
  })

  it('should classify "Remember to always run lint before commit" as feedback type', () => {
    const result = classifyEntry('Remember to always run lint before commit')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('feedback')
  })

  it('should classify "Dashboard at https://grafana.example.com" as reference type', () => {
    const result = classifyEntry('Dashboard at https://grafana.example.com')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('reference')
  })

  it('should return null for routine action "Fixed a bug in the parser"', () => {
    const result = classifyEntry('Fixed a bug in the parser')
    expect(result).toBeNull()
  })

  it('should return null for status update "Working on SCNS project"', () => {
    const result = classifyEntry('Working on SCNS project')
    expect(result).toBeNull()
  })

  it('should classify "User dislikes tabs, prefers spaces" as user type', () => {
    const result = classifyEntry('User dislikes tabs, prefers spaces')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('user')
  })

  it('should return confidence in expected range (0.6–0.9)', () => {
    const strong = classifyEntry('User prefers dark mode')
    expect(strong).not.toBeNull()
    expect(strong!.confidence).toBeGreaterThanOrEqual(0.6)
    expect(strong!.confidence).toBeLessThanOrEqual(1.0)

    const project = classifyEntry('Using PostgreSQL as the database')
    expect(project).not.toBeNull()
    expect(project!.confidence).toBeGreaterThanOrEqual(0.6)
    expect(project!.confidence).toBeLessThanOrEqual(1.0)
  })

  it('should classify "always wants ESLint strict mode" as user type', () => {
    const result = classifyEntry('always wants ESLint strict mode')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('user')
  })

  it('should classify "API at https://api.example.com/v2" as reference type', () => {
    const result = classifyEntry('API at https://api.example.com/v2')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('reference')
  })

  it('should classify "architecture uses microservices" as project type', () => {
    const result = classifyEntry('architecture uses microservices')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('project')
  })

  it('should classify "better to use named exports" as feedback type', () => {
    const result = classifyEntry('better to use named exports')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('feedback')
  })

  it('should classify "don\'t use var in JavaScript" as feedback type', () => {
    const result = classifyEntry("don't use var in JavaScript")
    expect(result).not.toBeNull()
    expect(result!.type).toBe('feedback')
  })
})

// ---------------------------------------------------------------------------
// extractFromLog
// ---------------------------------------------------------------------------

describe('extractFromLog', () => {
  it('should extract entries from a realistic daily log', () => {
    const entries = extractFromLog(realisticLog, '2026-04-05')
    expect(entries.length).toBeGreaterThan(0)

    // All entries should be valid MemoryEntry objects
    for (const entry of entries) {
      expect(entry.type).toMatch(/^(user|feedback|project|reference)$/)
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.content.length).toBeGreaterThan(0)
    }
  })

  it('should return empty array for empty log', () => {
    expect(extractFromLog('', '2026-04-05')).toEqual([])
  })

  it('should return empty array for log with no classifiable lines', () => {
    const boringLog = `## 2026-04-05

### 14:30 — Session abc123
- Working on the project
- Fixed some bugs
- Reviewed code
`
    const entries = extractFromLog(boringLog, '2026-04-05')
    expect(entries).toEqual([])
  })

  it('should set correct source on entries', () => {
    const entries = extractFromLog(realisticLog, '2026-04-05')
    for (const entry of entries) {
      expect(entry.source).toBe('daily-log:2026-04-05')
    }
  })

  it('should set correct createdAt on entries', () => {
    const entries = extractFromLog(realisticLog, '2026-04-05')
    for (const entry of entries) {
      expect(entry.createdAt).toMatch(/^2026-04-05T\d{2}:\d{2}:00Z$/)
    }
  })
})

// ---------------------------------------------------------------------------
// extractFromLog — machine-authored dispatch briefs (regression, 2026-10-12)
// ---------------------------------------------------------------------------

describe('extractFromLog — machine-authored lines are not harvested', () => {
  // Verbatim text of the three briefs that were harvested on 2026-09-25 from an unrelated deck
  // project, typed `prohibition`, and rendered into USER.md under "Things To Avoid" — a file
  // injected into every session's briefing in every directory.
  const dispatchBriefLog = `## 2026-09-25

### 22:14 — Session deck-e19f65
- You are slidesmith. Short DELTA pass. Read .orchestrator/deck-e19f65/kickoff-build-5.md IN FULL and execute it exactly. Scope is TWO rows of storyboard.md and nothing else - you must NOT touch slides.
- You are the CHALLENGE reviewer for the repair round on the deck in this folder. You SCORE and REPORT - you NEVER write the deck. If you find a defect, name it with evidence; do not fix it. Read .orchestrator/deck-e19f65/brief-challenge.md.
`

  it('drops "You are <role>" dispatch briefs instead of harvesting them', () => {
    expect(extractFromLog(dispatchBriefLog, '2026-09-25')).toEqual([])
  })

  it('never types a dispatch brief as a prohibition', () => {
    // The gate is what prevents this; classifyEntry alone still reads "must NOT" as a prohibition.
    const line =
      'You are slidesmith. Scope is TWO rows of storyboard.md and nothing else - you must NOT touch slides.'
    expect(classifyEntry(line)?.type).toBe('prohibition')
    expect(
      extractFromLog(`## 2026-09-25\n\n### 22:14 — Session x\n- ${line}\n`, '2026-09-25'),
    ).toEqual([])
  })

  it('drops an orchestrator brief that has no role preamble', () => {
    const log = `## 2026-09-25

### 22:30 — Session deck-e19f65
- Read .orchestrator/deck-e19f65/brief-challenge-r3.md IN FULL. You never write the deck and must NOT touch slides.md.
`
    expect(extractFromLog(log, '2026-09-25')).toEqual([])
  })

  it('still harvests a genuine human prohibition', () => {
    const log = `## 2026-09-25

### 09:00 — Session abc123
- You must not commit secrets into source code.
`
    const entries = extractFromLog(log, '2026-09-25')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe('prohibition')
  })

  it('drops a multi-line brief whose prohibition sentence is on a continuation line', () => {
    // A multi-line prompt preview is split into separate lines by parseDailyLog,
    // so the authorship marker ("You are …") and the prohibition ("must NOT …")
    // land on DIFFERENT physical lines. A per-line gate passes the prohibition
    // line — the entry must be classified as a whole.
    const log = `## 22:14:03

**[session-hook]** User prompt: You are slidesmith. Short DELTA pass.
Scope is TWO rows of storyboard.md and nothing else - you must NOT touch slides.
Tags: type:session-hook, source:user-prompt, session-id:deck-e19f65
`
    expect(extractFromLog(log, '2026-10-12')).toEqual([])
  })

  it('still harvests the human lines of a multi-line human entry', () => {
    const log = `## 2026-10-12

### 09:00 — Session abc123
- Decided to use PostgreSQL for the audit service.
- You must not commit secrets into source code.
`
    const entries = extractFromLog(log, '2026-10-12')
    expect(entries.map((e) => e.type).sort()).toEqual(['prohibition', 'project'])
  })
})

// ---------------------------------------------------------------------------
// extractFromMultipleLogs
// ---------------------------------------------------------------------------

describe('extractFromMultipleLogs', () => {
  it('should combine entries from two logs sorted by date', () => {
    const log1 = `## 2026-04-04

### 10:00 — Session aaa
- User prefers dark mode
`
    const log2 = `## 2026-04-05

### 14:00 — Session bbb
- Decided to use PostgreSQL
`
    const entries = extractFromMultipleLogs([
      { content: log1, date: '2026-04-04' },
      { content: log2, date: '2026-04-05' },
    ])

    expect(entries.length).toBe(2)
    // Should be sorted by date (earlier first)
    expect(entries[0]!.createdAt!.startsWith('2026-04-04')).toBe(true)
    expect(entries[1]!.createdAt!.startsWith('2026-04-05')).toBe(true)
  })

  it('should deduplicate across logs (same fact → keep latest)', () => {
    const log1 = `## 2026-04-04

### 10:00 — Session aaa
- User prefers dark mode
`
    const log2 = `## 2026-04-05

### 14:00 — Session bbb
- User prefers dark mode
`
    const entries = extractFromMultipleLogs([
      { content: log1, date: '2026-04-04' },
      { content: log2, date: '2026-04-05' },
    ])

    // Same fact appears in both logs; should keep only the latest
    expect(entries.length).toBe(1)
    expect(entries[0]!.createdAt!.startsWith('2026-04-05')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Production daily log format (## HH:MM:SS + **[type]** content + Tags:)
// ---------------------------------------------------------------------------

const productionLog = `
## 13:37:38

**[session-hook]** User prompt: something fundamental is broken -- it didn't text me again today
Tags: type:session-hook, source:user-prompt, session-id:70bec71c

## 13:37:50

**[session-hook]** Tool used: bash
Tags: type:session-hook, source:tool-use, session-id:70bec71c, tool:bash

## 13:37:50

**[session-hook]** Pre-tool: bash
Tags: type:session-hook, source:pre-tool-use, session-id:70bec71c, tool:bash

## 13:37:50

**[session-hook]** Post-tool: bash
Tags: type:session-hook, source:post-tool-use, session-id:70bec71c, tool:bash

## 13:38:05

**[session-hook]** User prompt: why would you skip the tests AGAIN? stop doing this
Tags: type:session-hook, source:user-prompt, session-id:70bec71c

## 14:00:00

**[session-hook]** Session 70bec71c ended
Tags: type:session-hook, source:session-end, session-id:70bec71c

## 14:05:00

**[active-app]**
Tags: type:active-app, source:terminal

## 14:10:00

**[learning]** User prefers dark mode for all IDE settings
Tags: type:learning, source:otel-digest
`

describe('parseDailyLog — production format', () => {
  it('should parse ## HH:MM:SS headers', () => {
    const entries = parseDailyLog(productionLog, '2026-04-14')
    expect(entries.length).toBeGreaterThan(0)
    const first = entries[0]!
    expect(first.time).toBe('13:37:38')
    expect(first.date).toBe('2026-04-14')
  })

  it('should extract session ID from Tags line', () => {
    const entries = parseDailyLog(productionLog, '2026-04-14')
    const withSession = entries.find((e) => e.sessionId === '70bec71c')
    expect(withSession).toBeDefined()
  })

  it('should extract content from **[type]** format', () => {
    const entries = parseDailyLog(productionLog, '2026-04-14')
    // Should have the user prompt content
    const userPrompt = entries.find((e) =>
      e.lines.some((l) => l.includes('something fundamental is broken')),
    )
    expect(userPrompt).toBeDefined()
  })

  it('should filter out noise (pre-tool, post-tool, basic tool-use)', () => {
    const entries = parseDailyLog(productionLog, '2026-04-14')
    // Noise entries should be filtered: pre-tool-use, post-tool-use, tool-use, session-end
    const noiseLines = entries
      .flatMap((e) => e.lines)
      .filter((l) => l.includes('Pre-tool:') || l.includes('Post-tool:') || l === 'Tool used: bash')
    expect(noiseLines).toHaveLength(0)
  })

  it('should keep user prompts and learning entries', () => {
    const entries = parseDailyLog(productionLog, '2026-04-14')
    const allLines = entries.flatMap((e) => e.lines)
    // User prompt content should be present (stripped of wrapper)
    expect(allLines.some((l) => l.includes('something fundamental is broken'))).toBe(true)
    // Learning entry should be present
    expect(allLines.some((l) => l.includes('User prefers dark mode'))).toBe(true)
  })

  it('should handle entries with no content (like active-app)', () => {
    const entries = parseDailyLog(productionLog, '2026-04-14')
    // active-app with empty content should be filtered
    const activeApp = entries.find((e) => e.lines.some((l) => l === '' || l === 'active-app'))
    // Either filtered entirely or present with empty lines
    if (activeApp) {
      expect(activeApp.lines.filter((l) => l.trim().length > 0)).toHaveLength(0)
    }
  })
})

describe('extractFromLog — production format', () => {
  it('should extract classifiable entries from production-format logs', () => {
    const entries = extractFromLog(productionLog, '2026-04-14')
    expect(entries.length).toBeGreaterThan(0)
  })

  it('should classify user prompts with prohibition language', () => {
    const entries = extractFromLog(productionLog, '2026-04-14')
    // "stop doing this" should classify as prohibition and be synthesized
    const prohibition = entries.find((e) => e.type === 'prohibition')
    expect(prohibition).toBeDefined()
    // Synthesis transforms raw prompts into actionable rules
    expect(prohibition!.type).toBe('prohibition')
  })

  it('should classify learning entries as user preferences', () => {
    const entries = extractFromLog(productionLog, '2026-04-14')
    const userPref = entries.find((e) => e.type === 'user')
    expect(userPref).toBeDefined()
    expect(userPref!.content).toContain('prefers dark mode')
  })

  it('should not extract noise entries (tool-use, pre-tool, post-tool)', () => {
    const entries = extractFromLog(productionLog, '2026-04-14')
    // No entries should be about "Tool used: bash" or "Pre-tool: bash"
    for (const entry of entries) {
      expect(entry.content).not.toMatch(/^Tool used:/)
      expect(entry.content).not.toMatch(/^Pre-tool:/)
      expect(entry.content).not.toMatch(/^Post-tool:/)
    }
  })

  it('should generate valid createdAt for HH:MM:SS times', () => {
    const entries = extractFromLog(productionLog, '2026-04-14')
    for (const entry of entries) {
      expect(entry.createdAt).toMatch(/^2026-04-14T\d{2}:\d{2}:\d{2}Z$/)
      // Verify it's a valid date
      expect(new Date(entry.createdAt!).toString()).not.toBe('Invalid Date')
    }
  })
})

describe('parseDailyLog — backward compat with old format', () => {
  it('should still parse ### HH:MM headers', () => {
    const oldFormat = `## 2026-04-05

### 14:30 — Session abc123
- User prefers TypeScript
- Decided to use Express 5
`
    const entries = parseDailyLog(oldFormat, '2026-04-05')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.time).toBe('14:30')
    expect(entries[0]!.sessionId).toBe('abc123')
    expect(entries[0]!.lines).toContain('User prefers TypeScript')
  })

  it('should handle mixed old and new format in same file', () => {
    const mixed = `### 14:30 — Session abc123
- User prefers TypeScript

## 15:00:00

**[learning]** Decided to use PostgreSQL
Tags: type:learning, source:otel-digest
`
    const entries = parseDailyLog(mixed, '2026-04-05')
    expect(entries.length).toBe(2)
    const allLines = entries.flatMap((e) => e.lines)
    expect(allLines.some((l) => l.includes('User prefers TypeScript'))).toBe(true)
    expect(allLines.some((l) => l.includes('Decided to use PostgreSQL'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// generateEntryName
// ---------------------------------------------------------------------------

describe('generateEntryName', () => {
  it('should truncate long content to ~60 chars', () => {
    const long =
      'This is a really long description that goes on and on and should be truncated to fit within sixty characters or so'
    const name = generateEntryName(long)
    expect(name.length).toBeLessThanOrEqual(60)
  })

  it('should remove leading bullet markers', () => {
    const name = generateEntryName('- User prefers TypeScript')
    expect(name).not.toMatch(/^-/)
  })

  it('should title case the result', () => {
    const name = generateEntryName('user prefers dark mode')
    // Each word should be title-cased
    expect(name).toBe('User Prefers Dark Mode')
  })

  it('should handle short content', () => {
    const name = generateEntryName('uses vim')
    expect(name.length).toBeGreaterThan(0)
    expect(name).toBe('Uses Vim')
  })

  it('should handle empty string', () => {
    const name = generateEntryName('')
    expect(name).toBe('')
  })

  it('should take first clause before comma or period', () => {
    const name = generateEntryName('decided to use Express 5, it has better middleware support')
    expect(name).not.toContain(',')
    expect(name.toLowerCase()).toContain('decided to use express 5')
  })
})
