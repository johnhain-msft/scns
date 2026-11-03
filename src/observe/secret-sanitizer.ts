/**
 * Secret sanitizer — detects and redacts sensitive data from text.
 */

export type SecretType =
  | 'api-key'
  | 'bearer-token'
  | 'aws-key'
  | 'github-token'
  | 'slack-token'
  | 'ssh-key'
  | 'password-assignment'
  | 'generic-secret'
  | 'env-var-secret'
  | 'jwt'
  | 'custom'

export interface SecretDetection {
  readonly type: SecretType
  readonly index: number
  readonly length: number
}

export interface SanitizeOptions {
  readonly replacement?: string
  readonly extraPatterns?: readonly RegExp[]
}

interface SecretPattern {
  readonly type: SecretType
  readonly pattern: RegExp
}

const BUILTIN_PATTERNS: readonly SecretPattern[] = [
  // SSH private keys (multiline — must precede shorter patterns)
  {
    type: 'ssh-key',
    pattern:
      /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE KEY-----/g,
  },
  // JWT tokens
  {
    type: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
  },
  // Bearer tokens
  {
    type: 'bearer-token',
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  },
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  {
    type: 'github-token',
    pattern: /gh[pousr]_[A-Za-z0-9]{36}/g,
  },
  // AWS access key IDs
  { type: 'aws-key', pattern: /AKIA[A-Z0-9]{16}/g },
  // AWS secret access key assignments
  {
    type: 'aws-key',
    pattern: /aws_secret_access_key\s*[:=]\s*\S+/gi,
  },
  // Slack tokens
  {
    type: 'slack-token',
    pattern: /xox[bpsa]-[A-Za-z0-9-]+/g,
  },
  // API keys with prefixes (sk-, pk-, sk_live_, sk_test_)
  {
    type: 'api-key',
    pattern: /(?:sk|pk)-[A-Za-z0-9]{20,}|sk_(?:live|test)_[A-Za-z0-9]+/g,
  },
  // Azure SharedAccessKey
  {
    type: 'api-key',
    pattern: /SharedAccessKey=[A-Za-z0-9+/=]+/g,
  },
  // Env var secret exports
  {
    type: 'env-var-secret',
    pattern: /export\s+(?:SECRET|TOKEN|KEY|PASSWORD|API_KEY)\w*=\S+/g,
  },
  // Password / secret / passwd assignments
  {
    type: 'password-assignment',
    pattern: /(?:password|passwd|secret)\s*[:=]\s*\S+/gi,
  },
  // Connection strings with credentials
  {
    type: 'generic-secret',
    pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:\s]+:[^@\s]+@[^\s]+/g,
  },
  // Generic hex secrets (32+ hex chars)
  {
    type: 'generic-secret',
    pattern: /\b[0-9a-fA-F]{32,}\b/g,
  },
]

/** Collect non-overlapping matches sorted by position. */
function findAllMatches(text: string, patterns: readonly SecretPattern[]): SecretDetection[] {
  const raw: SecretDetection[] = []

  for (const { type, pattern } of patterns) {
    const re = new RegExp(pattern.source, pattern.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      raw.push({ type, index: m.index, length: m[0].length })
    }
  }

  raw.sort((a, b) => a.index - b.index || b.length - a.length)

  // Remove overlapping matches (keep earliest, longest)
  const result: SecretDetection[] = []
  let end = 0
  for (const d of raw) {
    if (d.index >= end) {
      result.push(d)
      end = d.index + d.length
    }
  }
  return result
}

/** Create a secret sanitizer. */
export function createSecretSanitizer(options?: SanitizeOptions) {
  const replacement = options?.replacement ?? '[REDACTED]'

  const allPatterns: readonly SecretPattern[] = options?.extraPatterns
    ? [
        ...BUILTIN_PATTERNS,
        ...options.extraPatterns.map((p): SecretPattern => ({ type: 'custom', pattern: p })),
      ]
    : BUILTIN_PATTERNS

  function sanitize(text: string): string {
    if (!text) return text
    const matches = findAllMatches(text, allPatterns)
    if (matches.length === 0) return text

    let result = text
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i]!
      result = result.slice(0, m.index) + replacement + result.slice(m.index + m.length)
    }
    return result
  }

  function containsSecrets(text: string): boolean {
    if (!text) return false
    return allPatterns.some(({ pattern }) => {
      const re = new RegExp(pattern.source, pattern.flags)
      return re.test(text)
    })
  }

  function detectSecrets(text: string): SecretDetection[] {
    if (!text) return []
    return findAllMatches(text, allPatterns)
  }

  return { sanitize, containsSecrets, detectSecrets }
}
