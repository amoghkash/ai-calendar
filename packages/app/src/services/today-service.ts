import type {
  Clock,
  Database,
  Instant,
  Interval,
  ScheduleBlock,
  TaskRisk,
  ThreadPosture,
  UserId,
} from '@calendar-agent/core';
import { localDayInterval, localDayKey } from '@calendar-agent/core';
import type { ContactLinkService } from './contact-link-service.js';
import type { OutreachService } from './outreach-service.js';
import type { PreferencesService } from './preferences-service.js';
import type { SchedulingService } from './scheduling-service.js';

export interface TodayPerson {
  readonly name: string;
  readonly handle: string;
  readonly posture: ThreadPosture;
}

export interface TodayEntry {
  readonly id: string;
  readonly kind: 'event' | 'block';
  readonly title: string;
  readonly start: Instant;
  readonly end: Instant;
  readonly isAllDay: boolean;
  readonly classification?: string;
  readonly people: readonly TodayPerson[];
  /** True when it is with somebody and nothing has been asked yet. */
  readonly canConfirm: boolean;
  /** Where an existing confirmation for this entry has got to. */
  readonly confirmation?: { readonly id: string; readonly state: string };
}

export interface TodayAction {
  readonly id: string;
  readonly kind: 'needs_you' | 'unsent_draft';
  readonly person: string;
  readonly summary: string;
  readonly note?: string;
}

export interface TodayView {
  readonly now: Instant;
  readonly timezone: string;
  readonly dayStart: Instant;
  readonly dayEnd: Instant;
  readonly entries: readonly TodayEntry[];
  /** The next thing that has not started yet. */
  readonly next?: TodayEntry;
  readonly freeWindows: readonly Interval[];
  readonly actions: readonly TodayAction[];
  readonly risks: readonly TaskRisk[];
  /** A proposal waiting for approval, if one is outstanding. */
  readonly pendingChangeSetId?: string;
}

/**
 * The day, arranged around what needs deciding.
 *
 * The calendar grid already shows what exists; this exists to surface what
 * wants an answer - a meeting nobody has confirmed, a reply the agent could
 * not read, a draft still sitting unsent. Assembled here rather than in the
 * browser so that one request answers the whole page instead of one per event.
 */
export class TodayService {
  constructor(
    private readonly db: Database,
    private readonly scheduling: SchedulingService,
    private readonly contacts: ContactLinkService,
    private readonly outreach: OutreachService,
    private readonly preferences: PreferencesService,
    private readonly clock: Clock,
  ) {}

  async get(userId: UserId): Promise<TodayView> {
    const now = this.clock.now();
    const preferences = await this.preferences.get(userId);
    const timezone = preferences.timezone;
    const day = localDayInterval(localDayKey(now, timezone), timezone);

    const [agenda, risks, outreachItems, changeSets] = await Promise.all([
      this.scheduling.agenda(userId, day),
      this.scheduling.risks(userId),
      this.outreach.list(userId),
      this.db.changeSets.list(userId),
    ]);

    // One lookup per event, done here so the browser makes one request.
    const people = new Map<string, TodayPerson[]>();
    await Promise.all(
      agenda.events.map(async (event) => {
        const linked = await this.contacts.peopleOnEvent(event.id);
        if (linked.length > 0) {
          people.set(
            event.id,
            linked.map((person) => ({
              name: person.link.displayName,
              handle: person.link.handle,
              posture: person.posture,
            })),
          );
        }
      }),
    );

    const confirmations = new Map<string, { id: string; state: string }>();
    for (const item of outreachItems) {
      if (item.kind === 'confirm' && item.eventId) {
        confirmations.set(item.eventId, { id: item.id, state: item.state });
      }
    }

    const entries: TodayEntry[] = [
      ...agenda.events.map((event) => {
        const linked = people.get(event.id) ?? [];
        const confirmation = confirmations.get(event.id);
        return {
          id: event.id,
          kind: 'event' as const,
          title: event.title,
          start: event.start,
          end: event.end,
          isAllDay: event.isAllDay,
          classification: event.classification,
          people: linked,
          // Nothing to ask if nobody is on it, or if it is already over.
          canConfirm: linked.length > 0 && confirmation === undefined && event.end > now,
          ...(confirmation === undefined ? {} : { confirmation }),
        };
      }),
      ...agenda.blocks.map((block: ScheduleBlock & { title: string }) => ({
        id: block.id,
        kind: 'block' as const,
        title: block.title,
        start: block.start,
        end: block.end,
        isAllDay: false,
        people: [],
        canConfirm: false,
      })),
    ].sort((a, b) => a.start - b.start);

    const free = await this.scheduling.findSlots({
      userId,
      durationMinutes: 30,
      range: { start: now, end: day.end },
      basis: 'waking_hours',
      limit: 12,
    });

    const actions: TodayAction[] = outreachItems
      .filter((item) => item.state === 'needs_you' || item.state === 'draft')
      .map((item) => ({
        id: item.id,
        kind: item.state === 'draft' ? ('unsent_draft' as const) : ('needs_you' as const),
        person: item.displayName,
        summary: item.message,
        ...(item.note === undefined ? {} : { note: item.note }),
      }));

    const pending = changeSets.find((set) => set.status === 'pending');

    return {
      now,
      timezone,
      dayStart: day.start,
      dayEnd: day.end,
      entries,
      ...(entries.find((entry) => entry.start > now) === undefined
        ? {}
        : { next: entries.find((entry) => entry.start > now)! }),
      freeWindows: free.map((window) => ({ start: window.start, end: window.end })),
      actions,
      risks: risks.filter((risk) => risk.level !== 'SAFE'),
      ...(pending === undefined ? {} : { pendingChangeSetId: pending.id }),
    };
  }
}
