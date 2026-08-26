import type { Calendar } from '../api';
import { Icon } from './Icon';

interface Props {
  calendars: Calendar[];
  busy: boolean;
  onChange: (id: string, changes: Partial<Calendar>) => void;
}

/**
 * Which calendars are shown, which of them consume time when planning, and
 * which one receives scheduled task blocks. These are three different
 * questions, so they get three different controls.
 */
export function CalendarSettings({ calendars, busy, onChange }: Props) {
  if (calendars.length === 0) {
    return (
      <section className="panel calendars">
        <div className="panel-head">
          <h2>Calendars</h2>
        </div>
        <p className="empty">No calendars connected yet.</p>
        <p className="hint">
          Open <code>/api/oauth/google/start</code> to connect Google Calendar, or{' '}
          <code>/api/oauth/microsoft/start</code> for Outlook.
        </p>
      </section>
    );
  }

  return (
    <section className="panel calendars">
      <div className="panel-head">
        <h2>Calendars</h2>
        <span className="spacer" />
        <span className="badge count">{calendars.length}</span>
      </div>
      <p className="hint">
        <strong>Show</strong> displays it here. <strong>Busy</strong> means its events block time
        when planning. <strong>Tasks</strong> is where scheduled blocks are written.
      </p>

      <div className="calendar-rows">
        <div className="col-heads">
          <span />
          <span>Show</span>
          <span>Busy</span>
          <span>Tasks</span>
        </div>

        {calendars.map((calendar) => (
          <CalendarRow key={calendar.id} calendar={calendar} busy={busy} onChange={onChange} />
        ))}
      </div>
    </section>
  );
}

function CalendarRow({
  calendar,
  busy,
  onChange,
}: {
  calendar: Calendar;
  busy: boolean;
  onChange: (id: string, changes: Partial<Calendar>) => void;
}) {
  return (
    <div className="calendar-row">
      <span className="calendar-name" title={`${calendar.name} (${calendar.provider})`}>
        <span
          className="dot"
          style={{ background: calendar.color ?? 'var(--surface-strong)' }}
          aria-hidden="true"
        />
        <span className="label">{calendar.name}</span>
        {!calendar.isWritable && (
          <span className="lock" title="Read-only calendar">
            <Icon name="lock" size={13} />
          </span>
        )}
      </span>

      <input
        type="checkbox"
        aria-label={`Show ${calendar.name}`}
        checked={calendar.selected}
        disabled={busy}
        onChange={(event) => onChange(calendar.id, { selected: event.target.checked })}
      />

      <input
        type="checkbox"
        aria-label={`${calendar.name} blocks time`}
        checked={calendar.includeInAvailability}
        disabled={busy || !calendar.selected}
        title={
          calendar.selected
            ? 'Count these events as busy when planning'
            : 'Hidden calendars never block time'
        }
        onChange={(event) => onChange(calendar.id, { includeInAvailability: event.target.checked })}
      />

      <input
        type="radio"
        name="task-target"
        aria-label={`Write task blocks to ${calendar.name}`}
        checked={calendar.isTaskTarget}
        disabled={busy || !calendar.isWritable}
        title={
          calendar.isWritable
            ? 'Write scheduled task blocks here'
            : 'This calendar cannot be written to'
        }
        onChange={() => onChange(calendar.id, { isTaskTarget: true })}
      />
    </div>
  );
}
