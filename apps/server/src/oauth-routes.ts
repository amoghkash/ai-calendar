import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { AppContext } from '@calendar-agent/app';
import { ValidationError } from '@calendar-agent/core';
import { asyncRoute } from './http-errors.js';

interface PendingAuth {
  readonly provider: string;
  readonly createdAt: number;
}

/**
 * OAuth authorisation-code flow for calendar providers.
 *
 * The state parameter is kept in memory: this is a local-first, single-user
 * application, and the flow completes in seconds. A multi-user deployment
 * would move this into the database.
 */
export function buildOAuthRoutes(app: AppContext): Router {
  const router = Router();
  const pending = new Map<string, PendingAuth>();
  const STATE_TTL_MS = 10 * 60_000;

  const prune = (): void => {
    const now = app.clock.now();
    for (const [state, entry] of pending) {
      if (now - entry.createdAt > STATE_TTL_MS) pending.delete(state);
    }
  };

  router.get(
    '/:provider/start',
    asyncRoute(async (req, res) => {
      const provider = req.params.provider!;
      const oauth = app.registry.oauth(provider);
      if (!oauth) {
        throw new ValidationError(
          `No OAuth credentials configured for "${provider}". Set its client id and secret.`,
        );
      }
      prune();
      const state = randomUUID();
      pending.set(state, { provider, createdAt: app.clock.now() });
      const url = oauth.buildAuthorizationUrl(state);
      if (req.query.json === 'true') {
        res.json({ url, state });
        return;
      }
      res.redirect(url);
    }),
  );

  router.get(
    '/:provider/callback',
    asyncRoute(async (req, res) => {
      const provider = req.params.provider!;
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const entry = pending.get(state);
      if (typeof req.query.error === 'string') {
        throw new ValidationError(`Authorisation failed: ${req.query.error}`);
      }
      if (!code) throw new ValidationError('The provider did not return an authorisation code.');
      if (!entry || entry.provider !== provider) {
        throw new ValidationError('Unknown or expired OAuth state. Start the flow again.');
      }
      pending.delete(state);

      const oauth = app.registry.oauth(provider);
      if (!oauth) throw new ValidationError(`No OAuth credentials configured for "${provider}".`);
      const tokens = await oauth.exchangeCode(code);
      const { account, calendars } = await app.calendars.connectAccount({
        userId: app.user.id,
        provider,
        tokens,
      });
      app.logger.info('oauth.connected', {
        provider,
        accountId: account.id,
        calendars: calendars.length,
      });
      res.redirect(`/?connected=${encodeURIComponent(account.displayName)}`);
    }),
  );

  return router;
}
