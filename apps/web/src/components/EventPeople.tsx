import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DirectoryContact,
  LinkSuggestion,
  LinkedPerson,
  MessagingStatus,
  ThreadPosture,
} from '../api';
import { api } from '../api';
import { relativeDay } from '../time';
import { Icon } from './Icon';

interface Props {
  eventId: string;
  timezone: string;
  busy: boolean;
  /** Linking changes the event's classification, so the grid has to re-read it. */
  onChanged: () => void;
}

const POSTURE: Record<ThreadPosture, { label: string; hint: string }> = {
  unmentioned: {
    label: 'not mentioned',
    hint: 'Nothing has been said in this thread since the plan was made.',
  },
  awaiting_them: {
    label: 'waiting on them',
    hint: 'You spoke last.',
  },
  awaiting_me: {
    label: 'your turn',
    hint: 'They spoke last.',
  },
};

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

/**
 * Who this event is with, for plans that were agreed over text.
 *
 * Deliberately separate from Guests: a guest is a calendar attendee who gets an
 * emailed invite, and a person here is a local link that never leaves the
 * machine. The two look different because confusing them would send mail to
 * somebody who was only ever going to get a text.
 */
export function EventPeople({ eventId, timezone, busy, onChanged }: Props) {
  const [status, setStatus] = useState<MessagingStatus | null>(null);
  const [people, setPeople] = useState<LinkedPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryContact[] | null>(null);
  const [suggestions, setSuggestions] = useState<LinkSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow search landing after a newer one.
  const searchId = useRef(0);

  const load = useCallback(async () => {
    const [nextStatus, nextPeople, nextSuggestions] = await Promise.all([
      api.messagingStatus(),
      api.eventPeople(eventId),
      api.eventPeopleSuggestions(eventId),
    ]);
    setStatus(nextStatus);
    setPeople(nextPeople.people);
    setSuggestions(nextSuggestions.suggestions);
  }, [eventId]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    load()
      .catch((cause: unknown) => {
        if (live) setError(describe(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [load]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY || status?.canReadContacts !== true) {
      setResults(null);
      return;
    }
    const id = (searchId.current += 1);
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .searchContacts(trimmed)
        .then((response) => {
          if (searchId.current === id) setResults(response.contacts);
        })
        .catch((cause: unknown) => {
          if (searchId.current === id) setError(describe(cause));
        })
        .finally(() => {
          if (searchId.current === id) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, status?.canReadContacts]);

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await action();
      await load();
      onChanged();
    } catch (cause: unknown) {
      setError(describe(cause));
    } finally {
      setPending(false);
    }
  };

  const pick = (contact: DirectoryContact, normalized: string): void => {
    void act(() =>
      api.linkPerson(eventId, {
        handle: normalized,
        displayName: contact.displayName,
        contactId: contact.id,
      }),
    );
  };

  const linked = new Set(people.map((person) => person.link.handle));
  const disabled = busy || pending;

  return (
    <div className="field people">
      <span>
        With
        {people.length > 0 && <span className="badge count">{people.length}</span>}
      </span>

      {loading && <p className="people-empty">Checking for linked people...</p>}

      {!loading && people.length > 0 && (
        <ul className="people-list">
          {people.map(({ link, posture, lastInboundAt, lastOutboundAt }) => {
            const heard = lastInboundAt ?? lastOutboundAt;
            return (
              <li key={link.id}>
                <span className="person-name">{link.displayName}</span>
                <span className="person-handle">{link.handle}</span>
                <span className={`badge posture ${posture}`} title={POSTURE[posture].hint}>
                  {POSTURE[posture].label}
                </span>
                <span className="person-heard">
                  {heard === undefined ? '' : relativeDay(heard, Date.now(), timezone)}
                </span>
                <button
                  type="button"
                  className="icon ghost"
                  onClick={() => void act(() => api.unlinkPerson(link.id))}
                  disabled={disabled}
                  aria-label={`Unlink ${link.displayName}`}
                  title={`Unlink ${link.displayName}`}
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && people.length > 0 && (
        <p className="note">
          <Icon name="lock" size={15} />
          <span>
            Linked people make this a real commitment, so the scheduler will never move it on its
            own. Nobody is invited and no message is sent.
          </span>
        </p>
      )}

      {!loading && status?.canReadContacts === true && (
        <div className="people-search">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // This lives inside the entry form; Enter must not submit it.
              if (event.key === 'Enter') event.preventDefault();
            }}
            placeholder="Search your contacts"
            disabled={disabled}
          />
          {searching && <span className="people-hint">Searching...</span>}
        </div>
      )}

      {results !== null && results.length === 0 && !searching && (
        <p className="people-empty">No contact matches that name.</p>
      )}

      {!loading && suggestions.length > 0 && (
        <div className="people-suggestions">
          {suggestions.map((suggestion) => (
            <div key={suggestion.candidate} className="suggestion">
              <span className="people-hint">
                {suggestion.kind === 'unique'
                  ? `The title mentions ${suggestion.candidate}`
                  : `Which ${suggestion.candidate}?`}
              </span>
              <ContactList
                contacts={suggestion.contacts}
                linked={linked}
                disabled={disabled}
                onPick={pick}
              />
            </div>
          ))}
        </div>
      )}

      {results !== null && results.length > 0 && (
        <ContactList contacts={results} linked={linked} disabled={disabled} onPick={pick} />
      )}

      {!loading && status !== null && !status.canReadContacts && (
        <p className="note">
          <Icon name="alert" size={15} />
          <span>
            {status.detail ??
              'Contacts are unavailable. Start the local bridge with "npm run bridge" to link people to this event.'}
          </span>
        </p>
      )}

      {error && (
        <p className="warn error">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

/** One row per contact, one chip per way to reach them. */
function ContactList({
  contacts,
  linked,
  disabled,
  onPick,
}: {
  contacts: DirectoryContact[];
  linked: Set<string>;
  disabled: boolean;
  onPick: (contact: DirectoryContact, normalized: string) => void;
}) {
  return (
    <ul className="contact-results">
      {contacts.map((contact) => (
        <li key={contact.id}>
          <span className="contact-name">{contact.displayName}</span>
          <span className="contact-handles">
            {contact.handles.length === 0 && (
              <span className="people-hint">no phone or email</span>
            )}
            {contact.handles.map((handle) => (
              <button
                key={handle.normalized}
                type="button"
                className="handle-chip"
                disabled={disabled || linked.has(handle.normalized)}
                title={
                  linked.has(handle.normalized)
                    ? 'Already linked to this event'
                    : `Link ${contact.displayName} on ${handle.value}`
                }
                onClick={() => onPick(contact, handle.normalized)}
              >
                <Icon name={handle.kind === 'email' ? 'send' : 'users'} size={13} />
                {handle.value}
                {handle.label && <span className="handle-label">{handle.label}</span>}
              </button>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
