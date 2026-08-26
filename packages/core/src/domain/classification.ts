import type { Attendee, EventClassification } from './calendar.js';
import { METADATA_MANAGED } from './calendar.js';
import type { EventClassificationRule } from './preferences.js';

export interface ClassifiableEvent {
  readonly title: string;
  readonly calendarId?: string;
  readonly attendees: readonly Attendee[];
  readonly isOrganizer: boolean;
  readonly isAllDay: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
  /**
   * Handles of people locally linked to this event.
   *
   * Plans agreed over text have no attendees, so without this a lunch with a
   * friend looks exactly like a solo block and classifies `UNKNOWN` - which the
   * default policy lets the agent propose moving. The link is what tells the
   * scheduler a human is on the other end.
   */
  readonly linkedPeople?: readonly string[];
}

export interface ClassificationResult {
  readonly classification: EventClassification;
  readonly isMovable: boolean;
  readonly isProtected: boolean;
  readonly ruleId?: string;
  readonly explanation: string;
}

const hasOtherAttendees = (event: ClassifiableEvent): boolean =>
  event.attendees.filter((a) => !a.self).length > 0;

const hasLinkedPeople = (event: ClassifiableEvent): boolean =>
  (event.linkedPeople ?? []).length > 0;

/**
 * Decide how the scheduler may treat an event.
 *
 * User rules win; otherwise conservative heuristics apply. Anything the system
 * is unsure about becomes UNKNOWN, which blocks time but is never moved.
 */
export function classifyEvent(
  event: ClassifiableEvent,
  rules: readonly EventClassificationRule[] = [],
): ClassificationResult {
  for (const rule of rules) {
    if (matches(rule, event)) {
      return finish(rule.classification, `Matched classification rule "${rule.id}".`, rule.id);
    }
  }

  if (event.metadata?.[METADATA_MANAGED] === 'true') {
    return finish('MOVABLE', 'This event is a task block created by the scheduling agent.');
  }

  if (hasOtherAttendees(event)) {
    return finish('FIXED', 'The event involves other people, so it is never moved automatically.');
  }

  if (hasLinkedPeople(event)) {
    return finish(
      'FIXED',
      'The event is linked to someone you know, so it is never moved automatically.',
    );
  }

  if (event.isAllDay) {
    return finish('UNKNOWN', 'All-day events are not classified automatically.');
  }

  return finish(
    'UNKNOWN',
    'No rule matched, so the event is treated conservatively: it blocks time but is never moved.',
  );
}

function matches(rule: EventClassificationRule, event: ClassifiableEvent): boolean {
  if (rule.calendarId !== undefined && rule.calendarId !== event.calendarId) return false;
  if (rule.isAllDay !== undefined && rule.isAllDay !== event.isAllDay) return false;
  if (rule.hasOtherAttendees !== undefined && rule.hasOtherAttendees !== hasOtherAttendees(event)) {
    return false;
  }
  if (rule.createdByAgent !== undefined) {
    const managed = event.metadata?.[METADATA_MANAGED] === 'true';
    if (rule.createdByAgent !== managed) return false;
  }
  if (rule.titlePattern !== undefined) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(rule.titlePattern, 'i');
    } catch {
      return false;
    }
    if (!pattern.test(event.title)) return false;
  }
  return true;
}

function finish(
  classification: EventClassification,
  explanation: string,
  ruleId?: string,
): ClassificationResult {
  return {
    classification,
    isMovable: classification === 'MOVABLE',
    isProtected: classification === 'PROTECTED',
    explanation,
    ...(ruleId === undefined ? {} : { ruleId }),
  };
}
