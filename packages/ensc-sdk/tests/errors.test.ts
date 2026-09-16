import { describe, expect, it } from 'vitest';
import {
  EnscError,
  isClientError,
  isEnscError,
  isEnscErrorCode,
  isEnscErrorResponse,
  isServerError,
} from '../src/index.js';

describe('EnscError', () => {
  it('exposes code, status, message, and details', () => {
    const err = new EnscError('ENSC_INVALID_CHAIN', 'bad chain', { slug: 'nope' });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('ENSC_INVALID_CHAIN');
    expect(err.status).toBe(400);
    expect(err.message).toBe('bad chain');
    expect(err.details).toEqual({ slug: 'nope' });
  });

  it('derives status from the code (5xx example)', () => {
    expect(new EnscError('ENSC_INTERNAL', 'boom').status).toBe(500);
    expect(new EnscError('ENSC_RATE_LIMITED', 'slow down').status).toBe(429);
    expect(new EnscError('ENSC_NOT_FOUND', 'gone').status).toBe(404);
  });

  it('serializes via toJSON with the API error envelope shape', () => {
    const body = new EnscError('ENSC_NOT_FOUND', 'gone').toJSON('req_123');
    expect(body).toEqual({
      error: { code: 'ENSC_NOT_FOUND', message: 'gone', requestId: 'req_123' },
    });
  });
});

describe('isEnscError', () => {
  it('is true for an EnscError', () => {
    expect(isEnscError(new EnscError('ENSC_INTERNAL', 'x'))).toBe(true);
  });

  it('is false for a plain Error and for non-errors', () => {
    expect(isEnscError(new Error('plain'))).toBe(false);
    expect(isEnscError('a string')).toBe(false);
    expect(isEnscError(null)).toBe(false);
    expect(isEnscError(undefined)).toBe(false);
  });
});

describe('isEnscErrorCode', () => {
  it('matches the specific code', () => {
    const err = new EnscError('ENSC_MINT_LIMIT_EXCEEDED', 'too much');
    expect(isEnscErrorCode(err, 'ENSC_MINT_LIMIT_EXCEEDED')).toBe(true);
    expect(isEnscErrorCode(err, 'ENSC_RATE_LIMITED')).toBe(false);
  });

  it('is false for non-EnscError values', () => {
    expect(isEnscErrorCode(new Error('x'), 'ENSC_INTERNAL')).toBe(false);
  });
});

describe('isClientError / isServerError', () => {
  it('classifies 4xx as client errors', () => {
    const e = new EnscError('ENSC_VALIDATION_FAILED', 'bad'); // 400
    expect(isClientError(e)).toBe(true);
    expect(isServerError(e)).toBe(false);
  });

  it('classifies 5xx as server errors', () => {
    const e = new EnscError('ENSC_DB_UNAVAILABLE', 'down'); // 503
    expect(isServerError(e)).toBe(true);
    expect(isClientError(e)).toBe(false);
  });

  it('both are false for non-EnscError values', () => {
    expect(isClientError(new Error('x'))).toBe(false);
    expect(isServerError(new Error('x'))).toBe(false);
  });
});

describe('isEnscErrorResponse', () => {
  it('recognizes the API error envelope', () => {
    expect(isEnscErrorResponse({ error: { code: 'ENSC_NOT_FOUND', message: 'gone' } })).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isEnscErrorResponse({ error: { message: 'no code' } })).toBe(false);
    expect(isEnscErrorResponse({ notError: true })).toBe(false);
    expect(isEnscErrorResponse(null)).toBe(false);
    expect(isEnscErrorResponse('string')).toBe(false);
  });
});
