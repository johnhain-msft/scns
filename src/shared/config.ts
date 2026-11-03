import { z } from 'zod'

export const ScnsConfigSchema = z.object({
  port: z.number().default(3456),
  logLevel: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  dataDir: z.string().default('~/.scns'),
  maxConcurrentSessions: z.number().default(3),
  yieldToUser: z.boolean().default(true),
})

export type ScnsConfig = z.infer<typeof ScnsConfigSchema>
