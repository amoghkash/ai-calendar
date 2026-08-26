import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@calendar-agent/core': pkg('core'),
      '@calendar-agent/imessage-contract': pkg('imessage-contract'),
      '@calendar-agent/config': pkg('config'),
      '@calendar-agent/database': pkg('database'),
      '@calendar-agent/integrations': pkg('integrations'),
      '@calendar-agent/agent': pkg('agent'),
      '@calendar-agent/app': pkg('app'),
      '@calendar-agent/cli': fileURLToPath(new URL('./apps/cli/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
