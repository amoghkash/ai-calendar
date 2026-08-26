import { describe, expect, it } from 'vitest';
import { osascriptFailure, parseDump } from './contacts.js';

const killed = (): Error & { killed?: boolean } =>
  Object.assign(new Error('Command failed'), { killed: true });

describe('osascript failure classification', () => {
  it('names a killed probe as a pending permission prompt', () => {
    const error = osascriptFailure(killed(), '', 10_000, 'probe');

    expect(error.code).toBe('UNSUPPORTED');
    expect(error.message).toBe('Contacts did not respond within 10s.');
    expect(error.detail).toMatch(/waiting on screen/);
  });

  it('does not blame a prompt when it is the dump that timed out', () => {
    // The probe succeeding proves permission is granted, so sending the
    // operator to look for a dialog would waste their time.
    const error = osascriptFailure(killed(), '', 30_000, 'dump');

    expect(error.message).toBe('Reading the address book did not finish within 30s.');
    expect(error.detail).not.toMatch(/waiting on screen/);
    expect(error.detail).toMatch(/CONTACTS_TIMEOUT_MS/);
  });

  it('names a Contacts.app that never came up', () => {
    const error = osascriptFailure(
      new Error("Contacts got an error: Application isn't running. (-600)"),
      '',
      10_000,
      'probe',
    );

    expect(error.message).toBe('Contacts.app could not be started.');
    expect(error.detail).toMatch(/tried to launch it/);
  });

  it('recognises an outright denial', () => {
    const error = osascriptFailure(new Error('execution error: Not authorized (-1743)'), '', 10_000);

    expect(error.code).toBe('UNSUPPORTED');
    expect(error.message).toBe('Contacts access was denied.');
  });

  it('falls back to stderr when there is something to report', () => {
    const error = osascriptFailure(new Error('boom'), 'osascript: syntax error', 10_000);

    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.detail).toBe('osascript: syntax error');
  });

  it('never leaves the operator with an empty detail', () => {
    const error = osascriptFailure(new Error('something opaque'), '', 10_000);
    expect(error.detail).toBe('something opaque');
  });
});

describe('contact dump parsing', () => {
  it('reads phones and emails off one row', () => {
    const dump = 'AB:1\tSarah Chen\tP|mobile|(415) 555-1212\tE||sarah@example.com\n';

    expect(parseDump(dump)).toEqual([
      {
        id: 'AB:1',
        displayName: 'Sarah Chen',
        phones: [{ label: 'mobile', value: '(415) 555-1212' }],
        emails: [{ value: 'sarah@example.com' }],
      },
    ]);
  });

  it('keeps a contact with no handles and skips rows with no id', () => {
    expect(parseDump('AB:2\tNo Handles\n\tOrphan\n')).toEqual([
      { id: 'AB:2', displayName: 'No Handles', phones: [], emails: [] },
    ]);
  });
});
