#!/usr/bin/env node
import { BackgroundSync, createApp } from '@calendar-agent/app';
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
  const server = createServer(app, { backgroundSync });

  const httpServer = server.listen(config.server.port, config.server.host, () => {
    app.logger.info('server.listening', {
      url: `http://${config.server.host}:${config.server.port}`,
      automation: config.preferences.automation.mode,
      database: config.database.driver,
      syncEvery: config.sync.enabled ? `${config.sync.intervalMinutes}m` : 'off',
    });
    backgroundSync.start();
    process.stdout.write(
      `calendar-agent is running at http://${config.server.host}:${config.server.port}\n`,
    );
  });

  const shutdown = async (): Promise<void> => {
    backgroundSync.stop();
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
