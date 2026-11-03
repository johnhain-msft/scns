import pino from 'pino'

export const logger = pino({
  name: 'scns',
  level: process.env['SCNS_LOG_LEVEL'] ?? 'info',
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})

export type Logger = pino.Logger
