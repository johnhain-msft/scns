/**
 * Sanitize pipeline — composes privacy filter + secret sanitizer.
 * Returns null if observation should be filtered, otherwise sanitized content.
 */

import type { createPrivacyFilter } from './privacy-filter.js'
import type { FilterContext } from './privacy-filter.js'
import type { createSecretSanitizer } from './secret-sanitizer.js'

export type { FilterContext }

export function createSanitizePipeline(
  filter: ReturnType<typeof createPrivacyFilter>,
  sanitizer: ReturnType<typeof createSecretSanitizer>,
) {
  return {
    process(context: FilterContext, content: string): string | null {
      if (filter.shouldFilter(context)) return null
      return sanitizer.sanitize(content)
    },
  }
}
