import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveToken } from './config.js';

const tempPath = (): string => join(mkdtempSync(join(tmpdir(), 'bridge-token-')), 'token');

describe('token resolution', () => {
  it('prefers an explicit environment token', () => {
    const resolved = resolveToken({ IMESSAGE_BRIDGE_TOKEN: 'from-env' }, tempPath());
    expect(resolved).toEqual({ token: 'from-env', source: 'env' });
  });

  it('reads an existing token file', () => {
    const path = tempPath();
    writeFileSync(path, 'stored-token\n');

    expect(resolveToken({}, path)).toEqual({ token: 'stored-token', source: 'file', path });
  });

  it('honours IMESSAGE_BRIDGE_TOKEN_FILE over the default path', () => {
    const path = tempPath();
    writeFileSync(path, 'elsewhere\n');

    expect(resolveToken({ IMESSAGE_BRIDGE_TOKEN_FILE: path }, tempPath()).token).toBe('elsewhere');
  });

  it('generates and persists a token on first run', () => {
    const path = tempPath();
    const resolved = resolveToken({}, path);

    expect(resolved.source).toBe('generated');
    expect(resolved.token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, 'utf8').trim()).toBe(resolved.token);
  });

  it('writes the token file readable only by its owner', () => {
    const path = tempPath();
    resolveToken({}, path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps the same token across restarts', () => {
    const path = tempPath();
    const first = resolveToken({}, path);
    const second = resolveToken({}, path);

    expect(second.token).toBe(first.token);
    expect(second.source).toBe('file');
  });
});
