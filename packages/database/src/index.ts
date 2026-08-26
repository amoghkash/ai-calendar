import { resolve } from 'node:path';
import type { Database } from '@calendar-agent/core';
import { ValidationError } from '@calendar-agent/core';
import { MemoryDatabase } from './memory/memory-database.js';
import { JsonFileDatabase } from './memory/json-database.js';
import { PostgresDatabase } from './postgres/postgres-database.js';

export { MemoryDatabase } from './memory/memory-database.js';
export { JsonFileDatabase } from './memory/json-database.js';
export { PostgresDatabase } from './postgres/postgres-database.js';
export { MIGRATIONS } from './postgres/schema.sql.js';
export type { DatabaseSnapshot } from './memory/collections.js';

export interface DatabaseOptions {
  readonly driver: 'memory' | 'json' | 'postgres';
  readonly url?: string;
  readonly path?: string;
}

/** Build the configured database. The application only sees the port. */
export function createDatabase(options: DatabaseOptions): Database {
  switch (options.driver) {
    case 'memory':
      return new MemoryDatabase();
    case 'json':
      return new JsonFileDatabase(resolve(options.path ?? '.data/calendar-agent.json'));
    case 'postgres':
      if (!options.url) {
        throw new ValidationError('The postgres driver requires a connection url (DATABASE_URL).');
      }
      return new PostgresDatabase(options.url);
    default:
      throw new ValidationError(`Unknown database driver: ${String(options.driver)}`);
  }
}
