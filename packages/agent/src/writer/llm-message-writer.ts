import type { MessageWriteRequest, MessageWriter } from '@calendar-agent/core';
import { describeSlots } from '@calendar-agent/core';
import type { LLMProvider } from '../llm/types.js';

/** A text, not an email. Anything longer means the model got carried away. */
const MAX_CHARS = 320;

/** "12pm", "12:30pm", "9 am" - the tokens that must match what was offered. */
const CLOCK = /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/gi;

export interface LLMMessageWriterOptions {
  readonly llm: LLMProvider;
}

/**
 * Asks the model for the message, then checks it before letting it stand.
 *
 * The check that matters is the times: every time offered must appear, and no
 * other may. A model that slips in "or how about 4pm?" would be proposing
 * something the scheduler never approved and the user never saw, and nicer
 * wording is not worth that. Anything failing the check falls back to the
 * template - plainer, but always correct.
 */
export class LLMMessageWriter implements MessageWriter {
  constructor(private readonly options: LLMMessageWriterOptions) {}

  async write(request: MessageWriteRequest): Promise<string | undefined> {
    if (request.slots.length === 0) return undefined;
    const times = describeSlots(request.slots, request.now, request.timezone);
    const first = request.displayName.trim().split(/\s+/)[0] ?? request.displayName;

    let response;
    try {
      response = await this.options.llm.generate({
        system: [
          `Write one short text message to ${first}.`,
          request.kind === 'confirm'
            ? `It asks whether ${request.activity} at the time below still stands. The time is already agreed; do not offer alternatives.`
            : `It asks whether any of the times below suit, for ${request.activity}.`,
          '',
          `Times, worded exactly like this: ${times}`,
          `Tone: ${request.tone}.`,
          '',
          'Rules:',
          '- Include every time above, worded as given. Never mention any other time.',
          '- One or two sentences. It is a text message, not an email.',
          `- Start with their first name (${first}).`,
          '- No greeting block, no sign-off, no subject line, no markdown.',
          '- Reply with the message itself and nothing else.',
          '',
          `For length and register, the plain version is: ${request.fallback}`,
        ].join('\n'),
        messages: [{ role: 'user', content: 'Write it.' }],
      });
    } catch {
      return undefined;
    }

    const text = response.text
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["']|["']$/g, '');
    return acceptable(text, first, times) ? text : undefined;
  }
}

export function acceptable(text: string, firstName: string, times: string): boolean {
  if (text.length === 0 || text.length > MAX_CHARS) return false;
  if (!text.toLowerCase().includes(firstName.toLowerCase())) return false;

  // Compare tokens rather than whole phrases, so the model may group and
  // rephrase - "tomorrow at 12pm or 2pm" - but cannot introduce 4pm.
  //
  // Clock times alone are not enough: proposals pick the same hour on
  // different days, so "Sat at 11:30am or Sun at 11:30am" is one clock token
  // covering two offers. The day words carry that distinction, so both sets
  // have to match.
  if (!sameSet(clockTokens(times), clockTokens(text))) return false;
  if (!sameSet(dayTokens(times), dayTokens(text))) return false;
  return true;
}

function sameSet(offered: Set<string>, written: Set<string>): boolean {
  if (offered.size !== written.size) return false;
  for (const token of offered) if (!written.has(token)) return false;
  return true;
}

/** "today", "tomorrow", "Sat" - what tells two 11:30am offers apart. */
const DAY = /\b(today|tonight|tomorrow|mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/gi;

function dayTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(DAY)) tokens.add(match[1]!.toLowerCase());
  return tokens;
}

function clockTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(CLOCK)) {
    tokens.add(`${Number(match[1])}:${match[2] ?? '00'}${match[3]!.toLowerCase()}`);
  }
  return tokens;
}
