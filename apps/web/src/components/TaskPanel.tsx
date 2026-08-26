import { useState } from 'react';
import type { DailyWindow, Task, TaskRisk, Weekday } from '../api';
import { WEEKDAYS, dateLabel, formatMinutes, relativeDay } from '../time';
import { Icon } from './Icon';

interface Props {
  tasks: Task[];
  risks: Map<string, TaskRisk>;
  timezone: string;
  now: number;
  busy: boolean;
  onCreate: (input: {
    title: string;
    estimatedMinutes: number;
    deadline?: string;
    priority: Task['priority'];
    preferredWindows?: DailyWindow[];
    preferredDays?: Weekday[];
  }) => void;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
  onSchedule: (id: string) => void;
}

/** `<input type="time">` gives "HH:MM"; the API speaks `{ hour, minute }`. */
function toTimeOfDay(value: string): { hour: number; minute: number } | undefined {
  const [hour, minute] = value.split(':').map(Number);
  if (hour === undefined || minute === undefined) return undefined;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  return { hour, minute };
}

const RISK_LABEL: Record<string, string> = {
  SAFE: 'on track',
  AT_RISK: 'at risk',
  CRITICAL: 'critical',
  IMPOSSIBLE: 'impossible',
};

export function TaskPanel({
  tasks,
  risks,
  timezone,
  now,
  busy,
  onCreate,
  onComplete,
  onDelete,
  onSchedule,
}: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [hours, setHours] = useState('1');
  const [deadline, setDeadline] = useState('');
  const [priority, setPriority] = useState<Task['priority']>('normal');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [days, setDays] = useState<Weekday[]>([]);

  const toggleDay = (day: Weekday): void =>
    setDays((current) =>
      current.includes(day) ? current.filter((entry) => entry !== day) : [...current, day],
    );

  // A window needs both ends; half of one is not a constraint the scheduler
  // can use, so it is simply not sent.
  const preferredWindow = (): DailyWindow | undefined => {
    if (!windowStart || !windowEnd) return undefined;
    const start = toTimeOfDay(windowStart);
    const end = toTimeOfDay(windowEnd);
    if (!start || !end) return undefined;
    return { start, end };
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (title.trim().length === 0) return;
    const window = preferredWindow();
    onCreate({
      title: title.trim(),
      estimatedMinutes: Math.max(5, Math.round(Number(hours) * 60)),
      ...(deadline ? { deadline: new Date(deadline).toISOString() } : {}),
      priority,
      ...(window ? { preferredWindows: [window] } : {}),
      ...(days.length > 0 ? { preferredDays: days } : {}),
    });
    setTitle('');
    setDeadline('');
    setWindowStart('');
    setWindowEnd('');
    setDays([]);
    setOpen(false);
  };

  return (
    <section className="panel tasks">
      <div className="panel-head">
        <h2>Tasks</h2>
        <span className="badge count">{tasks.length}</span>
        <span className="spacer" />
        <button
          className={open ? 'small' : 'small primary'}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <Icon name={open ? 'close' : 'plus'} size={14} />
          {open ? 'Cancel' : 'New task'}
        </button>
      </div>

      {open && (
        <form className="task-form" onSubmit={submit}>
          <label className="field">
            <span>What needs doing</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Finish distributed systems assignment"
              autoFocus
            />
          </label>
          <div className="row">
            <label className="field">
              <span>Hours</span>
              <input
                type="number"
                min="0.25"
                step="0.25"
                value={hours}
                onChange={(event) => setHours(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Priority</span>
              <select
                value={priority}
                onChange={(event) => setPriority(event.target.value as Task['priority'])}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Due</span>
            <input
              type="datetime-local"
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
            />
          </label>
          <div className="row">
            <label className="field">
              <span>Prefer between</span>
              <input
                type="time"
                value={windowStart}
                aria-label="Preferred window start"
                onChange={(event) => setWindowStart(event.target.value)}
              />
            </label>
            <label className="field">
              <span>and</span>
              <input
                type="time"
                value={windowEnd}
                aria-label="Preferred window end"
                onChange={(event) => setWindowEnd(event.target.value)}
              />
            </label>
          </div>
          <div className="field">
            <span>On these days</span>
            <div className="day-picker">
              {WEEKDAYS.map((day) => (
                <button
                  type="button"
                  key={day}
                  className={days.includes(day) ? 'day on' : 'day'}
                  aria-pressed={days.includes(day)}
                  onClick={() => toggleDay(day)}
                >
                  {day.slice(0, 3)}
                </button>
              ))}
            </div>
            <p className="field-hint">
              A preference, not a rule: the scheduler places the task here when it can and looks
              elsewhere when it cannot. Leave both empty for any time inside working hours.
            </p>
          </div>
          <div className="row actions">
            <button type="submit" className="primary" disabled={busy || title.trim().length === 0}>
              Add task
            </button>
          </div>
        </form>
      )}

      <ul className="task-list">
        {tasks.length === 0 && (
          <li className="empty">No open tasks. Add one and the scheduler will find time for it.</li>
        )}
        {tasks.map((task) => {
          const risk = risks.get(task.id);
          const remaining = task.estimatedMinutes - task.completedMinutes;
          const level = risk && risk.level !== 'SAFE' ? risk.level.toLowerCase() : '';
          return (
            <li key={task.id} className={`task ${level}`}>
              <span className="accent" />
              <div className="task-main">
                <span className="task-title">{task.title}</span>
                <span className="task-meta">
                  <Icon name="clock" size={13} />
                  {formatMinutes(remaining)} left
                  <span className="dot" />
                  {task.priority}
                  {task.deadline !== undefined && (
                    <>
                      <span className="dot" />
                      <span title={dateLabel(task.deadline, timezone)}>
                        due {relativeDay(task.deadline, now, timezone)}
                      </span>
                    </>
                  )}
                </span>
                {risk && risk.level !== 'SAFE' && (
                  <span className={`badge ${risk.level.toLowerCase()}`} title={risk.explanation}>
                    {RISK_LABEL[risk.level]}
                  </span>
                )}
              </div>
              <div className="task-actions">
                <button
                  className="icon small ghost"
                  onClick={() => onSchedule(task.id)}
                  disabled={busy}
                  aria-label={`Find time for ${task.title}`}
                  title="Find time for this task"
                >
                  <Icon name="sparkle" size={14} />
                </button>
                <button
                  className="icon small ghost"
                  onClick={() => onComplete(task.id)}
                  disabled={busy}
                  aria-label={`Mark ${task.title} complete`}
                  title="Mark complete"
                >
                  <Icon name="check" size={14} />
                </button>
                <button
                  className="icon small ghost"
                  onClick={() => onDelete(task.id)}
                  disabled={busy}
                  aria-label={`Delete ${task.title}`}
                  title="Delete"
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
