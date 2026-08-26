import express from 'express';
import type { Express } from 'express';
import type { Bridge } from './bridge.js';
import { buildRoutes, errorMiddleware } from './routes.js';

/**
 * No CORS and no static hosting. The only client is the calendar app's server
 * process; nothing here should ever be reachable from a browser.
 */
export function createBridgeServer(bridge: Bridge): Express {
  const server = express();
  server.disable('x-powered-by');
  server.use(express.json({ limit: '64kb' }));
  server.use(buildRoutes(bridge));
  server.use(errorMiddleware());
  return server;
}
