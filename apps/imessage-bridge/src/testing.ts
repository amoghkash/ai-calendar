import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeConfig } from './config.js';
import type { ContactSource, RawContact } from './contacts.js';
import type { ImsgResult, ImsgRunner } from './imsg.js';

export const ok = (stdout: string): ImsgResult => ({ stdout, stderr: '', exitCode: 0 });
export const fail = (stderr: string, exitCode = 1): ImsgResult => ({ stdout: '', stderr, exitCode });

export type ImsgScript = Record<string, ImsgResult | ((args: readonly string[]) => ImsgResult)>;

/** Replays scripted output, keyed by subcommand, and records what was asked. */
export class FakeImsgRunner implements ImsgRunner {
  readonly calls: string[][] = [];

  constructor(private readonly script: ImsgScript = {}) {}

  run(args: readonly string[]): Promise<ImsgResult> {
    this.calls.push([...args]);
    const key = args[0] ?? '';
    const entry = this.script[key];
    if (entry === undefined) {
      return Promise.resolve(fail(`no scripted response for "${key}"`, 1));
    }
    return Promise.resolve(typeof entry === 'function' ? entry(args) : entry);
  }
}

export class FakeContactSource implements ContactSource {
  constructor(private readonly contacts: readonly RawContact[] = []) {}

  list(): Promise<RawContact[]> {
    return Promise.resolve([...this.contacts]);
  }

  count(): Promise<number> {
    return Promise.resolve(this.contacts.length);
  }
}

export class FailingContactSource implements ContactSource {
  constructor(private readonly error: Error) {}

  list(): Promise<RawContact[]> {
    return Promise.reject(this.error);
  }

  count(): Promise<number> {
    return Promise.reject(this.error);
  }
}

/** A config pointing at a throwaway audit log, with sending off unless asked. */
export function testBridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  const dir = mkdtempSync(join(tmpdir(), 'imessage-bridge-'));
  return {
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    tokenSource: 'env',
    imsgPath: 'imsg',
    region: 'US',
    sendEnabled: false,
    perRecipientDailyLimit: 3,
    globalDailyLimit: 20,
    auditLogPath: join(dir, 'audit.jsonl'),
    auditIncludesText: false,
    contactsCacheTtlMs: 60_000,
    chatScanLimit: 400,
    historyScanLimit: 40,
    imsgTimeoutMs: 5_000,
    missTtlMs: 300_000,
    contactsDumpTimeoutMs: 5_000,
    contactsProbeTimeoutMs: 1_000,
    ...overrides,
  };
}
