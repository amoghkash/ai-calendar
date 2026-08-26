import { execFile } from 'node:child_process';
import type { BridgeContact, ContactHandle } from '@calendar-agent/imessage-contract';
import { BridgeError } from './errors.js';
import { normalizeHandle } from './handles.js';

export interface RawContactField {
  readonly label?: string;
  readonly value: string;
}

export interface RawContact {
  readonly id: string;
  readonly displayName: string;
  readonly phones: readonly RawContactField[];
  readonly emails: readonly RawContactField[];
}

/** Injectable so tests never touch the real address book or trigger a prompt. */
export interface ContactSource {
  /** The full dump. Slow, and only needed to answer a search. */
  list(): Promise<RawContact[]>;
  /**
   * A cheap liveness probe. `/health` must not pay for a full address-book
   * dump just to answer "can we read Contacts at all".
   */
  count(): Promise<number>;
}

/*
 * Fields are separated by tab and handle parts by pipe, because AppleScript
 * string building is the fragile part of this and fewer escapes is fewer ways
 * to be wrong.
 *
 * Every property is read in its *plural* form - `value of phones of every
 * person` - and that is the whole performance story. Asking per person
 * (`phones of p` inside a loop) costs one Apple Event per property per
 * contact: measured at 113s for 20 contacts, which extrapolates to over an
 * hour for a real address book. The six bulk reads below fetch the same data
 * in six events, and the loop that follows touches only in-memory lists.
 * Measured at 1.9s for 783 contacts. Do not "simplify" this back into a
 * per-person loop.
 */
const DUMP_SCRIPT = `
on cleanText(v)
	set saved to AppleScript's text item delimiters
	try
		if v is missing value then
			set AppleScript's text item delimiters to saved
			return ""
		end if
		set s to v as text
		set AppleScript's text item delimiters to {tab, return, linefeed}
		set parts to text items of s
		set AppleScript's text item delimiters to " "
		set s to parts as text
		set AppleScript's text item delimiters to saved
		return s
	on error
		set AppleScript's text item delimiters to saved
		return ""
	end try
end cleanText

tell application "Contacts"
	set theIds to id of every person
	set theNames to name of every person
	set phoneValues to value of phones of every person
	set phoneLabels to label of phones of every person
	set emailValues to value of emails of every person
	set emailLabels to label of emails of every person
end tell

set rows to {}
repeat with i from 1 to count of theIds
	set rowParts to {cleanText(item i of theIds), cleanText(item i of theNames)}
	set pv to item i of phoneValues
	set pl to item i of phoneLabels
	repeat with j from 1 to count of pv
		set end of rowParts to "P|" & cleanText(item j of pl) & "|" & cleanText(item j of pv)
	end repeat
	set ev to item i of emailValues
	set el to item i of emailLabels
	repeat with j from 1 to count of ev
		set end of rowParts to "E|" & cleanText(item j of el) & "|" & cleanText(item j of ev)
	end repeat
	set AppleScript's text item delimiters to tab
	set end of rows to rowParts as text
end repeat
set AppleScript's text item delimiters to linefeed
return rows as text
`;

const COUNT_SCRIPT = 'tell application "Contacts" to count people';

/** True when AppleScript refused because Contacts.app is not up. */
const isNotRunning = (text: string): boolean =>
  text.includes('-600') || text.toLowerCase().includes("isn't running");

/**
 * Start Contacts.app in the background.
 *
 * `tell application "Contacts"` does not auto-launch it from a background
 * process - it fails with `-600` - and AppleScript's own `launch` does not
 * rescue it either. `open -ga` does, and the `-g` keeps a background service
 * from stealing the user's focus.
 */
function ensureContactsRunning(): Promise<void> {
  return new Promise((resolvePromise) => {
    execFile('open', ['-ga', 'Contacts'], { timeout: 10_000 }, () => {
      // Give the app a moment to accept Apple Events; the caller retries once.
      setTimeout(resolvePromise, 750);
    });
  });
}

export class OsascriptContactSource implements ContactSource {
  constructor(
    private readonly dumpTimeoutMs: number,
    private readonly probeTimeoutMs: number,
  ) {}

  async list(): Promise<RawContact[]> {
    return parseDump(await this.run(DUMP_SCRIPT, this.dumpTimeoutMs, 'dump'));
  }

  async count(): Promise<number> {
    const raw = await this.run(COUNT_SCRIPT, this.probeTimeoutMs, 'probe');
    const parsed = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(parsed)) {
      throw new BridgeError('PROVIDER_ERROR', 'Contacts returned an unreadable count.');
    }
    return parsed;
  }

  private async run(script: string, timeoutMs: number, kind: OsascriptKind): Promise<string> {
    const first = await this.exec(script, timeoutMs);
    if (first.ok) return first.stdout;

    // Cold start: Contacts.app is not up. Start it and try once more, so the
    // first call after a reboot succeeds instead of telling the user to go
    // open an app by hand.
    if (isNotRunning(`${first.stderr} ${first.error?.message ?? ''}`)) {
      await ensureContactsRunning();
      const second = await this.exec(script, timeoutMs);
      if (second.ok) return second.stdout;
      throw osascriptFailure(second.error!, second.stderr, timeoutMs, kind);
    }
    throw osascriptFailure(first.error!, first.stderr, timeoutMs, kind);
  }

  private exec(
    script: string,
    timeoutMs: number,
  ): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    error?: Error & { killed?: boolean };
  }> {
    return new Promise((resolvePromise) => {
      execFile(
        'osascript',
        ['-e', script],
        { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolvePromise(
            error ? { ok: false, stdout, stderr, error } : { ok: true, stdout, stderr },
          );
        },
      );
    });
  }
}

export type OsascriptKind = 'probe' | 'dump';

/**
 * A blocked AppleScript does not fail, it *hangs* - the timeout kills it and
 * leaves stderr empty - so the reason has to be inferred from which script died.
 *
 * The cheap probe hanging means nobody has answered the permission dialog. The
 * dump hanging when the probe already succeeded means permission is fine and
 * the read itself is too slow, which is a completely different fix. Blaming a
 * prompt in that second case sends the operator looking for a dialog that will
 * never appear.
 */
export function osascriptFailure(
  error: Error & { killed?: boolean; signal?: string | null },
  stderr: string,
  timeoutMs: number,
  kind: OsascriptKind = 'probe',
): BridgeError {
  const text = `${stderr} ${error.message}`.toLowerCase();
  if (text.includes('not authorized') || text.includes('-1743')) {
    return new BridgeError(
      'UNSUPPORTED',
      'Contacts access was denied.',
      'Enable it under System Settings > Privacy & Security > Automation, for the process running the bridge.',
    );
  }
  if (isNotRunning(text)) {
    return new BridgeError(
      'PROVIDER_ERROR',
      'Contacts.app could not be started.',
      'The bridge tried to launch it and Contacts still did not respond. Open Contacts once by hand and retry.',
    );
  }
  if (error.killed === true || text.includes('etimedout')) {
    const seconds = Math.round(timeoutMs / 1000);
    if (kind === 'dump') {
      return new BridgeError(
        'UNSUPPORTED',
        `Reading the address book did not finish within ${seconds}s.`,
        'Permission is not the problem if /health reports a contact count. Raise IMESSAGE_BRIDGE_CONTACTS_TIMEOUT_MS for an unusually large address book.',
      );
    }
    return new BridgeError(
      'UNSUPPORTED',
      `Contacts did not respond within ${seconds}s.`,
      'A permission prompt is probably waiting on screen - approve it and retry. If none appears, grant Automation access under System Settings > Privacy & Security.',
    );
  }
  return new BridgeError(
    'PROVIDER_ERROR',
    'Reading Contacts failed.',
    stderr.trim().slice(0, 400) || error.message.slice(0, 400),
  );
}

export function parseDump(stdout: string): RawContact[] {
  const contacts: RawContact[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    const parts = line.split('\t');
    const id = parts[0];
    if (id === undefined || id.length === 0) continue;
    const phones: RawContactField[] = [];
    const emails: RawContactField[] = [];
    for (const part of parts.slice(2)) {
      const kind = part.slice(0, 1);
      const rest = part.slice(2);
      const separator = rest.indexOf('|');
      if (separator === -1) continue;
      const label = rest.slice(0, separator);
      const value = rest.slice(separator + 1).trim();
      if (value.length === 0) continue;
      const field: RawContactField = { value, ...(label.length === 0 ? {} : { label }) };
      if (kind === 'P') phones.push(field);
      else if (kind === 'E') emails.push(field);
    }
    contacts.push({ id, displayName: parts[1] ?? '', phones, emails });
  }
  return contacts;
}

/**
 * Search over a cached snapshot of the address book.
 *
 * The dump is slow enough (AppleScript iterating every person) that doing it per
 * request would make linking feel broken, and static enough that a TTL is
 * honest. Concurrent cold requests share one dump rather than racing.
 */
export class ContactDirectory {
  private cache: readonly RawContact[] | undefined;
  private loadedAt = 0;
  private inFlight: Promise<readonly RawContact[]> | undefined;

  constructor(
    private readonly source: ContactSource,
    private readonly region: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async search(query: string, limit: number): Promise<{ contacts: BridgeContact[]; truncated: boolean }> {
    const all = await this.load();
    const needle = query.trim().toLowerCase();
    const matches = needle.length === 0 ? [] : all.filter((c) => c.displayName.toLowerCase().includes(needle));
    return {
      contacts: matches.slice(0, limit).map((c) => this.toContact(c)),
      truncated: matches.length > limit,
    };
  }

  /** Delegates to the cheap probe; never triggers the full dump. */
  async count(): Promise<number> {
    return this.source.count();
  }

  private toContact(raw: RawContact): BridgeContact {
    const handles: ContactHandle[] = [];
    for (const phone of raw.phones) {
      handles.push({
        kind: 'phone',
        value: phone.value,
        normalized: normalizeHandle(phone.value, this.region).normalized,
        ...(phone.label === undefined ? {} : { label: phone.label }),
      });
    }
    for (const email of raw.emails) {
      handles.push({
        kind: 'email',
        value: email.value,
        normalized: normalizeHandle(email.value, this.region).normalized,
        ...(email.label === undefined ? {} : { label: email.label }),
      });
    }
    return { id: raw.id, displayName: raw.displayName, handles };
  }

  private async load(): Promise<readonly RawContact[]> {
    const fresh = this.cache !== undefined && this.now() - this.loadedAt < this.ttlMs;
    if (fresh && this.cache !== undefined) return this.cache;
    if (this.inFlight !== undefined) return this.inFlight;

    this.inFlight = this.source
      .list()
      .then((contacts) => {
        this.cache = contacts;
        this.loadedAt = this.now();
        return contacts;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
}
