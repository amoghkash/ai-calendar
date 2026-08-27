import { DateTime } from 'luxon';
import type { Interval } from '../time/interval.js';

/**
 * What a reply to an outreach message means.
 *
 * `unclear` is the important one. This runs on a message from a real person
 * whose answer decides whether something gets written to a calendar, so the
 * cost of a confident misread is a booking they never agreed to. Every rule
 * below is written to fall through to `unclear` rather than reach.
 */
export type ReplyIntent =
  /** They picked one of the times offered. */
  | { readonly kind: 'accepts'; readonly slotIndex: number }
  /** They said no to all of them. */
  | { readonly kind: 'declines' }
  /** Something was said that no rule could read. A person has to look. */
  | { readonly kind: 'unclear'; readonly reason: string };

const DECLINE =
  /\b(can'?t|cannot|no can do|won'?t work|does ?n'?t work|not free|i'?m busy|none of (?:those|these|them)|another time|rain ?check|maybe next|no thanks|unfortunately)\b/i;

const AFFIRM =
  /\b(yes|yep|yeah|yup|sure|sounds good|works for me|that works|works|perfect|great|ok(?:ay)?|deal|see you then|let'?s do)\b/i;

/**
 * Only true ordinals. The cardinals are deliberately absent: "the second one"
 * contains "one", and "one of those" names nothing at all.
 */
const ORDINALS: readonly (readonly [RegExp, number])[] = [
  [/\b(?:1st|first)\b/i, 0],
  [/\b(?:2nd|second)\b/i, 1],
  [/\b(?:3rd|third)\b/i, 2],
];

/**
 * Read a reply against the times that were actually offered.
 *
 * Deterministic and pure. A model can be layered on top for the replies these
 * rules cannot read, but the common cases - "yes", "Tuesday", "the second one",
 * "can't this week" - must not need one.
 */
export function classifyReply(
  text: string,
  slots: readonly Interval[],
  timezone: string,
): ReplyIntent {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: 'unclear', reason: 'The reply was empty.' };
  if (slots.length === 0) return { kind: 'unclear', reason: 'No times were offered.' };

  const declines = DECLINE.test(trimmed);
  const picked = matchSlot(trimmed, slots, timezone);
  const mentionsAny =
    picked !== undefined || slots.some((slot) => mentionsSlot(trimmed, slot, timezone));

  // "Tuesday doesn't work but Wednesday does" both refuses and names days.
  // Deciding which half governs is exactly the guess worth refusing.
  if (declines && mentionsAny) {
    return { kind: 'unclear', reason: 'The reply both refuses and names a time.' };
  }
  if (declines) return { kind: 'declines' };
  if (picked !== undefined) return { kind: 'accepts', slotIndex: picked };

  if (AFFIRM.test(trimmed)) {
    // A bare "sounds good" is only actionable when there was nothing to choose.
    if (slots.length === 1) return { kind: 'accepts', slotIndex: 0 };
    return {
      kind: 'unclear',
      reason: `They agreed but did not say which of the ${slots.length} times.`,
    };
  }

  return { kind: 'unclear', reason: 'No rule could read this reply.' };
}

/** The single offered slot this reply points at, if exactly one does. */
function matchSlot(
  text: string,
  slots: readonly Interval[],
  timezone: string,
): number | undefined {
  for (const [pattern, index] of ORDINALS) {
    if (index < slots.length && pattern.test(text)) return index;
  }

  const candidates = new Set<number>();
  slots.forEach((slot, index) => {
    if (mentionsSlot(text, slot, timezone)) candidates.add(index);
  });
  // Two offered times on the same weekday cannot be told apart by "Tuesday".
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function mentionsSlot(text: string, slot: Interval, timezone: string): boolean {
  const at = DateTime.fromMillis(slot.start, { zone: timezone });
  const weekday = at.toFormat('cccc').toLowerCase();
  const short = at.toFormat('ccc').toLowerCase();
  const lower = text.toLowerCase();

  const namesDay = new RegExp(`\\b(${weekday}|${short})\\b`).test(lower);

  const hour12 = at.hour % 12 === 0 ? 12 : at.hour % 12;
  const suffix = at.hour < 12 ? 'am' : 'pm';
  const minute = String(at.minute).padStart(2, '0');
  const namesTime =
    at.minute === 0
      ? // The lookahead stops "12" matching the hour part of "12:30".
        new RegExp(`\\b${hour12}(?![:.]\\d)\\s?(?:${suffix}|o'?clock)?\\b`).test(lower)
      : new RegExp(`\\b${hour12}[:.]${minute}\\s?(?:${suffix})?\\b`).test(lower);

  return namesDay || namesTime;
}
