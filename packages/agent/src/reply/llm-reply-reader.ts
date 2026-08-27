import { z } from 'zod';
import type { ReplyIntent, ReplyReader, ReplyReaderRequest } from '@calendar-agent/core';
import { describeSlotCasually } from '@calendar-agent/core';
import type { LLMProvider } from '../llm/types.js';

/**
 * What the model is allowed to say back.
 *
 * `slotIndex` rather than a time: the model picks from what was offered and
 * cannot invent anything. `confident` is separate from the choice so that an
 * unsure answer is still a well-formed one - it just does not act.
 */
const readingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('accepts'),
    slotIndex: z.number().int().min(0),
    confident: z.boolean(),
    reason: z.string().optional(),
  }),
  z.object({ kind: z.literal('declines'), confident: z.boolean(), reason: z.string().optional() }),
  z.object({ kind: z.literal('unclear'), reason: z.string().min(1) }),
]);

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['accepts', 'declines', 'unclear'] },
    slotIndex: { type: 'integer', minimum: 0, description: 'Required when kind is accepts' },
    confident: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['kind'],
};

export interface LLMReplyReaderOptions {
  readonly llm: LLMProvider;
}

/**
 * Reads the replies the rules cannot.
 *
 * The deterministic classifier handles "yes", "Tuesday", "the second one" and a
 * plain refusal. Everything else - "sure, the later one suits me better",
 * "can't do lunch but dinner works", an emoji - lands here.
 *
 * Every hedge resolves to `unclear`: an unconfident answer, an out-of-range
 * index, an unparseable response, a failed request. Booking the wrong time is
 * worse than asking a person to look.
 */
export class LLMReplyReader implements ReplyReader {
  constructor(private readonly options: LLMReplyReaderOptions) {}

  async read(request: ReplyReaderRequest): Promise<ReplyIntent | undefined> {
    if (request.slots.length === 0) return undefined;

    const offered = request.slots
      .map(
        (slot, index) =>
          `${index}: ${describeSlotCasually(slot.start, request.now, request.timezone)}`,
      )
      .join('\n');

    let response;
    try {
      response = await this.options.llm.generate({
        system: [
          `You are reading a reply from ${request.personName}, who was asked about ${request.activity}.`,
          'These times were offered, numbered from 0:',
          offered,
          '',
          'Decide what the reply means:',
          '- accepts: they chose one of the numbered times. Give its slotIndex.',
          '- declines: they said no to all of them.',
          '- unclear: anything else.',
          '',
          'Rules that matter more than being helpful:',
          '- Only ever pick from the numbered times. If they suggest a different time, that is unclear, not accepts.',
          '- If they accept without saying which one, that is unclear.',
          '- If a reply both refuses one time and names another, pick the one they accepted only if it is unmistakable; otherwise unclear.',
          '- Set confident to false whenever you are guessing. An unconfident answer is treated as unclear.',
          '- The result of accepts is a real calendar entry and a person expecting them. When in doubt, say unclear.',
        ].join('\n'),
        messages: [{ role: 'user', content: request.text }],
        jsonSchema: {
          name: 'reply_reading',
          description: 'What the reply means, in terms of the times offered.',
          schema: JSON_SCHEMA,
        },
      });
    } catch {
      // A model that cannot be reached costs a nudge to the human, nothing more.
      return undefined;
    }

    const payload = response.json ?? safeJson(response.text);
    const parsed = readingSchema.safeParse(payload);
    if (!parsed.success) return undefined;
    const reading = parsed.data;

    if (reading.kind === 'unclear') return { kind: 'unclear', reason: reading.reason };
    if (!reading.confident) {
      return { kind: 'unclear', reason: reading.reason ?? 'The reply was too ambiguous to act on.' };
    }
    if (reading.kind === 'declines') return { kind: 'declines' };
    if (reading.slotIndex >= request.slots.length) {
      return { kind: 'unclear', reason: 'The reply pointed at a time that was not offered.' };
    }
    return { kind: 'accepts', slotIndex: reading.slotIndex };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
