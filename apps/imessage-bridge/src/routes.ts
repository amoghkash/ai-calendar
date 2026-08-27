import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { CONTRACT_VERSION, sendRequestSchema } from '@calendar-agent/imessage-contract';
import type { Bridge } from './bridge.js';
import { BridgeError, validationError } from './errors.js';

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };

const tokensMatch = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationError(`${name} is required.`);
  }
  return value;
};

const optionalInt = (value: unknown, fallback: number, max: number): number => {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

export function buildRoutes(bridge: Bridge): Router {
  const router = Router();

  // Required even on loopback: any local process can reach 127.0.0.1.
  router.use((req, _res, next) => {
    const header = req.header('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!provided || !tokensMatch(provided, bridge.config.token)) {
      next(new BridgeError('AUTH_ERROR', 'A valid bearer token is required.'));
      return;
    }
    next();
  });

  router.get(
    '/health',
    asyncRoute(async (_req, res) => {
      const capabilities = await bridge.capabilities();
      const degraded = !capabilities.imsg.available || !capabilities.messages.readable;
      res.json({
        status: degraded ? 'degraded' : 'ok',
        contractVersion: CONTRACT_VERSION,
        capabilities,
      });
    }),
  );

  router.get(
    '/contacts',
    asyncRoute(async (req, res) => {
      const query = requireString(req.query.q, 'q');
      const limit = optionalInt(req.query.limit, 10, 50);
      res.json(await bridge.contacts.search(query, limit));
    }),
  );

  router.get(
    '/threads',
    asyncRoute(async (req, res) => {
      const handle = requireString(req.query.handle, 'handle');
      const since = optionalInt(req.query.since, 0, Number.MAX_SAFE_INTEGER);
      res.json(await bridge.threads.state(handle, since === 0 ? undefined : since));
    }),
  );

  // The one endpoint that carries message text. Bounded, and separate from
  // thread state so that reading bodies is always a deliberate choice.
  router.get(
    '/threads/messages',
    asyncRoute(async (req, res) => {
      const handle = requireString(req.query.handle, 'handle');
      const limit = optionalInt(req.query.limit, 20, 200);
      res.json(await bridge.threads.messages(handle, limit));
    }),
  );

  router.post(
    '/outbox',
    asyncRoute(async (req, res) => {
      const parsed = sendRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join('; '));
      }
      res.json(await bridge.outbox.send(parsed.data));
    }),
  );

  return router;
}

export function errorMiddleware() {
  return (error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (error instanceof BridgeError) {
      res.status(error.status).json({ error: error.toJSON() });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
  };
}
