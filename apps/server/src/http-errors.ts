import type { NextFunction, Request, Response } from 'express';
import { DomainError } from '@calendar-agent/core';
import type { Logger } from '@calendar-agent/core';

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  AUTH_ERROR: 401,
  PERMISSION_DENIED: 403,
  RATE_LIMITED: 429,
  UNSUPPORTED: 501,
  PROVIDER_ERROR: 502,
  SYNC_ERROR: 502,
  LLM_ERROR: 502,
  SCHEDULING_ERROR: 422,
  INTERNAL_ERROR: 500,
};

/** Wrap an async handler so rejections reach the error middleware. */
export const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };

export function errorMiddleware(logger: Logger) {
  return (error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (error instanceof DomainError) {
      const status = STATUS_BY_CODE[error.code] ?? 500;
      if (status >= 500) logger.error('http.error', { code: error.code, message: error.message });
      res.status(status).json({ error: error.toJSON() });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error('http.unhandled', { message });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
  };
}
