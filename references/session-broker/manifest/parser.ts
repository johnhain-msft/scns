import { parse as parseYaml } from 'yaml'
import { TeamManifestSchema, type TeamManifest } from './schema.js'
import { ZodError } from 'zod'

export interface ParseSuccess {
  readonly ok: true
  readonly manifest: TeamManifest
}

export interface ParseFailure {
  readonly ok: false
  readonly errors: readonly string[]
}

export type ParseResult = ParseSuccess | ParseFailure

export function parseManifest(yamlString: string): ParseResult {
  let raw: unknown
  try {
    raw = parseYaml(yamlString)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, errors: [`YAML parse error: ${message}`] }
  }

  try {
    const manifest = TeamManifestSchema.parse(raw)
    return { ok: true, manifest }
  } catch (err) {
    if (err instanceof ZodError) {
      const errors = err.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      )
      return { ok: false, errors }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, errors: [`Validation error: ${message}`] }
  }
}
