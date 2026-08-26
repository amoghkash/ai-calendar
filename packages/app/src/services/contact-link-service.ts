import type {
  Clock,
  ContactDirectory,
  Database,
  DirectoryContact,
  EventContactLink,
  EventId,
  IdGenerator,
  Logger,
  MessagingCapabilities,
  MessagingProvider,
  ThreadPosture,
  UserId,
} from '@calendar-agent/core';
import {
  METADATA_MANAGED,
  NotFoundError,
  UnsupportedError,
  ValidationError,
  classifyEvent,
  extractCandidateNames,
  resolveName,
  threadPosture,
} from '@calendar-agent/core';
import type { PreferencesService } from './preferences-service.js';

/** Wide enough to see a first-name collision, narrow enough to stay cheap. */
const SUGGESTION_SEARCH_LIMIT = 25;

export interface LinkRequest {
  readonly userId: UserId;
  readonly eventId: EventId;
  readonly contactId: string;
  readonly displayName: string;
  readonly handle: string;
}

/**
 * A person the event's title seems to name.
 *
 * `unique` is safe to offer as one click; `ambiguous` lists the people who tie
 * and makes the user choose. Neither one links anything on its own.
 */
export interface LinkSuggestion {
  readonly candidate: string;
  readonly kind: 'unique' | 'ambiguous';
  readonly contacts: readonly DirectoryContact[];
}

export interface LinkedPerson {
  readonly link: EventContactLink;
  readonly posture: ThreadPosture;
  readonly lastInboundAt?: number;
  readonly lastOutboundAt?: number;
}

/**
 * Owns the local record that an event involves a particular person.
 *
 * Two things live here rather than anywhere else. Linking **re-classifies the
 * event immediately**, because the classification is stored on the event and a
 * link that only took effect at the next sync would leave a real commitment
 * looking movable in the meantime. And nothing here ever picks a contact: the
 * directory returns candidates, a human confirms, and the confirmed handle is
 * what gets stored.
 */
export class ContactLinkService {
  constructor(
    private readonly db: Database,
    private readonly preferences: PreferencesService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly directory?: ContactDirectory,
    private readonly messaging?: MessagingProvider,
  ) {}

  async capabilities(): Promise<MessagingCapabilities> {
    if (!this.messaging) {
      return {
        available: false,
        canReadMessages: false,
        canReadContacts: false,
        canSend: false,
        detail: 'Messaging is not enabled. Set CALENDAR_AGENT_MESSAGING_ENABLED=true.',
      };
    }
    return this.messaging.capabilities();
  }

  async search(query: string, limit = 10): Promise<readonly DirectoryContact[]> {
    if (!this.directory) {
      throw new UnsupportedError(
        'Contact lookup needs the iMessage bridge. Set CALENDAR_AGENT_MESSAGING_ENABLED=true and start it with: npm run bridge',
      );
    }
    if (query.trim().length === 0) throw new ValidationError('A search query is required.');
    return this.directory.search(query.trim(), limit);
  }

  async list(userId: UserId): Promise<EventContactLink[]> {
    return this.db.contactLinks.list(userId);
  }

  async listForEvent(eventId: EventId): Promise<EventContactLink[]> {
    return this.db.contactLinks.listByEvent(eventId);
  }

  /** Handles linked to an event, for classification. */
  async handlesForEvent(eventId: EventId | undefined): Promise<readonly string[]> {
    if (eventId === undefined) return [];
    return (await this.db.contactLinks.listByEvent(eventId)).map((link) => link.handle);
  }

  /**
   * People the event's title appears to name, who are not linked yet.
   *
   * The directory does the coarse filtering and the resolver does the precise
   * ranking, so a title naming three people costs three narrow searches rather
   * than a scan of the whole address book.
   *
   * An unreachable bridge yields no suggestions rather than an error: the
   * capability check already tells the user messaging is down, and failing this
   * request too would only stop them opening the event.
   */
  async suggestForEvent(eventId: EventId): Promise<LinkSuggestion[]> {
    if (!this.directory) return [];
    const event = await this.db.events.get(eventId);
    if (!event) return [];

    const linked = new Set((await this.db.contactLinks.listByEvent(eventId)).map((l) => l.handle));
    const suggestions: LinkSuggestion[] = [];

    for (const candidate of extractCandidateNames(event.title)) {
      let found;
      try {
        found = await this.directory.search(candidate.normalized, SUGGESTION_SEARCH_LIMIT);
      } catch (error) {
        this.logger.debug?.('contacts.suggest_unavailable', {
          message: error instanceof Error ? error.message : String(error),
        });
        return suggestions;
      }

      const resolution = resolveName(
        candidate,
        // Someone already on the event is not a suggestion.
        found.filter((contact) => !contact.handles.some((h) => linked.has(h.normalized))),
      );
      if (resolution.kind === 'none') continue;
      suggestions.push(
        resolution.kind === 'unique'
          ? { candidate: candidate.text, kind: 'unique', contacts: [resolution.match.contact] }
          : {
              candidate: candidate.text,
              kind: 'ambiguous',
              contacts: resolution.matches.map((match) => match.contact),
            },
      );
    }
    return suggestions;
  }

  async link(request: LinkRequest): Promise<EventContactLink> {
    const event = await this.db.events.get(request.eventId);
    if (!event || event.userId !== request.userId) {
      throw new NotFoundError('Event', request.eventId);
    }
    const handle = request.handle.trim();
    if (handle.length === 0) throw new ValidationError('A contact handle is required.');

    const existing = (await this.db.contactLinks.listByEvent(request.eventId)).find(
      (link) => link.handle === handle,
    );
    if (existing) return existing;

    const link: EventContactLink = {
      id: this.ids.next('lnk'),
      userId: request.userId,
      eventId: request.eventId,
      contactId: request.contactId,
      displayName: request.displayName,
      handle,
      source: 'manual',
      createdAt: this.clock.now(),
    };
    await this.db.contactLinks.save(link);
    await this.reclassify(request.userId, request.eventId);

    this.logger.info('contacts.linked', { eventId: request.eventId, source: link.source });
    return link;
  }

  async unlink(userId: UserId, id: string): Promise<void> {
    const link = await this.db.contactLinks.get(id);
    if (!link || link.userId !== userId) throw new NotFoundError('Contact link', id);
    await this.db.contactLinks.delete(id);
    await this.reclassify(userId, link.eventId);
    this.logger.info('contacts.unlinked', { eventId: link.eventId });
  }

  /**
   * Who is on an event, and whether the plan has been spoken about since.
   *
   * A thread the bridge cannot reach degrades to `unmentioned` rather than
   * failing the whole request - the link is still true when messaging is down.
   */
  async peopleOnEvent(eventId: EventId): Promise<LinkedPerson[]> {
    const links = await this.db.contactLinks.listByEvent(eventId);
    if (links.length === 0) return [];
    const event = await this.db.events.get(eventId);
    const since = event?.createdAt ?? 0;

    const people: LinkedPerson[] = [];
    for (const link of links) {
      let snapshot;
      try {
        snapshot = await this.messaging?.thread(link.handle);
      } catch (error) {
        this.logger.debug?.('contacts.thread_unavailable', {
          message: error instanceof Error ? error.message : String(error),
        });
        snapshot = undefined;
      }
      people.push({
        link,
        posture: threadPosture(snapshot, since),
        ...(snapshot?.lastInboundAt === undefined ? {} : { lastInboundAt: snapshot.lastInboundAt }),
        ...(snapshot?.lastOutboundAt === undefined
          ? {}
          : { lastOutboundAt: snapshot.lastOutboundAt }),
      });
    }
    return people;
  }

  /**
   * Recompute and persist the event's classification.
   *
   * This is the point of the whole link: an event with no attendees classifies
   * `UNKNOWN`, whose default policy is `ask` - so before this runs, the agent
   * may propose moving a lunch someone is actually expecting.
   */
  private async reclassify(userId: UserId, eventId: EventId): Promise<void> {
    const event = await this.db.events.get(eventId);
    if (!event) return;
    const preferences = await this.preferences.get(userId);
    const linkedPeople = await this.handlesForEvent(eventId);

    const result = classifyEvent(
      {
        title: event.title,
        calendarId: event.calendarId,
        attendees: event.attendees,
        isOrganizer: event.isOrganizer,
        isAllDay: event.isAllDay,
        // The stored event has no provider metadata, but an agent-created task
        // block is identifiable by its blockId - and must stay MOVABLE.
        ...(event.blockId === undefined ? {} : { metadata: { [METADATA_MANAGED]: 'true' } }),
        linkedPeople,
      },
      preferences.classificationRules,
    );
    if (result.classification === event.classification) return;

    await this.db.events.save({ ...event, classification: result.classification });
    this.logger.info('contacts.reclassified', {
      eventId,
      from: event.classification,
      to: result.classification,
    });
  }
}
