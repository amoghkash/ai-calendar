import { describe, expect, it } from 'vitest';
import type { CommandParser, ParseRequest, ParseResult } from '@calendar-agent/agent';
import { createTestApp } from './testing.js';

/** Records what the parser was handed, so threading can be asserted directly. */
class RecordingParser implements CommandParser {
  readonly name = 'recording';
  readonly seen: ParseRequest[] = [];

  async parse(request: ParseRequest): Promise<ParseResult> {
    this.seen.push(request);
    return { commands: [{ type: 'list_risks' }], source: 'heuristic', confidence: 1 };
  }
}

describe('conversation memory', () => {
  it('hands the parser what was already said', async () => {
    const parser = new RecordingParser();
    const { app, userId } = await createTestApp({ withoutCalendar: true, parser });

    const first = await app.agent.handle({ userId, text: 'climbing with Ronit this afternoon' });
    await app.agent.handle({
      userId,
      text: 'make it one hour',
      conversationId: first.conversationId,
    });

    // The opening turn has nothing to look back on.
    expect(parser.seen[0]?.history ?? []).toEqual([]);

    // The follow-up sees the exchange that preceded it, oldest first, and not
    // the message it is being asked to interpret.
    const history = parser.seen[1]?.history ?? [];
    expect(history.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(history[0]?.content).toBe('climbing with Ronit this afternoon');
    expect(history.some((turn) => turn.content === 'make it one hour')).toBe(false);
  });

  it('keeps separate conversations apart', async () => {
    const parser = new RecordingParser();
    const { app, userId } = await createTestApp({ withoutCalendar: true, parser });

    const first = await app.agent.handle({ userId, text: 'first thread' });
    await app.agent.handle({ userId, text: 'second thread' });
    await app.agent.handle({ userId, text: 'follow up', conversationId: first.conversationId });

    expect(parser.seen[1]?.history ?? []).toEqual([]);
    expect((parser.seen[2]?.history ?? []).map((t) => t.content)).toContain('first thread');
    expect((parser.seen[2]?.history ?? []).map((t) => t.content)).not.toContain('second thread');
  });
});
