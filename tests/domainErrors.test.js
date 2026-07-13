import { describe, it, expect, vi } from 'vitest';
import {
  DomainError, ValidationError, NotFoundError, UnauthorizedError,
  ForbiddenError, ConflictError, InsufficientBalanceError, RiskLimitError,
  RateLimitError, UpstreamServiceError, expressErrorHandler,
} from '../server/domain/errors.js';

describe('domainErrors', () => {
  it('DomainError defaults to status 500 / code DOMAIN_ERROR', () => {
    const e = new DomainError('boom');
    expect(e.status).toBe(500);
    expect(e.code).toBe('DOMAIN_ERROR');
    expect(e).toBeInstanceOf(Error);
  });

  it('each subclass carries its expected status/code', () => {
    expect(new ValidationError().status).toBe(400);
    expect(new ValidationError().code).toBe('VALIDATION_ERROR');
    expect(new NotFoundError().status).toBe(404);
    expect(new UnauthorizedError().status).toBe(401);
    expect(new ForbiddenError().status).toBe(403);
    expect(new ConflictError().status).toBe(409);
    expect(new InsufficientBalanceError().status).toBe(422);
    expect(new InsufficientBalanceError().code).toBe('INSUFFICIENT_BALANCE');
    expect(new RiskLimitError().status).toBe(422);
    expect(new RiskLimitError().code).toBe('RISK_LIMIT_EXCEEDED');
    expect(new RateLimitError().status).toBe(429);
    expect(new UpstreamServiceError().status).toBe(503);
  });

  it('toResponse() includes details only when provided', () => {
    const withDetails = new ValidationError('bad field', { field: 'amount' });
    expect(withDetails.toResponse()).toEqual({
      ok: false, error: 'bad field', code: 'VALIDATION_ERROR', details: { field: 'amount' },
    });

    const noDetails = new NotFoundError('missing');
    expect(noDetails.toResponse()).toEqual({ ok: false, error: 'missing', code: 'NOT_FOUND' });
  });

  it('expressErrorHandler responds with the DomainError shape and status', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const handler = expressErrorHandler(logger, false);
    const req = { path: '/api/x', requestId: 'r1' };
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };

    handler(new InsufficientBalanceError('not enough USDT'), req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({ ok: false, error: 'not enough USDT', code: 'INSUFFICIENT_BALANCE' });
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('expressErrorHandler falls back to 500 for non-DomainError, hiding message in prod', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const req = { path: '/api/x', requestId: 'r1' };

    const jsonDev = vi.fn();
    const resDev = { status: vi.fn(() => ({ json: jsonDev })) };
    expressErrorHandler(logger, false)(new Error('raw db error'), req, resDev, () => {});
    expect(resDev.status).toHaveBeenCalledWith(500);
    expect(jsonDev).toHaveBeenCalledWith({ ok: false, error: 'raw db error', code: 'INTERNAL_ERROR' });

    const jsonProd = vi.fn();
    const resProd = { status: vi.fn(() => ({ json: jsonProd })) };
    expressErrorHandler(logger, true)(new Error('raw db error'), req, resProd, () => {});
    expect(jsonProd).toHaveBeenCalledWith({ ok: false, error: 'Internal server error', code: 'INTERNAL_ERROR' });
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
