import { execFile } from 'node:child_process';
import { z } from 'zod';
import { BridgeError } from './errors.js';

export interface ImsgResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * The seam that keeps this package testable on a machine with no `imsg`, no
 * `chat.db` and no macOS. The real implementation spawns the binary; tests
 * replay scripted JSON. Same idea as the calendar app's injectable clock.
 */
export interface ImsgRunner {
  run(args: readonly string[]): Promise<ImsgResult>;
}

export class SpawnImsgRunner implements ImsgRunner {
  constructor(
    private readonly binary: string,
    private readonly timeoutMs: number,
  ) {}

  run(args: readonly string[]): Promise<ImsgResult> {
    return new Promise((resolvePromise) => {
      execFile(
        this.binary,
        [...args],
        { timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            resolvePromise({ stdout: '', stderr: 'imsg not found', exitCode: 127 });
            return;
          }
          const exitCode =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? (error as unknown as { code: number }).code
              : error
                ? 1
                : 0;
          resolvePromise({ stdout, stderr, exitCode });
        },
      );
    });
  }
}

/*
 * The field names below are `imsg`'s, taken from its documented JSON schema
 * reference. They are the one place this package knows another tool's shape, so
 * a change there is a change here and nowhere else.
 *
 * Its convention is that inapplicable strings are omitted rather than null,
 * which is why almost everything is optional.
 */
const imsgChatSchema = z.object({
  id: z.number(),
  identifier: z.string().optional(),
  name: z.string().optional(),
  display_name: z.string().optional(),
  contact_name: z.string().optional(),
  service: z.string().optional(),
  last_message_at: z.string().optional(),
  is_group: z.boolean().optional(),
  participants: z.array(z.string()).optional(),
});

const imsgMessageSchema = z.object({
  id: z.number(),
  chat_id: z.number().optional(),
  sender: z.string().optional(),
  sender_name: z.string().optional(),
  is_from_me: z.boolean().optional(),
  text: z.string().optional(),
  created_at: z.string().optional(),
});

export type ImsgChat = z.infer<typeof imsgChatSchema>;
export type ImsgMessage = z.infer<typeof imsgMessageSchema>;

/**
 * `imsg` emits both a JSON array and NDJSON depending on the command, so accept
 * either rather than depending on which one a given version chose.
 */
function parseRecords(stdout: string): unknown[] {
  const text = stdout.trim();
  if (text.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed !== null && typeof parsed === 'object') {
      const container = parsed as Record<string, unknown>;
      for (const key of ['chats', 'messages', 'items', 'results', 'data']) {
        const value = container[key];
        if (Array.isArray(value)) return value;
      }
      return [parsed];
    }
    return [];
  } catch {
    // NDJSON: one record per line, tolerating progress lines that are not JSON.
    const records: unknown[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        continue;
      }
    }
    return records;
  }
}

/** Drop records that do not fit rather than failing the whole read. */
const collect = <T>(records: readonly unknown[], schema: z.ZodType<T>): T[] => {
  const out: T[] = [];
  for (const record of records) {
    const parsed = schema.safeParse(record);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
};

export const parseChats = (stdout: string): ImsgChat[] => collect(parseRecords(stdout), imsgChatSchema);

export const parseMessages = (stdout: string): ImsgMessage[] =>
  collect(parseRecords(stdout), imsgMessageSchema);

/** `imsg` speaks ISO 8601; the domain speaks epoch milliseconds. Convert once, here. */
export function toEpochMs(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

const PERMISSION_HINTS = [
  'full disk access',
  'operation not permitted',
  'not authorized',
  'permission denied',
  'tcc',
];

/**
 * Turn a failed invocation into the most useful error available.
 *
 * A denied permission is not a crash - it is a machine-configuration state with
 * a known remedy, and it should read like one.
 */
export function imsgFailure(command: string, result: ImsgResult): BridgeError {
  if (result.exitCode === 127) {
    return new BridgeError(
      'UNSUPPORTED',
      'The imsg binary was not found.',
      'Install it with: brew install steipete/tap/imsg',
    );
  }
  const haystack = `${result.stderr} ${result.stdout}`.toLowerCase();
  if (PERMISSION_HINTS.some((hint) => haystack.includes(hint))) {
    return new BridgeError(
      'UNSUPPORTED',
      `imsg ${command} was denied access to the Messages database.`,
      'Grant Full Disk Access to the process running the bridge, then restart it.',
    );
  }
  const detail = result.stderr.trim() || result.stdout.trim();
  return new BridgeError('PROVIDER_ERROR', `imsg ${command} failed.`, detail.slice(0, 400));
}
