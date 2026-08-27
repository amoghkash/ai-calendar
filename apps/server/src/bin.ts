#!/usr/bin/env node
import { BackgroundSync, OutreachPoller, createApp } from '@calendar-agent/app';
import { loadConfig } from '@calendar-agent/config';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);

  // Periodic sync belongs to the long-running process, not to createApp: a
  // one-shot CLI invocation must never start a loop.
  const backgroundSync = new BackgroundSync(
    app.user.id,
    app.sync,
    app.scheduling,
    app.preferences,
    app.clock,
    app.logger,
    config.sync,
  );
  // Answers arrive on other people's schedules, so something has to keep
  // looking. Same ownership rule as the sync loop: the server, never the CLI.
  const outreachPoller = new OutreachPoller(
    app.user.id,
    app.outreach,
    app.messaging,
    app.clock,
    app.logger,
    {
      enabled: config.messaging.enabled,
      intervalMinutes: config.messaging.pollIntervalMinutes,
      readLimit: 20,
    },
  );
  const server = createServer(app, { backgroundSync, outreachPoller });

  const httpServer = server.listen(config.server.port, config.server.host, () => {
    app.logger.info('server.listening', {
      url: `http://${config.server.host}:${config.server.port}`,
      automation: config.preferences.automation.mode,
      database: config.database.driver,
      syncEvery: config.sync.enabled ? `${config.sync.intervalMinutes}m` : 'off',
      outreachPolling: config.messaging.enabled
        ? `${config.messaging.pollIntervalMinutes}m`
        : 'off',
    });
    backgroundSync.start();
    outreachPoller.start();
    process.stdout.write(
      `calendar-agent is running at http://${config.server.host}:${config.server.port}\n`,
    );
  });

  const shutdown = async (): Promise<void> => {
    backgroundSync.stop();
    outreachPoller.stop();
    httpServer.close();
    await app.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
