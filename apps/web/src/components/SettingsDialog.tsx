import { useEffect, useMemo, useState } from 'react';
import type {
  ClassificationRule,
  DailyWindow,
  EventClassification,
  LogLevel,
  MovePolicy,
  Preferences,
  SettingsView,
  WeekStart,
  WeeklySchedule,
} from '../api';
import { ApiError, api } from '../api';
import { WEEKDAYS } from '../time';
import { Icon } from './Icon';

interface Props {
  preferences: Preferences;
  onClose: () => void;
  /** Called after a successful save so the app can reload its state. */
  onSaved: () => Promise<void> | void;
}

type SectionId = 'general' | 'hours' | 'scheduling' | 'automation' | 'model' | 'rules';

const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'hours', label: 'Hours', icon: 'clock' },
  { id: 'scheduling', label: 'Scheduling', icon: 'calendar' },
  { id: 'automation', label: 'Automation', icon: 'sparkle' },
  { id: 'model', label: 'Model', icon: 'chip' },
  { id: 'rules', label: 'Event rules', icon: 'flag' },
];

const CLASSIFICATIONS: EventClassification[] = ['MOVABLE', 'PROTECTED', 'FIXED', 'UNKNOWN'];
const MOVE_POLICIES: MovePolicy[] = ['never', 'ask', 'auto'];
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Windows are edited as `HH:MM` strings, which is what `<input type="time">` speaks. */
type DraftWindow = { start: string; end: string };
type DraftSchedule = Record<string, DraftWindow[]>;

const pad = (value: number): string => String(value).padStart(2, '0');

const toDraftSchedule = (schedule: WeeklySchedule): DraftSchedule =>
  Object.fromEntries(
    WEEKDAYS.map((day) => [
      day,
      (schedule[day] ?? []).map((window: DailyWindow) => ({
        start: `${pad(window.start.hour)}:${pad(window.start.minute)}`,
        end: `${pad(window.end.hour)}:${pad(window.end.minute)}`,
      })),
    ]),
  );

/** Days with no windows are omitted, which is how the server stores "never". */
const fromDraftSchedule = (draft: DraftSchedule): Record<string, DraftWindow[]> =>
  Object.fromEntries(Object.entries(draft).filter(([, windows]) => windows.length > 0));

interface Draft {
  timezone: string;
  planningHorizonDays: number;
  workingHours: DraftSchedule;
  sleepHours: DraftSchedule;
  recurringBlocks: DraftSchedule;
  deepWorkEnabled: boolean;
  deepWorkSchedule: DraftSchedule;
  deepWorkAllowMeetings: boolean;
  deepWorkReserve: boolean;
  minimumBlockMinutes: number;
  maximumBlockMinutes: number;
  allowTaskSplitting: boolean;
  bufferBetweenBlocksMinutes: number;
  maxDailyTaskMinutes: string;
  protectExistingEvents: boolean;
  allDayEventsBlockTime: boolean;
  granularityMinutes: number;
  placementStrategy: Preferences['placementStrategy'];
  automationMode: Preferences['automation']['mode'];
  movePolicy: Record<EventClassification, MovePolicy>;
  createBlocks: MovePolicy;
  deleteBlocks: MovePolicy;
  freezeWindowMinutes: number;
  maxAutoMutations: number;
  classificationRules: ClassificationRule[];
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  baseUrl: string;
  logLevel: LogLevel;
  weekStart: WeekStart;
}

function buildDraft(preferences: Preferences, view: SettingsView): Draft {
  return {
    timezone: preferences.timezone,
    planningHorizonDays: preferences.planningHorizonDays,
    workingHours: toDraftSchedule(preferences.workingHours),
    sleepHours: toDraftSchedule(preferences.sleepHours),
    recurringBlocks: toDraftSchedule(preferences.recurringBlocks),
    deepWorkEnabled: preferences.deepWork.enabled,
    deepWorkSchedule: toDraftSchedule(preferences.deepWork.schedule),
    deepWorkAllowMeetings: preferences.deepWork.allowMeetings,
    deepWorkReserve: preferences.deepWork.reserveForFocusTasks,
    minimumBlockMinutes: preferences.minimumBlockMinutes,
    maximumBlockMinutes: preferences.maximumBlockMinutes,
    allowTaskSplitting: preferences.allowTaskSplitting,
    bufferBetweenBlocksMinutes: preferences.bufferBetweenBlocksMinutes,
    maxDailyTaskMinutes:
      preferences.maxDailyTaskMinutes === undefined ? '' : String(preferences.maxDailyTaskMinutes),
    protectExistingEvents: preferences.protectExistingEvents,
    allDayEventsBlockTime: preferences.allDayEventsBlockTime,
    granularityMinutes: preferences.granularityMinutes,
    placementStrategy: preferences.placementStrategy,
    automationMode: preferences.automation.mode,
    movePolicy: { ...preferences.automation.movePolicy },
    createBlocks: preferences.automation.createBlocks,
    deleteBlocks: preferences.automation.deleteBlocks,
    freezeWindowMinutes: preferences.automation.freezeWindowMinutes,
    maxAutoMutations: preferences.automation.maxAutoMutations,
    classificationRules: preferences.classificationRules.map((rule) => ({ ...rule })),
    provider: view.settings.llm.provider,
    model: view.settings.llm.model,
    temperature: view.settings.llm.temperature,
    maxTokens: view.settings.llm.maxTokens,
    baseUrl: view.settings.llm.baseUrl ?? '',
    logLevel: view.settings.logLevel,
    weekStart: view.settings.weekStart,
  };
}

/**
 * Everything from the configuration file that can be changed at runtime.
 *
 * The scheduling policy is written to `PUT /preferences` and the runtime
 * settings to `PUT /settings`; both are stored in the database, which is the
 * source of truth once the app has started for the first time. API keys are
 * deliberately absent - they stay in `.env`.
 */
export function SettingsDialog({ preferences, onClose, onSaved }: Props) {
  const [section, setSection] = useState<SectionId>('general');
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [initial, setInitial] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .settings()
      .then((next) => {
        const built = buildDraft(preferences, next);
        setView(next);
        setDraft(built);
        setInitial(JSON.stringify(built));
      })
      .catch((cause: unknown) => setError(describe(cause)));
  }, [preferences]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dirty = useMemo(
    () => draft !== null && JSON.stringify(draft) !== initial,
    [draft, initial],
  );

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const provider = view?.providers.find((entry) => entry.provider === draft?.provider);

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await api.updatePreferences({
        timezone: draft.timezone,
        planningHorizonDays: draft.planningHorizonDays,
        workingHours: fromDraftSchedule(draft.workingHours) as never,
        sleepHours: fromDraftSchedule(draft.sleepHours) as never,
        recurringBlocks: fromDraftSchedule(draft.recurringBlocks) as never,
        deepWork: {
          enabled: draft.deepWorkEnabled,
          schedule: fromDraftSchedule(draft.deepWorkSchedule) as never,
          allowMeetings: draft.deepWorkAllowMeetings,
          reserveForFocusTasks: draft.deepWorkReserve,
        },
        minimumBlockMinutes: draft.minimumBlockMinutes,
        maximumBlockMinutes: draft.maximumBlockMinutes,
        allowTaskSplitting: draft.allowTaskSplitting,
        bufferBetweenBlocksMinutes: draft.bufferBetweenBlocksMinutes,
        maxDailyTaskMinutes: (draft.maxDailyTaskMinutes === ''
          ? null
          : globalThis.Number(draft.maxDailyTaskMinutes)) as never,
        protectExistingEvents: draft.protectExistingEvents,
        allDayEventsBlockTime: draft.allDayEventsBlockTime,
        granularityMinutes: draft.granularityMinutes,
        placementStrategy: draft.placementStrategy,
        automation: {
          mode: draft.automationMode,
          movePolicy: draft.movePolicy,
          createBlocks: draft.createBlocks,
          deleteBlocks: draft.deleteBlocks,
          freezeWindowMinutes: draft.freezeWindowMinutes,
          maxAutoMutations: draft.maxAutoMutations,
        },
        classificationRules: draft.classificationRules,
      });

      const saved = await api.updateSettings({
        llm: {
          provider: draft.provider,
          model: draft.model,
          temperature: draft.temperature,
          maxTokens: draft.maxTokens,
          baseUrl: draft.baseUrl.trim(),
        },
        logLevel: draft.logLevel,
        weekStart: draft.weekStart,
      });

      setView(saved);
      setInitial(JSON.stringify(draft));
      await onSaved();
      onClose();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h3>Settings</h3>
          <button type="button" className="icon ghost" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        {!draft || !view ? (
          <p className="empty">{error ?? 'Loading settings...'}</p>
        ) : (
          <>
            <div className="settings-body">
              <nav className="settings-nav" aria-label="Settings sections">
                {SECTIONS.map((entry) => (
                  <button
                    key={entry.id}
                    className={section === entry.id ? 'active' : ''}
                    aria-pressed={section === entry.id}
                    onClick={() => setSection(entry.id)}
                  >
                    <Icon name={entry.icon} size={15} />
                    {entry.label}
                  </button>
                ))}
              </nav>

              <div className="settings-content">
                {section === 'general' && (
                  <Group
                    title="General"
                    hint="Where you are and how far ahead the scheduler plans."
                  >
                    <label className="field">
                      <span>Timezone</span>
                      <input
                        value={draft.timezone}
                        list="tz-options"
                        onChange={(event) => set('timezone', event.target.value)}
                      />
                      <datalist id="tz-options">
                        {timezoneOptions().map((zone) => (
                          <option key={zone} value={zone} />
                        ))}
                      </datalist>
                    </label>
                    <label className="field">
                      <span>Week view</span>
                      <select
                        value={draft.weekStart}
                        onChange={(event) => set('weekStart', event.target.value as WeekStart)}
                      >
                        <option value="rolling">Rolling - today is the leftmost column</option>
                        <option value="sunday">Calendar week - Sunday to Saturday</option>
                      </select>
                      <small className="field-hint">
                        Only the 7-day view; day and 3-day always start from the day you are on.
                      </small>
                    </label>
                    <NumberField
                      label="Planning horizon (days)"
                      hint="How far ahead the scheduler may place work."
                      value={draft.planningHorizonDays}
                      min={1}
                      max={365}
                      onChange={(value) => set('planningHorizonDays', value)}
                    />
                    <label className="field">
                      <span>Log level</span>
                      <select
                        value={draft.logLevel}
                        onChange={(event) => set('logLevel', event.target.value as LogLevel)}
                      >
                        {LOG_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    </label>
                    {view.sources.length > 0 && (
                      <p className="hint">
                        Started from {view.sources.join(', ')}. Changes saved here go to the
                        database and take precedence from now on.
                      </p>
                    )}
                  </Group>
                )}

                {section === 'hours' && (
                  <>
                    <Group title="Working hours" hint="The only time task blocks may be placed.">
                      <ScheduleEditor
                        schedule={draft.workingHours}
                        onChange={(next) => set('workingHours', next)}
                      />
                    </Group>
                    <Group
                      title="Sleep"
                      hint="Never available. Windows may cross midnight, e.g. 23:00 to 07:00."
                    >
                      <ScheduleEditor
                        schedule={draft.sleepHours}
                        onChange={(next) => set('sleepHours', next)}
                      />
                    </Group>
                    <Group title="Recurring blocks" hint="Lunch, gym, commute - anything regular.">
                      <ScheduleEditor
                        schedule={draft.recurringBlocks}
                        onChange={(next) => set('recurringBlocks', next)}
                      />
                    </Group>
                    <Group title="Deep work" hint="Windows reserved for focused work.">
                      <Toggle
                        label="Enable deep-work windows"
                        checked={draft.deepWorkEnabled}
                        onChange={(value) => set('deepWorkEnabled', value)}
                      />
                      {draft.deepWorkEnabled && (
                        <>
                          <ScheduleEditor
                            schedule={draft.deepWorkSchedule}
                            onChange={(next) => set('deepWorkSchedule', next)}
                          />
                          <Toggle
                            label="Allow meetings inside deep-work windows"
                            checked={draft.deepWorkAllowMeetings}
                            onChange={(value) => set('deepWorkAllowMeetings', value)}
                          />
                          <Toggle
                            label="Reserve these windows for deep-focus tasks only"
                            checked={draft.deepWorkReserve}
                            onChange={(value) => set('deepWorkReserve', value)}
                          />
                        </>
                      )}
                    </Group>
                  </>
                )}

                {section === 'scheduling' && (
                  <Group title="Scheduling" hint="How work is broken up and placed.">
                    <div className="settings-row">
                      <NumberField
                        label="Minimum block (minutes)"
                        value={draft.minimumBlockMinutes}
                        min={5}
                        max={1440}
                        onChange={(value) => set('minimumBlockMinutes', value)}
                      />
                      <NumberField
                        label="Maximum block (minutes)"
                        value={draft.maximumBlockMinutes}
                        min={5}
                        max={1440}
                        onChange={(value) => set('maximumBlockMinutes', value)}
                      />
                    </div>
                    <div className="settings-row">
                      <NumberField
                        label="Buffer between blocks (minutes)"
                        hint="Breathing room either side of meetings and other blocks."
                        value={draft.bufferBetweenBlocksMinutes}
                        min={0}
                        max={240}
                        onChange={(value) => set('bufferBetweenBlocksMinutes', value)}
                      />
                      <NumberField
                        label="Granularity (minutes)"
                        hint="Block boundaries snap to this."
                        value={draft.granularityMinutes}
                        min={1}
                        max={120}
                        onChange={(value) => set('granularityMinutes', value)}
                      />
                    </div>
                    <label className="field">
                      <span>Daily cap on task time (minutes)</span>
                      <input
                        type="number"
                        min={15}
                        max={1440}
                        placeholder="No limit"
                        value={draft.maxDailyTaskMinutes}
                        onChange={(event) => set('maxDailyTaskMinutes', event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>Placement strategy</span>
                      <select
                        value={draft.placementStrategy}
                        onChange={(event) =>
                          set('placementStrategy', event.target.value as Draft['placementStrategy'])
                        }
                      >
                        <option value="earliest_fit">
                          Earliest fit - start work as soon as possible
                        </option>
                        <option value="best_fit">Best fit - pick the highest-scoring slot</option>
                      </select>
                    </label>
                    <Toggle
                      label="Split tasks across multiple blocks"
                      checked={draft.allowTaskSplitting}
                      onChange={(value) => set('allowTaskSplitting', value)}
                    />
                    <Toggle
                      label="Existing calendar events consume availability"
                      checked={draft.protectExistingEvents}
                      onChange={(value) => set('protectExistingEvents', value)}
                    />
                    <Toggle
                      label="All-day events block the whole day"
                      checked={draft.allDayEventsBlockTime}
                      onChange={(value) => set('allDayEventsBlockTime', value)}
                    />
                  </Group>
                )}

                {section === 'automation' && (
                  <Group title="Automation" hint="What the agent may do without asking you.">
                    <label className="field">
                      <span>Mode</span>
                      <select
                        value={draft.automationMode}
                        onChange={(event) =>
                          set('automationMode', event.target.value as Draft['automationMode'])
                        }
                      >
                        <option value="read_only">Read only - analyse, never write</option>
                        <option value="suggest">Suggest - propose and wait for approval</option>
                        <option value="autonomous">
                          Autonomous - apply what the policy allows
                        </option>
                      </select>
                    </label>

                    <div className="policy-grid">
                      <span className="policy-head">Action</span>
                      <span className="policy-head">Policy</span>
                      {CLASSIFICATIONS.map((classification) => (
                        <PolicyRow
                          key={classification}
                          label={`Move a ${classification} event`}
                          value={draft.movePolicy[classification]}
                          onChange={(value) =>
                            set('movePolicy', { ...draft.movePolicy, [classification]: value })
                          }
                        />
                      ))}
                      <PolicyRow
                        label="Create task blocks"
                        value={draft.createBlocks}
                        onChange={(value) => set('createBlocks', value)}
                      />
                      <PolicyRow
                        label="Delete task blocks"
                        value={draft.deleteBlocks}
                        onChange={(value) => set('deleteBlocks', value)}
                      />
                    </div>

                    <div className="settings-row">
                      <NumberField
                        label="Freeze window (minutes)"
                        hint="Never touch anything starting this soon."
                        value={draft.freezeWindowMinutes}
                        min={0}
                        max={1440}
                        onChange={(value) => set('freezeWindowMinutes', value)}
                      />
                      <NumberField
                        label="Max automatic changes"
                        hint="Refuse to auto-apply a larger change set."
                        value={draft.maxAutoMutations}
                        min={0}
                        max={1000}
                        onChange={(value) => set('maxAutoMutations', value)}
                      />
                    </div>
                  </Group>
                )}

                {section === 'model' && (
                  <Group
                    title="Language model"
                    hint="Optional. Scheduling is deterministic - the model only turns your words into commands, and structured explanations into prose."
                  >
                    <label className="field">
                      <span>Provider</span>
                      <select
                        value={draft.provider}
                        onChange={(event) => {
                          const next = view.providers.find(
                            (entry) => entry.provider === event.target.value,
                          );
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  provider: event.target.value,
                                  model: next?.defaultModel ?? '',
                                }
                              : current,
                          );
                        }}
                      >
                        {view.providers.map((entry) => (
                          <option key={entry.provider} value={entry.provider}>
                            {entry.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    {draft.provider !== 'none' && (
                      <>
                        <label className="field">
                          <span>Model</span>
                          <input
                            value={draft.model}
                            list="model-options"
                            placeholder={provider?.defaultModel}
                            onChange={(event) => set('model', event.target.value)}
                          />
                          <datalist id="model-options">
                            {(provider?.suggestedModels ?? []).map((model) => (
                              <option key={model} value={model} />
                            ))}
                          </datalist>
                        </label>

                        <div className="settings-row">
                          <label className="field">
                            <span>Temperature</span>
                            <input
                              type="number"
                              min={0}
                              max={2}
                              step={0.1}
                              value={draft.temperature}
                              onChange={(event) =>
                                set('temperature', globalThis.Number(event.target.value))
                              }
                            />
                          </label>
                          <NumberField
                            label="Max tokens"
                            value={draft.maxTokens}
                            min={1}
                            max={200000}
                            onChange={(value) => set('maxTokens', value)}
                          />
                        </div>

                        {provider?.supportsBaseUrl && (
                          <label className="field">
                            <span>Base URL</span>
                            <input
                              value={draft.baseUrl}
                              placeholder="Default endpoint"
                              onChange={(event) => set('baseUrl', event.target.value)}
                            />
                          </label>
                        )}

                        {provider?.requiresApiKey && (
                          <p className={provider.hasApiKey ? 'note ok' : 'warn'}>
                            <Icon name={provider.hasApiKey ? 'check' : 'alert'} size={15} />
                            <span>
                              {provider.hasApiKey
                                ? `${provider.apiKeyEnvVar} is set in the server environment.`
                                : `No credential found. Add ${provider.apiKeyEnvVar} to your .env file and restart the server - keys are never entered here.`}
                            </span>
                          </p>
                        )}
                      </>
                    )}

                    <p className="hint">
                      Currently running: <code>{view.active.provider}</code>
                      {view.active.provider !== 'none' && (
                        <>
                          {' / '}
                          <code>{view.active.model}</code>
                        </>
                      )}
                    </p>
                  </Group>
                )}

                {section === 'rules' && (
                  <Group
                    title="Event rules"
                    hint="Teach the classifier about your calendar. The first matching rule wins."
                  >
                    <RuleEditor
                      rules={draft.classificationRules}
                      onChange={(rules) => set('classificationRules', rules)}
                    />
                  </Group>
                )}
              </div>
            </div>

            {error && (
              <p className="warn error">
                <Icon name="alert" />
                <span>{error}</span>
              </p>
            )}

            <div className="modal-actions settings-actions">
              <span className="hint">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
              <button type="button" className="push" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void save()}
                disabled={saving || !dirty}
              >
                Save changes
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Group({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-group">
      <h4>{title}</h4>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(globalThis.Number(event.target.value))}
      />
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}

function PolicyRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: MovePolicy;
  onChange: (value: MovePolicy) => void;
}) {
  return (
    <>
      <span className="policy-label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as MovePolicy)}>
        {MOVE_POLICIES.map((policy) => (
          <option key={policy} value={policy}>
            {policy}
          </option>
        ))}
      </select>
    </>
  );
}

function ScheduleEditor({
  schedule,
  onChange,
}: {
  schedule: DraftSchedule;
  onChange: (next: DraftSchedule) => void;
}) {
  const update = (day: string, windows: DraftWindow[]): void =>
    onChange({ ...schedule, [day]: windows });

  return (
    <div className="schedule-editor">
      {WEEKDAYS.map((day) => {
        const windows = schedule[day] ?? [];
        return (
          <div className="schedule-day" key={day}>
            <span className="schedule-name">{day.slice(0, 3)}</span>
            <div className="schedule-windows">
              {windows.length === 0 && <span className="schedule-empty">None</span>}
              {windows.map((window, index) => (
                <span className="schedule-window" key={index}>
                  <input
                    type="time"
                    value={window.start}
                    aria-label={`${day} window ${index + 1} start`}
                    onChange={(event) =>
                      update(
                        day,
                        windows.map((entry, position) =>
                          position === index ? { ...entry, start: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                  <span className="dash">to</span>
                  <input
                    type="time"
                    value={window.end}
                    aria-label={`${day} window ${index + 1} end`}
                    onChange={(event) =>
                      update(
                        day,
                        windows.map((entry, position) =>
                          position === index ? { ...entry, end: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="icon small ghost"
                    aria-label={`Remove ${day} window ${index + 1}`}
                    onClick={() =>
                      update(
                        day,
                        windows.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <Icon name="close" size={13} />
                  </button>
                </span>
              ))}
            </div>
            <button
              type="button"
              className="small ghost"
              aria-label={`Add a window on ${day}`}
              onClick={() =>
                update(day, [...windows, windows.at(-1) ?? { start: '09:00', end: '17:00' }])
              }
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A rule condition has three states, not two: unset means "do not care". The
 * select speaks strings so an unset condition is a real option rather than an
 * empty value the browser might coerce.
 */
const triState = (value: boolean | undefined): string =>
  value === undefined ? 'any' : value ? 'yes' : 'no';

const fromTriState = (value: string): boolean | undefined =>
  value === 'any' ? undefined : value === 'yes';

function RuleEditor({
  rules,
  onChange,
}: {
  rules: ClassificationRule[];
  onChange: (rules: ClassificationRule[]) => void;
}) {
  const update = (index: number, changes: Partial<ClassificationRule>): void =>
    onChange(rules.map((rule, position) => (position === index ? { ...rule, ...changes } : rule)));

  return (
    <div className="rule-editor">
      {rules.length === 0 && <p className="empty">No rules. Events fall back to heuristics.</p>}
      {rules.map((rule, index) => (
        <div className="rule" key={index}>
          <div className="settings-row">
            <label className="field">
              <span>Name</span>
              <input
                value={rule.id}
                placeholder="medical"
                onChange={(event) => update(index, { id: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Classify as</span>
              <select
                value={rule.classification}
                onChange={(event) =>
                  update(index, { classification: event.target.value as EventClassification })
                }
              >
                {CLASSIFICATIONS.map((classification) => (
                  <option key={classification} value={classification}>
                    {classification}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="icon ghost"
              aria-label={`Remove rule ${rule.id || index + 1}`}
              onClick={() => onChange(rules.filter((_, position) => position !== index))}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
          <label className="field">
            <span>Title matches (regular expression)</span>
            <input
              value={rule.titlePattern ?? ''}
              placeholder="doctor|dentist|therapy"
              onChange={(event) => update(index, { titlePattern: event.target.value })}
            />
          </label>
          <div className="settings-row">
            <label className="field">
              <span>Guests</span>
              <select
                value={triState(rule.hasOtherAttendees)}
                onChange={(event) =>
                  update(index, { hasOtherAttendees: fromTriState(event.target.value) })
                }
              >
                <option value="any">Any</option>
                <option value="yes">Other people are invited</option>
                <option value="no">Just me</option>
              </select>
            </label>
            <label className="field">
              <span>Length</span>
              <select
                value={triState(rule.isAllDay)}
                onChange={(event) => update(index, { isAllDay: fromTriState(event.target.value) })}
              >
                <option value="any">Any</option>
                <option value="yes">All-day only</option>
                <option value="no">Timed only</option>
              </select>
            </label>
          </div>
          <p className="field-hint">
            Every condition set here must match. Rules are tried in order and the first match wins,
            so put the narrower rule above the broader one.
          </p>
        </div>
      ))}
      <button
        type="button"
        className="small"
        onClick={() =>
          onChange([...rules, { id: `rule-${rules.length + 1}`, classification: 'PROTECTED' }])
        }
      >
        <Icon name="plus" size={14} />
        Add rule
      </button>
    </div>
  );
}

let cachedZones: string[] | undefined;

function timezoneOptions(): string[] {
  if (cachedZones) return cachedZones;
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  cachedZones = supported ? supported('timeZone') : ['UTC'];
  return cachedZones;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
