import type { Instant } from '../time/instant.js';
import type { CalendarId, UserId } from './ids.js';

export type CategoryId = string;

/**
 * A user-defined grouping with a colour: "Work", "Study", "Personal".
 *
 * Categories are presentation and reporting, deliberately separate from
 * `EventClassification` (MOVABLE / PROTECTED / FIXED / UNKNOWN), which is a
 * safety decision about what the scheduler may touch. Renaming a category can
 * never change what the agent is allowed to move.
 */
export interface Category {
  readonly id: CategoryId;
  readonly userId: UserId;
  readonly name: string;
  /** `#rrggbb`. */
  readonly color: string;
  readonly description?: string;
  /** Case-insensitive regular expression matched against event titles. */
  readonly matchPattern?: string;
  /** Everything on this calendar belongs to the category. */
  readonly calendarId?: CalendarId;
  /** Used for anything unmatched. At most one category may be the default. */
  readonly isDefault: boolean;
  /** Lower sorts first, both in the UI and when resolving matches. */
  readonly position: number;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const isValidColor = (value: string): boolean => HEX_COLOR.test(value);

/** Normalise `#ABC` / `ABCDEF` / `#abcdef` to `#abcdef`. */
export function normaliseColor(value: string): string {
  const trimmed = value.trim().replace(/^#/, '');
  const expanded =
    trimmed.length === 3
      ? trimmed
          .split('')
          .map((character) => character + character)
          .join('')
      : trimmed;
  const candidate = `#${expanded.toLowerCase()}`;
  if (!isValidColor(candidate)) {
    throw new TypeError(`Invalid colour "${value}" (expected #rrggbb)`);
  }
  return candidate;
}

/** Readable on both the light and dark calendar surfaces. */
export const CATEGORY_PALETTE: readonly string[] = [
  '#5b8def',
  '#3f9a6a',
  '#7a5cc4',
  '#b98b2f',
  '#b8453f',
  '#2f8f9d',
  '#c2698d',
  '#6b7280',
];

export interface CategorySeed {
  readonly name: string;
  readonly color: string;
  readonly matchPattern?: string;
  readonly isDefault?: boolean;
}

/** Starting point for a new user; entirely editable afterwards. */
export const DEFAULT_CATEGORIES: readonly CategorySeed[] = [
  { name: 'Work', color: '#5b8def', isDefault: true },
  { name: 'Study', color: '#7a5cc4', matchPattern: 'assignment|lecture|class|exam|revision' },
  { name: 'Personal', color: '#3f9a6a', matchPattern: 'lunch|dinner|coffee|gym|birthday' },
  { name: 'Health', color: '#b8453f', matchPattern: 'doctor|dentist|therapy|appointment' },
];

export interface CategorisableEvent {
  readonly title: string;
  readonly calendarId?: CalendarId;
  readonly categoryId?: CategoryId;
}

/**
 * Resolve which category an event belongs to.
 *
 * Order: an explicit assignment, then a calendar-wide rule, then a title
 * pattern, then the default category. Returns undefined when nothing matches
 * and no default exists, so callers can fall back to the calendar's own colour.
 */
export function resolveCategory(
  event: CategorisableEvent,
  categories: readonly Category[],
): Category | undefined {
  if (event.categoryId !== undefined) {
    const explicit = categories.find((category) => category.id === event.categoryId);
    if (explicit) return explicit;
  }
  const ordered = [...categories].sort((a, b) => a.position - b.position);

  if (event.calendarId !== undefined) {
    const byCalendar = ordered.find((category) => category.calendarId === event.calendarId);
    if (byCalendar) return byCalendar;
  }

  for (const category of ordered) {
    if (category.matchPattern === undefined) continue;
    let pattern: RegExp;
    try {
      pattern = new RegExp(category.matchPattern, 'i');
    } catch {
      continue;
    }
    if (pattern.test(event.title)) return category;
  }

  return ordered.find((category) => category.isDefault);
}
