import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { ZodError, z } from 'zod'
import { createErrorHandler } from '../../../../src/broker/middleware/error-handler.js'
import {
  BrokerError,
  ValidationError,
  NotFoundError,
  RateLimitError,
} from '../../../../src/broker/errors.js'

function mockLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function mockReqRes(path = '/api/test') {
  const req = { path } as Request
  const res = {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as unknown as Response
  const next = vi.fn() as NextFunction
  return { req, res, next }
}

describe('createErrorHandler', () => {
  it('returns a function with arity 4 (Express error handler signature)', () => {
    const handler = createErrorHandler(mockLogger())
    expect(typeof handler).toBe('function')
    expect(handler.length).toBe(4)
  })

  it('BrokerError returns correct statusCode + toJSON()', () => {
    const log = mockLogger()
    const handler = createErrorHandler(log)
    const { req, res, next } = mockReqRes()

    const err = new NotFoundError('Session', 'abc')
    handler(err, req, res, next)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: err.toJSON(),
    })
    expect(log.warn).toHaveBeenCalled()
  })

  it('ValidationError returns 400 + fields', () => {
    const log = mockLogger()
    const handler = createErrorHandler(log)
    const { req, res, next } = mockReqRes()

    const err = new ValidationError('Bad input', { name: 'required' })
    handler(err, req, res, next)

    expect(res.status).toHaveBeenCalledWith(400)
    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(jsonArg.success).toBe(false)
    expect(jsonArg.error.code).toBe('VALIDATION_ERROR')
    expect(jsonArg.error.fields).toEqual({ name: 'required' })
  })

  it('ZodError is wrapped as 400 ValidationError', () => {
    const log = mockLogger()
    const handler = createErrorHandler(log)
    const { req, res, next } = mockReqRes()

    const schema = z.object({ name: z.string() })
    let zodErr: ZodError | undefined
    try {
      schema.parse({ name: 123 })
    } catch (e) {
      zodErr = e as ZodError
    }

    handler(zodErr!, req, res, next)

    expect(res.status).toHaveBeenCalledWith(400)
    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(jsonArg.success).toBe(false)
    expect(jsonArg.error.code).toBe('VALIDATION_ERROR')
    expect(jsonArg.error.fields).toBeDefined()
  })

  it('RateLimitError sets Retry-After header', () => {
    const log = mockLogger()
    const handler = createErrorHandler(log)
    const { req, res, next } = mockReqRes()

    const err = new RateLimitError(60)
    handler(err, req, res, next)

    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60')
  })

  it('unknown error returns 500 + generic message', () => {
    const log = mockLogger()
    const handler = createErrorHandler(log)
    const { req, res, next } = mockReqRes()

    handler(new Error('oops'), req, res, next)

    expect(res.status).toHaveBeenCalledWith(500)
    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(jsonArg.success).toBe(false)
    expect(jsonArg.error.code).toBe('INTERNAL_ERROR')
    expect(jsonArg.error.message).toBe('Internal server error')
  })

  it('error is logged', () => {
    const log = mockLogger()
    const handler = createErrorHandler(log)
    const { req, res, next } = mockReqRes()

    handler(new BrokerError('test', 500, 'TEST'), req, res, next)
    expect(log.warn).toHaveBeenCalled()

    handler(new Error('unknown'), req, res, next)
    expect(log.error).toHaveBeenCalled()
  })

  it('delegates to next() if headers already sent', () => {
    const log = mockLogger()
    const handler = createErrorHandler(log)
    const { req, res, next } = mockReqRes()
    ;(res as Record<string, unknown>).headersSent = true

    const err = new Error('too late')
    handler(err, req, res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.status).not.toHaveBeenCalled()
  })

  it('SyntaxError from JSON parsing returns 400', () => {
    const log = mockLogger()
    const handler = createErrorHandler(log)
    const { req, res, next } = mockReqRes()

    const err = new SyntaxError('Unexpected token') as SyntaxError & { body: string }
    ;(err as Record<string, unknown>).body = 'bad json'
    handler(err, req, res, next)

    expect(res.status).toHaveBeenCalledWith(400)
    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(jsonArg.error).toContain('Invalid JSON')
  })
})
