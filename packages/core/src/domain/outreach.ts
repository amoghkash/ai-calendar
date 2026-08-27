import { DateTime } from 'luxon';
import { ValidationError } from '../errors.js';
import type { DailyWindow } from '../time/wall-clock.js';
import { dailyWindow } from '../time/wall-clock.js';
import type { Instant } from '../time/instant.js';
import type { Interval } from '../time/interval.js';
import type { EventId, OutreachId, UserId } from './ids.js';

/**
 * Arranging something with someone who is not on your calendar.
 *
 * You cannot compute a time that suits you both - you know your own free/busy
 * and nothing at all about theirs - so this is not a scheduling problem but a
 * conversation: offer a few times, wait, and book what they pick. The record
 * below is that conversation, which outlives any single request and has to
 * survive a restart.
 */
export type OutreachState =
  /** Composed and waiting for a human to approve it. Nothing has been sent. */
  | 'draft'
  /** Sent; waiting on them. */
  | 'sent'
  /** A reply arrived that could not be read confidently. A person must look. */
  | 'needs_you'
  /** A time is agreed but is not on the calendar yet. */
  | 'agreed'
  | 'booked'
  | 'declined'
  | 'expired'
  | 'cancelled';

/**
 * How many times the agent may ask "which one?" before handing over.
 *
 * One. A second unreadable answer means the conversation has gone somewhere
 * these rules do not follow, and asking again would be pestering somebody on
 * the user's behalf.
 */
export const MAX_CLARIFICATIONS = 1;

/**
 * What is being asked.
 *
 * `propose` offers times for something that is not on the calendar yet.
 * `confirm` names one time that already is, and asks whether it still stands.
 * They share a state machine, a reply reader and a poller because the shape of
 * the conversation is the same; only the question and the consequences differ.
 */
export type OutreachKind = 'propose' | 'confirm';

export const OUTREACH_STATES: readonly OutreachState[] = [
  'draft',
  'sent',
  'needs_you',
  'agreed',
  'booked',
  'declined',
  'expired',
  'cancelled',
];

/**
 * Only these moves are legal.
 *
 * Written down rather than implied, because the two transitions that leave this
 * machine - sending a message and booking an event - are the irreversible ones,
 * and a state machine you cannot read is one you cannot audit.
 */
const TRANSITIONS: Record<OutreachState, readonly OutreachState[]> = {
  draft: ['sent', 'cancelled'],
  sent: ['needs_you', 'agreed', 'declined', 'expired', 'cancelled'],
  needs_you: ['agreed', 'declined', 'sent', 'expired', 'cancelled'],
  agreed: ['booked', 'needs_you', 'cancelled'],
  booked: [],
  declined: [],
  expired: [],
  cancelled: [],
};

export const canTransition = (from: OutreachState, to: OutreachState): boolean =>
  TRANSITIONS[from].includes(to);

export const isTerminal = (state: OutreachState): boolean => TRANSITIONS[state].length === 0;

export interface Outreach {
  readonly id: OutreachId;
  /** Defaults to `propose` for records written before confirmations existed. */
  readonly kind?: OutreachKind;
  readonly userId: UserId;
  /** Who it is with. Mirrors the fields on a contact link. */
  readonly contactId: string;
  readonly displayName: string;
  readonly handle: string;
  /** What is being arranged, in the words it will appear in the message. */
  readonly activity: string;
  readonly durationMinutes: number;
  /** The times offered, in the order they were offered. */
  readonly proposedSlots: readonly Interval[];
  /** The exact text. Stored so what was sent is never in doubt. */
  readonly message: string;
  readonly state: OutreachState;
  readonly agreedSlot?: Interval;
  /** Why the last transition happened; the difference between a state and an explanation. */
  readonly note?: string;
  /** Timestamp of the newest reply already acted on. */
  readonly lastReplyAt?: Instant;
  /** How many times the agent has asked which slot. Bounded by MAX_CLARIFICATIONS. */
  readonly clarifications?: number;
  readonly eventId?: EventId;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly sentAt?: Instant;
  /** After this, stop waiting for an answer. */
  readonly expiresAt?: Instant;
}

/**
 * The hours an activity belongs in.
 *
 * Offering lunch at 4pm is technically free time and obviously wrong, and the
 * availability engine has no opinion about it because it does not know what the
 * time is *for*. Unrecognised activities get no band at all rather than a
 * guessed one - a wide offer is better than a confidently wrong one.
 */
export function defaultWindowsForActivity(activity: string): readonly DailyWindow[] {
  const text = activity.toLowerCase();
  if (/\bbreakfast\b/.test(text)) return [dailyWindow('07:30', '10:00')];
  if (/\blunch\b/.test(text)) return [dailyWindow('11:30', '14:00')];
  if (/\bbrunch\b/.test(text)) return [dailyWindow('10:00', '14:00')];
  if (/\b(dinner|supper)\b/.test(text)) return [dailyWindow('18:00', '21:00')];
  if (/\b(drinks|beer|pub|bar)\b/.test(text)) return [dailyWindow('17:00', '21:30')];
  if (/\b(coffee|tea)\b/.test(text)) return [dailyWindow('09:00', '16:00')];
  return [];
}

/**
 * How the message should read.
 *
 * The same three times can be offered as a text to a friend or a note to a
 * colleague, and getting that wrong is more jarring than getting the times
 * wrong. It is a per-message choice with a stored default, not a global one.
 */
export type OutreachTone = 'casual' | 'warm' | 'formal';

export const OUTREACH_TONES: readonly OutreachTone[] = ['casual', 'warm', 'formal'];

export const isOutreachTone = (value: unknown): value is OutreachTone =>
  typeof value === 'string' && (OUTREACH_TONES as readonly string[]).includes(value);

/**
 * What the booked entry should be called.
 *
 * The activity carries the phrasing that suited a message ("lunch this week"),
 * which reads badly on a calendar. The qualifier is dropped and the person is
 * named, because six months later "Lunch" alone tells you nothing.
 */
export function outreachEventTitle(activity: string, displayName: string): string {
  const bare = activity
    .replace(/\b(this|next)\s+(week|weekend|month)\b/gi, '')
    .replace(/\bsometime\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const subject = bare.length > 0 ? bare : activity.trim();
  const titled = subject.charAt(0).toUpperCase() + subject.slice(1);
  return `${titled} with ${displayName.trim()}`;
}

/**
 * Strip the recipient back out of the activity.
 *
 * "coffee with Sarah" is a natural way to say it and a natural thing for a
 * parser to hand over whole, but the recipient is already known - leaving it in
 * produces "Hey Sarah, coffee with Sarah?" and a calendar entry reading "Coffee
 * with Sarah with Sarah Chen".
 */
export function sanitizeActivity(activity: string, displayName: string): string {
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = [displayName.trim(), displayName.trim().split(/\s+/)[0] ?? ''].filter(
    (name) => name.length > 0,
  );

  let out = activity;
  for (const name of names) {
    out = out.replace(new RegExp(`\\s*\\bwith\\s+${escape(name)}\\b`, 'gi'), '');
  }
  // Any other capitalised "with X" is the recipient under a different spelling.
  out = out.replace(/\s*\bwith\s+[A-Z][\w'\u2019-]*(?:\s+[A-Z][\w'\u2019-]*)*/g, '');
  const cleaned = out.replace(/\s+/g, ' ').replace(/[\s,]+$/, '').trim();
  return cleaned.length > 0 ? cleaned : activity.trim();
}

/**
 * The one question the agent is allowed to ask on its own.
 *
 * Sent when a reply agrees without saying which time. It repeats the same
 * options rather than offering new ones, so the conversation cannot drift into
 * times the user never approved.
 */
export function composeClarifyingMessage(input: OutreachMessageInput): string {
  if (input.slots.length === 0) {
    throw new ValidationError('A clarifying message needs the times it is asking about.');
  }
  const list = describeSlots(input.slots, input.now, input.timezone);
  switch (input.tone ?? 'casual') {
    case 'formal':
      return `Apologies - could you confirm which works: ${list}?`;
    case 'warm':
      return `Sorry, which one works for you - ${list}?`;
    default:
      return `Sorry, which one - ${list}?`;
  }
}

/**
 * "Still on for X?" - the message for a meeting that is already booked.
 *
 * It names the one time rather than offering a list, because the time is not
 * in question; only whether they are still coming.
 */
export function composeConfirmationMessage(input: OutreachMessageInput): string {
  const slot = input.slots[0];
  if (slot === undefined) {
    throw new ValidationError('A confirmation needs the time it is confirming.');
  }
  const first = input.displayName.trim().split(/\s+/)[0] ?? input.displayName;
  const when = describeSlotCasually(slot.start, input.now, input.timezone);
  const activity = midSentence(input.activity);
  switch (input.tone ?? 'casual') {
    case 'formal':
      return `Hi ${first}, just confirming ${activity} ${when}. Does that still work?`;
    case 'warm':
      return `Hi ${first}! Still good for ${activity} ${when}?`;
    default:
      return `Hey ${first}, still on for ${activity} ${when}?`;
  }
}

/**
 * Lower a title-cased phrase so it reads inside a sentence.
 *
 * An activity often comes from an event title - "Catching up with Sam" - where
 * capitals are right. Dropped into "still on for ___?" they are not.
 *
 * Only plain sentence case is lowered. An acronym, an internal capital, a
 * leading digit or a possessive is left alone, because "AGM", "1:1", "DnD" and
 * "Ben's birthday" are all worse lowercased. A brand name in first position
 * ("Zoom sync") still gets lowered; that reads slightly informal rather than
 * wrong, which is the right way round for a text message.
 */
export function midSentence(activity: string): string {
  const trimmed = activity.trim();
  // The whole first word must be plain sentence case. Checking only its first
  // two letters lowers "DnD night" to "dnD night"; requiring the word to end
  // at a space or the string also leaves possessives like "Ben's" alone.
  return /^[A-Z][a-z]+(\s|$)/.test(trimmed)
    ? trimmed.charAt(0).toLowerCase() + trimmed.slice(1)
    : trimmed;
}

export interface OutreachMessageInput {
  readonly displayName: string;
  readonly activity: string;
  readonly slots: readonly Interval[];
  readonly timezone: string;
  readonly now: Instant;
  readonly tone?: OutreachTone;
}

/**
 * The default draft.
 *
 * Deliberately plain, and deliberately deterministic. A model can write a
 * warmer version later, but the feature must not depend on one being reachable
 * - and a template you can predict is a template you can review before it goes
 * to a friend.
 */
export function composeOutreachMessage(input: OutreachMessageInput): string {
  if (input.slots.length === 0) {
    throw new ValidationError('An outreach message needs at least one time to offer.');
  }
  const first = input.displayName.trim().split(/\s+/)[0] ?? input.displayName;
  const list = describeSlots(input.slots, input.now, input.timezone);
  const times = input.slots;
  const one = times.length === 1;
  const activity = midSentence(input.activity);

  switch (input.tone ?? 'casual') {
    case 'formal':
      return (
        `Hi ${first}, are you free for ${activity}? ` +
        `I have availability ${list}. ` +
        `Please let me know ${one ? 'if that works' : 'which suits you'}.`
      );
    case 'warm':
      return (
        `Hi ${first}! Would love to do ${activity}. ` +
        `I'm free ${list} - ${one ? 'does that work' : 'any of those work'} for you?`
      );
    default:
      return `Hey ${first}, ${activity}? I'm free ${list}. ${one ? 'Does that work?' : 'Any of those work?'}`;
  }
}

/**
 * The list of times, as a person would say it.
 *
 * When every option falls on one day the day is named once: "tomorrow at
 * 10:45am, 2pm or 3pm". Repeating it - "tomorrow at 10:45am, tomorrow at 2pm,
 * tomorrow at 3pm" - is the kind of thing nobody types, and it is immediately
 * obvious that a machine wrote it.
 */
export function describeSlots(
  slots: readonly Interval[],
  now: Instant,
  timezone: string,
): string {
  if (slots.length === 0) return '';
  const days = new Set(
    slots.map((slot) => DateTime.fromMillis(slot.start, { zone: timezone }).toISODate()),
  );
  if (days.size > 1) {
    return joinNaturally(slots.map((slot) => describeSlotCasually(slot.start, now, timezone)));
  }
  const first = slots[0]!;
  const day = describeDayCasually(first.start, now, timezone);
  const clocks = slots.map((slot) =>
    casualClock(DateTime.fromMillis(slot.start, { zone: timezone })),
  );
  return `${day} at ${joinNaturally(clocks)}`;
}

/** "today at 12:30pm", "Thu at 1pm" - how a person writes a time, not a log line. */
export function describeSlotCasually(instant: Instant, now: Instant, timezone: string): string {
  const at = DateTime.fromMillis(instant, { zone: timezone });
  return `${describeDayCasually(instant, now, timezone)} at ${casualClock(at)}`;
}

/** "today", "tomorrow", "Thu", "Thu 3 Sep" - whichever a person would use. */
export function describeDayCasually(instant: Instant, now: Instant, timezone: string): string {
  const at = DateTime.fromMillis(instant, { zone: timezone });
  const today = DateTime.fromMillis(now, { zone: timezone }).startOf('day');
  const days = Math.round(at.startOf('day').diff(today, 'days').days);

  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1 && days < 7) return at.toFormat('ccc');
  return at.toFormat('ccc d LLL');
}

function casualClock(at: DateTime): string {
  const hour = at.hour % 12 === 0 ? 12 : at.hour % 12;
  const suffix = at.hour < 12 ? 'am' : 'pm';
  return at.minute === 0
    ? `${hour}${suffix}`
    : `${hour}:${String(at.minute).padStart(2, '0')}${suffix}`;
}

function joinNaturally(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]!}`;
}
