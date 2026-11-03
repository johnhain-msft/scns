import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  base: { service: 'session-broker' },
})

/** Create a child logger scoped to a specific HTTP request. */
export function createRequestLogger(requestId: string): pino.Logger {
  return logger.child({ requestId })
}

/** Create a child logger scoped to a specific session. */
export function createSessionLogger(sessionId: string): pino.Logger {
  return logger.child({ sessionId })
}

/** Create a child logger scoped to a specific team. */
export function createTeamLogger(teamId: string): pino.Logger {
  return logger.child({ teamId })
}
