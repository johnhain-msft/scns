import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const BLIND_REVIEW_VERSION = 'BLIND_REVIEW_V1' as const
export const FOLLOWUP_REVIEW_VERSION = 'BLIND_REVIEW_FOLLOWUP_V1' as const

type ReviewVersion = typeof BLIND_REVIEW_VERSION | typeof FOLLOWUP_REVIEW_VERSION

export interface FrozenSection {
  readonly path: string
  readonly section: string
  readonly sha256: string
}

export interface FrozenFile {
  readonly path: string
  readonly sha256: string
}

export interface FrozenRepository {
  readonly path: string
  readonly revision: string
}

/**
 * An acceptance item the acceptance source's own owner has withdrawn.
 *
 * Without this, a retracted requirement can never be closed — the reviewer
 * scores the frozen acceptance source verbatim, so a misdiagnosed item goes
 * on failing the artifact on every pass.
 *
 * This is the only producer-controlled field in the envelope, so it is kept
 * as narrow as possible: an item identifier and a URL to the authority that
 * withdrew it. No justification, no prose — the reviewer follows the link
 * and judges for itself. Follow-up mode only; pass one stays fully blind.
 */
export interface RetractedItem {
  readonly item: string
  readonly authority: string
}

/** An identifier, not an argument. Long enough to name an item, no more. */
const MAX_RETRACTED_ITEM_LENGTH = 80

export interface BlindReviewRequest {
  readonly version: typeof BLIND_REVIEW_VERSION
  readonly artifact: FrozenSection
  readonly acceptance: FrozenSection
  readonly repository: FrozenRepository
}

export interface FollowupReviewRequest {
  readonly version: typeof FOLLOWUP_REVIEW_VERSION
  readonly artifact: FrozenSection
  readonly acceptance: FrozenSection
  readonly repository: FrozenRepository
  readonly blindVerdict: FrozenFile
  readonly retracted: readonly RetractedItem[]
}

export type ReviewRequest = BlindReviewRequest | FollowupReviewRequest

export interface GeneratedReviewPrompt {
  readonly mode: 'blind' | 'followup'
  readonly prompt: string
  readonly promptSha256: string
  readonly requestSha256: string
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function requireExactKeys(record: UnknownRecord, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown field(s): ${unknown.join(', ')}`)
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function requireAbsolutePath(value: unknown, label: string): string {
  const path = requireString(value, label)
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`)
  return path
}

function requireSha256(value: unknown, label: string): string {
  const hash = requireString(value, label).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label} must be a 64-character sha256`)
  return hash
}

function parseFrozenSection(value: unknown, label: string): FrozenSection {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['path', 'section', 'sha256'], label)
  return {
    path: requireAbsolutePath(record.path, `${label}.path`),
    section: requireString(record.section, `${label}.section`),
    sha256: requireSha256(record.sha256, `${label}.sha256`),
  }
}

function parseFrozenFile(value: unknown, label: string): FrozenFile {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['path', 'sha256'], label)
  return {
    path: requireAbsolutePath(record.path, `${label}.path`),
    sha256: requireSha256(record.sha256, `${label}.sha256`),
  }
}

function parseRetracted(value: unknown): readonly RetractedItem[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('retracted must be an array')
  return value.map((entry, index) => {
    const label = `retracted[${index}]`
    const record = requireRecord(entry, label)
    requireExactKeys(record, ['item', 'authority'], label)
    const item = requireString(record.item, `${label}.item`)
    if (item.length > MAX_RETRACTED_ITEM_LENGTH || /[\r\n]/.test(item)) {
      throw new Error(
        `${label}.item must be a single-line identifier of at most ` +
          `${MAX_RETRACTED_ITEM_LENGTH} characters — name the item, do not argue it`,
      )
    }
    const authority = requireString(record.authority, `${label}.authority`)
    if (!/^https?:\/\/\S+$/.test(authority)) {
      throw new Error(`${label}.authority must be an http(s) URL to the withdrawing decision`)
    }
    return { item, authority }
  })
}

function parseRepository(value: unknown): FrozenRepository {
  const record = requireRecord(value, 'repository')
  requireExactKeys(record, ['path', 'revision'], 'repository')
  const revision = requireString(record.revision, 'repository.revision').toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error('repository.revision must be a full 40-character commit hash')
  }
  return {
    path: requireAbsolutePath(record.path, 'repository.path'),
    revision,
  }
}

export function parseReviewRequest(value: unknown): ReviewRequest {
  const record = requireRecord(value, 'request')
  const version = requireString(record.version, 'request.version') as ReviewVersion

  if (version === BLIND_REVIEW_VERSION) {
    requireExactKeys(record, ['version', 'artifact', 'acceptance', 'repository'], 'request')
    return {
      version,
      artifact: parseFrozenSection(record.artifact, 'artifact'),
      acceptance: parseFrozenSection(record.acceptance, 'acceptance'),
      repository: parseRepository(record.repository),
    }
  }

  if (version === FOLLOWUP_REVIEW_VERSION) {
    requireExactKeys(
      record,
      ['version', 'artifact', 'acceptance', 'repository', 'blindVerdict', 'retracted'],
      'request',
    )
    if (record.blindVerdict === undefined) {
      throw new Error('blindVerdict is required for BLIND_REVIEW_FOLLOWUP_V1')
    }
    return {
      version,
      artifact: parseFrozenSection(record.artifact, 'artifact'),
      acceptance: parseFrozenSection(record.acceptance, 'acceptance'),
      repository: parseRepository(record.repository),
      blindVerdict: parseFrozenFile(record.blindVerdict, 'blindVerdict'),
      retracted: parseRetracted(record.retracted),
    }
  }

  throw new Error(`unsupported request.version: ${version}`)
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function verifyFrozenFile(label: string, file: FrozenFile): void {
  const actual = sha256File(file.path)
  if (actual !== file.sha256) {
    throw new Error(`${label} sha256 mismatch: expected ${file.sha256}, got ${actual}`)
  }
}

function causalDiscipline(): readonly string[] {
  return [
    'For every causal claim you assess, keep two questions separate: whether a mechanism exists or is broken, and whether that mechanism produced the observed outcome.',
    'Identify other paths that could produce the same observation. Rule them out with evidence or state that attribution is not established.',
  ]
}

function blindPrompt(request: BlindReviewRequest): string {
  return [
    BLIND_REVIEW_VERSION,
    '',
    'You are an independent fresh-context reviewer. You did not produce the artifact.',
    'Review the frozen artifact against the cited acceptance source. Derive the investigation from those primary sources and inspect any raw evidence you need. Do not assume the artifact conclusions are correct.',
    '',
    `Artifact path: ${request.artifact.path}`,
    `Artifact section: ${request.artifact.section}`,
    `Artifact sha256: ${request.artifact.sha256}`,
    `Acceptance path: ${request.acceptance.path}`,
    `Acceptance section: ${request.acceptance.section}`,
    `Acceptance sha256: ${request.acceptance.sha256}`,
    `Repository path: ${request.repository.path}`,
    `Frozen revision: ${request.repository.revision}`,
    '',
    ...causalDiscipline(),
    '',
    'Return a clear PASS, FAIL, or BLOCKED verdict with evidence. Do not edit files.',
  ].join('\n')
}

function retractedLines(request: FollowupReviewRequest): readonly string[] {
  if (request.retracted.length === 0) return []
  return [
    'Retracted acceptance items — withdrawn by the owner of the acceptance source. Do not score these; follow the authority link and judge it yourself if you disagree:',
    ...request.retracted.map((r) => `  - ${r.item} (authority: ${r.authority})`),
    '',
  ]
}

function followupPrompt(request: FollowupReviewRequest): string {
  return [
    FOLLOWUP_REVIEW_VERSION,
    '',
    'You are an independent fresh-context reviewer performing a second pass after a completed blind verdict.',
    'Review the frozen artifact against the same acceptance source and independently verify whether the prior verdict remains supported.',
    '',
    `Artifact path: ${request.artifact.path}`,
    `Artifact section: ${request.artifact.section}`,
    `Artifact sha256: ${request.artifact.sha256}`,
    `Acceptance path: ${request.acceptance.path}`,
    `Acceptance section: ${request.acceptance.section}`,
    `Acceptance sha256: ${request.acceptance.sha256}`,
    `Repository path: ${request.repository.path}`,
    `Frozen revision: ${request.repository.revision}`,
    `Prior blind verdict path: ${request.blindVerdict.path}`,
    `Prior blind verdict sha256: ${request.blindVerdict.sha256}`,
    '',
    ...retractedLines(request),
    ...causalDiscipline(),
    '',
    'Return a clear PASS, FAIL, or BLOCKED verdict with evidence. Do not edit files.',
  ].join('\n')
}

const FRAMING_MARKERS: readonly RegExp[] = [
  /\bproducer\s+(?:summary|findings?|notes?)\s*:/i,
  /\balleged\s+fix(?:es)?\s*:/i,
  /\breview\s+checklist\s*:/i,
  /\bprior\s+findings?\s*:/i,
  /\bverify this claim directly\b/i,
]

export function auditBlindPrompt(prompt: string): string[] {
  return prompt.split('\n').filter((line) => FRAMING_MARKERS.some((marker) => marker.test(line)))
}

export function buildReviewPrompt(request: ReviewRequest): GeneratedReviewPrompt {
  verifyFrozenFile('artifact', request.artifact)
  verifyFrozenFile('acceptance', request.acceptance)
  if (request.version === FOLLOWUP_REVIEW_VERSION) {
    verifyFrozenFile('blindVerdict', request.blindVerdict)
  }

  const prompt =
    request.version === BLIND_REVIEW_VERSION ? blindPrompt(request) : followupPrompt(request)

  // Audit BOTH modes. `retracted` is the one producer-controlled field in
  // the envelope, so the follow-up prompt needs the same guard the blind
  // prompt has always had.
  const framingLeaks = auditBlindPrompt(prompt)
  if (framingLeaks.length > 0) {
    throw new Error(`generated blind prompt contains framing: ${framingLeaks.join(' | ')}`)
  }

  return {
    mode: request.version === BLIND_REVIEW_VERSION ? 'blind' : 'followup',
    prompt,
    promptSha256: sha256Text(prompt),
    requestSha256: sha256Text(JSON.stringify(request)),
  }
}
