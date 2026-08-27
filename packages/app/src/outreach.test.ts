import { describe, expect, it } from 'vitest';
import type {
  ContactDirectory,
  MessageWriteRequest,
  MessageWriter,
  MessageSendRequest,
  MessageSendResult,
  MessageSender,
  MessagingProvider,
  ReplyIntent,
  ReplyReader,
} from '@calendar-agent/core';
import { createTestApp } from './testing.js';

const person = (id: string, displayName: string, last: string) => ({
  id,
  displayName,
  handles: [{ kind: 'phone' as const, value: `(415) 555-${last}`, normalized: `+1415555${last}` }],
});

const BOOK = [
  person('AB:1', 'Sarah Chen', '1212'),
  person('AB:2', 'Sarah Jones', '9999'),
  person('AB:3', 'Priya Raman', '7777'),
];

const directory: ContactDirectory = {
  search: (query) =>
    Promise.resolve(BOOK.filter((c) => c.displayName.toLowerCase().includes(query.toLowerCase()))),
};

const messaging: MessagingProvider = {
  id: 'fake',
  capabilities: () =>
    Promise.resolve({
      available: true,
      canReadMessages: true,
      canReadContacts: true,
      canSend: false,
    }),
  thread: () => Promise.resolve(undefined),
};

const harness = () => createTestApp({ messaging: { directory, provider: messaging } });

describe('drafting an outreach', () => {
  it('offers real free times and writes a message you could send', async () => {
    const app = (await harness()).app;

    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch this week',
    });

    expect(outcome.kind).toBe('drafted');
    if (outcome.kind !== 'drafted') return;
    expect(outcome.outreach.handle).toBe('+14155557777');
    expect(outcome.outreach.state).toBe('draft');
    // The clock sits at Monday 08:00 UTC with 09:00-17:00 working hours, so
    // lunch lands inside its band on three different days.
    expect(outcome.outreach.proposedSlots).toHaveLength(3);
    expect(outcome.outreach.message).toBe(
      "Hey Priya, lunch this week? I'm free today at 11:30am, tomorrow at 11:30am or Wed at 11:30am. Any of those work?",
    );
  });

  it('can arrange dinner, which working hours would call impossible', async () => {
    const app = (await harness()).app;

    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'dinner',
    });

    expect(outcome.kind).toBe('drafted');
    if (outcome.kind !== 'drafted') return;
    // Inside the dinner band, which sits entirely outside 09:00-17:00.
    for (const slot of outcome.outreach.proposedSlots) {
      const hour = new Date(slot.start).getUTCHours();
      expect(hour).toBeGreaterThanOrEqual(18);
      expect(hour).toBeLessThan(21);
    }
  });

  it('can still be asked the working-hours question', async () => {
    const app = (await harness()).app;

    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'dinner',
      basis: 'working_hours',
    });

    // The escape hatch: for a work dinner you may genuinely not want a Sunday.
    expect(outcome.kind).toBe('no_time');
  });

  it('keeps lunch at lunchtime even with the whole day available', async () => {
    const app = (await harness()).app;

    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
    });

    expect(outcome.kind).toBe('drafted');
    if (outcome.kind !== 'drafted') return;
    for (const slot of outcome.outreach.proposedSlots) {
      const hour = new Date(slot.start).getUTCHours();
      expect(hour).toBeGreaterThanOrEqual(11);
      expect(hour).toBeLessThan(14);
    }
  });

  it('asks which person rather than picking one', async () => {
    const app = (await harness()).app;

    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Sarah',
      activity: 'lunch',
    });

    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind !== 'ambiguous') return;
    expect(outcome.candidates.map((c) => c.displayName)).toEqual(['Sarah Chen', 'Sarah Jones']);
  });

  it('says so when it does not know the person', async () => {
    const app = (await harness()).app;
    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Jordan',
      activity: 'lunch',
    });
    expect(outcome).toEqual({ kind: 'unknown', person: 'Jordan' });
  });

  it('says so when there is no time long enough', async () => {
    // With sleep configured, a waking day is 16 hours and split by midnight,
    // so nothing can hold an eighteen-hour outing.
    const rested = await createTestApp({
      messaging: { directory, provider: messaging },
      config: {
        sleep_hours: {
          monday: '23:00-07:00',
          tuesday: '23:00-07:00',
          wednesday: '23:00-07:00',
          thursday: '23:00-07:00',
          friday: '23:00-07:00',
          saturday: '23:00-07:00',
          sunday: '23:00-07:00',
        },
      },
    });

    const outcome = await rested.app.outreach.draft({
      userId: rested.app.user.id,
      person: 'Priya',
      activity: 'a very long walk',
      durationMinutes: 18 * 60,
    });

    expect(outcome.kind).toBe('no_time');
  });

  it('persists the draft so it survives a restart', async () => {
    const app = (await harness()).app;
    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
    });
    if (outcome.kind !== 'drafted') throw new Error('expected a draft');

    const stored = await app.db.outreach.list({ userId: app.user.id });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(outcome.outreach.id);
  });
});

describe('moving an outreach along', () => {
  const drafted = async () => {
    const app = (await harness()).app;
    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
    });
    if (outcome.kind !== 'drafted') throw new Error('expected a draft');
    return { app, outreach: outcome.outreach };
  };

  it('records that a human sent it', async () => {
    const { app, outreach } = await drafted();

    const sent = await app.outreach.markSent(app.user.id, outreach.id);

    expect(sent.state).toBe('sent');
    expect(sent.sentAt).toBeDefined();
  });

  it('refuses a transition the state machine does not allow', async () => {
    const { app, outreach } = await drafted();
    await app.outreach.cancel(app.user.id, outreach.id);

    // Cancelled is terminal; nothing gets sent afterwards.
    await expect(app.outreach.markSent(app.user.id, outreach.id)).rejects.toThrow(/cannot become/);
  });

  it("does not leak another user's outreach", async () => {
    const { app, outreach } = await drafted();
    await expect(app.outreach.get('someone-else', outreach.id)).rejects.toThrow(/not found/i);
  });
});

describe('asking for it in chat', () => {
  it('drafts a message from a plain sentence, with no model configured', async () => {
    const app = (await harness()).app;

    const turn = await app.agent.handle({ userId: app.user.id, text: 'lunch with Priya' });

    expect(turn.source).toBe('heuristic');
    expect(turn.commands[0]).toMatchObject({ type: 'schedule_with_person', person: 'Priya' });
    expect(turn.reply).toContain('Drafted a message to Priya Raman');
    expect(turn.reply).toContain("Hey Priya, lunch?");
    // The reply must not imply anything reached another person.
    expect(turn.reply).toContain('Nothing has been sent');

    const stored = await app.db.outreach.list({ userId: app.user.id });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.state).toBe('draft');
  });

  it('asks which person instead of drafting to a guess', async () => {
    const app = (await harness()).app;

    const turn = await app.agent.handle({ userId: app.user.id, text: 'lunch with Sarah' });

    expect(turn.reply).toMatch(/More than one "Sarah"/);
    expect(turn.reply).toContain('Sarah Chen');
    expect(turn.reply).toContain('Sarah Jones');
    expect(await app.db.outreach.list({ userId: app.user.id })).toHaveLength(0);
  });

  it('says when it does not recognise the name', async () => {
    const app = (await harness()).app;
    const turn = await app.agent.handle({ userId: app.user.id, text: 'dinner with Jordan' });
    expect(turn.reply).toMatch(/could not find "Jordan"/);
  });

  it('leaves a settled time to the calendar', async () => {
    const app = (await harness()).app;
    const turn = await app.agent.handle({
      userId: app.user.id,
      text: 'lunch with Priya at 1pm tomorrow',
    });
    expect(turn.commands[0]).toMatchObject({ type: 'create_event' });
    expect(await app.db.outreach.list({ userId: app.user.id })).toHaveLength(0);
  });

  it('uses the stored tone', async () => {
    const app = (await harness()).app;
    await app.settings.update(app.user.id, { outreachTone: 'formal' });

    const turn = await app.agent.handle({ userId: app.user.id, text: 'lunch with Priya' });

    expect(turn.reply).toContain('Hi Priya, are you free for lunch?');
  });
});

describe('acting on their reply', () => {
  const sent = async () => {
    const app = (await harness()).app;
    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
    });
    if (outcome.kind !== 'drafted') throw new Error('expected a draft');
    const live = await app.outreach.markSent(app.user.id, outcome.outreach.id);
    return { app, outreach: live };
  };

  it('books the time they picked, without asking again', async () => {
    const { app, outreach } = await sent();
    const chosen = outreach.proposedSlots[1]!;

    const result = await app.outreach.recordReply(app.user.id, outreach.id, 'the second one works');

    expect(result.state).toBe('booked');
    expect(result.agreedSlot).toEqual(chosen);
    expect(result.eventId).toBeDefined();

    const event = await app.db.events.get(result.eventId!);
    expect(event?.title).toBe('Lunch with Priya Raman');
    expect(event?.start).toBe(chosen.start);
    // Nobody is invited: they were reached by message, not by email.
    expect(event?.attendees).toEqual([]);
  });

  it('links the person to what it booked, so the scheduler will not move it', async () => {
    const { app, outreach } = await sent();

    const result = await app.outreach.recordReply(app.user.id, outreach.id, 'first works');

    const event = await app.db.events.get(result.eventId!);
    expect(event?.classification).toBe('FIXED');
    expect(event?.isMovable).toBe(false);
    const links = await app.contactLinks.listForEvent(result.eventId!);
    expect(links[0]?.handle).toBe('+14155557777');
  });

  it('records a refusal and books nothing', async () => {
    const { app, outreach } = await sent();

    const result = await app.outreach.recordReply(app.user.id, outreach.id, "can't this week");

    expect(result.state).toBe('declined');
    expect(result.eventId).toBeUndefined();
  });

  it('escalates a reply it cannot read, with the reason attached', async () => {
    const { app, outreach } = await sent();

    const result = await app.outreach.recordReply(app.user.id, outreach.id, 'sounds good');

    expect(result.state).toBe('needs_you');
    expect(result.note).toMatch(/did not say which/);
    expect(result.eventId).toBeUndefined();
  });

  it('refuses to book a slot that stopped being free', async () => {
    const { app, outreach } = await sent();
    const target = outreach.proposedSlots[0]!;
    const calendar = (await app.calendars.listCalendars(app.user.id)).find((c) => c.isWritable)!;
    // Something else lands on that time between the offer and the answer.
    await app.calendars.createEvent({
      userId: app.user.id,
      calendarId: calendar.id,
      title: 'Something else',
      start: target.start,
      end: target.end,
    });

    const result = await app.outreach.recordReply(app.user.id, outreach.id, 'first one');

    expect(result.state).toBe('needs_you');
    expect(result.note).toMatch(/no longer free/);
    expect(result.eventId).toBeUndefined();
  });

  it('will not take a reply to something that was never sent', async () => {
    const app = (await harness()).app;
    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
    });
    if (outcome.kind !== 'drafted') throw new Error('expected a draft');

    await expect(
      app.outreach.recordReply(app.user.id, outcome.outreach.id, 'yes'),
    ).rejects.toThrow(/not awaiting a reply/);
  });

  it('lets an escalated outreach still be resolved by a later reply', async () => {
    const { app, outreach } = await sent();
    await app.outreach.recordReply(app.user.id, outreach.id, 'sounds good');

    const result = await app.outreach.recordReply(app.user.id, outreach.id, 'tuesday');

    expect(['booked', 'needs_you']).toContain(result.state);
  });
});

describe('a day the user actually named', () => {
  const DAY = 86_400_000;

  it('offers times on that day, not on days they did not ask about', async () => {
    const app = (await harness()).app;
    // Tuesday, the day after the fixed Monday clock.
    const start = Date.parse('2026-03-10T00:00:00Z');

    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
      range: { start, end: start + DAY },
    });

    expect(outcome.kind).toBe('drafted');
    if (outcome.kind !== 'drafted') return;
    for (const slot of outcome.outreach.proposedSlots) {
      expect(slot.start).toBeGreaterThanOrEqual(start);
      expect(slot.start).toBeLessThan(start + DAY);
    }
  });

  it('offers several times on one day rather than a single one', async () => {
    const app = (await harness()).app;
    const start = Date.parse('2026-03-10T00:00:00Z');

    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
      range: { start, end: start + DAY },
    });

    if (outcome.kind !== 'drafted') throw new Error('expected a draft');
    // "lunch tomorrow" with one option reads as take-it-or-leave-it.
    expect(outcome.outreach.proposedSlots.length).toBeGreaterThan(1);
  });

  it('still spreads across days when no day was named', async () => {
    const app = (await harness()).app;
    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
    });

    if (outcome.kind !== 'drafted') throw new Error('expected a draft');
    const days = new Set(
      outcome.outreach.proposedSlots.map((slot) => new Date(slot.start).toISOString().slice(0, 10)),
    );
    expect(days.size).toBe(outcome.outreach.proposedSlots.length);
  });

  it('says there is no time when the named day is full', async () => {
    const app = (await harness()).app;
    const start = Date.parse('2026-03-10T00:00:00Z');
    const calendar = (await app.calendars.listCalendars(app.user.id)).find((c) => c.isWritable)!;
    await app.calendars.createEvent({
      userId: app.user.id,
      calendarId: calendar.id,
      title: 'All day of meetings',
      start: start + 10 * 3_600_000,
      end: start + 16 * 3_600_000,
    });

    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
      range: { start, end: start + DAY },
    });

    expect(outcome.kind).toBe('no_time');
  });
});

describe('explaining why nothing fits', () => {
  const DAY = 86_400_000;

  /** A day with exactly a 45-minute gap inside the lunch band. */
  const cramped = async () => {
    const harnessed = await harness();
    const app = harnessed.app;
    const day = Date.parse('2026-03-10T00:00:00Z');
    const calendar = (await app.calendars.listCalendars(app.user.id)).find((c) => c.isWritable)!;
    // Lunch band is 11:30-14:00; leave 11:30-12:15 and nothing else.
    await app.calendars.createEvent({
      userId: app.user.id,
      calendarId: calendar.id,
      title: 'Booked',
      start: day + 12 * 3_600_000 + 15 * 60_000,
      end: day + 15 * 3_600_000,
    });
    return { app, day };
  };

  it('says how close it got instead of just "no"', async () => {
    const { app, day } = await cramped();

    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
      range: { start: day, end: day + DAY },
    });

    expect(outcome.kind).toBe('no_time');
    if (outcome.kind !== 'no_time') return;
    expect(outcome.neededMinutes).toBe(60);
    // 11:30 to 12:15 is the whole of it.
    expect(outcome.longestFreeMinutes).toBe(45);
  });

  it('points at the next day that would work', async () => {
    const { app, day } = await cramped();

    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
      range: { start: day, end: day + DAY },
    });

    if (outcome.kind !== 'no_time') throw new Error('expected no_time');
    expect(outcome.nextAvailable).toBeDefined();
    // The following day is clear, so that is where it should point.
    expect(outcome.nextAvailable!.start).toBeGreaterThanOrEqual(day + DAY);
  });

  it('does not look further when no window was named', async () => {
    const app = (await harness()).app;

    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'a very long walk',
      // Windows are split at local midnight, so nothing can hold thirty hours.
      durationMinutes: 30 * 60,
    });

    if (outcome.kind !== 'no_time') throw new Error('expected no_time');
    // The search was already as wide as it gets.
    expect(outcome.nextAvailable).toBeUndefined();
  });

  it('reports the buffer, which is often the whole difference', async () => {
    const app = (await harness()).app;
    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
      range: { start: Date.parse('2026-03-01T00:00:00Z'), end: Date.parse('2026-03-01T01:00:00Z') },
    });

    if (outcome.kind !== 'no_time') throw new Error('expected no_time');
    expect(typeof outcome.bufferMinutes).toBe('number');
  });
});

describe('replies the rules cannot read', () => {
  /** Records whether it was consulted, so the fast path can be asserted. */
  class CountingReader implements ReplyReader {
    calls = 0;
    constructor(private readonly answer: ReplyIntent | undefined) {}
    read(): Promise<ReplyIntent | undefined> {
      this.calls += 1;
      return Promise.resolve(this.answer);
    }
  }

  const sentWith = async (reader: ReplyReader) => {
    const harnessed = await createTestApp({
      messaging: { directory, provider: messaging },
      replyReader: reader,
    });
    const app = harnessed.app;
    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
    });
    if (outcome.kind !== 'drafted') throw new Error('expected a draft');
    return { app, outreach: await app.outreach.markSent(app.user.id, outcome.outreach.id) };
  };

  it('books from a phrasing no rule matches', async () => {
    const reader = new CountingReader({ kind: 'accepts', slotIndex: 1 });
    const { app, outreach } = await sentWith(reader);

    const result = await app.outreach.recordReply(
      app.user.id,
      outreach.id,
      'the middle one suits me better tbh',
    );

    expect(reader.calls).toBe(1);
    expect(result.state).toBe('booked');
    expect(result.agreedSlot).toEqual(outreach.proposedSlots[1]);
  });

  it('does not consult the model when a rule already read it', async () => {
    const reader = new CountingReader({ kind: 'accepts', slotIndex: 2 });
    const { app, outreach } = await sentWith(reader);

    const result = await app.outreach.recordReply(app.user.id, outreach.id, 'the first one');

    // Free and instant beats a round trip; the model is for the hard ones.
    expect(reader.calls).toBe(0);
    expect(result.agreedSlot).toEqual(outreach.proposedSlots[0]);
  });

  it('keeps its own unclear when the model declines to help', async () => {
    const reader = new CountingReader(undefined);
    const { app, outreach } = await sentWith(reader);

    const result = await app.outreach.recordReply(app.user.id, outreach.id, 'hmm');

    expect(reader.calls).toBe(1);
    expect(result.state).toBe('needs_you');
  });

  it('escalates rather than booking when the model is unsure', async () => {
    const reader = new CountingReader({ kind: 'unclear', reason: 'They suggested Friday instead.' });
    const { app, outreach } = await sentWith(reader);

    const result = await app.outreach.recordReply(app.user.id, outreach.id, 'how about friday?');

    expect(result.state).toBe('needs_you');
    expect(result.note).toBe('They suggested Friday instead.');
  });

  it('survives a reader that throws', async () => {
    const throwing: ReplyReader = { read: () => Promise.reject(new Error('boom')) };
    const { app, outreach } = await sentWith(throwing);

    const result = await app.outreach.recordReply(app.user.id, outreach.id, 'hmm');

    expect(result.state).toBe('needs_you');
  });
});

describe('sending, and finishing the conversation alone', () => {
  class FakeSender implements MessageSender {
    readonly sent: MessageSendRequest[] = [];
    constructor(private readonly result: MessageSendResult = { status: 'sent', retrySafe: false }) {}
    send(request: MessageSendRequest): Promise<MessageSendResult> {
      this.sent.push(request);
      return Promise.resolve(this.result);
    }
  }

  const drafted = async (sender?: MessageSender) => {
    const harnessed = await createTestApp({
      messaging: {
        directory,
        provider: messaging,
        ...(sender === undefined ? {} : { sender }),
      },
    });
    const app = harnessed.app;
    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
    });
    if (outcome.kind !== 'drafted') throw new Error('expected a draft');
    return { app, outreach: outcome.outreach };
  };

  it('sends the draft and starts waiting', async () => {
    const sender = new FakeSender();
    const { app, outreach } = await drafted(sender);

    const result = await app.outreach.send(app.user.id, outreach.id);

    expect(result.state).toBe('sent');
    expect(result.sentAt).toBeDefined();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({
      handle: '+14155557777',
      text: outreach.message,
      idempotencyKey: `outreach:${outreach.id}:initial`,
    });
  });

  it('cannot send the same outreach twice', async () => {
    const sender = new FakeSender();
    const { app, outreach } = await drafted(sender);
    await app.outreach.send(app.user.id, outreach.id);

    await expect(app.outreach.send(app.user.id, outreach.id)).rejects.toThrow(/already gone out/);
    expect(sender.sent).toHaveLength(1);
  });

  it('says so when sending is not configured', async () => {
    const { app, outreach } = await drafted();
    await expect(app.outreach.send(app.user.id, outreach.id)).rejects.toThrow(/not configured/);
    expect((await app.outreach.get(app.user.id, outreach.id)).state).toBe('draft');
  });

  it('leaves the draft alone when the bridge refuses', async () => {
    const sender = new FakeSender({ status: 'blocked', retrySafe: true, reason: 'daily cap' });
    const { app, outreach } = await drafted(sender);

    await expect(app.outreach.send(app.user.id, outreach.id)).rejects.toThrow(/blocked/);
    expect((await app.outreach.get(app.user.id, outreach.id)).state).toBe('draft');
  });

  it('asks which time, on its own, instead of stopping to ask you', async () => {
    const sender = new FakeSender();
    const { app, outreach } = await drafted(sender);
    await app.outreach.send(app.user.id, outreach.id);

    const result = await app.outreach.recordReply(app.user.id, outreach.id, 'sounds good!');

    // Still waiting on them, not parked for the user.
    expect(result.state).toBe('sent');
    expect(result.clarifications).toBe(1);
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1]?.text).toMatch(/^Sorry, which one - /);
    expect(sender.sent[1]?.idempotencyKey).toBe(`outreach:${outreach.id}:clarify:0`);
  });

  it('asks only once, then hands over', async () => {
    const sender = new FakeSender();
    const { app, outreach } = await drafted(sender);
    await app.outreach.send(app.user.id, outreach.id);
    await app.outreach.recordReply(app.user.id, outreach.id, 'sounds good!');

    const result = await app.outreach.recordReply(app.user.id, outreach.id, 'yeah whenever');

    // A second unreadable answer means the thread has gone somewhere the rules
    // do not follow; asking again would be pestering on the user's behalf.
    expect(result.state).toBe('needs_you');
    expect(sender.sent).toHaveLength(2);
  });

  it('still books straight from a clear answer, with no question asked', async () => {
    const sender = new FakeSender();
    const { app, outreach } = await drafted(sender);
    await app.outreach.send(app.user.id, outreach.id);

    const result = await app.outreach.recordReply(app.user.id, outreach.id, 'the second one');

    expect(result.state).toBe('booked');
    expect(sender.sent).toHaveLength(1);
  });

  it('falls back to asking you when it cannot send the question', async () => {
    const sender = new FakeSender({ status: 'blocked', retrySafe: true });
    const { app, outreach } = await drafted(sender);
    await app.outreach.markSent(app.user.id, outreach.id);

    const result = await app.outreach.recordReply(app.user.id, outreach.id, 'sounds good!');

    expect(result.state).toBe('needs_you');
  });
});

describe('confirming a meeting that already exists', () => {
  /** The harness clock is fixed at Monday 2026-03-09 08:00 UTC. */
  const NOW = Date.parse('2026-03-09T08:00:00Z');

  class Sender implements MessageSender {
    readonly sent: MessageSendRequest[] = [];
    send(request: MessageSendRequest): Promise<MessageSendResult> {
      this.sent.push(request);
      return Promise.resolve({ status: 'sent', retrySafe: false });
    }
  }

  const withMeeting = async () => {
    const sender = new Sender();
    const harnessed = await createTestApp({
      messaging: { directory, provider: messaging, sender },
    });
    const app = harnessed.app;
    const calendar = (await app.calendars.listCalendars(app.user.id)).find((c) => c.isWritable)!;
    const event = await app.calendars.createEvent({
      userId: app.user.id,
      calendarId: calendar.id,
      title: 'Lunch with Priya',
      start: NOW + 26 * 3_600_000,
      end: NOW + 27 * 3_600_000,
    });
    await app.contactLinks.link({
      userId: app.user.id,
      eventId: event.id,
      contactId: 'AB:3',
      displayName: 'Priya Raman',
      handle: '+14155557777',
    });
    return { app, event, sender };
  };

  it('asks about the one time that is booked, not a list', async () => {
    const { app, event } = await withMeeting();

    const outcome = await app.outreach.confirmMeeting(app.user.id, event.id);

    expect(outcome.kind).toBe('drafted');
    if (outcome.kind !== 'drafted') return;
    expect(outcome.outreach.kind).toBe('confirm');
    expect(outcome.outreach.eventId).toBe(event.id);
    expect(outcome.outreach.proposedSlots).toHaveLength(1);
    // Lower-cased mid-sentence: the title is "Lunch with Priya", but
    // "still on for Lunch?" reads like a robot wrote it.
    expect(outcome.outreach.message).toMatch(/^Hey Priya, still on for lunch tomorrow at /);
  });

  it('refuses when nobody is linked to the event', async () => {
    const app = (await createTestApp({ messaging: { directory, provider: messaging } })).app;
    const calendar = (await app.calendars.listCalendars(app.user.id)).find((c) => c.isWritable)!;
    const event = await app.calendars.createEvent({
      userId: app.user.id,
      calendarId: calendar.id,
      title: 'Lunch',
      start: NOW + 26 * 3_600_000,
      end: NOW + 27 * 3_600_000,
    });

    await expect(app.outreach.confirmMeeting(app.user.id, event.id)).rejects.toThrow(
      /Nobody is linked/,
    );
  });

  it('marks it confirmed without booking anything new', async () => {
    const { app, event } = await withMeeting();
    const outcome = await app.outreach.confirmMeeting(app.user.id, event.id);
    if (outcome.kind !== 'drafted') throw new Error('expected a draft');
    await app.outreach.send(app.user.id, outcome.outreach.id);
    const before = (await app.calendars.listEvents(app.user.id, {
      start: NOW,
      end: NOW + 7 * 86_400_000,
    })).length;

    const result = await app.outreach.recordReply(app.user.id, outcome.outreach.id, 'yes see you then');

    expect(result.state).toBe('booked');
    expect(result.note).toBe('They confirmed.');
    expect(result.eventId).toBe(event.id);
    const after = await app.calendars.listEvents(app.user.id, {
      start: NOW,
      end: NOW + 7 * 86_400_000,
    });
    // A confirmation confirms; it must not create a second lunch.
    expect(after).toHaveLength(before);
  });

  it('leaves the event alone when they cannot make it', async () => {
    const { app, event } = await withMeeting();
    const outcome = await app.outreach.confirmMeeting(app.user.id, event.id);
    if (outcome.kind !== 'drafted') throw new Error('expected a draft');
    await app.outreach.send(app.user.id, outcome.outreach.id);

    const result = await app.outreach.recordReply(
      app.user.id,
      outcome.outreach.id,
      "sorry can't make it",
    );

    expect(result.state).toBe('declined');
    expect(result.note).toMatch(/still on your calendar/);
    // Cancelling a real commitment off a read message is the user's call.
    expect(await app.db.events.get(event.id)).toBeDefined();
  });

  it('does not draft a second confirmation for the same event', async () => {
    const { app, event } = await withMeeting();

    const first = await app.outreach.confirmMeeting(app.user.id, event.id);
    const second = await app.outreach.confirmMeeting(app.user.id, event.id);

    // Pressing the button twice is the same request, not a second message.
    if (first.kind !== 'drafted' || second.kind !== 'drafted') throw new Error('expected drafts');
    expect(second.outreach.id).toBe(first.outreach.id);
    expect(await app.outreach.list(app.user.id)).toHaveLength(1);
  });

  it('can ask again once the last one is finished', async () => {
    const { app, event } = await withMeeting();
    const first = await app.outreach.confirmMeeting(app.user.id, event.id);
    if (first.kind !== 'drafted') throw new Error('expected a draft');
    await app.outreach.cancel(app.user.id, first.outreach.id);

    const second = await app.outreach.confirmMeeting(app.user.id, event.id);

    if (second.kind !== 'drafted') throw new Error('expected a draft');
    expect(second.outreach.id).not.toBe(first.outreach.id);
  });

  it('accepts a bare yes, because only one time was named', async () => {
    const { app, event, sender } = await withMeeting();
    const outcome = await app.outreach.confirmMeeting(app.user.id, event.id);
    if (outcome.kind !== 'drafted') throw new Error('expected a draft');
    await app.outreach.send(app.user.id, outcome.outreach.id);

    const result = await app.outreach.recordReply(app.user.id, outcome.outreach.id, 'sounds good');

    // With a list it would have had to ask which; with one time there is no
    // ambiguity to resolve.
    expect(result.state).toBe('booked');
    expect(sender.sent).toHaveLength(1);
  });
});

describe('who writes the message', () => {
  const drafted = async (writer?: MessageWriter) => {
    const app = (
      await createTestApp({
        messaging: { directory, provider: messaging },
        ...(writer === undefined ? {} : { messageWriter: writer }),
      })
    ).app;
    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
    });
    if (outcome.kind !== 'drafted') throw new Error('expected a draft');
    return outcome.outreach;
  };

  it('uses the template when there is no writer', async () => {
    expect((await drafted()).message).toMatch(/^Hey Priya, lunch\? I'm free /);
  });

  it('prefers what the model wrote', async () => {
    const writer: MessageWriter = { write: () => Promise.resolve('Priya! Lunch this week?') };
    expect((await drafted(writer)).message).toBe('Priya! Lunch this week?');
  });

  it('falls back to the template when the model declines', async () => {
    const writer: MessageWriter = { write: () => Promise.resolve(undefined) };
    expect((await drafted(writer)).message).toMatch(/^Hey Priya, lunch\? I'm free /);
  });

  it('falls back when the writer throws', async () => {
    const writer: MessageWriter = { write: () => Promise.reject(new Error('boom')) };
    expect((await drafted(writer)).message).toMatch(/^Hey Priya, lunch\? I'm free /);
  });

  it('hands the writer the template to work from', async () => {
    let seen: MessageWriteRequest | undefined;
    const writer: MessageWriter = {
      write: (request) => {
        seen = request;
        return Promise.resolve(undefined);
      },
    };
    await drafted(writer);

    expect(seen?.kind).toBe('propose');
    expect(seen?.displayName).toBe('Priya Raman');
    expect(seen?.fallback).toMatch(/^Hey Priya, lunch\?/);
    expect(seen?.slots.length).toBeGreaterThan(0);
  });
});
