import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConfig, buildPreferences, loadConfig, toWeeklySchedule } from './load.js';
import { parseDotEnv } from './env.js';

describe('toWeeklySchedule', () => {
  it('accepts the compact string form', () => {
    expect(toWeeklySchedule({ monday: '09:00-17:00' })).toEqual({
      monday: [{ start: { hour: 9, minute: 0 }, end: { hour: 17, minute: 0 } }],
    });
  });

  it('accepts multiple windows per day', () => {
    const schedule = toWeeklySchedule({ tuesday: ['09:00-12:00', '13:00-17:00'] });
    expect(schedule.tuesday).toHaveLength(2);
  });

  it('accepts the object form with a label', () => {
    expect(toWeeklySchedule({ friday: { start: '10:00', end: '11:00', label: 'review' } })).toEqual(
      {
        friday: [{ start: { hour: 10, minute: 0 }, end: { hour: 11, minute: 0 }, label: 'review' }],
      },
    );
  });

  it('rejects malformed ranges', () => {
    expect(() => toWeeklySchedule({ monday: '09:00' })).toThrow(/Invalid time range/);
  });
});

describe('buildConfig', () => {
  it('produces a working default configuration with no input', () => {
    const config = buildConfig({}, { CALENDAR_AGENT_TIMEZONE: 'UTC' });
    expect(config.timezone).toBe('UTC');
    expect(config.preferences.automation.mode).toBe('suggest');
    expect(config.database.driver).toBe('json');
    expect(config.llm.provider).toBe('none');
  });

  it('maps YAML onto scheduling preferences', () => {
    const config = buildConfig(
      {
        timezone: 'Europe/Berlin',
        working_hours: { monday: '08:00-16:00' },
        deep_work: { enabled: true, preferred_start: '09:00', preferred_end: '12:00' },
        scheduling: { minimum_block_minutes: 45, allow_task_splitting: false },
        automation: { mode: 'autonomous', move_policy: { UNKNOWN: 'never' } },
        weights: { deadline_urgency: 9 },
      },
      {},
    );
    expect(config.preferences.timezone).toBe('Europe/Berlin');
    expect(config.preferences.workingHours.monday).toHaveLength(1);
    expect(config.preferences.minimumBlockMinutes).toBe(45);
    expect(config.preferences.allowTaskSplitting).toBe(false);
    expect(config.preferences.automation.mode).toBe('autonomous');
    expect(config.preferences.automation.movePolicy.UNKNOWN).toBe('never');
    expect(config.preferences.automation.movePolicy.MOVABLE).toBe('auto');
    expect(config.preferences.weights.deadlineUrgency).toBe(9);
    expect(config.preferences.deepWork.schedule.monday).toHaveLength(1);
  });

  it('lets the environment override the file', () => {
    const config = buildConfig(
      { timezone: 'UTC', server: { port: 1234 } },
      { CALENDAR_AGENT_TIMEZONE: 'Asia/Kolkata', PORT: '9999', ANTHROPIC_API_KEY: 'sk-test' },
    );
    expect(config.timezone).toBe('Asia/Kolkata');
    expect(config.server.port).toBe(9999);
    expect(config.llm.provider).toBe('anthropic');
    expect(config.llm.apiKey).toBe('sk-test');
  });

  it('switches to postgres when a database url is present', () => {
    const config = buildConfig({}, { DATABASE_URL: 'postgres://localhost/calendar' });
    expect(config.database.driver).toBe('postgres');
    expect(config.database.url).toBe('postgres://localhost/calendar');
  });

  it('rejects an unknown timezone', () => {
    expect(() => buildConfig({ timezone: 'Mars/Olympus' })).toThrow(/Unknown IANA timezone/);
  });

  it('derives OAuth redirect URIs from the public url', () => {
    const config = buildConfig({ server: { public_url: 'https://cal.example.com' } });
    expect(config.google.redirectUri).toBe('https://cal.example.com/api/oauth/google/callback');
    expect(config.microsoft.redirectUri).toBe(
      'https://cal.example.com/api/oauth/microsoft/callback',
    );
  });
});

describe('buildPreferences', () => {
  it('parses blocked periods and classification rules', () => {
    const preferences = buildPreferences(
      {
        blocked_periods: [
          { start: '2026-03-09T12:00:00Z', end: '2026-03-09T13:00:00Z', label: 'lunch' },
        ],
        classification_rules: [
          { id: 'doctor', classification: 'PROTECTED', title_pattern: 'doctor' },
        ],
      },
      'user',
      'UTC',
    );
    expect(preferences.blockedPeriods[0]!.label).toBe('lunch');
    expect(preferences.classificationRules[0]!.titlePattern).toBe('doctor');
  });
});

describe('parseDotEnv', () => {
  it('parses keys, quotes and comments', () => {
    expect(
      parseDotEnv(['# comment', 'A=1', 'export B="two"', "C='three'", 'bad-line', ''].join('\n')),
    ).toEqual({ A: '1', B: 'two', C: 'three' });
  });
});

describe('dotenv exporting', () => {
  const originalKey = process.env.CALENDAR_AGENT_TEST_SECRET;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.CALENDAR_AGENT_TEST_SECRET;
    else process.env.CALENDAR_AGENT_TEST_SECRET = originalKey;
  });

  it('exports .env values into process.env for later credential lookups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-agent-env-'));
    writeFileSync(join(dir, '.env'), 'CALENDAR_AGENT_TEST_SECRET=from-dotenv\n');
    delete process.env.CALENDAR_AGENT_TEST_SECRET;

    loadConfig({ cwd: dir });

    // Config resolution alone is not enough: services that read process.env
    // directly must see the same value.
    expect(process.env.CALENDAR_AGENT_TEST_SECRET).toBe('from-dotenv');
    rmSync(dir, { recursive: true, force: true });
  });

  it('never overwrites a variable the shell already set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-agent-env-'));
    writeFileSync(join(dir, '.env'), 'CALENDAR_AGENT_TEST_SECRET=from-dotenv\n');
    process.env.CALENDAR_AGENT_TEST_SECRET = 'from-shell';

    loadConfig({ cwd: dir });

    expect(process.env.CALENDAR_AGENT_TEST_SECRET).toBe('from-shell');
    rmSync(dir, { recursive: true, force: true });
  });
});
