import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import type { AppContext, BackgroundSync, OutreachPoller } from '@calendar-agent/app';
import { errorMiddleware } from './http-errors.js';
import { buildOAuthRoutes } from './oauth-routes.js';
import { buildRoutes } from './routes.js';

export interface ServerOptions {
  /** Directory holding the built web UI; auto-detected when omitted. */
  readonly webRoot?: string;
  /** Periodic sync loop, so its status can be reported. */
  readonly backgroundSync?: BackgroundSync;
  /** Reply-watching loop, so its status can be reported. */
  readonly outreachPoller?: OutreachPoller;
}

export function createServer(app: AppContext, options: ServerOptions = {}): Express {
  const server = express();
  server.disable('x-powered-by');
  server.use(express.json({ limit: '1mb' }));
  server.use(cors({ origin: [...app.config.server.corsOrigins], credentials: true }));

  server.use('/api/oauth', buildOAuthRoutes(app));
  server.use('/api', buildRoutes(app, options.backgroundSync, options.outreachPoller));

  const webRoot = options.webRoot ?? findWebRoot();
  if (webRoot) {
    server.use(express.static(webRoot));
    // SPA fallback for client-side routes; API 404s stay JSON.
    server.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(resolve(webRoot, 'index.html'));
    });
  }

  server.use(errorMiddleware(app.logger));
  return server;
}

function findWebRoot(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../web/dist'),
    resolve(here, '../../../apps/web/dist'),
    resolve(process.cwd(), 'apps/web/dist'),
  ];
  return candidates.find((candidate) => existsSync(resolve(candidate, 'index.html')));
}
