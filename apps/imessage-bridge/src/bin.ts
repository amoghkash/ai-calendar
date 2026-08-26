#!/usr/bin/env node
import { createBridge } from './bridge.js';
import type { BridgeConfig } from './config.js';
import { loadBridgeConfig, resolveToken } from './config.js';
import { BridgeError } from './errors.js';
import { createBridgeServer } from './server.js';

async function main(): Promise<void> {
  // Lets other tooling ask for the token without starting a listener.
  if (process.argv.includes('--print-token')) {
    process.stdout.write(`${resolveToken().token}\n`);
    return;
  }

  const config = loadBridgeConfig();
  const bridge = await createBridge(config);
  const server = createBridgeServer(bridge);

  const httpServer = server.listen(config.port, config.host, () => {
    process.stdout.write(banner(config));
  });

  const shutdown = (): void => {
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Prints the token only when a human is watching.
 *
 * Under launchd stdout is a log file that outlives the process, so echoing a
 * secret there would undo the point of keeping it in a 0600 file.
 */
function banner(config: BridgeConfig): string {
  const lines = [
    `imessage-bridge listening on http://${config.host}:${config.port} ` +
      `(sending ${config.sendEnabled ? 'ENABLED' : 'disabled'})`,
  ];
  if (config.tokenSource === 'env') {
    lines.push('  token  supplied via IMESSAGE_BRIDGE_TOKEN');
  } else if (process.stdout.isTTY) {
    lines.push('', `  token  ${config.token}`, `  saved  ${config.tokenPath}`, '');
  } else {
    lines.push(`  token  read from ${config.tokenPath} (hidden: stdout is not a terminal)`);
  }
  return `${lines.join('\n')}\n`;
}

main().catch((error: unknown) => {
  if (error instanceof BridgeError) {
    process.stderr.write(`${error.message}${error.detail ? `\n${error.detail}` : ''}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
