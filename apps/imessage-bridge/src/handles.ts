import type { HandleKind } from '@calendar-agent/imessage-contract';

export interface NormalizedHandle {
  readonly kind: HandleKind;
  readonly normalized: string;
}

const DIGITS = /\d/g;

/** What a written phone number may contain. Anything else is not one. */
const PHONE_SHAPED = /^[+0-9\s().-]+$/;

/** Country calling codes for the regions worth defaulting. Extend as needed. */
const CALLING_CODES: Record<string, string> = {
  US: '1',
  CA: '1',
  GB: '44',
  IN: '91',
  AU: '61',
  DE: '49',
  FR: '33',
};

export const isEmailHandle = (raw: string): boolean => raw.includes('@');

/**
 * Reduce a handle to the form iMessage uses, so two spellings of one person
 * compare equal.
 *
 * This is a pragmatic normaliser, not libphonenumber: it is correct for the
 * common cases and will mis-handle unusual international formats. That is
 * tolerable only because the bridge never *picks* a contact - it returns
 * candidates and the calendar app has a human confirm the link once. If that
 * ever stops being true, this function needs a real phone-number library.
 */
export function normalizeHandle(raw: string, region: string): NormalizedHandle {
  const trimmed = raw.trim();
  if (isEmailHandle(trimmed)) {
    return { kind: 'email', normalized: trimmed.toLowerCase() };
  }

  if (!PHONE_SHAPED.test(trimmed)) {
    // An opaque handle, not a number. Harvesting whatever digits it happens to
    // contain would fabricate an E.164 number pointing at a stranger, so pass
    // it through untouched.
    return { kind: 'phone', normalized: trimmed.toLowerCase() };
  }

  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.match(DIGITS)?.join('') ?? '';
  if (digits.length === 0) return { kind: 'phone', normalized: trimmed.toLowerCase() };
  if (hadPlus) return { kind: 'phone', normalized: `+${digits}` };

  const code = CALLING_CODES[region.toUpperCase()];
  if (code === undefined) return { kind: 'phone', normalized: `+${digits}` };

  // A US-style 11-digit number already carries its country code.
  if (digits.startsWith(code) && digits.length > 10) {
    return { kind: 'phone', normalized: `+${digits}` };
  }
  return { kind: 'phone', normalized: `+${code}${digits}` };
}

/** True when two handles reach the same person. */
export const handlesMatch = (a: string, b: string, region: string): boolean =>
  normalizeHandle(a, region).normalized === normalizeHandle(b, region).normalized;
