import type { BridgeCapabilities } from '@calendar-agent/imessage-contract';
import type { BridgeConfig } from './config.js';
import { BridgeError } from './errors.js';
import { ContactDirectory, OsascriptContactSource } from './contacts.js';
import type { ContactSource } from './contacts.js';
import type { ImsgRunner } from './imsg.js';
import { SpawnImsgRunner } from './imsg.js';
import { Outbox } from './outbox.js';
import { ThreadService } from './threads.js';

export interface BridgeOverrides {
  readonly runner?: ImsgRunner;
  readonly contactSource?: ContactSource;
  readonly now?: () => number;
}

export interface Bridge {
  readonly config: BridgeConfig;
  readonly contacts: ContactDirectory;
  readonly threads: ThreadService;
  readonly outbox: Outbox;
  capabilities(): Promise<BridgeCapabilities>;
}

/**
 * Wires the bridge from its config, with every Apple-touching dependency
 * injectable - which is what lets the whole HTTP surface be tested on a machine
 * with no `imsg`, no `chat.db` and no Contacts.
 */
export async function createBridge(
  config: BridgeConfig,
  overrides: BridgeOverrides = {},
): Promise<Bridge> {
  const now = overrides.now ?? Date.now;
  const runner = overrides.runner ?? new SpawnImsgRunner(config.imsgPath, config.imsgTimeoutMs);
  const contactSource =
    overrides.contactSource ??
    new OsascriptContactSource(config.contactsDumpTimeoutMs, config.contactsProbeTimeoutMs);

  const contacts = new ContactDirectory(contactSource, config.region, config.contactsCacheTtlMs, now);
  const threads = new ThreadService(runner, {
    region: config.region,
    chatScanLimit: config.chatScanLimit,
    historyScanLimit: config.historyScanLimit,
  });
  const outbox = new Outbox(runner, config, now);
  await outbox.load();

  return {
    config,
    contacts,
    threads,
    outbox,
    capabilities: () => probe(config, runner, contacts, outbox),
  };
}

/**
 * Every probe here is allowed to fail. A fresh machine has granted nothing, and
 * that is a state to report rather than an error to raise - Contacts can be
 * readable while Messages is not, and reading can work while sending does not.
 */
async function probe(
  config: BridgeConfig,
  runner: ImsgRunner,
  contacts: ContactDirectory,
  outbox: Outbox,
): Promise<BridgeCapabilities> {
  const version = await runner.run(['--version']).catch(() => undefined);
  const available = version !== undefined && version.exitCode === 0;

  let readable = false;
  let messagesDetail: string | undefined;
  if (available) {
    const probeRead = await runner.run(['chats', '--limit', '1', '--json']).catch(() => undefined);
    readable = probeRead !== undefined && probeRead.exitCode === 0;
    if (!readable) {
      messagesDetail = 'Grant Full Disk Access to the process running the bridge, then restart it.';
    }
  } else {
    messagesDetail = 'Install imsg with: brew install steipete/tap/imsg';
  }

  let contactCount: number | undefined;
  let contactsDetail: string | undefined;
  try {
    contactCount = await contacts.count();
  } catch (error) {
    // `detail` is where the remedy lives, so reporting only `message` turns an
    // actionable "approve the prompt" into a useless "it failed".
    contactsDetail =
      error instanceof BridgeError
        ? [error.message, error.detail].filter(Boolean).join(' ')
        : error instanceof Error
          ? error.message
          : String(error);
  }

  // Automation permission cannot be probed without actually sending something,
  // so this reports intent, not proof, and says so.
  const sendable = available && config.sendEnabled;
  const sendDetail =
    messagesDetail ??
    (config.sendEnabled
      ? 'Messages automation permission is confirmed only on the first real send.'
      : 'Sending is disabled; set IMESSAGE_BRIDGE_SEND=true to enable it.');

  return {
    imsg: {
      available,
      ...(version?.stdout.trim() ? { version: version.stdout.trim() } : {}),
      ...(available ? {} : { detail: 'imsg was not found on PATH.' }),
    },
    messages: {
      readable,
      sendable,
      detail: sendDetail,
    },
    contacts: {
      readable: contactCount !== undefined,
      ...(contactCount === undefined ? {} : { count: contactCount }),
      ...(contactsDetail === undefined ? {} : { detail: contactsDetail }),
    },
    send: {
      enabled: config.sendEnabled,
      remainingToday: config.sendEnabled ? outbox.remainingToday() : 0,
    },
  };
}
