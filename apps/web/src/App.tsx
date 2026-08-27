import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AppState,
  DataStats,
  PendingDeletion,
  PlanResult,
  Task,
  TaskRisk,
} from './api';
import { ApiError, api } from './api';
import { AgendaPanel } from './components/AgendaPanel';
import { DeletionToast } from './components/DeletionToast';
import { CalendarSettings } from './components/CalendarSettings';
import { OutboxPanel } from './components/OutboxPanel';
import { CategoryPanel } from './components/CategoryPanel';
import { DataPanel } from './components/DataPanel';
import { CalendarView } from './components/CalendarView';
import type { ChatMessage } from './components/ChatPanel';
import { AssistantDock } from './components/AssistantDock';
import type { EditorTarget } from './components/EntryEditor';
import { EntryEditor } from './components/EntryEditor';
import { Icon } from './components/Icon';
import { ProposalPanel } from './components/ProposalPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { TaskPanel } from './components/TaskPanel';
import { spanLabel, startOfWeek } from './time';

const DAY_MS = 86_400_000;

const VIEWS = [
  { days: 1, label: 'Day' },
  { days: 3, label: '3 days' },
  { days: 7, label: 'Week' },
] as const;

type RailTab = 'tasks' | 'calendars' | 'outbox';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [proposal, setProposal] = useState<PlanResult | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [daysToShow, setDaysToShow] = useState(7);
  const [offsetDays, setOffsetDays] = useState(0);
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const [dataStats, setDataStats] = useState<DataStats | null>(null);
  const [dataResult, setDataResult] = useState<string | null>(null);
  const [rail, setRail] = useState<RailTab>('tasks');
  // The glance page answers "what wants something from me"; the grid answers
  // "what is on my calendar". Different questions, so a separate view.
  const [mainView, setMainView] = useState<'grid' | 'agenda'>('grid');
  // Deletions are deferred for a few seconds; this is the only way back.
  const [pendingDeletions, setPendingDeletions] = useState<PendingDeletion[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Transient view state, not a stored preference: a moment, not a setting.
  const [hidden, setHidden] = useState({ left: false, right: false });
  const [assistantOpen, setAssistantOpen] = useState(false);
  // Distinct from `busy`, which is true for any mutation: only a chat turn in
  // flight should show the assistant thinking.
  const [thinking, setThinking] = useState(false);
  // Threads every turn onto the same conversation, so a follow-up like "make it
  // an hour" is resolved against what was already said.
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const next = await api.state();
    setState(next);
    return next;
  }, []);

  useEffect(() => {
    refresh().catch((cause: unknown) => setError(describe(cause)));
  }, [refresh]);

  // Escape brings the panels back, but only once nothing nearer the front is
  // listening for it: the editor, the settings dialog and the assistant all
  // dismiss on Escape and each should get it first.
  const anyHidden = hidden.left || hidden.right;
  const bothHidden = hidden.left && hidden.right;
  useEffect(() => {
    if (!anyHidden) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (editing || settingsOpen || assistantOpen) return;
      setHidden({ left: false, right: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anyHidden, editing, settingsOpen, assistantOpen]);

  const guard = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const riskByTask = useMemo(
    () => new Map((state?.risks ?? []).map((risk: TaskRisk) => [risk.taskId, risk])),
    [state],
  );
  const taskTitles = useMemo(
    () => new Map((state?.tasks ?? []).map((task: Task) => [task.id, task.title])),
    [state],
  );

  // The visible window, derived before the loading guard so the fetch effect
  // below can depend on it. Hooks may not live after a conditional return.
  const now = state?.now;
  const timezone = state?.timezone;
  const weekStart = state?.weekStart;
  const windowStart = useMemo(() => {
    if (now === undefined || timezone === undefined) return undefined;
    const anchor = now + offsetDays * DAY_MS;
    return daysToShow === 7 && weekStart === 'sunday' ? startOfWeek(anchor, timezone) : anchor;
  }, [now, timezone, weekStart, offsetDays, daysToShow]);

  /**
   * Load the days actually on screen.
   *
   * `/state` only ships a forward horizon, so without this the grid can never
   * show anything that already happened - not this morning, and not last week.
   */
  useEffect(() => {
    if (windowStart === undefined) return;
    let live = true;
    // A day either side, so a drag or a timezone edge never lands on a gap.
    const from = windowStart - DAY_MS;
    const to = windowStart + (daysToShow + 1) * DAY_MS;
    api
      .agenda(from, to)
      .then((agenda) => {
        if (!live) return;
        setState((current) =>
          current === null ? current : { ...current, events: agenda.events, blocks: agenda.blocks },
        );
      })
      .catch((cause: unknown) => {
        if (live) setError(describe(cause));
      });
    return () => {
      live = false;
    };
  }, [windowStart, daysToShow]);

  if (!state) {
    return (
      <div className="loading">
        <div className="brand">
          <span className="mark">ca</span>
          <h1 className="display-sm">calendar-agent</h1>
        </div>
        {error ? <p className="warn error">{error}</p> : <p>Connecting to your schedule...</p>}
      </div>
    );
  }

  const plan = (taskIds?: string[]) =>
    guard(async () => {
      const result = await api.plan(taskIds ? { taskIds } : {});
      setProposal(result);
    });

  const approve = () =>
    guard(async () => {
      if (!proposal) return;
      const result = await api.apply(proposal.changeSetId);
      if (result.failures.length > 0) {
        setError(result.failures.map((failure) => failure.error).join('; '));
      }
      setProposal(null);
      await refresh();
    });

  const reject = () =>
    guard(async () => {
      if (!proposal) return;
      await api.reject(proposal.changeSetId);
      setProposal(null);
    });

  const send = (text: string) =>
    guard(async () => {
      setMessages((current) => [...current, { role: 'user', content: text }]);
      setThinking(true);
      try {
        const reply = await api.message(text, conversationId);
        // The agent can delete, so check whether this turn started one.
        void api
          .deletions()
          .then((result) => setPendingDeletions(result.pending))
          .catch(() => undefined);
        setConversationId(reply.conversationId);
        setMessages((current) => [...current, { role: 'assistant', content: reply.reply }]);
        if (reply.changeSetId && reply.plan && reply.changeSet) {
          setProposal({
            changeSetId: reply.changeSetId,
            plan: reply.plan,
            changeSet: reply.changeSet,
            tasks: state.tasks,
          });
        }
      } finally {
        setThinking(false);
      }
      await refresh();
    });

  const sync = () =>
    guard(async () => {
      const report = await api.sync();
      if (report.errors.length > 0) setError(report.errors.map((e) => e.message).join('; '));
      await refresh();
      if (report.needsReplan) {
        const result = await api.plan();
        setProposal(result);
        setMessages((current) => [
          ...current,
          {
            role: 'assistant',
            content:
              'Your calendar changed outside the app. I re-planned around it - review the proposed changes.',
          },
        ]);
      }
    });

  // Every mutation refreshes state, so the grid always reflects the server.
  const mutate = (action: () => Promise<unknown>) =>
    guard(async () => {
      await action();
      setEditing(null);
      await refresh();
    });

  // The week view can either roll forward from today or sit on a calendar week.
  // Day and 3-day views always roll, since aligning them has no meaning.
  const startInstant = windowStart ?? state.now;
  const notableRisks = state.risks.filter((risk) => risk.level !== 'SAFE');
  const visibleCalendars = state.calendars.filter((calendar) => calendar.selected).length;

  return (
    <div className={`app ${hidden.left ? 'hide-left' : ''} ${hidden.right ? 'hide-right' : ''}`}>
      <header className="top-nav">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            ca
          </span>
          <h1>calendar-agent</h1>
        </div>

        <div className="date-nav">
          <div className="stepper">
            <button
              className="icon"
              onClick={() => setOffsetDays((value) => value - daysToShow)}
              aria-label="Previous period"
              title="Previous period"
            >
              <Icon name="chevron-left" />
            </button>
            <button
              className="icon"
              onClick={() => setOffsetDays((value) => value + daysToShow)}
              aria-label="Next period"
              title="Next period"
            >
              <Icon name="chevron-right" />
            </button>
          </div>
          <button className="small" onClick={() => setOffsetDays(0)} disabled={offsetDays === 0}>
            Today
          </button>
          <span className="range-label">{spanLabel(startInstant, daysToShow, state.timezone)}</span>
        </div>

        <div className="nav-actions">
          <div className="pill-group" role="group" aria-label="Days to show">
            <button aria-pressed={mainView === 'agenda'} onClick={() => setMainView('agenda')}>
              Today
            </button>
            {VIEWS.map((view) => (
              <button
                key={view.days}
                aria-pressed={mainView === 'grid' && daysToShow === view.days}
                onClick={() => {
                  setMainView('grid');
                  setDaysToShow(view.days);
                }}
              >
                {view.label}
              </button>
            ))}
          </div>
          <button onClick={sync} disabled={busy} title="Pull changes from your calendars">
            <Icon name="sync" />
            Sync
          </button>
          <button
            className="primary"
            onClick={() => plan()}
            disabled={busy}
            title="Find time for every open task"
          >
            <Icon name="sparkle" />
            Plan everything
          </button>
          <div className="pill-group" role="group" aria-label="Side panels">
            <button
              aria-pressed={!hidden.left}
              onClick={() => setHidden((value) => ({ ...value, left: !value.left }))}
              aria-label={hidden.left ? 'Show the tasks panel' : 'Hide the tasks panel'}
              title={hidden.left ? 'Show the tasks panel' : 'Hide the tasks panel'}
            >
              <Icon name="panel-left" size={15} />
            </button>
            <button
              aria-pressed={!hidden.right}
              onClick={() => setHidden((value) => ({ ...value, right: !value.right }))}
              aria-label={hidden.right ? 'Show the proposal panel' : 'Hide the proposal panel'}
              title={hidden.right ? 'Show the proposal panel' : 'Hide the proposal panel'}
            >
              <Icon name="panel-right" size={15} />
            </button>
          </div>
          <button
            className="icon"
            onClick={() =>
              setHidden(bothHidden ? { left: false, right: false } : { left: true, right: true })
            }
            aria-pressed={bothHidden}
            aria-label={bothHidden ? 'Show both panels' : 'Full-screen the calendar'}
            title={
              bothHidden ? 'Show both panels (Esc)' : 'Full-screen the calendar (hide both panels)'
            }
          >
            <Icon name={bothHidden ? 'collapse' : 'expand'} />
          </button>
          <button
            className="icon"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title="Settings"
          >
            <Icon name="settings" />
          </button>
        </div>
      </header>

      {error && (
        <div className="banner" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
          <button className="small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <main>
        <aside className="rail rail-left">
          <div className="rail-tabs">
            <div className="pill-group" role="group" aria-label="Sidebar section">
              <button aria-pressed={rail === 'tasks'} onClick={() => setRail('tasks')}>
                Tasks
              </button>
              <button aria-pressed={rail === 'calendars'} onClick={() => setRail('calendars')}>
                Calendars
              </button>
              <button aria-pressed={rail === 'outbox'} onClick={() => setRail('outbox')}>
                Outbox
              </button>
            </div>
          </div>

          {rail === 'tasks' ? (
            <>
              <TaskPanel
                tasks={state.tasks}
                risks={riskByTask}
                timezone={state.timezone}
                now={state.now}
                busy={busy}
                onCreate={(input) =>
                  guard(async () => {
                    await api.createTask(input as never);
                    await refresh();
                  })
                }
                onComplete={(id) =>
                  guard(async () => {
                    await api.completeTask(id);
                    await refresh();
                  })
                }
                onDelete={(id) =>
                  guard(async () => {
                    await api.deleteTask(id);
                    await refresh();
                  })
                }
                onSchedule={(id) => plan([id])}
              />
              <RiskPanel risks={notableRisks} />
            </>
          ) : rail === 'outbox' ? (
            <OutboxPanel
              timezone={state.timezone}
              busy={busy}
              // Booking an accepted time writes an event, so the grid re-reads.
              onChanged={() => {
                void refresh().catch((cause: unknown) => setError(describe(cause)));
              }}
            />
          ) : (
            <>
              <CalendarSettings
                calendars={state.calendars}
                busy={busy}
                onChange={(id, changes) => mutate(() => api.updateCalendar(id, changes))}
              />
              <CategoryPanel
                categories={state.categories}
                busy={busy}
                onCreate={(input) => mutate(() => api.createCategory(input))}
                onUpdate={(id, changes) => mutate(() => api.updateCategory(id, changes))}
                onDelete={(id) => mutate(() => api.deleteCategory(id))}
              />
              <DataPanel
                stats={dataStats}
                busy={busy}
                lastResult={dataResult}
                onRefresh={() =>
                  guard(async () => {
                    setDataStats(await api.dataStats());
                  })
                }
                onPrune={(days, dryRun) =>
                  guard(async () => {
                    const report = await api.prune({ days, dryRun });
                    setDataResult(
                      `${dryRun ? 'Would remove' : 'Removed'}: ${JSON.stringify(report, null, 2)}`,
                    );
                    setDataStats(await api.dataStats());
                    if (!dryRun) await refresh();
                  })
                }
                onReset={(scopes, confirm) =>
                  guard(async () => {
                    const report = await api.reset(scopes, confirm, !confirm);
                    setDataResult(
                      `${report.dryRun ? 'Would delete' : 'Deleted'}: ${JSON.stringify(report.deleted, null, 2)}`,
                    );
                    setDataStats(await api.dataStats());
                    if (confirm) await refresh();
                  })
                }
              />
            </>
          )}
        </aside>

        <section className="center">
          {mainView === 'agenda' ? (
            <AgendaPanel
              busy={busy}
              onChanged={() => {
                void refresh().catch((cause: unknown) => setError(describe(cause)));
              }}
              onOpenOutbox={() => setRail('outbox')}
            />
          ) : (
          <CalendarView
            state={state}
            calendars={state.calendars}
            daysToShow={daysToShow}
            startInstant={startInstant}
            riskByTask={riskByTask}
            taskTitles={taskTitles}
            onOpen={setEditing}
            onMoveBlock={(id, start, end) => mutate(() => api.moveBlock(id, start, end))}
            onMoveEvent={(id, start, end) => mutate(() => api.updateEvent(id, { start, end }))}
            {...(proposal
              ? {
                  proposedBlocks: proposal.plan.diff.added
                    .concat(proposal.plan.diff.moved)
                    .map((entry) => ({
                      id: entry.blockId,
                      taskId: entry.taskId,
                      start: entry.after!.start,
                      end: entry.after!.end,
                    })),
                }
              : {})}
          />
          )}
          {mainView === 'grid' && <Legend />}
        </section>

        <aside className="rail rail-right">
          <ProposalPanel
            proposal={proposal}
            timezone={state.timezone}
            busy={busy}
            onApprove={approve}
            onReject={reject}
          />
        </aside>
      </main>

      <footer className="app-footer">
        <span className="wordmark">calendar-agent</span>
        <span className="sep" />
        <span>
          {state.tasks.length} open {state.tasks.length === 1 ? 'task' : 'tasks'} ·{' '}
          {state.blocks.length} scheduled {state.blocks.length === 1 ? 'block' : 'blocks'}
        </span>
        <div className="foot-meta">
          <span title="How much the agent may change without asking">
            Automation <b>{state.automationMode.replace('_', '-')}</b>
          </span>
          <span title="Calendars shown on the grid">
            Calendars <b>{visibleCalendars}</b>
          </span>
          <span title="Scheduling never depends on an LLM">
            Language model{' '}
            <b>{state.llm.provider === 'none' ? 'off (rule parser)' : state.llm.model}</b>
          </span>
          <span>{state.timezone}</span>
        </div>
      </footer>

      <AssistantDock
        messages={messages}
        busy={busy}
        thinking={thinking}
        llm={state.llm}
        open={assistantOpen}
        onOpenChange={setAssistantOpen}
        onSend={send}
      />

      {settingsOpen && (
        <SettingsDialog
          preferences={state.preferences}
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => {
            await refresh();
          }}
        />
      )}

      <DeletionToast
        pending={pendingDeletions}
        busy={busy}
        onUndo={(token) =>
          guard(async () => {
            await api.undoDeletion(token);
            setPendingDeletions((current) => current.filter((item) => item.token !== token));
            await refresh();
          })
        }
        onEmpty={() => {
          // The window has closed; the event is gone and the grid should say so.
          setPendingDeletions([]);
          void refresh().catch(() => undefined);
        }}
      />

      {editing && (
        <EntryEditor
          target={editing}
          calendars={state.calendars}
          timezone={state.timezone}
          busy={busy}
          onClose={() => setEditing(null)}
          onCreate={(input) => mutate(() => api.createEvent(input))}
          onUpdateEvent={(id, changes) => mutate(() => api.updateEvent(id, changes))}
          onDeleteEvent={(id, notify) =>
            // Deferred, like the agent's: the toast is the way back.
            guard(async () => {
              const pending = await api.deleteEventSoon(id, notify);
              setPendingDeletions((current) => [...current, pending]);
              setEditing(null);
              await refresh();
            })
          }
          onMoveBlock={(id, start, end) => mutate(() => api.moveBlock(id, start, end))}
          onPinBlock={(id, pinned) => mutate(() => api.pinBlock(id, pinned))}
          onDeleteBlock={(id) => mutate(() => api.deleteBlock(id))}
          // Refresh without closing: linking several people in a row is normal,
          // and the editor should stay put while the grid picks up the change.
          onPeopleChanged={() => {
            void refresh().catch((cause: unknown) => setError(describe(cause)));
          }}
        />
      )}
    </div>
  );
}

function RiskPanel({ risks }: { risks: TaskRisk[] }) {
  return (
    <section className="panel risks">
      <div className="panel-head">
        <h2>Deadline risk</h2>
        <span className="spacer" />
        {risks.length > 0 && <span className="badge count">{risks.length}</span>}
      </div>
      {risks.length === 0 ? (
        <p className="empty">Everything is on track.</p>
      ) : (
        <ul className="risk-list">
          {risks.map((risk) => (
            <li key={risk.taskId}>
              <span className="risk-title">{risk.title}</span>
              <span className={`badge ${risk.level.toLowerCase()}`}>
                {risk.level.replace('_', ' ').toLowerCase()}
              </span>
              <span>{risk.explanation}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Legend() {
  const items = [
    { className: 'event', label: 'Calendar event' },
    { className: 'block', label: 'Task block' },
    { className: 'proposal', label: 'Proposed' },
    { className: 'deep', label: 'Deep work' },
    { className: 'unavailable', label: 'Outside working hours' },
  ];
  return (
    <div className="legend">
      {items.map((item) => (
        <span className="item" key={item.className}>
          <span className={`swatch ${item.className}`} />
          {item.label}
        </span>
      ))}
      <span className="item" style={{ marginLeft: 'auto' }}>
        Drag empty space to block out time · drag an entry to move it · drag its edges to resize
      </span>
    </div>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
