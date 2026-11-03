// Session Broker — Phase 2

// Errors
export {
  BrokerError,
  ValidationError,
  NotFoundError,
  ConflictError,
  AuthError,
  RateLimitError,
  InternalError,
} from './errors.js'
export type { BrokerErrorJSON, BrokerErrorOptions } from './errors.js'

// Types
export {
  SessionStatus,
  IntentType,
  SessionSchema,
  MessageSchema,
  FileIntentSchema,
  SharedStateEntrySchema,
  EventSchema,
  TeamStatus,
  TeamRole,
  MemberStatus,
  TaskStatus,
  TeamSchema,
  TeamMemberSchema,
  TaskSchema,
  BackgroundTaskSchema,
  GateFailureReason,
} from './types.js'
export type {
  Session,
  Message,
  FileIntent,
  SharedStateEntry,
  Event,
  Team,
  TeamMember,
  Task,
  TaskWithDeps,
  BackgroundTask,
  GateResult,
  GateCheckResult,
  TaskGateConfig,
} from './types.js'

// Config
export { loadConfig, ensureDbDirectory } from './config.js'
export type { BrokerConfig } from './config.js'

// Schemas (request validation)
export {
  RegisterSessionSchema,
  CreateTeamSchema,
  SendMessageSchema,
  DeclareIntentSchema,
  HeartbeatSchema,
  JoinTeamSchema,
} from './schemas.js'

// Storage
export { openDatabase, closeDatabase } from './storage/db.js'

// Middleware
export { createErrorHandler } from './middleware/error-handler.js'
export { createAuthMiddleware } from './middleware/auth.js'
export { createGlobalLimiter } from './middleware/rate-limiter.js'
export type { RateLimiterOptions } from './middleware/rate-limiter.js'

// Routes
export { registerRoutes } from './routes/index.js'

// Server
export { createBrokerServer } from './server.js'
export type { BrokerServer, BrokerServerOptions } from './server.js'

// Startup
export { startBroker } from './startup.js'
export type { BrokerHandle } from './startup.js'

// MCP Tools
export { registerTools } from './tools/register-tools.js'
