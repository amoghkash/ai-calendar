import { useState } from 'react';
import type { DailyWindow, Task, TaskRisk, Weekday } from '../api';
import {
  WEEKDAYS,
  dateLabel,
  formatMinutes,
  fromLocalInputValue,
  relativeDay,
  toLocalInputValue,
} from '../time';
import { Icon } from './Icon';

/** The fields the form collects, shared by the create and edit paths. */
export interface TaskFormValues {
  title: string;
  estimatedMinutes: number;
  deadline?: string;
  priority: Task['priority'];
  preferredWindows?: DailyWindow[];
  preferredDays?: Weekday[];
  /** Hours per day, or null to lift an existing cap. */
  maxDailyMinutes?: number | null;
}

interface Props {
  tasks: Task[];
  /** Completed and cancelled tasks. `null` until the done view first loads. */
  archive: Task[] | null;
  archiveLoading: boolean;
  risks: Map<string, TaskRisk>;
  timezone: string;
  now: number;
  busy: boolean;
  onCreate: (input: TaskFormValues) => void;
  onUpdate: (id: string, input: TaskFormValues) => void;
  onComplete: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
  onSchedule: (id: string) => void;
  onLoadArchive: () => void;
}

/** `<input type="time">` gives "HH:MM"; the API speaks `{ hour, minute }`. */
function toTimeOfDay(value: string): { hour: number; minute: number } | undefined {
  const [hour, minute] = value.split(':').map(Number);
  if (hour === undefined || minute === undefined) return undefined;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  return { hour, minute };
}

/** `{ hour, minute }` back to the "HH:MM" an `<input type="time">` wants. */
const toTimeInput = (time: { hour: number; minute: number }): string =>
  `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;

const RISK_LABEL: Record<string, string> = {
  SAFE: 'on track',
  AT_RISK: 'at risk',
  CRITICAL: 'critical',
  IMPOSSIBLE: 'impossible',
};

/** Blank form state, i.e. what "New task" opens with. */
const EMPTY = {
  title: '',
  hours: '1',
  deadline: '',
  priority: 'normal' as Task['priority'],
  windowStart: '',
  windowEnd: '',
  days: [] as Weekday[],
  maxDaily: '3',
};

export function TaskPanel({
  tasks,
  archive,
  archiveLoading,
  risks,
  timezone,
  now,
  busy,
  onCreate,
  onUpdate,
  onComplete,
  onReopen,
  onDelete,
  onSchedule,
  onLoadArchive,
}: Props) {
  const [view, setView] = useState<'open' | 'done'>('open');
  // `null` = closed, '' = creating, an id = editing that task.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);

  const set = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]): void =>
    setForm((current) => ({ ...current, [key]: value }));

  const toggleDay = (day: Weekday): void =>
    setForm((current) => ({
      ...current,
      days: current.days.includes(day)
        ? current.days.filter((entry) => entry !== day)
        : [...current.days, day],
    }));

  const close = (): void => {
    setEditing(null);
    setForm(EMPTY);
  };

  const openCreate = (): void => {
    if (editing === '') {
      close();
      return;
    }
    setForm(EMPTY);
    setEditing('');
  };

  /** Load a task into the form. The inverse of `submit` below. */
  const openEdit = (task: Task): void => {
    if (editing === task.id) {
      close();
      return;
    }
    const window = task.preferredWindows[0];
    setForm({
      title: task.title,
      hours: String(task.estimatedMinutes / 60),
      deadline: task.deadline === undefined ? '' : toLocalInputValue(task.deadline, timezone),
      priority: task.priority,
      windowStart: window ? toTimeInput(window.start) : '',
      windowEnd: window ? toTimeInput(window.end) : '',
      days: [...task.preferredDays],
      maxDaily:
        task.maxDailyMinutes === undefined ? '' : String(task.maxDailyMinutes / 60),
    });
    setEditing(task.id);
  };

  // A window needs both ends; half of one is not a constraint the scheduler
  // can use, so it is simply not sent.
  const preferredWindow = (): DailyWindow | undefined => {
    if (!form.windowStart || !form.windowEnd) return undefined;
    const start = toTimeOfDay(form.windowStart);
    const end = toTimeOfDay(form.windowEnd);
    if (!start || !end) return undefined;
    return { start, end };
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (form.title.trim().length === 0) return;
    const window = preferredWindow();
    const values: TaskFormValues = {
      title: form.title.trim(),
      estimatedMinutes: Math.max(5, Math.round(Number(form.hours) * 60)),
      priority: form.priority,
      // On edit these must be sent even when empty, so that clearing a
      // constraint in the form actually removes it from the task.
      ...(form.deadline
        ? { deadline: new Date(fromLocalInputValue(form.deadline, timezone)).toISOString() }
        : {}),
      ...(window ? { preferredWindows: [window] } : { preferredWindows: [] }),
      preferredDays: form.days,
      // null rather than omitted, so clearing the box lifts the cap.
      maxDailyMinutes:
        form.maxDaily.trim() === ''
          ? null
          : Math.max(1, Math.round(Number(form.maxDaily) * 60)),
    };
    if (editing !== null && editing !== '') onUpdate(editing, values);
    else onCreate(values);
    close();
  };

  const showDone = (): void => {
    setView('done');
    close();
    onLoadArchive();
  };

  const doneCount = archive?.length;

  return (
    <section className="panel tasks">
      <div className="panel-head">
        <h2>Tasks</h2>
        <span className="badge count">{view === 'open' ? tasks.length : (doneCount ?? '-')}</span>
        <span className="spacer" />
        {view === 'open' && (
          <button
            className={editing === '' ? 'small' : 'small primary'}
            onClick={openCreate}
            aria-expanded={editing === ''}
          >
            <Icon name={editing === '' ? 'close' : 'plus'} size={14} />
            {editing === '' ? 'Cancel' : 'New task'}
          </button>
        )}
      </div>

      <div className="task-views" role="tablist">
        <button
          role="tab"
          aria-selected={view === 'open'}
          className={view === 'open' ? 'on' : ''}
          onClick={() => {
            setView('open');
            close();
          }}
        >
          Open
        </button>
        <button
          role="tab"
          aria-selected={view === 'done'}
          className={view === 'done' ? 'on' : ''}
          onClick={showDone}
        >
          Done
        </button>
      </div>

      {view === 'open' && editing !== null && (
        <form className="task-form" onSubmit={submit}>
          <label className="field">
            <span>What needs doing</span>
            <input
              value={form.title}
              onChange={(event) => set('title', event.target.value)}
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
                value={form.hours}
                onChange={(event) => set('hours', event.target.value)}
              />
            </label>
            <label className="field">
              <span>Priority</span>
              <select
                value={form.priority}
                onChange={(event) => set('priority', event.target.value as Task['priority'])}
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
              value={form.deadline}
              onChange={(event) => set('deadline', event.target.value)}
            />
          </label>
          <label className="field">
            <span>Most per day</span>
            <input
              type="number"
              min="0.25"
              step="0.25"
              placeholder="No limit"
              value={form.maxDaily}
              onChange={(event) => set('maxDaily', event.target.value)}
            />
            <p className="field-hint">
              Hours of this task the scheduler may place on any one day. Leave empty to let it
              use whatever time it finds.
            </p>
          </label>
          <div className="row">
            <label className="field">
              <span>Prefer between</span>
              <input
                type="time"
                value={form.windowStart}
                aria-label="Preferred window start"
                onChange={(event) => set('windowStart', event.target.value)}
              />
            </label>
            <label className="field">
              <span>and</span>
              <input
                type="time"
                value={form.windowEnd}
                aria-label="Preferred window end"
                onChange={(event) => set('windowEnd', event.target.value)}
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
                  className={form.days.includes(day) ? 'day on' : 'day'}
                  aria-pressed={form.days.includes(day)}
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
            <button
              type="submit"
              className="primary"
              disabled={busy || form.title.trim().length === 0}
            >
              {editing === '' ? 'Add task' : 'Save changes'}
            </button>
            {editing !== '' && (
              <button type="button" onClick={close}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {view === 'open' ? (
        <ul className="task-list">
          {tasks.length === 0 && (
            <li className="empty">
              No open tasks. Add one and the scheduler will find time for it.
            </li>
          )}
          {tasks.map((task) => {
            const risk = risks.get(task.id);
            const remaining = task.estimatedMinutes - task.completedMinutes;
            const level = risk && risk.level !== 'SAFE' ? risk.level.toLowerCase() : '';
            return (
              <li key={task.id} className={`task ${level} ${editing === task.id ? 'editing' : ''}`}>
                <span className="accent" />
                <div className="task-main">
                  <span className="task-title">{task.title}</span>
                  <span className="task-meta">
                    <Icon name="clock" size={13} />
                    {formatMinutes(remaining)} left
                    <span className="dot" />
                    {task.priority}
                    {task.maxDailyMinutes !== undefined && (
                      <>
                        <span className="dot" />
                        <span title="Most of this task the scheduler will place on one day">
                          max {formatMinutes(task.maxDailyMinutes)}/day
                        </span>
                      </>
                    )}
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
                    onClick={() => openEdit(task)}
                    disabled={busy}
                    aria-label={`Edit ${task.title}`}
                    aria-expanded={editing === task.id}
                    title="Edit"
                  >
                    <Icon name="pencil" size={14} />
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
      ) : (
        <DoneList
          archive={archive}
          loading={archiveLoading}
          timezone={timezone}
          now={now}
          busy={busy}
          onReopen={onReopen}
        />
      )}
    </section>
  );
}

/**
 * The record of finished work. Newest first, because the question this answers
 * is usually "what did I get done recently".
 */
function DoneList({
  archive,
  loading,
  timezone,
  now,
  busy,
  onReopen,
}: {
  archive: Task[] | null;
  loading: boolean;
  timezone: string;
  now: number;
  busy: boolean;
  onReopen: (id: string) => void;
}) {
  if (loading && archive === null) {
    return <p className="task-archive-note">Loading...</p>;
  }
  if (archive === null || archive.length === 0) {
    return (
      <p className="task-archive-note">
        Nothing finished yet. Completed tasks are kept here for good.
      </p>
    );
  }

  const logged = archive.reduce((total, task) => total + task.completedMinutes, 0);
  const done = (task: Task): number => task.completedAt ?? task.updatedAt;
  const sorted = [...archive].sort((a, b) => done(b) - done(a));

  return (
    <>
      <p className="task-archive-note">
        {archive.length} {archive.length === 1 ? 'task' : 'tasks'} · {formatMinutes(logged)} logged
      </p>
      <ul className="task-list archive">
        {sorted.map((task) => (
          <li key={task.id} className={`task done ${task.status}`}>
            <span className="accent" />
            <div className="task-main">
              <span className="task-title">{task.title}</span>
              <span className="task-meta">
                <Icon name="check" size={13} />
                {task.status === 'cancelled' ? 'cancelled' : formatMinutes(task.completedMinutes)}
                <span className="dot" />
                <span title={dateLabel(done(task), timezone)}>
                  {relativeDay(done(task), now, timezone)}
                </span>
                <span className="dot" />
                {task.priority}
              </span>
            </div>
            <div className="task-actions">
              <button
                className="icon small ghost"
                onClick={() => onReopen(task.id)}
                disabled={busy}
                aria-label={`Reopen ${task.title}`}
                title="Reopen this task"
              >
                <Icon name="undo" size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
