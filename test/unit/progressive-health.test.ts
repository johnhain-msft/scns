import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  buildProgressiveHealth,
  computeOverallStatus,
  type ProgressiveHealthDeps,
} from '../../src/broker/progressive-health.js'

describe('buildProgressiveHealth', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('returns starting status within 500ms of startedAt', () => {
    const now = Date.now()
    const deps: ProgressiveHealthDeps = { db, startedAt: now - 100 }
    const body = buildProgressiveHealth(deps, now)
    expect(body.status).toBe('starting')
    expect(body.components.db.status).toBe('ready')
    expect(body.components.embeddings.status).toBe('idle')
    expect(body.components.brain.status).toBe('starting')
  })

  it('returns degraded while embeddings backfilling', () => {
    const now = Date.now()
    const deps: ProgressiveHealthDeps = {
      db,
      startedAt: now - 10_000,
      getEmbeddingBackfillState: () => ({
        status: 'backfilling',
        progress: { done: 100, total: 1000 },
      }),
      getBrainStatus: () => 'ready',
    }
    const body = buildProgressiveHealth(deps, now)
    expect(body.status).toBe('degraded')
    expect(body.components.embeddings.status).toBe('backfilling')
    expect(body.components.embeddings.progress).toEqual({ done: 100, total: 1000 })
  })

  it('returns ready when all components ready', () => {
    const now = Date.now()
    const deps: ProgressiveHealthDeps = {
      db,
      startedAt: now - 10_000,
      getEmbeddingBackfillState: () => ({
        status: 'ready',
        progress: { done: 1000, total: 1000 },
      }),
      getBrainStatus: () => 'ready',
    }
    const body = buildProgressiveHealth(deps, now)
    expect(body.status).toBe('ready')
    expect(body.components.embeddings.status).toBe('ready')
    expect(body.components.brain.status).toBe('ready')
  })

  it('returns ready when embeddings idle (no provider) after starting window', () => {
    const now = Date.now()
    const deps: ProgressiveHealthDeps = {
      db,
      startedAt: now - 10_000,
      getBrainStatus: () => 'ready',
    }
    const body = buildProgressiveHealth(deps, now)
    expect(body.status).toBe('ready')
  })

  // ── OTel component (Phase 13.12.8) ───────────────────────────────

  it('includes otel component with unconfigured status when no provider', () => {
    const now = Date.now()
    const deps: ProgressiveHealthDeps = { db, startedAt: now - 10_000 }
    const body = buildProgressiveHealth(deps, now)
    expect(body.components.otel).toBeDefined()
    expect(body.components.otel.status).toBe('unconfigured')
  })

  it('surfaces otel ready status with span count progress', () => {
    const now = Date.now()
    const deps: ProgressiveHealthDeps = {
      db,
      startedAt: now - 10_000,
      getOtelStatus: () => ({
        status: 'ready',
        progress: { done: 12345, total: 12345 },
      }),
    }
    const body = buildProgressiveHealth(deps, now)
    expect(body.components.otel.status).toBe('ready')
    expect(body.components.otel.progress).toEqual({ done: 12345, total: 12345 })
  })

  it('surfaces otel error status with errorMessage', () => {
    const now = Date.now()
    const deps: ProgressiveHealthDeps = {
      db,
      startedAt: now - 10_000,
      getOtelStatus: () => ({
        status: 'error',
        errorMessage: 'file not readable',
      }),
    }
    const body = buildProgressiveHealth(deps, now)
    expect(body.components.otel.status).toBe('error')
    expect(body.components.otel.errorMessage).toBe('file not readable')
  })

  it('returns degraded when db errors', () => {
    const brokenDb = new Database(':memory:')
    brokenDb.close()
    const deps: ProgressiveHealthDeps = {
      db: brokenDb,
      startedAt: Date.now() - 10_000,
    }
    const body = buildProgressiveHealth(deps)
    expect(body.components.db.status).toBe('error')
    expect(body.status).toBe('degraded')
  })

  it('computes uptime_seconds', () => {
    const now = Date.now()
    const deps: ProgressiveHealthDeps = { db, startedAt: now - 42_500 }
    const body = buildProgressiveHealth(deps, now)
    expect(body.uptime_seconds).toBe(42)
  })

  it('surfaces failed embedding status as degraded', () => {
    const now = Date.now()
    const deps: ProgressiveHealthDeps = {
      db,
      startedAt: now - 10_000,
      getEmbeddingBackfillState: () => ({
        status: 'failed',
        progress: { done: 10, total: 100 },
        errorMessage: 'onnx explosion',
      }),
      getBrainStatus: () => 'ready',
    }
    const body = buildProgressiveHealth(deps, now)
    expect(body.status).toBe('degraded')
    expect(body.components.embeddings.errorMessage).toBe('onnx explosion')
  })
})

describe('computeOverallStatus', () => {
  it('prefers db error over everything', () => {
    const s = computeOverallStatus(
      10_000,
      { status: 'ready' },
      { status: 'ready' },
      { status: 'error' },
    )
    expect(s).toBe('degraded')
  })

  it('starting when within 500ms', () => {
    const s = computeOverallStatus(
      100,
      { status: 'idle' },
      { status: 'starting' },
      { status: 'ready' },
    )
    expect(s).toBe('starting')
  })
})

// P7 — meta-broker identity verification fields.
describe('buildProgressiveHealth (P7 identity fields)', () => {
  let db: Database.Database
  const original = { instance: process.env['SCNS_INSTANCE_ID'], project: process.env['BROKER_PROJECT_ID'] }

  beforeEach(() => {
    db = new Database(':memory:')
  })

  afterEach(() => {
    db.close()
    if (original.instance === undefined) delete process.env['SCNS_INSTANCE_ID']
    else process.env['SCNS_INSTANCE_ID'] = original.instance
    if (original.project === undefined) delete process.env['BROKER_PROJECT_ID']
    else process.env['BROKER_PROJECT_ID'] = original.project
  })

  it('echoes SCNS_INSTANCE_ID when set (meta-broker identity verification)', () => {
    process.env['SCNS_INSTANCE_ID'] = 'inst-abc-123'
    const now = Date.now()
    const body = buildProgressiveHealth({ db, startedAt: now - 10_000 }, now)
    expect(body.instance_id).toBe('inst-abc-123')
  })

  it('echoes BROKER_PROJECT_ID when set', () => {
    process.env['BROKER_PROJECT_ID'] = 'scns-deadbeef'
    const now = Date.now()
    const body = buildProgressiveHealth({ db, startedAt: now - 10_000 }, now)
    expect(body.project_id).toBe('scns-deadbeef')
  })

  it('omits both fields when env not set (single-broker default)', () => {
    delete process.env['SCNS_INSTANCE_ID']
    delete process.env['BROKER_PROJECT_ID']
    const now = Date.now()
    const body = buildProgressiveHealth({ db, startedAt: now - 10_000 }, now)
    expect(body.instance_id).toBeUndefined()
    expect(body.project_id).toBeUndefined()
  })
})
