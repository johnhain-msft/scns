import { describe, it, expect } from 'vitest'
import {
  BrokerError,
  ValidationError,
  NotFoundError,
  ConflictError,
  AuthError,
  RateLimitError,
  InternalError,
} from '../../../src/broker/errors.js'

describe('BrokerError hierarchy', () => {
  describe('BrokerError (base)', () => {
    it('carries statusCode, errorCode, message', () => {
      const err = new BrokerError('boom', 500, 'TEST_ERR')
      expect(err.message).toBe('boom')
      expect(err.statusCode).toBe(500)
      expect(err.errorCode).toBe('TEST_ERR')
      expect(err.name).toBe('BrokerError')
    })

    it('defaults retryable to false', () => {
      const err = new BrokerError('no', 400, 'X')
      expect(err.retryable).toBe(false)
      expect(err.retryAfterMs).toBeNull()
      expect(err.isRetryable()).toBe(false)
    })

    it('accepts retryable options', () => {
      const err = new BrokerError('yes', 500, 'X', { retryable: true, retryAfterMs: 2000 })
      expect(err.isRetryable()).toBe(true)
      expect(err.retryAfterMs).toBe(2000)
    })

    it('instanceof Error', () => {
      const err = new BrokerError('test', 500, 'X')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(BrokerError)
    })

    it('toJSON() omits retryable when false', () => {
      const json = new BrokerError('test', 400, 'T').toJSON()
      expect(json).toEqual({ code: 'T', message: 'test' })
      expect(json).not.toHaveProperty('retryable')
    })

    it('toJSON() includes retryable and retryAfterMs when set', () => {
      const json = new BrokerError('r', 500, 'R', { retryable: true, retryAfterMs: 1000 }).toJSON()
      expect(json.retryable).toBe(true)
      expect(json.retryAfterMs).toBe(1000)
    })
  })

  describe('ValidationError (400)', () => {
    it('has statusCode 400 and VALIDATION_ERROR code', () => {
      const err = new ValidationError('bad input')
      expect(err.statusCode).toBe(400)
      expect(err.errorCode).toBe('VALIDATION_ERROR')
      expect(err.name).toBe('ValidationError')
      expect(err).toBeInstanceOf(BrokerError)
    })

    it('includes fields in toJSON when present', () => {
      const err = new ValidationError('bad', { name: 'too short' })
      const json = err.toJSON()
      expect(json.fields).toEqual({ name: 'too short' })
    })

    it('omits fields in toJSON when empty', () => {
      const err = new ValidationError('bad')
      const json = err.toJSON()
      expect(json).not.toHaveProperty('fields')
    })

    it('freezes fields', () => {
      const err = new ValidationError('bad', { x: 'y' })
      expect(Object.isFrozen(err.fields)).toBe(true)
    })
  })

  describe('NotFoundError (404)', () => {
    it('formats message with resource + id', () => {
      const err = new NotFoundError('Session', 'abc')
      expect(err.message).toBe("Session 'abc' not found")
      expect(err.statusCode).toBe(404)
      expect(err.errorCode).toBe('NOT_FOUND')
      expect(err.resource).toBe('Session')
    })

    it('formats message without id', () => {
      const err = new NotFoundError('Team')
      expect(err.message).toBe('Team not found')
    })
  })

  describe('ConflictError (409)', () => {
    it('has statusCode 409', () => {
      const err = new ConflictError('already exists')
      expect(err.statusCode).toBe(409)
      expect(err.errorCode).toBe('CONFLICT')
      expect(err.name).toBe('ConflictError')
    })
  })

  describe('AuthError (401)', () => {
    it('defaults message to Authentication required', () => {
      const err = new AuthError()
      expect(err.message).toBe('Authentication required')
      expect(err.statusCode).toBe(401)
      expect(err.errorCode).toBe('AUTH_ERROR')
    })

    it('accepts custom message', () => {
      const err = new AuthError('token expired')
      expect(err.message).toBe('token expired')
    })
  })

  describe('RateLimitError (429)', () => {
    it('is retryable with correct retryAfterMs', () => {
      const err = new RateLimitError(30)
      expect(err.statusCode).toBe(429)
      expect(err.errorCode).toBe('RATE_LIMITED')
      expect(err.isRetryable()).toBe(true)
      expect(err.retryAfterSeconds).toBe(30)
      expect(err.retryAfterMs).toBe(30_000)
    })

    it('toJSON includes retryAfterSeconds', () => {
      const json = new RateLimitError(60).toJSON()
      expect(json.retryAfterSeconds).toBe(60)
      expect(json.retryable).toBe(true)
    })
  })

  describe('InternalError (500)', () => {
    it('defaults message and is retryable', () => {
      const err = new InternalError()
      expect(err.message).toBe('Internal server error')
      expect(err.statusCode).toBe(500)
      expect(err.isRetryable()).toBe(true)
      expect(err.retryAfterMs).toBe(1000)
    })

    it('accepts custom message and retryAfterMs', () => {
      const err = new InternalError('db locked', 5000)
      expect(err.message).toBe('db locked')
      expect(err.retryAfterMs).toBe(5000)
    })
  })
})
