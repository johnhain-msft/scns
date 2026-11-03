/**
 * MEMORY.md size enforcement — keeps entrypoint within claurst spec limits.
 */

export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000 // 25KB

export interface TruncateResult {
  readonly content: string
  readonly truncated: boolean
  readonly warning: string | null
}

/** Count lines: newlines + 1. Empty string = 0. */
export function countLines(content: string): number {
  if (content === '') return 0
  // Strip trailing newline before counting
  const stripped = content.endsWith('\n') ? content.slice(0, -1) : content
  if (stripped === '') return 0
  return stripped.split('\n').length
}

/** UTF-8 byte count. */
export function countBytes(content: string): number {
  return Buffer.byteLength(content, 'utf-8')
}

/**
 * Truncate entrypoint content to stay within line and byte limits.
 * Warning line is appended but does NOT count toward the limits.
 */
export function truncateEntrypoint(content: string): TruncateResult {
  if (content === '') {
    return { content: '', truncated: false, warning: null }
  }

  const overLines = countLines(content) > MAX_ENTRYPOINT_LINES
  const overBytes = countBytes(content) > MAX_ENTRYPOINT_BYTES

  if (!overLines && !overBytes) {
    return { content, truncated: false, warning: null }
  }

  let result = content
  let hitLines = false
  let hitBytes = false

  // Apply line limit first
  if (overLines) {
    const lines = result.split('\n')
    result = lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    hitLines = true
  }

  // Apply byte limit
  if (countBytes(result) > MAX_ENTRYPOINT_BYTES) {
    result = truncateToByteLimit(result)
    hitBytes = true
  }

  const cap = hitLines && hitBytes ? 'lines and bytes' : hitLines ? 'lines' : 'bytes'
  const warning = `<!-- Truncated: exceeded ${cap} limit -->`

  return {
    content: result + '\n' + warning,
    truncated: true,
    warning,
  }
}

/** Truncate string to MAX_ENTRYPOINT_BYTES at last newline boundary, or hard-cut if single line. */
function truncateToByteLimit(content: string): string {
  const buf = Buffer.from(content, 'utf-8')
  const sliced = buf.subarray(0, MAX_ENTRYPOINT_BYTES)
  let str = sliced.toString('utf-8')

  // Find last newline to cut at a clean boundary
  const lastNl = str.lastIndexOf('\n')
  if (lastNl > 0) {
    str = str.slice(0, lastNl)
  } else {
    // Single line or no newline — hard-cut at byte limit
    // Re-encode to ensure we don't split a multi-byte char
    str = Buffer.from(content, 'utf-8').subarray(0, MAX_ENTRYPOINT_BYTES).toString('utf-8')
    // Remove trailing replacement char if we split a multi-byte sequence
    if (str.endsWith('\uFFFD')) {
      str = str.slice(0, -1)
    }
  }

  return str
}
