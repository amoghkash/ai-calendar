import type {
  AvailabilityBasis,
  Clock,
  DailyWindow,
  Database,
  DirectoryContact,
  IdGenerator,
  Interval,
  Logger,
  MessageSender,
  MessageWriter,
  Outreach,
  OutreachState,
  ReplyReader,
  OutreachTone,
  UserId,
} from '@calendar-agent/core';
import {
  NotFoundError,
  UnsupportedError,
  ValidationError,
  MAX_CLARIFICATIONS,
  canTransition,
  classifyReply,
  composeClarifyingMessage,
  composeConfirmationMessage,
  composeOutreachMessage,
  defaultWindowsForActivity,
  extractCandidateNames,
  outreachEventTitle,
  longestUsableMinutes,
  proposeSlots,
  resolveName,
  sanitizeActivity,
} from '@calendar-agent/core';
import type { CalendarService } from './calendar-service.js';
import type { ContactLinkService } from './contact-link-service.js';
import type { PreferencesService } from './preferences-service.js';
import type { SettingsService } from './settings-service.js';
import type { SchedulingService } from './scheduling-service.js';

export interface DraftOutreachRequest {
  readonly userId: UserId;
  /** A name as a human said it: "Sarah", "Sarah Chen". */
  readonly person: string;
  /** What is being arranged, in the words that will appear in the message. */
  readonly activity: string;
  readonly durationMinutes?: number;
  readonly withinDays?: number;
  /** An explicit window from a day the user named. Overrides `withinDays`. */
  readonly range?: Interval;
  readonly preferredWindows?: readonly DailyWindow[];
  /**
   * Defaults to `waking_hours`. Arranging something with a friend is not work,
   * and asking the working-hours question would report no availability for
   * every evening and weekend - the times most of these plans actually happen.
   */
  readonly basis?: AvailabilityBasis;
  /** Overrides the stored default for this one message. */
  readonly tone?: OutreachTone;
}

/**
 * Not all of these are failures.
 *
 * A shared first name and an empty calendar are ordinary situations with
 * different answers - ask which person, or say there is no time - and
 * collapsing them into one error would make both unanswerable.
 */
export type DraftOutcome =
  | { readonly kind: 'drafted'; readonly outreach: Outreach }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly DirectoryContact[] }
  | { readonly kind: 'unknown'; readonly person: string }
  | {
      readonly kind: 'no_time';
      readonly person: string;
      /** The longest stretch that was free inside the activity's hours. */
      readonly longestFreeMinutes: number;
      readonly neededMinutes: number;
      /** Padding applied around every meeting, which is often the difference. */
      readonly bufferMinutes: number;
      /** The first time that would work if the window were widened. */
      readonly nextAvailable?: Interval;
    };

const DEFAULT_DURATION_MINUTES = 60;
const DEFAULT_WITHIN_DAYS = 7;

/**
 * Arranging something with a person who is not on your calendar.
 *
 * Every step is deterministic: the name resolves the same way twice, the times
 * come from the availability engine, and the message is a template. A model can
 * improve the wording later, but nothing here waits on one.
 *
 * Nothing in this service sends anything. A draft is a draft until a human acts
 * on it, and the transition that would reach another person lives behind the
 * bridge's own switch.
 */
export class OutreachService {
  constructor(
    private readonly db: Database,
    private readonly scheduling: SchedulingService,
    private readonly contacts: ContactLinkService,
    private readonly calendars: CalendarService,
    private readonly preferences: PreferencesService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
    /** Optional second opinion on replies the rules cannot read. */
    private readonly replyReader?: ReplyReader,
    /** Present only when the bridge is configured; absent means copy-and-paste. */
    private readonly sender?: MessageSender,
    /** Optional: writes the message text. Falls back to the template. */
    private readonly writer?: MessageWriter,
  ) {}

  async draft(request: DraftOutreachRequest): Promise<DraftOutcome> {
    const person = request.person.trim();
    if (person.length === 0) throw new ValidationError('Who is this with?');
    if (request.activity.trim().length === 0) {
      throw new ValidationError('What are you arranging?');
    }

    // The same resolver the title suggestions use, so "lunch with Sarah" means
    // the same thing typed into chat as written on an event.
    const candidate = extractCandidateNames(person)[0] ?? {
      text: person,
      normalized: person.toLowerCase(),
    };
    const found = await this.contacts.search(candidate.normalized, 25);
    const resolution = resolveName(candidate, found);
    if (resolution.kind === 'none') return { kind: 'unknown', person };
    if (resolution.kind === 'ambiguous') {
      return { kind: 'ambiguous', candidates: resolution.matches.map((match) => match.contact) };
    }

    const contact = resolution.match.contact;
    const handle = contact.handles[0];
    if (handle === undefined) return { kind: 'unknown', person };

    const now = this.clock.now();
    const preferences = await this.preferences.get(request.userId);
    const durationMinutes = request.durationMinutes ?? DEFAULT_DURATION_MINUTES;
    // A named day wins over the default horizon; the start is clipped to now so
    // "today" still means the rest of today.
    const range: Interval = request.range
      ? { start: Math.max(request.range.start, now), end: request.range.end }
      : { start: now, end: now + (request.withinDays ?? DEFAULT_WITHIN_DAYS) * 86_400_000 };
    if (range.end <= range.start) {
      // The named window is entirely in the past.
      return {
        kind: 'no_time',
        person: contact.displayName,
        longestFreeMinutes: 0,
        neededMinutes: durationMinutes,
        bufferMinutes: preferences.bufferBetweenBlocksMinutes,
      };
    }

    const free = await this.scheduling.findSlots({
      userId: request.userId,
      durationMinutes,
      range,
      limit: 200,
      basis: request.basis ?? 'waking_hours',
    });
    // Spreading across days is right for "this week" and wrong for "tomorrow":
    // one named day should offer a few times on that day, not a single one.
    const spanDays = (range.end - range.start) / 86_400_000;
    const slots = proposeSlots(free, now, {
      durationMinutes,
      timezone: preferences.timezone,
      preferredWindows: request.preferredWindows ?? defaultWindowsForActivity(request.activity),
      maxPerDay: spanDays <= 1.5 ? 3 : 1,
    });
    if (slots.length === 0) {
      // Report how close it got, and when it would work, rather than a bare no.
      const proposalOptions = {
        durationMinutes,
        timezone: preferences.timezone,
        preferredWindows: request.preferredWindows ?? defaultWindowsForActivity(request.activity),
      };
      const nextAvailable = await this.lookFurther(request, durationMinutes, range, proposalOptions);
      return {
        kind: 'no_time',
        person: contact.displayName,
        longestFreeMinutes: longestUsableMinutes(free, proposalOptions),
        neededMinutes: durationMinutes,
        bufferMinutes: preferences.bufferBetweenBlocksMinutes,
        ...(nextAvailable === undefined ? {} : { nextAvailable }),
      };
    }

    // The parser may hand over "coffee with Sarah" whole; the recipient is
    // already known and must not appear twice.
    const activity = sanitizeActivity(request.activity, contact.displayName);

    const outreach: Outreach = {
      id: this.ids.next('out'),
      userId: request.userId,
      contactId: contact.id,
      displayName: contact.displayName,
      handle: handle.normalized,
      activity,
      durationMinutes,
      proposedSlots: slots,
      message: await this.compose({
        kind: 'propose',
        displayName: contact.displayName,
        activity,
        slots,
        timezone: preferences.timezone,
        now,
        tone: request.tone ?? (await this.settings.get(request.userId)).outreachTone,
      }),
      state: 'draft',
      createdAt: now,
      updatedAt: now,
      // Waiting past the last time offered is waiting for nothing.
      expiresAt: slots[slots.length - 1]!.end,
    };
    await this.db.outreach.save(outreach);
    this.logger.info('outreach.drafted', {
      id: outreach.id,
      slots: slots.length,
      activity: outreach.activity,
    });
    return { kind: 'drafted', outreach };
  }

  /**
   * Ask whether a meeting that is already on the calendar still stands.
   *
   * Distinct from `draft` in what happens afterwards: there is nothing to book
   * on a yes, and on a no the event stays exactly where it is. Cancelling a
   * real commitment because a text read like a refusal is not a decision worth
   * making automatically.
   */
  async confirmMeeting(userId: UserId, eventId: string): Promise<DraftOutcome> {
    const event = await this.db.events.get(eventId);
    if (!event || event.userId !== userId) throw new NotFoundError('Event', eventId);

    // A second press is the same request, not a second message.
    const open = (await this.list(userId)).find(
      (item) =>
        item.kind === 'confirm' &&
        item.eventId === eventId &&
        (item.state === 'draft' || item.state === 'sent' || item.state === 'needs_you'),
    );
    if (open) return { kind: 'drafted', outreach: open };

    const links = await this.contacts.listForEvent(eventId);
    const link = links[0];
    if (link === undefined) {
      throw new ValidationError(
        `Nobody is linked to "${event.title}". Link the person to it first, then it can be confirmed.`,
      );
    }

    const now = this.clock.now();
    const [preferences, settings] = await Promise.all([
      this.preferences.get(userId),
      this.settings.get(userId),
    ]);
    const slot = { start: event.start, end: event.end };
    const activity = sanitizeActivity(event.title, link.displayName);

    const outreach: Outreach = {
      id: this.ids.next('out'),
      userId,
      kind: 'confirm',
      contactId: link.contactId,
      displayName: link.displayName,
      handle: link.handle,
      activity,
      durationMinutes: Math.max(1, Math.round((event.end - event.start) / 60_000)),
      proposedSlots: [slot],
      message: await this.compose({
        kind: 'confirm',
        displayName: link.displayName,
        activity,
        slots: [slot],
        timezone: preferences.timezone,
        now,
        tone: settings.outreachTone,
      }),
      state: 'draft',
      agreedSlot: slot,
      eventId: event.id,
      createdAt: now,
      updatedAt: now,
      // No point asking after it has happened.
      expiresAt: event.end,
    };
    await this.db.outreach.save(outreach);
    this.logger.info('outreach.confirmation_drafted', { id: outreach.id, eventId });
    return { kind: 'drafted', outreach };
  }

  /**
   * The message text: written by the model when there is one, otherwise the
   * template.
   *
   * The template is always computed first and handed over as the fallback, so
   * a model that is unreachable, slow to the point of failing, or writes
   * something that does not survive checking costs nothing but plainer wording.
   */
  private async compose(input: {
    kind: 'propose' | 'confirm';
    displayName: string;
    activity: string;
    slots: readonly Interval[];
    timezone: string;
    now: number;
    tone: OutreachTone;
  }): Promise<string> {
    const message = { ...input, slots: input.slots };
    const fallback =
      input.kind === 'confirm'
        ? composeConfirmationMessage(message)
        : composeOutreachMessage(message);
    if (!this.writer) return fallback;

    const written = await this.writer
      .write({ ...input, fallback })
      .catch(() => undefined);
    if (written === undefined) return fallback;
    this.logger.debug?.('outreach.message_written_by_model', { kind: input.kind });
    return written;
  }

  /** Whether the agent can reach anybody at all. */
  get canSend(): boolean {
    return this.sender !== undefined;
  }

  /**
   * Send a draft, on one deliberate press.
   *
   * The initial message is the only part of a negotiation that asks the user
   * anything: it is where the person is chosen, and choosing the wrong one is
   * the mistake worth a tap. Everything after this happens on its own.
   */
  async send(userId: UserId, id: string): Promise<Outreach> {
    const outreach = await this.get(userId, id);
    if (outreach.state !== 'draft') {
      throw new ValidationError(`An outreach that is ${outreach.state} has already gone out.`);
    }
    if (!this.sender) {
      throw new UnsupportedError(
        'Sending is not configured. Start the bridge with IMESSAGE_BRIDGE_SEND=true, or send it yourself and press "I sent it".',
      );
    }

    const result = await this.sender.send({
      handle: outreach.handle,
      text: outreach.message,
      // Stable per message, so a retried press cannot text somebody twice.
      idempotencyKey: `outreach:${outreach.id}:initial`,
    });

    if (result.status === 'blocked' || result.status === 'failed' || result.status === 'simulated') {
      this.logger.warn?.('outreach.send_refused', { id, status: result.status });
      throw new UnsupportedError(
        `The bridge did not send it (${result.status})${result.reason ? `: ${result.reason}` : '.'}`,
      );
    }

    this.logger.info('outreach.sent', { id, status: result.status });
    return this.transition(userId, id, 'sent', () => ({
      sentAt: this.clock.now(),
      ...(result.status === 'unconfirmed'
        ? { note: 'The bridge could not confirm delivery. Check Messages before resending.' }
        : {}),
    }));
  }

  /**
   * Take in what they said back, and act on it.
   *
   * An accepted time is booked without asking again. That is a standing
   * authorisation with real edges: the agent can only ever book a slot the user
   * personally offered, only in response to an inbound reply, and only if that
   * slot is *still* free. It cannot invent a time, and it cannot book over
   * something that appeared in the meantime.
   *
   * Everything it cannot read confidently becomes `needs_you` with the reason
   * attached, because the cost of a wrong guess here is an entry in a real
   * calendar and a friend expecting you somewhere.
   */
  async recordReply(
    userId: UserId,
    id: string,
    text: string,
    receivedAt?: number,
  ): Promise<Outreach> {
    const outreach = await this.get(userId, id);
    if (outreach.state !== 'sent' && outreach.state !== 'needs_you') {
      throw new ValidationError(`An outreach that is ${outreach.state} is not awaiting a reply.`);
    }
    const preferences = await this.preferences.get(userId);
    // Rules first: they are free, instant, and cover "yes", "Tuesday" and a
    // plain no. The model is only asked about what they could not read.
    let intent = classifyReply(text, outreach.proposedSlots, preferences.timezone);
    if (intent.kind === 'unclear' && this.replyReader) {
      const second = await this.replyReader
        .read({
          text,
          slots: outreach.proposedSlots,
          timezone: preferences.timezone,
          now: this.clock.now(),
          personName: outreach.displayName,
          activity: outreach.activity,
        })
        .catch(() => undefined);
      if (second) {
        this.logger.info('outreach.reply_read_by_model', { id, kind: second.kind });
        intent = second;
      }
    }
    // Recorded on every outcome, so a poller never reads the same message twice.
    const lastReplyAt = receivedAt ?? this.clock.now();

    if (intent.kind === 'declines') {
      this.logger.info('outreach.declined', { id, kind: outreach.kind ?? 'propose' });
      return this.transition(userId, id, 'declined', () => ({
        // The event stays on the calendar. Removing a real commitment on the
        // strength of a read message is the user's call, not the agent's.
        note:
          outreach.kind === 'confirm'
            ? 'They cannot make it. The event is still on your calendar - cancel or rearrange it yourself.'
            : 'They said no.',
        lastReplyAt,
      }));
    }
    if (intent.kind === 'unclear') {
      // Once a conversation is under way the agent finishes it. Asking which of
      // the times they meant is the one question it may ask unprompted - and it
      // may ask it once, because a second unreadable answer means the thread has
      // gone somewhere these rules do not follow.
      const asked = outreach.clarifications ?? 0;
      if (this.sender && asked < MAX_CLARIFICATIONS && outreach.state === 'sent') {
        const settings = await this.settings.get(userId);
        const question = composeClarifyingMessage({
          displayName: outreach.displayName,
          activity: outreach.activity,
          slots: outreach.proposedSlots,
          timezone: preferences.timezone,
          now: this.clock.now(),
          tone: settings.outreachTone,
        });
        const sent = await this.sender
          .send({
            handle: outreach.handle,
            text: question,
            idempotencyKey: `outreach:${outreach.id}:clarify:${asked}`,
          })
          .catch(() => undefined);

        if (sent && (sent.status === 'sent' || sent.status === 'unconfirmed')) {
          this.logger.info('outreach.clarified', { id, asked: asked + 1 });
          const next: Outreach = {
            ...outreach,
            clarifications: asked + 1,
            lastReplyAt,
            note: `Asked which time they meant: "${question}"`,
            updatedAt: this.clock.now(),
          };
          await this.db.outreach.save(next);
          return next;
        }
      }
      this.logger.info('outreach.needs_you', { id, reason: intent.reason });
      return this.transition(userId, id, 'needs_you', () => ({ note: intent.reason, lastReplyAt }));
    }

    const slot = outreach.proposedSlots[intent.slotIndex];
    if (slot === undefined) {
      return this.transition(userId, id, 'needs_you', () => ({
        note: 'They picked a time that is no longer on the list.',
        lastReplyAt,
      }));
    }

    // Time has passed since the offer went out, so a proposed slot has to be
    // re-checked rather than trusted. A confirmation is the opposite case: the
    // time is *supposed* to be occupied, by the very event being confirmed, so
    // asking whether it is free would always say no.
    if (outreach.kind !== 'confirm' && !(await this.stillFree(userId, slot))) {
      this.logger.info('outreach.slot_taken', { id });
      return this.transition(userId, id, 'needs_you', () => ({
        agreedSlot: slot,
        note: 'They accepted a time that is no longer free. Offer them another.',
        lastReplyAt,
      }));
    }

    const agreed = await this.transition(userId, id, 'agreed', () => ({
      agreedSlot: slot,
      lastReplyAt,
    }));

    // A confirmation has nothing to book; the meeting was already there.
    if (outreach.kind === 'confirm') {
      this.logger.info('outreach.confirmed', { id, eventId: outreach.eventId });
      return this.transition(userId, id, 'booked', () => ({
        note: 'They confirmed.',
      }));
    }
    return this.book(userId, agreed, slot);
  }

  /** Write the agreed time to the calendar and link the person to it. */
  private async book(userId: UserId, outreach: Outreach, slot: Interval): Promise<Outreach> {
    const target = await this.calendars.taskTarget(userId);
    if (!target) {
      return this.transition(userId, outreach.id, 'needs_you', () => ({
        note: 'There is no writable calendar to put this on.',
      }));
    }

    const event = await this.calendars.createEvent({
      userId,
      calendarId: target.calendarId,
      title: outreachEventTitle(outreach.activity, outreach.displayName),
      start: slot.start,
      end: slot.end,
      // Nobody is invited: this person was reached by message, not by email,
      // and an invite would be a second, unasked-for contact.
      notifyAttendees: false,
    });

    // Linking classifies the event FIXED, so the scheduler will not later
    // propose moving something another person is expecting.
    await this.contacts.link({
      userId,
      eventId: event.id,
      contactId: outreach.contactId,
      displayName: outreach.displayName,
      handle: outreach.handle,
    });

    this.logger.info('outreach.booked', { id: outreach.id, eventId: event.id });
    return this.transition(userId, outreach.id, 'booked', () => ({
      eventId: event.id,
      note: undefined,
    }));
  }

  private async stillFree(userId: UserId, slot: Interval): Promise<boolean> {
    const windows = await this.scheduling.findSlots({
      userId,
      durationMinutes: 1,
      range: { start: slot.start - 60_000, end: slot.end + 60_000 },
      basis: 'waking_hours',
      limit: 50,
    });
    return windows.some((window) => window.start <= slot.start && slot.end <= window.end);
  }

  /**
   * The first time this would have worked, had the window not been narrowed.
   *
   * Only worth asking when the user named a window: without one the search was
   * already as wide as it gets.
   */
  private async lookFurther(
    request: DraftOutreachRequest,
    durationMinutes: number,
    range: Interval,
    options: { durationMinutes: number; timezone: string; preferredWindows: readonly DailyWindow[] },
  ): Promise<Interval | undefined> {
    if (request.range === undefined) return undefined;
    const wider: Interval = {
      start: range.start,
      end: range.start + DEFAULT_WITHIN_DAYS * 86_400_000,
    };
    const free = await this.scheduling.findSlots({
      userId: request.userId,
      durationMinutes,
      range: wider,
      limit: 200,
      basis: request.basis ?? 'waking_hours',
    });
    return proposeSlots(free, this.clock.now(), { ...options, maxPerDay: 1 })[0];
  }

  list(userId: UserId, states?: readonly OutreachState[]): Promise<Outreach[]> {
    return this.db.outreach.list({ userId, ...(states === undefined ? {} : { states }) });
  }

  async get(userId: UserId, id: string): Promise<Outreach> {
    const outreach = await this.db.outreach.get(id);
    if (!outreach || outreach.userId !== userId) throw new NotFoundError('Outreach', id);
    return outreach;
  }

  /**
   * Record that the message went out.
   *
   * In the draft-first flow the human sends it themselves, so this is how the
   * record catches up with reality. It is the same transition an automated send
   * will make later, which is why the guard lives on the state machine rather
   * than at the call site.
   */
  async markSent(userId: UserId, id: string): Promise<Outreach> {
    return this.transition(userId, id, 'sent', () => ({ sentAt: this.clock.now() }));
  }

  /** Stop waiting once the last time offered has passed. */
  async expire(userId: UserId, id: string): Promise<Outreach> {
    return this.transition(userId, id, 'expired', () => ({
      note: 'The last time offered has passed with no answer.',
    }));
  }

  async cancel(userId: UserId, id: string): Promise<Outreach> {
    return this.transition(userId, id, 'cancelled', () => ({}));
  }

  private async transition(
    userId: UserId,
    id: string,
    to: OutreachState,
    patch: (outreach: Outreach) => Partial<Outreach>,
  ): Promise<Outreach> {
    const outreach = await this.get(userId, id);
    if (!canTransition(outreach.state, to)) {
      throw new ValidationError(`An outreach that is ${outreach.state} cannot become ${to}.`);
    }
    const next: Outreach = {
      ...outreach,
      ...patch(outreach),
      state: to,
      updatedAt: this.clock.now(),
    };
    await this.db.outreach.save(next);
    this.logger.info('outreach.transitioned', { id, from: outreach.state, to });
    return next;
  }
}
