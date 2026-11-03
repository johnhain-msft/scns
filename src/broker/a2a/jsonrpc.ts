import { z } from 'zod'

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 protocol primitives
// ---------------------------------------------------------------------------

export const JsonRpcVersion = '2.0' as const

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional(),
  id: z.union([z.string(), z.number()]),
})
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  result: z.unknown(),
  id: z.union([z.string(), z.number(), z.null()]),
})
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>

export const JsonRpcErrorSchema = z.object({
  jsonrpc: z.literal('2.0'),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
  id: z.union([z.string(), z.number(), z.null()]),
})
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional(),
})
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>

// ---------------------------------------------------------------------------
// Standard + A2A error codes
// ---------------------------------------------------------------------------

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // A2A custom codes
  TaskNotFound: -32000,
  TaskAlreadyCompleted: -32001,
  AgentNotFound: -32002,
  RateLimited: -32003,
} as const

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------

export function createRequest(
  method: string,
  params: unknown,
  id: string | number,
): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    method,
    params: params as Record<string, unknown>,
    id,
  }
}

export function createResponse(result: unknown, id: string | number | null): JsonRpcResponse {
  return { jsonrpc: '2.0', result, id }
}

export function createError(
  code: number,
  message: string,
  id: string | number | null,
  data?: unknown,
): JsonRpcError {
  const error: { code: number; message: string; data?: unknown } = { code, message }
  if (data !== undefined) {
    error.data = data
  }
  return { jsonrpc: '2.0', error, id }
}

export function createNotification(method: string, params?: unknown): JsonRpcNotification {
  const msg: JsonRpcNotification = { jsonrpc: '2.0', method }
  if (params !== undefined) {
    return { ...msg, params: params as Record<string, unknown> }
  }
  return msg
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null
}

export function isRequest(msg: unknown): msg is JsonRpcRequest {
  if (!isObject(msg)) return false
  return (
    msg['jsonrpc'] === '2.0' &&
    typeof msg['method'] === 'string' &&
    'id' in msg &&
    !('error' in msg) &&
    !('result' in msg)
  )
}

export function isResponse(msg: unknown): msg is JsonRpcResponse {
  if (!isObject(msg)) return false
  return msg['jsonrpc'] === '2.0' && 'result' in msg && 'id' in msg
}

export function isError(msg: unknown): msg is JsonRpcError {
  if (!isObject(msg)) return false
  return msg['jsonrpc'] === '2.0' && 'error' in msg && isObject(msg['error'])
}

export function isNotification(msg: unknown): msg is JsonRpcNotification {
  if (!isObject(msg)) return false
  return msg['jsonrpc'] === '2.0' && typeof msg['method'] === 'string' && !('id' in msg)
}
