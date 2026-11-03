import { describe, it, expect } from 'vitest'
import {
  JsonRpcVersion,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  JsonRpcErrorSchema,
  JsonRpcNotificationSchema,
  JsonRpcErrorCode,
  createRequest,
  createResponse,
  createError,
  createNotification,
  isRequest,
  isResponse,
  isError,
  isNotification,
} from '../../../../src/broker/a2a/jsonrpc.js'

describe('JsonRpcVersion', () => {
  it('is "2.0"', () => {
    expect(JsonRpcVersion).toBe('2.0')
  })
})

describe('JsonRpcRequestSchema', () => {
  it('validates a correct request', () => {
    const req = JsonRpcRequestSchema.parse({
      jsonrpc: '2.0',
      method: 'tasks/send',
      params: { taskId: '123' },
      id: 1,
    })
    expect(req.method).toBe('tasks/send')
    expect(req.id).toBe(1)
  })

  it('rejects missing jsonrpc', () => {
    expect(() => JsonRpcRequestSchema.parse({ method: 'test', id: 1 })).toThrow()
  })

  it('rejects wrong jsonrpc version', () => {
    expect(() => JsonRpcRequestSchema.parse({ jsonrpc: '1.0', method: 'test', id: 1 })).toThrow()
  })

  it('rejects missing method', () => {
    expect(() => JsonRpcRequestSchema.parse({ jsonrpc: '2.0', id: 1 })).toThrow()
  })

  it('rejects empty method', () => {
    expect(() => JsonRpcRequestSchema.parse({ jsonrpc: '2.0', method: '', id: 1 })).toThrow()
  })

  it('accepts string id', () => {
    const req = JsonRpcRequestSchema.parse({
      jsonrpc: '2.0',
      method: 'test',
      id: 'abc-123',
    })
    expect(req.id).toBe('abc-123')
  })

  it('accepts number id', () => {
    const req = JsonRpcRequestSchema.parse({
      jsonrpc: '2.0',
      method: 'test',
      id: 42,
    })
    expect(req.id).toBe(42)
  })

  it('accepts params as object', () => {
    const req = JsonRpcRequestSchema.parse({
      jsonrpc: '2.0',
      method: 'test',
      params: { key: 'value' },
      id: 1,
    })
    expect(req.params).toEqual({ key: 'value' })
  })

  it('accepts params as array', () => {
    const req = JsonRpcRequestSchema.parse({
      jsonrpc: '2.0',
      method: 'test',
      params: [1, 'two', true],
      id: 1,
    })
    expect(req.params).toEqual([1, 'two', true])
  })

  it('allows omitted params', () => {
    const req = JsonRpcRequestSchema.parse({
      jsonrpc: '2.0',
      method: 'test',
      id: 1,
    })
    expect(req.params).toBeUndefined()
  })
})

describe('JsonRpcResponseSchema', () => {
  it('validates a correct response', () => {
    const res = JsonRpcResponseSchema.parse({
      jsonrpc: '2.0',
      result: { status: 'ok' },
      id: 1,
    })
    expect(res.result).toEqual({ status: 'ok' })
  })

  it('accepts null id', () => {
    const res = JsonRpcResponseSchema.parse({
      jsonrpc: '2.0',
      result: 'done',
      id: null,
    })
    expect(res.id).toBeNull()
  })
})

describe('JsonRpcErrorSchema', () => {
  it('validates a correct error response', () => {
    const err = JsonRpcErrorSchema.parse({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid Request' },
      id: null,
    })
    expect(err.error.code).toBe(-32600)
  })

  it('validates error with data field', () => {
    const err = JsonRpcErrorSchema.parse({
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Invalid params', data: { field: 'name' } },
      id: 1,
    })
    expect(err.error.data).toEqual({ field: 'name' })
  })
})

describe('JsonRpcNotificationSchema', () => {
  it('validates a correct notification', () => {
    const notif = JsonRpcNotificationSchema.parse({
      jsonrpc: '2.0',
      method: 'tasks/statusUpdate',
      params: { taskId: '1', status: 'completed' },
    })
    expect(notif.method).toBe('tasks/statusUpdate')
  })

  it('allows omitted params', () => {
    const notif = JsonRpcNotificationSchema.parse({
      jsonrpc: '2.0',
      method: 'heartbeat',
    })
    expect(notif.params).toBeUndefined()
  })
})

describe('JsonRpcErrorCode', () => {
  it('has correct standard error codes', () => {
    expect(JsonRpcErrorCode.ParseError).toBe(-32700)
    expect(JsonRpcErrorCode.InvalidRequest).toBe(-32600)
    expect(JsonRpcErrorCode.MethodNotFound).toBe(-32601)
    expect(JsonRpcErrorCode.InvalidParams).toBe(-32602)
    expect(JsonRpcErrorCode.InternalError).toBe(-32603)
  })

  it('has correct A2A custom error codes', () => {
    expect(JsonRpcErrorCode.TaskNotFound).toBe(-32000)
    expect(JsonRpcErrorCode.TaskAlreadyCompleted).toBe(-32001)
    expect(JsonRpcErrorCode.AgentNotFound).toBe(-32002)
    expect(JsonRpcErrorCode.RateLimited).toBe(-32003)
  })
})

describe('helper builders', () => {
  it('createRequest produces valid JSON-RPC 2.0 request', () => {
    const req = createRequest('tasks/send', { task: 'do it' }, 'req-1')
    expect(req.jsonrpc).toBe('2.0')
    expect(req.method).toBe('tasks/send')
    expect(req.params).toEqual({ task: 'do it' })
    expect(req.id).toBe('req-1')
    expect(() => JsonRpcRequestSchema.parse(req)).not.toThrow()
  })

  it('createResponse produces valid response', () => {
    const res = createResponse({ status: 'ok' }, 1)
    expect(res.jsonrpc).toBe('2.0')
    expect(res.result).toEqual({ status: 'ok' })
    expect(res.id).toBe(1)
    expect(() => JsonRpcResponseSchema.parse(res)).not.toThrow()
  })

  it('createError produces valid error', () => {
    const err = createError(-32600, 'Invalid Request', 1)
    expect(err.jsonrpc).toBe('2.0')
    expect(err.error.code).toBe(-32600)
    expect(err.error.message).toBe('Invalid Request')
    expect(err.id).toBe(1)
    expect(() => JsonRpcErrorSchema.parse(err)).not.toThrow()
  })

  it('createError accepts optional data', () => {
    const err = createError(-32602, 'Invalid params', 1, { field: 'name' })
    expect(err.error.data).toEqual({ field: 'name' })
  })

  it('createNotification produces valid notification (no id)', () => {
    const notif = createNotification('heartbeat', { ts: 123 })
    expect(notif.jsonrpc).toBe('2.0')
    expect(notif.method).toBe('heartbeat')
    expect(notif.params).toEqual({ ts: 123 })
    expect(notif).not.toHaveProperty('id')
    expect(() => JsonRpcNotificationSchema.parse(notif)).not.toThrow()
  })

  it('createNotification works without params', () => {
    const notif = createNotification('ping')
    expect(notif.params).toBeUndefined()
  })
})

describe('type guards', () => {
  const req = createRequest('test', {}, 1)
  const res = createResponse('ok', 1)
  const err = createError(-32600, 'bad', 1)
  const notif = createNotification('ping')

  it('isRequest returns true for requests', () => {
    expect(isRequest(req)).toBe(true)
  })

  it('isRequest returns false for responses', () => {
    expect(isRequest(res)).toBe(false)
  })

  it('isRequest returns false for errors', () => {
    expect(isRequest(err)).toBe(false)
  })

  it('isRequest returns false for non-objects', () => {
    expect(isRequest(null)).toBe(false)
    expect(isRequest(42)).toBe(false)
    expect(isRequest('string')).toBe(false)
  })

  it('isResponse returns true for responses', () => {
    expect(isResponse(res)).toBe(true)
  })

  it('isResponse returns false for requests', () => {
    expect(isResponse(req)).toBe(false)
  })

  it('isError returns true for errors', () => {
    expect(isError(err)).toBe(true)
  })

  it('isError returns false for responses', () => {
    expect(isError(res)).toBe(false)
  })

  it('isNotification returns true for notifications', () => {
    expect(isNotification(notif)).toBe(true)
  })

  it('isNotification returns false for requests (has id)', () => {
    expect(isNotification(req)).toBe(false)
  })
})
