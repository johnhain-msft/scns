import { describe, it, expect } from 'vitest'
import {
  parseSessionDateTime,
  fileForDia,
  diaFromFilePath,
  extractTurns,
  oracleGazetteer,
  type LocomoSample,
} from '../../../scripts/locomo-corpus.js'

// Characterization tests locking the LoCoMo corpus helpers extracted (WS-2 Phase R, Q2) from
// locomo-multihop-harness.ts — proves the shared module behaves identically to the recall harness's
// originals (no regression from the extraction). Pure helpers only (buildVault/loadLocomoSamples do I/O).

describe('parseSessionDateTime', () => {
  it('parses a LoCoMo session datetime to epoch ms (UTC)', () => {
    expect(parseSessionDateTime('1:56 pm on 8 May, 2023')).toBe(Date.UTC(2023, 4, 8, 13, 56))
    expect(parseSessionDateTime('9:05 am on 1 January, 2024')).toBe(Date.UTC(2024, 0, 1, 9, 5))
  })
  it('returns null for non-strings and malformed input', () => {
    expect(parseSessionDateTime(undefined)).toBeNull()
    expect(parseSessionDateTime('not a date')).toBeNull()
    expect(parseSessionDateTime('13:00 on 2 Foo, 2023')).toBeNull()
  })
})

describe('fileForDia / diaFromFilePath — round-trip', () => {
  it('maps a dia_id to a filesystem-safe basename and back', () => {
    expect(fileForDia('D2:8')).toBe('D2-8.md')
    expect(diaFromFilePath('/tmp/scns-locomo-x/D2-8.md')).toBe('D2:8')
    expect(diaFromFilePath(fileForDia('D11:3'))).toBe('D11:3')
  })
})

describe('extractTurns', () => {
  const conversation: Record<string, unknown> = {
    session_1_date_time: '1:56 pm on 8 May, 2023',
    session_1: [
      { speaker: 'Caroline', dia_id: 'D1:1', text: 'I joined a support group.' },
      { speaker: 'Melanie', dia_id: 'D1:2', text: 'Nice!', blip_caption: 'a photo of a park' },
    ],
    session_2_date_time: 'bad date',
    session_2: [{ speaker: 'Caroline', dia_id: 'D2:1', text: 'I researched adoption.' }],
  }
  it('flattens sessions into ordered per-turn nodes with speaker-prefixed content + τ', () => {
    const turns = extractTurns(conversation, 0)
    expect(turns.map((t) => t.diaId)).toEqual(['D1:1', 'D1:2', 'D2:1'])
    expect(turns[0]!.content).toBe('Caroline: I joined a support group.')
    expect(turns[0]!.tauMs).toBe(Date.UTC(2023, 4, 8, 13, 56))
    expect(turns[1]!.content).toContain('[shared image: a photo of a park]')
    expect(turns[2]!.tauMs).toBeNull() // unparseable session datetime → null τ
  })
  it('honours the maxTurns cap', () => {
    expect(extractTurns(conversation, 2).map((t) => t.diaId)).toEqual(['D1:1', 'D1:2'])
  })
})

describe('oracleGazetteer', () => {
  it('includes speaker names and proper nouns seen ≥2×, excluding sentence-initial noise', () => {
    const sample = {
      sample_id: 's',
      qa: [],
      conversation: { speaker_a: 'Caroline', speaker_b: 'Melanie' },
    } as unknown as LocomoSample
    const turns = [
      { diaId: 'D1:1', content: 'Caroline: I love Riverdale. Riverdale is great.', tauMs: null },
      { diaId: 'D1:2', content: 'Melanie: The weather there is nice.', tauMs: null },
    ]
    const gaz = oracleGazetteer(sample, turns)
    const canon = gaz.map((g) => g.canonical)
    expect(canon).toContain('Caroline')
    expect(canon).toContain('Melanie')
    expect(canon).toContain('Riverdale') // appears 2×
    expect(canon).not.toContain('The') // sentence-initial stopword
  })
})
