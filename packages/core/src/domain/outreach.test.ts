import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import {
  canTransition,
  describeSlots,
  composeConfirmationMessage,
  midSentence,
  composeOutreachMessage,
  describeSlotCasually,
  isTerminal,
  outreachEventTitle,
  sanitizeActivity,
} from './outreach.js';

const t = (iso: string): number => Date.parse(iso);
const NOW = t('2026-03-09T08:00:00Z');
const slot = (iso: string) => ({ start: t(iso), end: t(iso) + 3_600_000 });

const message = (
  slots: readonly { start: number; end: number }[],
  tone?: 'casual' | 'warm' | 'formal',
): string =>
  composeOutreachMessage({
    displayName: 'Sarah Chen',
    activity: 'lunch this week',
    slots,
    timezone: 'UTC',
    now: NOW,
    ...(tone === undefined ? {} : { tone }),
  });

describe('composing the message', () => {
  it('uses a first name and lists every time offered', () => {
    expect(
      message([slot('2026-03-10T12:30:00Z'), slot('2026-03-11T13:00:00Z'), slot('2026-03-12T12:00:00Z')]),
    ).toBe(
      "Hey Sarah, lunch this week? I'm free tomorrow at 12:30pm, Wed at 1pm or Thu at 12pm. Any of those work?",
    );
  });

  it('asks differently when there is only one time', () => {
    expect(message([slot('2026-03-10T12:30:00Z')])).toBe(
      "Hey Sarah, lunch this week? I'm free tomorrow at 12:30pm. Does that work?",
    );
  });

  it('refuses to compose a message with no times in it', () => {
    expect(() => message([])).toThrow(ValidationError);
  });
});

describe('tone', () => {
  const three = [slot('2026-03-10T12:30:00Z'), slot('2026-03-11T13:00:00Z')];

  it('is casual by default', () => {
    expect(message(three)).toBe(message(three, 'casual'));
    expect(message(three)).toMatch(/^Hey Sarah, /);
  });

  it('warms up without becoming a different message', () => {
    const warm = message(three, 'warm');
    expect(warm).toBe(
      "Hi Sarah! Would love to do lunch this week. I'm free tomorrow at 12:30pm or Wed at 1pm - any of those work for you?",
    );
  });

  it('can be formal enough for a colleague', () => {
    expect(message(three, 'formal')).toBe(
      'Hi Sarah, are you free for lunch this week? I have availability tomorrow at 12:30pm or Wed at 1pm. Please let me know which suits you.',
    );
  });

  it('keeps the single-time phrasing in every tone', () => {
    const one = [slot('2026-03-10T12:30:00Z')];
    expect(message(one, 'casual')).toMatch(/Does that work\?$/);
    expect(message(one, 'warm')).toMatch(/does that work for you\?$/);
    expect(message(one, 'formal')).toMatch(/if that works\.$/);
  });

  it('offers the same times whatever the tone', () => {
    for (const tone of ['casual', 'warm', 'formal'] as const) {
      expect(message(three, tone)).toContain('tomorrow at 12:30pm');
      expect(message(three, tone)).toContain('Wed at 1pm');
    }
  });
});

describe('saying a time the way a person would', () => {
  const say = (iso: string, timezone = 'UTC'): string =>
    describeSlotCasually(t(iso), NOW, timezone);

  it('names today and tomorrow', () => {
    expect(say('2026-03-09T12:00:00Z')).toBe('today at 12pm');
    expect(say('2026-03-10T12:00:00Z')).toBe('tomorrow at 12pm');
  });

  it('uses the weekday inside a week', () => {
    expect(say('2026-03-12T13:00:00Z')).toBe('Thu at 1pm');
  });

  it('adds a date once it is far enough out', () => {
    expect(say('2026-03-20T13:00:00Z')).toBe('Fri 20 Mar at 1pm');
  });

  it('drops a zero minute and keeps a real one', () => {
    expect(say('2026-03-10T13:00:00Z')).toBe('tomorrow at 1pm');
    expect(say('2026-03-10T13:45:00Z')).toBe('tomorrow at 1:45pm');
  });

  it('says noon and midnight the way people do', () => {
    expect(say('2026-03-10T12:00:00Z')).toBe('tomorrow at 12pm');
    expect(say('2026-03-10T00:00:00Z')).toBe('tomorrow at 12am');
  });

  it("speaks in the reader's timezone", () => {
    expect(say('2026-03-10T20:30:00Z', 'America/New_York')).toBe('tomorrow at 4:30pm');
  });
});

describe('the state machine', () => {
  it('allows the ordinary path', () => {
    expect(canTransition('draft', 'sent')).toBe(true);
    expect(canTransition('sent', 'agreed')).toBe(true);
    expect(canTransition('agreed', 'booked')).toBe(true);
  });

  it('refuses to book something that was never sent', () => {
    expect(canTransition('draft', 'booked')).toBe(false);
    expect(canTransition('draft', 'agreed')).toBe(false);
  });

  it('lets an unreadable reply escalate and come back', () => {
    expect(canTransition('sent', 'needs_you')).toBe(true);
    expect(canTransition('needs_you', 'agreed')).toBe(true);
  });

  it('treats the finished states as final', () => {
    for (const state of ['booked', 'declined', 'expired', 'cancelled'] as const) {
      expect(isTerminal(state)).toBe(true);
    }
    expect(isTerminal('sent')).toBe(false);
  });
});

describe('keeping the recipient out of the activity', () => {
  const clean = (activity: string) => sanitizeActivity(activity, 'Sarah Chen');

  it('strips the name a parser folded in', () => {
    expect(clean('coffee with Sarah')).toBe('coffee');
    expect(clean('lunch with Sarah Chen')).toBe('lunch');
    expect(clean('dinner with sarah')).toBe('dinner');
  });

  it('keeps a qualifier that is not the name', () => {
    expect(clean('coffee with Sarah next week')).toBe('coffee next week');
    expect(clean('lunch this week')).toBe('lunch this week');
  });

  it('leaves a genuine part of the activity alone', () => {
    expect(clean('lunch with the team')).toBe('lunch with the team');
  });

  it('never empties the activity entirely', () => {
    expect(clean('with Sarah')).toBe('with Sarah');
  });
});

describe('naming the booked entry', () => {
  it('drops the qualifier and names the person', () => {
    expect(outreachEventTitle('lunch this week', 'Sarah Chen')).toBe('Lunch with Sarah Chen');
    expect(outreachEventTitle('coffee', 'Sarah Chen')).toBe('Coffee with Sarah Chen');
    expect(outreachEventTitle('drinks next week', 'Sarah Chen')).toBe('Drinks with Sarah Chen');
  });
});

describe('listing times the way a person would', () => {
  const say = (isos: readonly string[]) => describeSlots(isos.map(slot), NOW, 'UTC');

  it('names a shared day once, not once per time', () => {
    // "tomorrow at 10:45am, tomorrow at 2pm, tomorrow at 3pm" is nobody's
    // sentence; it is immediately obvious a machine wrote it.
    expect(
      say(['2026-03-10T10:45:00Z', '2026-03-10T14:00:00Z', '2026-03-10T15:00:00Z']),
    ).toBe('tomorrow at 10:45am, 2pm or 3pm');
  });

  it('still names each day when they differ', () => {
    expect(say(['2026-03-10T12:00:00Z', '2026-03-11T13:00:00Z'])).toBe(
      'tomorrow at 12pm or Wed at 1pm',
    );
  });

  it('reads naturally for a single time', () => {
    expect(say(['2026-03-10T12:30:00Z'])).toBe('tomorrow at 12:30pm');
  });

  it('handles two on the same day', () => {
    expect(say(['2026-03-10T12:00:00Z', '2026-03-10T15:30:00Z'])).toBe(
      'tomorrow at 12pm or 3:30pm',
    );
  });
});

describe('the whole message, same-day', () => {
  it('reads like something a person typed', () => {
    expect(
      composeOutreachMessage({
        displayName: 'Viraj Sharma',
        activity: 'coffee',
        slots: ['2026-03-10T10:45:00Z', '2026-03-10T14:00:00Z', '2026-03-10T15:00:00Z'].map(slot),
        timezone: 'UTC',
        now: NOW,
      }),
    ).toBe("Hey Viraj, coffee? I'm free tomorrow at 10:45am, 2pm or 3pm. Any of those work?");
  });
});

describe('confirming a booked meeting', () => {
  const confirm = (tone?: 'casual' | 'warm' | 'formal') =>
    composeConfirmationMessage({
      displayName: 'Priya Raman',
      activity: 'lunch',
      slots: [slot('2026-03-10T12:30:00Z')],
      timezone: 'UTC',
      now: NOW,
      ...(tone === undefined ? {} : { tone }),
    });

  it('names the one time rather than offering a list', () => {
    expect(confirm()).toBe('Hey Priya, still on for lunch tomorrow at 12:30pm?');
  });

  it('carries the tone', () => {
    expect(confirm('warm')).toBe('Hi Priya! Still good for lunch tomorrow at 12:30pm?');
    expect(confirm('formal')).toBe(
      'Hi Priya, just confirming lunch tomorrow at 12:30pm. Does that still work?',
    );
  });

  it('refuses to confirm nothing', () => {
    expect(() =>
      composeConfirmationMessage({
        displayName: 'Priya',
        activity: 'lunch',
        slots: [],
        timezone: 'UTC',
        now: NOW,
      }),
    ).toThrow(ValidationError);
  });
});

describe('an activity dropped into a sentence', () => {
  it('lowers a title-cased phrase', () => {
    // Event titles are capitalised; "still on for Catching up?" is not.
    expect(midSentence('Catching up')).toBe('catching up');
    expect(midSentence('Lunch')).toBe('lunch');
    expect(midSentence('Design review')).toBe('design review');
  });

  it('leaves what is already lower alone', () => {
    expect(midSentence('lunch this week')).toBe('lunch this week');
  });

  it('leaves acronyms and numbers alone', () => {
    expect(midSentence('AGM')).toBe('AGM');
    expect(midSentence('1:1')).toBe('1:1');
    expect(midSentence('DnD night')).toBe('DnD night');
  });

  it('leaves a possessive alone, because it is probably a name', () => {
    expect(midSentence("Ben's birthday")).toBe("Ben's birthday");
  });

  it('reads correctly in a confirmation', () => {
    expect(
      composeConfirmationMessage({
        displayName: 'Sam Rivera',
        activity: 'Catching up',
        slots: [slot('2026-03-09T14:00:00Z')],
        timezone: 'UTC',
        now: NOW,
      }),
    ).toBe('Hey Sam, still on for catching up today at 2pm?');
  });
});
