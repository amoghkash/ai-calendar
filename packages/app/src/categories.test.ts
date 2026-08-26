import { describe, expect, it } from 'vitest';
import { instantFromISO, resolveCategory } from '@calendar-agent/core';
import { mockEvent } from '@calendar-agent/integrations';
import { createTestApp } from './testing.js';

const at = instantFromISO;

describe('categories', () => {
  it('seeds a starter set for a new user', async () => {
    const harness = await createTestApp();
    const categories = await harness.app.categories.list(harness.userId);
    expect(categories.map((category) => category.name)).toEqual([
      'Work',
      'Study',
      'Personal',
      'Health',
    ]);
    expect(categories.filter((category) => category.isDefault)).toHaveLength(1);
  });

  it('normalises colours and rejects nonsense', async () => {
    const harness = await createTestApp();
    const created = await harness.app.categories.create(harness.userId, {
      name: 'Deep work',
      color: 'ABCDEF',
    });
    expect(created.color).toBe('#abcdef');
    await expect(
      harness.app.categories.create(harness.userId, { name: 'Bad', color: 'not-a-colour' }),
    ).rejects.toThrow(/Invalid colour/);
  });

  it('refuses a duplicate name and an invalid pattern', async () => {
    const harness = await createTestApp();
    await expect(harness.app.categories.create(harness.userId, { name: 'work' })).rejects.toThrow(
      /already exists/,
    );
    await expect(
      harness.app.categories.create(harness.userId, { name: 'Broken', matchPattern: '([' }),
    ).rejects.toThrow(/not a valid regular expression/);
  });

  it('keeps at most one default', async () => {
    const harness = await createTestApp();
    const created = await harness.app.categories.create(harness.userId, {
      name: 'Focus',
      isDefault: true,
    });
    const categories = await harness.app.categories.list(harness.userId);
    expect(categories.filter((category) => category.isDefault)).toEqual([
      expect.objectContaining({ id: created.id }),
    ]);
  });

  it('resolves by explicit assignment, then calendar, then pattern, then default', async () => {
    const categories = [
      { id: 'work', name: 'Work', color: '#1', isDefault: true, position: 0 },
      {
        id: 'study',
        name: 'Study',
        color: '#2',
        matchPattern: 'exam',
        isDefault: false,
        position: 1,
      },
      {
        id: 'team',
        name: 'Team',
        color: '#3',
        calendarId: 'cal-team',
        isDefault: false,
        position: 2,
      },
    ].map((c) => ({ ...c, userId: 'user', createdAt: 0, updatedAt: 0 })) as never;

    expect(resolveCategory({ title: 'anything', categoryId: 'study' }, categories)?.id).toBe(
      'study',
    );
    expect(resolveCategory({ title: 'anything', calendarId: 'cal-team' }, categories)?.id).toBe(
      'team',
    );
    expect(resolveCategory({ title: 'final exam prep' }, categories)?.id).toBe('study');
    expect(resolveCategory({ title: 'unmatched thing' }, categories)?.id).toBe('work');
  });

  it('colours blocks from their task', async () => {
    const harness = await createTestApp();
    const task = await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Revision for the exam',
      estimatedMinutes: 60,
    });
    const proposal = await harness.app.scheduling.plan({ userId: harness.userId });
    await harness.app.scheduling.approve(proposal.changeSetId, { userId: harness.userId });

    const blocks = await harness.app.db.blocks.list({ userId: harness.userId });
    const colors = await harness.app.categories.colorMap(harness.userId, [task], [], blocks);
    const study = (await harness.app.categories.list(harness.userId)).find(
      (category) => category.name === 'Study',
    )!;
    expect(colors.byTask[task.id]).toBe(study.id);
    expect(colors.byBlock[blocks[0]!.id]).toBe(study.id);
  });

  it('counts what each category actually covers, not only explicit links', async () => {
    const harness = await createTestApp();
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Dentist follow-up appointment',
      estimatedMinutes: 30,
    });
    const usage = await harness.app.categories.usage(harness.userId);
    expect(usage.find((entry) => entry.category.name === 'Health')?.taskCount).toBe(1);
  });

  it('unassigns everything when a category is deleted', async () => {
    const harness = await createTestApp();
    const category = await harness.app.categories.create(harness.userId, { name: 'Temp' });
    const task = await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Something',
      estimatedMinutes: 30,
      categoryId: category.id,
    });
    const result = await harness.app.categories.delete(category.id);
    expect(result.tasksUnassigned).toBe(1);
    expect((await harness.app.tasks.get(task.id)).categoryId).toBeUndefined();
  });

  it('categorises synced events by title', async () => {
    const harness = await createTestApp();
    harness.provider.seed(
      mockEvent({
        externalId: 'e1',
        title: 'Dentist appointment',
        start: at('2026-03-10T09:00:00Z'),
        end: at('2026-03-10T10:00:00Z'),
      }),
    );
    await harness.app.sync.sync({ userId: harness.userId });
    const events = await harness.app.calendars.listEvents(harness.userId, {
      start: at('2026-03-09T00:00:00Z'),
      end: at('2026-03-16T00:00:00Z'),
    });
    const resolved = await harness.app.categories.resolveForEvent(harness.userId, events[0]!);
    expect(resolved?.name).toBe('Health');
  });
});

describe('editing a category', () => {
  it('renames without disturbing its colour, pattern or membership', async () => {
    const harness = await createTestApp();
    const before = (await harness.app.categories.list(harness.userId)).find(
      (category) => category.name === 'Health',
    )!;

    const renamed = await harness.app.categories.update(before.id, { name: 'Appointments' });

    expect(renamed.name).toBe('Appointments');
    expect(renamed.color).toBe(before.color);
    expect(renamed.matchPattern).toBe(before.matchPattern);

    // Anything it matched still belongs to it.
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Dentist appointment',
      estimatedMinutes: 30,
    });
    const usage = await harness.app.categories.usage(harness.userId);
    expect(usage.find((entry) => entry.category.id === before.id)?.taskCount).toBe(1);
  });

  it('can clear a match pattern', async () => {
    const harness = await createTestApp();
    const category = (await harness.app.categories.list(harness.userId))[1]!;
    const updated = await harness.app.categories.update(category.id, { matchPattern: '' });
    expect(updated.matchPattern).toBe('');
  });

  it('keeps explicit assignments through a rename', async () => {
    const harness = await createTestApp();
    const category = await harness.app.categories.create(harness.userId, { name: 'Errands' });
    const task = await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Post office',
      estimatedMinutes: 30,
      categoryId: category.id,
    });
    await harness.app.categories.update(category.id, { name: 'Chores' });
    expect((await harness.app.tasks.get(task.id)).categoryId).toBe(category.id);
  });
});
