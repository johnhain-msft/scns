/**
 * Input sanitization utilities.
 */

/** Escape markdown special characters in untrusted text */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&')
}

/** Strip potential prompt injection patterns */
export function sanitizeExternalText(text: string): string {
  return text
    .replace(/<system[^>]*>/gi, '')
    .replace(/<\/system[^>]*>/gi, '')
    .replace(/<assistant[^>]*>/gi, '')
    .replace(/<\/assistant[^>]*>/gi, '')
}
