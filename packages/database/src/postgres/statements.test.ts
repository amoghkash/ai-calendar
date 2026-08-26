import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A parameter-count mismatch is invisible to the memory and JSON drivers and
 * only surfaces as `bind message supplies N parameters, but prepared statement
 * requires M` against a real PostgreSQL - in production, on the one code path
 * the default test run never touches. Checking the SQL statically costs
 * nothing and catches it at the point the column is forgotten.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('./postgres-database.ts', import.meta.url)),
  'utf8',
);

interface Statement {
  readonly table: string;
  readonly columns: number;
  readonly placeholders: readonly number[];
  readonly values: number;
}

/** Count top-level commas, ignoring anything nested in brackets. */
function countEntries(body: string): number {
  let depth = 0;
  let count = body.trim().length > 0 ? 1 : 0;
  for (const character of body) {
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) count += 1;
  }
  return body.trimEnd().endsWith(',') ? count - 1 : count;
}

/** The bracketed argument that follows a statement's closing backtick. */
function valuesArray(after: string): string {
  const start = after.indexOf('[', after.indexOf('`'));
  let depth = 0;
  let index = start;
  for (; index < after.length; index += 1) {
    if (after[index] === '[') depth += 1;
    else if (after[index] === ']') depth -= 1;
    if (depth === 0) break;
  }
  return after.slice(start + 1, index);
}

function parseStatements(source: string): Statement[] {
  const statements: Statement[] = [];
  const pattern = /INSERT INTO (\w+) \(([^)]*)\)\s*VALUES \(([^)]*)\)/gs;
  for (const match of source.matchAll(pattern)) {
    statements.push({
      table: match[1]!,
      columns: match[2]!.split(',').filter((column) => column.trim().length > 0).length,
      placeholders: [...match[3]!.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
      values: countEntries(valuesArray(source.slice(match.index! + match[0].length))),
    });
  }
  return statements;
}

describe('postgres insert statements', () => {
  const statements = parseStatements(SOURCE);

  it('finds every insert in the file', () => {
    // A guard on the parser itself: silently matching nothing would make every
    // assertion below vacuously true.
    expect(statements.length).toBeGreaterThanOrEqual(15);
    expect(statements.map((statement) => statement.table)).toContain('tasks');
    expect(statements.map((statement) => statement.table)).toContain('calendar_events');
  });

  it.each(parseStatements(SOURCE).map((statement) => [statement.table, statement] as const))(
    '%s binds one value per column',
    (_table, statement) => {
      expect({ columns: statement.columns, values: statement.values }).toEqual({
        columns: statement.columns,
        values: statement.columns,
      });
      expect(statement.placeholders).toEqual(
        Array.from({ length: statement.columns }, (_, index) => index + 1),
      );
    },
  );
});
