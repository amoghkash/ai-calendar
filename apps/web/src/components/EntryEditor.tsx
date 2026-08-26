import { useEffect, useState } from 'react';
import type { Attendee, Calendar, CalendarEvent, ScheduleBlock, Transparency } from '../api';
import { attendeeLabel, guestsOf, linkLabel, meetingUrl, responseLabel } from '../event';
import { fromLocalInputValue, toLocalInputValue } from '../time';
import { EventPeople } from './EventPeople';
import { Icon } from './Icon';

export type EditorTarget =
  | { kind: 'create'; start: number; end: number }
  | { kind: 'event'; event: CalendarEvent }
  | { kind: 'block'; block: ScheduleBlock & { title: string } };

export interface EventDraft {
  title?: string;
  start?: number;
  end?: number;
  location?: string;
  description?: string;
  transparency?: Transparency;
  attendees?: Attendee[];
  notifyAttendees?: boolean;
}

interface Props {
  target: EditorTarget;
  calendars: Calendar[];
  timezone: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (
    input: EventDraft & { calendarId: string; title: string; start: number; end: number },
  ) => void;
  onUpdateEvent: (id: string, changes: EventDraft) => void;
  onDeleteEvent: (id: string, notify: boolean) => void;
  onMoveBlock: (id: string, start: number, end: number) => void;
  onPinBlock: (id: string, pinned: boolean) => void;
  onDeleteBlock: (id: string) => void;
  /** Linking changes the classification, so the grid needs to re-read it. */
  onPeopleChanged: () => void;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * One dialog for the three things you can edit on the grid: a new event, an
 * existing event, or a scheduled task block.
 */
export function EntryEditor(props: Props) {
  const { target, calendars, timezone, busy, onClose } = props;
  const writable = calendars.filter((calendar) => calendar.isWritable);

  const initial = describe(target);
  const [title, setTitle] = useState(initial.title);
  const [start, setStart] = useState(toLocalInputValue(initial.start, timezone));
  const [end, setEnd] = useState(toLocalInputValue(initial.end, timezone));
  const [location, setLocation] = useState(initial.location);
  const [description, setDescription] = useState(initial.description);
  const [transparency, setTransparency] = useState<Transparency>(initial.transparency);
  const [attendees, setAttendees] = useState<Attendee[]>(initial.attendees);
  const [guestInput, setGuestInput] = useState('');
  const [calendarId, setCalendarId] = useState(
    initial.calendarId ??
      writable.find((calendar) => calendar.isTaskTarget)?.id ??
      writable[0]?.id ??
      '',
  );
  const [notify, setNotify] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isSeries = target.kind === 'event' && target.event.recurrenceKind === 'series_master';
  const readOnlyCalendar =
    target.kind === 'event' &&
    calendars.find((calendar) => calendar.id === target.event.calendarId)?.isWritable === false;
  const locked = isSeries || readOnlyCalendar;
  const guests = guestsOf({ attendees });
  const guestsChanged =
    target.kind === 'event' && guestKey(attendees) !== guestKey(target.event.attendees);

  const addGuest = (): void => {
    const email = guestInput.trim();
    if (email.length === 0) return;
    if (!EMAIL.test(email)) {
      setError(`"${email}" is not an email address.`);
      return;
    }
    if (attendees.some((attendee) => attendee.email.toLowerCase() === email.toLowerCase())) {
      setError(`${email} is already invited.`);
      return;
    }
    setError(null);
    setAttendees([...attendees, { email, response: 'needsAction' }]);
    setGuestInput('');
  };

  const removeGuest = (email: string): void => {
    setAttendees(attendees.filter((attendee) => attendee.email !== email));
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const startInstant = fromLocalInputValue(start, timezone);
    const endInstant = fromLocalInputValue(end, timezone);
    if (Number.isNaN(startInstant) || Number.isNaN(endInstant)) {
      setError('Enter a valid start and end time.');
      return;
    }
    if (endInstant <= startInstant) {
      setError('The end time must be after the start time.');
      return;
    }
    setError(null);

    const common: EventDraft = {
      start: startInstant,
      end: endInstant,
      location: location.trim(),
      description: description.trim(),
      transparency,
      notifyAttendees: notify,
    };

    if (target.kind === 'create') {
      if (!calendarId) {
        setError('No writable calendar is available.');
        return;
      }
      props.onCreate({
        ...common,
        calendarId,
        title: title.trim() || 'Untitled',
        start: startInstant,
        end: endInstant,
        ...(attendees.length > 0 ? { attendees } : {}),
      });
      return;
    }

    if (target.kind === 'event') {
      props.onUpdateEvent(target.event.id, {
        ...common,
        title: title.trim(),
        // Sending the list replaces it, so only a real change is sent.
        ...(guestsChanged ? { attendees } : {}),
      });
      return;
    }

    props.onMoveBlock(target.block.id, startInstant, endInstant);
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={heading(target)}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h3>{heading(target)}</h3>
          <button type="button" className="icon ghost" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        {isSeries && (
          <p className="warn">
            <Icon name="alert" />
            <span>
              This is a recurring series. Editing a whole series is deliberately not supported -
              open a single occurrence instead.
            </span>
          </p>
        )}
        {readOnlyCalendar && (
          <p className="warn">
            <Icon name="alert" />
            <span>This calendar is read-only for your account, so it cannot be edited.</span>
          </p>
        )}

        {target.kind === 'event' && (
          <EventFacts
            event={target.event}
            calendar={calendars.find((calendar) => calendar.id === target.event.calendarId)}
          />
        )}

        <form onSubmit={submit}>
          {target.kind === 'block' ? (
            <p className="block-summary">
              Task block for <strong>{target.block.title}</strong>
              {target.block.pinned && <span className="tag">pinned</span>}
            </p>
          ) : (
            <label className="field">
              <span>Title</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
            </label>
          )}

          <div className="row">
            <label className="field">
              <span>Start</span>
              <input
                type="datetime-local"
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            </label>
            <label className="field">
              <span>End</span>
              <input
                type="datetime-local"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
              />
            </label>
          </div>

          {target.kind === 'create' && (
            <label className="field">
              <span>Calendar</span>
              <select value={calendarId} onChange={(event) => setCalendarId(event.target.value)}>
                {writable.map((calendar) => (
                  <option key={calendar.id} value={calendar.id}>
                    {calendar.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {target.kind !== 'block' && (
            <>
              <div className="row">
                <label className="field">
                  <span>Location</span>
                  <input
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    placeholder="Optional"
                  />
                </label>
                <label className="field shrink">
                  <span>Show as</span>
                  <select
                    value={transparency}
                    onChange={(event) => setTransparency(event.target.value as Transparency)}
                  >
                    <option value="opaque">Busy</option>
                    <option value="transparent">Free</option>
                  </select>
                </label>
              </div>

              <label className="field">
                <span>Description</span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={3}
                  placeholder="Optional"
                />
              </label>

              <div className="field">
                <span>
                  Guests
                  {guests.length > 0 && <span className="badge count">{guests.length}</span>}
                </span>
                {attendees.length > 0 && (
                  <ul className="guest-list">
                    {attendees.map((attendee) => (
                      <li key={attendee.email} className={attendee.self ? 'self' : ''}>
                        <span className="guest-name">
                          {attendee.self ? 'You' : attendeeLabel(attendee)}
                          {attendee.organizer && <span className="tag">organiser</span>}
                          {attendee.optional && <span className="tag">optional</span>}
                        </span>
                        <span className="guest-email">{attendee.email}</span>
                        <span className={`badge rsvp ${attendee.response ?? 'needsAction'}`}>
                          {responseLabel(attendee.response)}
                        </span>
                        {!attendee.self && (
                          <button
                            type="button"
                            className="icon ghost"
                            onClick={() => removeGuest(attendee.email)}
                            disabled={busy || locked}
                            aria-label={`Remove ${attendee.email}`}
                            title={`Remove ${attendee.email}`}
                          >
                            <Icon name="close" size={14} />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="guest-add">
                  <input
                    type="email"
                    value={guestInput}
                    onChange={(event) => setGuestInput(event.target.value)}
                    onKeyDown={(event) => {
                      // Enter adds a guest; it must not submit the whole form.
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      addGuest();
                    }}
                    placeholder="name@example.com"
                    disabled={locked}
                  />
                  <button type="button" onClick={addGuest} disabled={busy || locked}>
                    <Icon name="plus" size={15} />
                    Invite
                  </button>
                </div>
              </div>
            </>
          )}

          {target.kind === 'event' && (
            <EventPeople
              eventId={target.event.id}
              timezone={timezone}
              busy={busy}
              onChanged={props.onPeopleChanged}
            />
          )}

          {target.kind === 'event' && !target.event.isOrganizer && guestsChanged && (
            <p className="note">
              <Icon name="alert" size={15} />
              <span>
                You are not the organiser of this event, so the calendar may refuse a change to its
                guest list.
              </span>
            </p>
          )}

          {guests.length > 0 && target.kind !== 'block' && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={notify}
                onChange={(event) => setNotify(event.target.checked)}
              />
              Email the {guests.length} guest{guests.length === 1 ? '' : 's'} about this
            </label>
          )}

          {error && (
            <p className="warn error">
              <Icon name="alert" />
              <span>{error}</span>
            </p>
          )}

          <div className="modal-actions">
            <button type="submit" className="primary" disabled={busy || locked}>
              Save
            </button>
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>

            {target.kind === 'block' && (
              <>
                <button
                  type="button"
                  onClick={() => props.onPinBlock(target.block.id, !target.block.pinned)}
                  disabled={busy}
                  title={
                    target.block.pinned
                      ? 'Let the scheduler move this block again'
                      : 'Keep this block where it is'
                  }
                >
                  <Icon name="pin" size={15} />
                  {target.block.pinned ? 'Unpin' : 'Pin'}
                </button>
                <button
                  type="button"
                  className="danger push"
                  onClick={() => props.onDeleteBlock(target.block.id)}
                  disabled={busy}
                  title="Remove this block; the task keeps its remaining time"
                >
                  Unschedule
                </button>
              </>
            )}

            {target.kind === 'event' && (
              <button
                type="button"
                className="danger push"
                onClick={() => props.onDeleteEvent(target.event.id, notify)}
                disabled={busy || locked}
              >
                <Icon name="trash" size={15} />
                Delete
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * What the calendar knows about an event but the form does not edit: which
 * calendar it lives on, who called it, and how to join it.
 */
function EventFacts({ event, calendar }: { event: CalendarEvent; calendar?: Calendar }) {
  const join = meetingUrl(event);
  const organizer = event.organizer;
  const facts: { icon: string; body: React.ReactNode }[] = [];

  if (calendar) {
    facts.push({
      icon: 'calendar',
      body: (
        <>
          {calendar.name}
          {event.isRecurring && <span className="tag">repeats</span>}
          {event.status !== 'confirmed' && <span className="tag">{event.status}</span>}
        </>
      ),
    });
  }
  if (organizer && !organizer.self) {
    facts.push({ icon: 'users', body: `Organised by ${attendeeLabel(organizer)}` });
  }
  if (join) {
    facts.push({
      icon: 'link',
      body: (
        <a href={join} target="_blank" rel="noreferrer noopener">
          Join {linkLabel(join)}
        </a>
      ),
    });
  }

  if (facts.length === 0) return null;
  return (
    <ul className="event-facts">
      {facts.map((fact, index) => (
        <li key={index}>
          <Icon name={fact.icon} size={15} />
          <span>{fact.body}</span>
        </li>
      ))}
    </ul>
  );
}

function heading(target: EditorTarget): string {
  if (target.kind === 'create') return 'New event';
  if (target.kind === 'event') return 'Edit event';
  return 'Task block';
}

/** Identity of a guest list, so an unchanged one is never re-sent. */
const guestKey = (attendees: readonly Attendee[]): string =>
  attendees
    .map((attendee) => `${attendee.email.toLowerCase()}:${attendee.optional === true}`)
    .sort()
    .join('|');

function describe(target: EditorTarget): {
  title: string;
  start: number;
  end: number;
  location: string;
  description: string;
  transparency: Transparency;
  attendees: Attendee[];
  calendarId?: string;
} {
  if (target.kind === 'create') {
    return {
      title: '',
      start: target.start,
      end: target.end,
      location: '',
      description: '',
      transparency: 'opaque',
      attendees: [],
    };
  }
  if (target.kind === 'event') {
    return {
      title: target.event.title,
      start: target.event.start,
      end: target.event.end,
      location: target.event.location ?? '',
      description: target.event.description ?? '',
      transparency: target.event.transparency ?? 'opaque',
      attendees: [...target.event.attendees],
      calendarId: target.event.calendarId,
    };
  }
  return {
    title: target.block.title,
    start: target.block.start,
    end: target.block.end,
    location: '',
    description: '',
    transparency: 'opaque',
    attendees: [],
  };
}
