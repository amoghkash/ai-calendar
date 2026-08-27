import { useCallback, useEffect, useRef, useState } from 'react';
import type { TodayEntry, TodayView } from '../api';
import { api } from '../api';
import { formatMinutes, timeLabel } from '../time';
import { Icon } from './Icon';

interface Props {
  busy: boolean;
  /** Confirming or replying changes the calendar, so the shell re-reads. */
  onChanged: () => void;
  onOpenOutbox: () => void;
}

/**
 * How often the page re-reads itself.
 *
 * This is a page you leave open, and the things it reports - a reply arriving,
 * a meeting getting booked - happen on other people's schedules. The reply
 * poller runs every couple of minutes, so half a minute here is comfortably
 * inside that without being chatty.
 */
const REFRESH_MS = 30_000;

const POSTURE_LABEL: Record<string, string> = {
  unmentioned: 'not mentioned',
  awaiting_them: 'waiting on them',
  awaiting_me: 'your turn',
};

/**
 * The day, arranged around what needs deciding.
 *
 * The grid already answers "what is on my calendar". This answers "what wants
 * something from me": a lunch nobody has confirmed, a reply the agent could not
 * read, a proposal still waiting. Anything with nothing outstanding says so and
 * gets out of the way.
 */
export function AgendaPanel({ busy, onChanged, onOpenOutbox }: Props) {
  const [view, setView] = useState<TodayView | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when a background refresh fails; the last good view stays on screen. */
  const [stale, setStale] = useState(false);
  // The interval closure would otherwise capture the first render's `pending`.
  const pendingRef = useRef<string | null>(null);
  pendingRef.current = pending;

  const load = useCallback(async () => {
    setView(await api.today());
  }, []);

  useEffect(() => {
    let live = true;
    load()
      .then(() => {
        if (live) setStale(false);
      })
      .catch((cause: unknown) => {
        if (live) setError(describe(cause));
      });

    const tick = (): void => {
      if (!live) return;
      // Nothing changes while nobody is looking, and a request mid-action would
      // land on top of a press the user has already made.
      if (document.visibilityState !== 'visible') return;
      if (pendingRef.current !== null) return;
      load()
        .then(() => {
          if (live) setStale(false);
        })
        .catch(() => {
          // Keep the last good view rather than blanking the page; say so quietly.
          if (live) setStale(true);
        });
    };

    const timer = setInterval(tick, REFRESH_MS);
    // Coming back to the laptop is exactly when the page is most out of date.
    document.addEventListener('visibilitychange', tick);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  const confirm = async (entry: TodayEntry): Promise<void> => {
    setPending(entry.id);
    setError(null);
    try {
      await api.confirmMeeting(entry.id);
      await load();
      onChanged();
    } catch (cause: unknown) {
      setError(describe(cause));
    } finally {
      setPending(null);
    }
  };

  if (error && !view) {
    return (
      <section className="panel agenda">
        <p className="warn error">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      </section>
    );
  }
  if (!view) return <section className="panel agenda"><p className="empty">Loading...</p></section>;

  const tz = view.timezone;
  const upcoming = view.entries.filter((entry) => entry.end > view.now);
  const done = view.entries.filter((entry) => entry.end <= view.now);
  const freeMinutes = view.freeWindows.reduce(
    (total, window) => total + Math.round((window.end - window.start) / 60_000),
    0,
  );

  return (
    <section className="panel agenda">
      <div className="panel-head">
        <h2>Today</h2>
        <span className="spacer" />
        <span className="agenda-count">
          {view.entries.length === 0
            ? 'nothing scheduled'
            : `${view.entries.length} thing${view.entries.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {view.actions.length > 0 && (
        <div className="agenda-section">
          <h3>Needs you</h3>
          {view.actions.map((action) => (
            <div key={action.id} className={`agenda-action ${action.kind}`}>
              <div className="agenda-action-head">
                <span className="agenda-who">{action.person}</span>
                <span className="badge outreach-state">
                  {action.kind === 'unsent_draft' ? 'not sent' : 'needs you'}
                </span>
              </div>
              {action.note && <p className="agenda-note">{action.note}</p>}
              <p className="outreach-message">{action.summary}</p>
              <button type="button" onClick={onOpenOutbox} disabled={busy}>
                Open the Outbox
              </button>
            </div>
          ))}
        </div>
      )}

      {view.pendingChangeSetId && (
        <p className="note">
          <Icon name="sparkle" size={15} />
          <span>A proposed schedule is waiting for you in the right-hand panel.</span>
        </p>
      )}

      <div className="agenda-section">
        <h3>{upcoming.length > 0 ? 'Still to come' : 'Nothing left today'}</h3>
        {upcoming.length === 0 && done.length === 0 && (
          <p className="empty">Your day is clear.</p>
        )}
        {upcoming.map((entry) => (
          <article key={entry.id} className={`agenda-entry ${entry.kind}`}>
            <span className="agenda-time">
              {entry.isAllDay ? 'all day' : `${timeLabel(entry.start, tz)}`}
            </span>
            <div className="agenda-body">
              <span className="agenda-title">{entry.title}</span>
              {entry.people.length > 0 && (
                <span className="agenda-people">
                  with {entry.people.map((person) => person.name).join(', ')}
                  <span className="agenda-posture">
                    {POSTURE_LABEL[entry.people[0]!.posture] ?? entry.people[0]!.posture}
                  </span>
                </span>
              )}
              {entry.confirmation && (
                <span className="agenda-people">
                  {entry.confirmation.state === 'booked'
                    ? 'they confirmed'
                    : entry.confirmation.state === 'declined'
                      ? 'they cannot make it'
                      : `confirmation ${entry.confirmation.state.replace('_', ' ')}`}
                </span>
              )}
            </div>
            {entry.canConfirm && (
              <button
                type="button"
                className="agenda-confirm"
                disabled={busy || pending === entry.id}
                onClick={() => void confirm(entry)}
                title={`Text ${entry.people[0]?.name ?? 'them'} to ask if this still stands`}
              >
                <Icon name="send" size={14} />
                Ask if still on
              </button>
            )}
          </article>
        ))}
      </div>

      {done.length > 0 && (
        <div className="agenda-section">
          <h3>Earlier</h3>
          {done.map((entry) => (
            <article key={entry.id} className="agenda-entry past">
              <span className="agenda-time">{timeLabel(entry.start, tz)}</span>
              <div className="agenda-body">
                <span className="agenda-title">{entry.title}</span>
              </div>
            </article>
          ))}
        </div>
      )}

      {view.risks.length > 0 && (
        <div className="agenda-section">
          <h3>At risk</h3>
          {view.risks.map((risk) => (
            <p key={risk.taskId} className="agenda-risk">
              <span className={`badge ${risk.level.toLowerCase()}`}>
                {risk.level.replace('_', ' ').toLowerCase()}
              </span>
              {risk.explanation}
            </p>
          ))}
        </div>
      )}

      {stale && (
        <p className="agenda-stale">
          <Icon name="alert" size={13} />
          <span>Could not refresh just now - showing the last update.</span>
        </p>
      )}

      <p className="agenda-free">
        {freeMinutes > 0
          ? `${formatMinutes(freeMinutes)} free left today.`
          : 'No free time left today.'}
      </p>

      {error && (
        <p className="warn error">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
