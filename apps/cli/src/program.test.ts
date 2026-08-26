import { beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '@calendar-agent/app';
import { createTestApp } from '@calendar-agent/app';
import { buildProgram } from './program.js';

/**
 * The CLI is exercised through the same application services as the web UI:
 * these tests assert wiring and output, never scheduling behaviour.
 */
describe('calendar-agent CLI', () => {
  let harness: TestApp;
  let output: string[];
  let errors: string[];

  const run = async (...argv: string[]): Promise<string> => {
    output = [];
    errors = [];
    const program = buildProgram({
      appFactory: async () => harness.app,
      out: (line) => output.push(line),
      errOut: (line) => errors.push(line),
    });
    // The shared app must survive across commands, so shutdown is a no-op here.
    await program.parseAsync(['node', 'calendar-agent', ...argv]);
    return output.join('\n');
  };

  beforeEach(async () => {
    harness = await createTestApp();
    // createTestApp uses an in-memory database; closing it between commands
    // would be harmless, but keeping it open matches a long-lived process.
    (harness.app as { shutdown: () => Promise<void> }).shutdown = async () => {};
  });

  it('adds and lists tasks', async () => {
    await run('tasks', 'add', 'Finish', 'ML', 'project', '--duration', '4h', '--priority', 'high');
    const listing = await run('tasks');
    expect(listing).toContain('Finish ML project');
    expect(listing).toContain('high');
    expect(listing).toContain('4h');
  });

  it('rejects an unreadable duration with a helpful message', async () => {
    const program = buildProgram({ appFactory: async () => harness.app, out: () => {} });
    await expect(
      program.parseAsync(['node', 'calendar-agent', 'tasks', 'add', 'X', '--duration', 'soon']),
    ).rejects.toThrow(/Could not read "soon" as a duration/);
  });

  it('simulates by default and writes nothing', async () => {
    await run('tasks', 'add', 'Reading', '--duration', '2h');
    const text = await run('schedule');
    expect(text).toContain('PROPOSED CHANGES');
    expect(text).toContain('No calendar changes were made.');
    expect(harness.provider.list()).toHaveLength(0);
  });

  it('applies the plan with --apply', async () => {
    await run('tasks', 'add', 'Reading', '--duration', '2h');
    const text = await run('schedule', '--apply');
    expect(text).toContain('Changes applied to your calendar.');
    expect(harness.provider.list()).toHaveLength(1);
    expect(harness.provider.list()[0]!.title).toBe('Reading');
  });

  it('prints the scheduling trace with --explain', async () => {
    await run('tasks', 'add', 'Reading', '--duration', '2h', '--due', 'friday');
    const text = await run('schedule', '--explain');
    expect(text).toContain('SCHEDULING TRACE');
    expect(text).toContain('TASK RANKING');
    expect(text).toContain('deadlineUrgency');
  });

  it('reports risks', async () => {
    await run('tasks', 'add', 'Huge', 'thing', '--duration', '20h', '--due', 'tomorrow');
    const text = await run('risks');
    expect(text).toMatch(/IMPOSSIBLE|CRITICAL/);
  });

  it('answers a natural-language question', async () => {
    await run('tasks', 'add', 'Algorithms', 'assignment', '--duration', '2h');
    const text = await run('ask', 'schedule', 'my', 'algorithms', 'assignment');
    expect(text).toMatch(/new block/);
    expect(text).toContain('Approve with: calendar-agent approve');
  });

  it('treats a bare argument as a question', async () => {
    const text = await run('what deadlines are at risk?');
    expect(text).toContain('No open tasks to assess.');
  });

  it('emits JSON when asked', async () => {
    await run('tasks', 'add', 'Reading', '--duration', '90m');
    const text = await run('--json', 'tasks');
    const parsed = JSON.parse(text) as { tasks: { title: string }[] };
    expect(parsed.tasks[0]!.title).toBe('Reading');
  });

  it('lists free windows', async () => {
    const text = await run('free', '2h', '--days', '2');
    expect(text).toContain('09:00');
  });

  it('runs doctor', async () => {
    const text = await run('doctor');
    expect(text).toContain('database');
    expect(text).toContain('working hours');
  });

  it('shows the agenda for a day', async () => {
    await run('tasks', 'add', 'Reading', '--duration', '1h');
    await run('schedule', '--apply');
    const text = await run('agenda', '--days', '3');
    expect(text).toContain('Reading');
  });

  it('syncs and reports no external changes', async () => {
    const text = await run('sync');
    expect(text).toContain('No external changes.');
    expect(errors).toHaveLength(0);
  });
});
