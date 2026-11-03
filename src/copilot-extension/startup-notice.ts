/** Last successfully delivered notice for a foreground-session activation. */
export interface StartupNoticeState {
  readonly version: 1
  readonly sessionId: string
  readonly activationId: string
  readonly message: string
  readonly level: string
}

export interface StartupNoticeDecision {
  readonly announce: boolean
  readonly next: StartupNoticeState
}

/**
 * Suppress an unchanged state, not every message ever seen in the conversation.
 * A ready -> failure -> ready transition must announce recovery. Activation IDs
 * come from the CLI lifecycle, not an elapsed-time estimate.
 */
export function decideStartupNotice(
  previous: unknown,
  sessionId: string,
  activationId: string,
  message: string,
  level = 'info',
): StartupNoticeDecision {
  const same =
    !!sessionId &&
    !!activationId &&
    typeof previous === 'object' &&
    previous !== null &&
    'version' in previous &&
    previous.version === 1 &&
    'sessionId' in previous &&
    previous.sessionId === sessionId &&
    'activationId' in previous &&
    previous.activationId === activationId &&
    'message' in previous &&
    previous.message === message &&
    'level' in previous &&
    previous.level === level
  return {
    announce: !same,
    next: { version: 1, sessionId, activationId, message, level },
  }
}

/** Standalone JavaScript, cross-checked against the TypeScript decision. */
export function startupNoticeRuntimeJs(): string {
  return `function decideStartupNotice(previous, sessionId, activationId, message, level = "info") {
  const same = !!sessionId && !!activationId &&
    typeof previous === "object" && previous !== null &&
    previous.version === 1 && previous.sessionId === sessionId &&
    previous.activationId === activationId && previous.message === message &&
    previous.level === level;
  return {
    announce: !same,
    next: { version: 1, sessionId, activationId, message, level },
  };
}`
}
