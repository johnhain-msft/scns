/**
 * WS-0 Safety Kernel — egress / spend signature classifiers (pure).
 *
 * These power the runtime gates (no-spend, egress-allowlist). They are
 * deliberately HEURISTIC and operate on the tool call's declared kind,
 * title, command, url and rawInput.
 *
 * ── HONEST LIMITATION (AWAITING-JOHN / L0 hardening, Option B) ──────────
 * Command-string egress detection is signature-based. A deliberately
 * obfuscated shell command (e.g. base64-decoding `curl` at runtime, or an
 * IP encoded in decimal) can DEFEAT this layer. Only an OS-level egress
 * jail around the spawned worktree process (deny-all outbound except an
 * allowlist) is truly UNBYPASSABLE. That jail is the scheduled L0 go-live
 * hardening item and is NOT implemented this cycle. Do not describe this
 * in-process layer as "unbypassable".
 *
 * SCOPING: the in-process gate targets explicit external-contact / exfil
 * verbs (curl, wget, nc, ssh, …) and paid-API hosts — the "reach out /
 * contact people / spend money" vectors John called out. It intentionally
 * does NOT block the package registry or git remotes (npm / git), which an
 * autopilot build legitimately needs; constraining those to an allowlist
 * is the OS-jail's job (L0), not an in-process block that would break the
 * build.
 */

export interface ToolView {
  readonly kind?: string
  readonly title?: string
  readonly command?: string
  readonly url?: string
  readonly rawInput?: unknown
}

/** External-contact / exfil command verbs (see SCOPING note above). */
export const NETWORK_VERBS: readonly string[] = [
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'ftp',
  'aria2c',
  'lynx',
  'links',
  'httpie',
]

/** Hosts that always classify as paid/billing spend. */
export const SPEND_HOST_SIGNATURES: readonly string[] = [
  'api.openai.com',
  'api.anthropic.com',
  'api.stripe.com',
  'api.cohere.ai',
  'api.cohere.com',
  'api.replicate.com',
  'api.mistral.ai',
  'generativelanguage.googleapis.com',
]

/** Keyword fragments (lowercased) that classify a tool call as spend. */
export const SPEND_KEYWORD_SIGNATURES: readonly string[] = [
  'stripe',
  'paypal',
  'payment_intent',
  'checkout.session',
  '/v1/charges',
  'braintreegateway',
]

const INTERNAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

/** Extract a candidate command string from the tool's command field or rawInput. */
export function extractCommand(tool: ToolView): string | null {
  if (typeof tool.command === 'string' && tool.command.trim()) return tool.command
  const ri = asRecord(tool.rawInput)
  if (ri) {
    for (const key of ['command', 'cmd', 'script', 'shellCommand']) {
      const v = ri[key]
      if (typeof v === 'string' && v.trim()) return v
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return (v as string[]).join(' ')
    }
  }
  return null
}

/** Extract a candidate URL from the url field, rawInput, or an embedded http(s) URL. */
export function extractUrl(tool: ToolView): string | null {
  if (typeof tool.url === 'string' && tool.url.trim()) return tool.url.trim()
  const ri = asRecord(tool.rawInput)
  if (ri) {
    for (const key of ['url', 'uri', 'endpoint', 'href']) {
      const v = ri[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  const haystacks = [extractCommand(tool), tool.title]
  for (const h of haystacks) {
    if (!h) continue
    const m = h.match(/https?:\/\/[^\s'"`)]+/i)
    if (m) return m[0]
  }
  return null
}

/** Parse a lowercase host from a URL or bare host, stripping scheme/port/path. */
export function hostOf(urlOrHost: string): string | null {
  if (!urlOrHost || !urlOrHost.trim()) return null
  let s = urlOrHost.trim()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // strip scheme://
  s = s.replace(/^[^@/]*@/, '') // strip userinfo@
  s = s.split(/[/?#]/)[0] ?? s // drop path/query/fragment
  // strip :port (but keep IPv6 bracket content / bare IPv6)
  if (s.startsWith('[')) {
    const end = s.indexOf(']')
    if (end !== -1) s = s.slice(1, end)
  } else {
    const colons = (s.match(/:/g) ?? []).length
    if (colons === 1) s = s.split(':')[0] ?? s // host:port
    // colons === 0 → plain host; colons > 1 → bare IPv6 (e.g. ::1), keep as-is
  }
  s = s.toLowerCase().trim()
  return s.length > 0 ? s : null
}

/** Is this URL/host the internal broker control-plane (loopback)? Decision B. */
export function isInternalControlPlane(urlOrHost: string): boolean {
  const host = hostOf(urlOrHost)
  return host !== null && INTERNAL_HOSTS.has(host)
}

function hasNetworkVerb(command: string): boolean {
  const lower = command.toLowerCase()
  return NETWORK_VERBS.some((v) => new RegExp(`(^|[^a-z0-9_-])${v}([^a-z0-9_-]|$)`, 'i').test(lower))
}

function mentionsInternalHost(command: string): boolean {
  return /(^|[^a-z0-9_.-])(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)([^a-z0-9_.-]|$)/i.test(command)
}

/** Does this tool call attempt outbound network egress to an EXTERNAL target? */
export function isEgressAttempt(tool: ToolView): boolean {
  const url = extractUrl(tool)
  if (url) return !isInternalControlPlane(url)
  if (tool.kind === 'fetch') return true // fetch with no resolvable target → unknown → fail-closed
  const cmd = extractCommand(tool)
  if (cmd && hasNetworkVerb(cmd)) return !mentionsInternalHost(cmd)
  return false
}

/** Does this tool call attempt a paid/billing/API-spend action? */
export function isSpendAttempt(tool: ToolView): boolean {
  const url = extractUrl(tool)
  const host = url ? hostOf(url) : null
  if (host && SPEND_HOST_SIGNATURES.includes(host)) return true
  const hay = `${extractCommand(tool) ?? ''} ${url ?? ''} ${tool.title ?? ''}`.toLowerCase()
  return SPEND_KEYWORD_SIGNATURES.some((k) => hay.includes(k))
}
