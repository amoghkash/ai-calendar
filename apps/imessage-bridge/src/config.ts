import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { BridgeError } from './errors.js';

export interface BridgeConfig {
  readonly host: string;
  readonly port: number;
  /** Required even on loopback: any local process can reach 127.0.0.1. */
  readonly token: string;
  readonly tokenSource: TokenSource;
  /** Where the token is persisted, when it did not come from the environment. */
  readonly tokenPath?: string;
  readonly imsgPath: string;
  /** Default region for phone numbers written without a country code. */
  readonly region: string;
  readonly sendEnabled: boolean;
  readonly perRecipientDailyLimit: number;
  readonly globalDailyLimit: number;
  readonly auditLogPath: string;
  /** Whether the audit log records message text as well as its length. */
  readonly auditIncludesText: boolean;
  readonly contactsCacheTtlMs: number;
  /** How many chats to scan when resolving a handle to a chat id. */
  readonly chatScanLimit: number;
  /** How many messages to read when deriving per-direction timestamps. */
  readonly historyScanLimit: number;
  readonly imsgTimeoutMs: number;
  /** How long to remember that a handle has no conversation. */
  readonly missTtlMs: number;
  /** Full address-book dump. AppleScript iterating every person is slow. */
  readonly contactsDumpTimeoutMs: number;
  /** Liveness probe used by /health, which must stay fast. */
  readonly contactsProbeTimeoutMs: number;
}

const bool = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

const int = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Environment only. The bridge has no config file and no settings API on
 * purpose: everything here changes the blast radius of sending, so it should
 * change where the operator can see it, not from across a socket.
 */
export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const token = resolveToken(env);

  return {
    host: env.IMESSAGE_BRIDGE_HOST ?? '127.0.0.1',
    port: int(env.IMESSAGE_BRIDGE_PORT, 4320),
    token: token.token,
    tokenSource: token.source,
    ...(token.path === undefined ? {} : { tokenPath: token.path }),
    imsgPath: env.IMESSAGE_BRIDGE_IMSG_PATH ?? 'imsg',
    region: env.IMESSAGE_BRIDGE_REGION ?? 'US',
    // Off by default. The whole feature is developable without it.
    sendEnabled: bool(env.IMESSAGE_BRIDGE_SEND, false),
    perRecipientDailyLimit: int(env.IMESSAGE_BRIDGE_PER_RECIPIENT_DAILY, 3),
    globalDailyLimit: int(env.IMESSAGE_BRIDGE_GLOBAL_DAILY, 20),
    auditLogPath:
      env.IMESSAGE_BRIDGE_AUDIT_LOG ??
      resolve(homedir(), '.calendar-agent', 'imessage-bridge', 'audit.jsonl'),
    auditIncludesText: bool(env.IMESSAGE_BRIDGE_AUDIT_TEXT, false),
    contactsCacheTtlMs: int(env.IMESSAGE_BRIDGE_CONTACTS_TTL_SECONDS, 900) * 1000,
    chatScanLimit: int(env.IMESSAGE_BRIDGE_CHAT_SCAN_LIMIT, 400),
    historyScanLimit: int(env.IMESSAGE_BRIDGE_HISTORY_SCAN_LIMIT, 40),
    imsgTimeoutMs: int(env.IMESSAGE_BRIDGE_IMSG_TIMEOUT_MS, 20_000),
    missTtlMs: int(env.IMESSAGE_BRIDGE_MISS_TTL_SECONDS, 300) * 1000,
    contactsDumpTimeoutMs: int(env.IMESSAGE_BRIDGE_CONTACTS_TIMEOUT_MS, 30_000),
    contactsProbeTimeoutMs: int(env.IMESSAGE_BRIDGE_CONTACTS_PROBE_TIMEOUT_MS, 10_000),
  };
}

export type TokenSource = 'env' | 'file' | 'generated';

export interface ResolvedToken {
  readonly token: string;
  readonly source: TokenSource;
  readonly path?: string;
}

export const defaultTokenPath = (): string =>
  resolve(homedir(), '.calendar-agent', 'imessage-bridge', 'token');

/**
 * Environment, then a token file, then a freshly generated one.
 *
 * Generating on first run rather than refusing to start looks like a weakened
 * default, but it is not: the point was never to make a human type a secret, it
 * was that the bridge must never listen without one. A 32-byte random token in
 * a 0600 file is stronger than what most people would paste in, and it means
 * nothing needs to embed the secret - not a launchd plist, not a shell history
 * entry, not a settings row.
 */
export function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
  fallbackPath: string = defaultTokenPath(),
): ResolvedToken {
  const explicit = env.IMESSAGE_BRIDGE_TOKEN?.trim();
  if (explicit) return { token: explicit, source: 'env' };

  const path = env.IMESSAGE_BRIDGE_TOKEN_FILE?.trim() || fallbackPath;
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length > 0) return { token: existing, source: 'file', path };
  } catch {
    // No token yet; fall through and make one.
  }

  const token = randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    // writeFileSync only applies `mode` when creating, so be explicit.
    chmodSync(path, 0o600);
  } catch (error) {
    throw new BridgeError(
      'INTERNAL_ERROR',
      `Could not write a bridge token to ${path}.`,
      error instanceof Error ? error.message : String(error),
    );
  }
  return { token, source: 'generated', path };
}
