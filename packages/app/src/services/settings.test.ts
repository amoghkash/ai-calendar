import { describe, expect, it } from 'vitest';
import { ValidationError } from '@calendar-agent/core';
import { createTestApp } from '../testing.js';
import { parsePreferencesPatch } from './preferences-input.js';
import { SettingsService } from './settings-service.js';

describe('settings', () => {
  it('starts from the configuration file and persists changes', async () => {
    const harness = await createTestApp({ withoutCalendar: true });
    const { app, userId } = harness;

    expect((await app.settings.get(userId)).llm.provider).toBe('none');

    await app.settings.update(userId, {
      llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
      logLevel: 'debug',
    });

    const stored = await app.db.settings.get(userId);
    expect(stored?.llm).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(stored?.logLevel).toBe('debug');
    expect(stored?.updatedAt).toBe(app.clock.now());
  });

  it('swaps the running model without a restart', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });
    expect(app.llm.name).toBe('none');

    await app.settings.update(userId, { llm: { provider: 'openai', model: 'gpt-4.1-mini' } });

    expect(app.llm.name).toBe('openai');
    expect(app.llm.model).toBe('gpt-4.1-mini');
  });

  it('fills in the provider default when only the provider changes', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });
    const saved = await app.settings.update(userId, { llm: { provider: 'anthropic' } });
    expect(saved.llm.model).toBe('claude-sonnet-5');
  });

  it('refuses to accept an API key over the API', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });
    await expect(
      app.settings.update(userId, { llm: { provider: 'anthropic', apiKey: 'sk-secret' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await app.db.settings.get(userId)).toBeUndefined();
  });

  it('reports credential availability without exposing the credential', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });
    const service = new SettingsService(app.db, app.config, app.clock, app.logger, undefined, {
      ANTHROPIC_API_KEY: 'sk-super-secret',
    });

    const view = await service.view(userId);
    expect(JSON.stringify(view)).not.toContain('sk-super-secret');
    expect(view.providers.find((p) => p.provider === 'anthropic')).toMatchObject({
      requiresApiKey: true,
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      hasApiKey: true,
    });
    expect(view.providers.find((p) => p.provider === 'openai')?.hasApiKey).toBe(false);
    expect(view.providers.find((p) => p.provider === 'ollama')?.requiresApiKey).toBe(false);
  });

  it('rejects unknown providers and out-of-range numbers', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });
    for (const patch of [
      { llm: { provider: 'skynet' } },
      { llm: { temperature: 9 } },
      { llm: { maxTokens: 0 } },
      { llm: { baseUrl: 'not-a-url' } },
      { logLevel: 'loud' },
    ]) {
      await expect(app.settings.update(userId, patch)).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe('preferences patching', () => {
  it('persists working hours through the validated path', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });
    const saved = await app.preferences.patch(userId, {
      workingHours: { monday: [{ start: '08:30', end: '16:00' }], saturday: [] },
      minimumBlockMinutes: 45,
    });

    expect(saved.workingHours.monday).toEqual([
      { start: { hour: 8, minute: 30 }, end: { hour: 16, minute: 0 } },
    ]);
    expect(saved.workingHours.saturday).toBeUndefined();
    expect(saved.minimumBlockMinutes).toBe(45);
    // Untouched fields survive.
    expect(saved.planningHorizonDays).toBe(14);
  });

  it('accepts the object form the API hands back', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });
    const saved = await app.preferences.patch(userId, {
      workingHours: {
        tuesday: [{ start: { hour: 10, minute: 0 }, end: { hour: 18, minute: 30 } }],
      },
    });
    expect(saved.workingHours.tuesday?.[0]?.end).toEqual({ hour: 18, minute: 30 });
  });

  it('drops unknown keys instead of merging them', () => {
    const current = { minimumBlockMinutes: 30, maximumBlockMinutes: 180 } as never;
    const patch = parsePreferencesPatch({ nonsense: 1, minimumBlockMinutes: 60 }, current);
    expect(patch).toEqual({ minimumBlockMinutes: 60 });
  });

  it('rejects contradictory and malformed values', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });
    for (const patch of [
      { minimumBlockMinutes: 240, maximumBlockMinutes: 60 },
      { timezone: 'Mars/Olympus' },
      { workingHours: { funday: [{ start: '09:00', end: '17:00' }] } },
      { workingHours: { monday: [{ start: '25:00', end: '17:00' }] } },
      { automation: { mode: 'yolo' } },
      { automation: { movePolicy: { PROTECTED: 'sometimes' } } },
      { classificationRules: [{ id: 'a', classification: 'PROTECTED', titlePattern: '(' }] },
      { granularityMinutes: 0 },
    ]) {
      await expect(app.preferences.patch(userId, patch)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('leaves the stored policy untouched when validation fails', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });
    const before = await app.preferences.get(userId);
    await expect(app.preferences.patch(userId, { planningHorizonDays: -3 })).rejects.toThrow();
    expect(await app.preferences.get(userId)).toEqual(before);
  });
});

describe('the assistant when a model is configured', () => {
  it('reports a broken model instead of quietly answering with the rule parser', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });

    // A provider with no credential in the environment: every call will throw.
    await app.settings.update(userId, {
      llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
    });
    expect(app.llm.name).toBe('anthropic');

    // Even a phrasing the rule parser answers confidently must not be
    // silently rerouted: while a model is set, it interprets everything.
    await expect(app.agent.handle({ userId, text: 'What deadlines are at risk?' })).rejects.toThrow(
      /could not interpret that request/,
    );
  });

  it('tells the user how to get back to the rule parser', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });
    await app.settings.update(userId, {
      llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
    });
    await expect(app.agent.handle({ userId, text: 'anything at all' })).rejects.toThrow(
      /set the provider to "none" in Settings/,
    );
  });

  it('uses the rule parser once the model is turned off', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });
    await app.settings.update(userId, {
      llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
    });
    await app.settings.update(userId, { llm: { provider: 'none' } });

    const risks = await app.agent.handle({ userId, text: 'What deadlines are at risk?' });
    expect(risks.source).toBe('heuristic');
    expect(risks.reply.length).toBeGreaterThan(0);
  });
});

describe('week layout', () => {
  it('defaults to the rolling view and persists a change', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });
    expect((await app.settings.get(userId)).weekStart).toBe('rolling');

    await app.settings.update(userId, { weekStart: 'sunday' });
    expect((await app.db.settings.get(userId))?.weekStart).toBe('sunday');
    expect((await app.settings.view(userId)).settings.weekStart).toBe('sunday');
  });

  it('is seeded from the configuration file', async () => {
    const { app, userId } = await createTestApp({
      withoutCalendar: true,
      config: { ui: { week_start: 'sunday' } },
    });
    expect((await app.settings.get(userId)).weekStart).toBe('sunday');
  });

  it('rejects anything else', async () => {
    const { app, userId } = await createTestApp({ withoutCalendar: true });
    await expect(app.settings.update(userId, { weekStart: 'monday' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
