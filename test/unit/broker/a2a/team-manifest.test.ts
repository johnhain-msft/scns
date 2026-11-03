import { describe, it, expect } from 'vitest'
import { TeamManifestSchema, RoleSlotSchema } from '../../../../src/broker/a2a/team-manifest.js'

describe('RoleSlotSchema', () => {
  it('validates a correct role slot', () => {
    const slot = RoleSlotSchema.parse({ role: 'researcher' })
    expect(slot.role).toBe('researcher')
  })

  it('defaults count to 1', () => {
    const slot = RoleSlotSchema.parse({ role: 'implementer' })
    expect(slot.count).toBe(1)
  })

  it('defaults capabilities to empty array', () => {
    const slot = RoleSlotSchema.parse({ role: 'tester' })
    expect(slot.capabilities).toEqual([])
  })

  it('accepts optional templateId', () => {
    const slot = RoleSlotSchema.parse({ role: 'reviewer', templateId: 'custom-tmpl' })
    expect(slot.templateId).toBe('custom-tmpl')
  })

  it('rejects count less than 1', () => {
    expect(() => RoleSlotSchema.parse({ role: 'tester', count: 0 })).toThrow()
  })
})

describe('TeamManifestSchema', () => {
  const validManifest = {
    id: 'team-1',
    name: 'Test Team',
    description: 'A test team',
    roles: [{ role: 'researcher', count: 2 }],
  }

  it('validates a correct manifest', () => {
    const manifest = TeamManifestSchema.parse(validManifest)
    expect(manifest.id).toBe('team-1')
    expect(manifest.name).toBe('Test Team')
    expect(manifest.roles).toHaveLength(1)
  })

  it('rejects empty roles array', () => {
    expect(() => TeamManifestSchema.parse({ ...validManifest, roles: [] })).toThrow()
  })

  it('defaults strategy to parallel', () => {
    const manifest = TeamManifestSchema.parse(validManifest)
    expect(manifest.strategy).toBe('parallel')
  })

  it('defaults maxConcurrent to 5', () => {
    const manifest = TeamManifestSchema.parse(validManifest)
    expect(manifest.maxConcurrent).toBe(5)
  })

  it('accepts phases with gate conditions', () => {
    const manifest = TeamManifestSchema.parse({
      ...validManifest,
      phases: [{ name: 'research', roles: ['researcher'], gateCondition: 'any-complete' }],
    })
    expect(manifest.phases![0]!.gateCondition).toBe('any-complete')
  })

  it('defaults phase gate condition to all-complete', () => {
    const manifest = TeamManifestSchema.parse({
      ...validManifest,
      phases: [{ name: 'research', roles: ['researcher'] }],
    })
    expect(manifest.phases![0]!.gateCondition).toBe('all-complete')
  })

  it('phases are optional', () => {
    const manifest = TeamManifestSchema.parse(validManifest)
    expect(manifest.phases).toBeUndefined()
  })
})
