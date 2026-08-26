import type { Instant } from './instant.js';
import { instantToISO, toMinutes } from './instant.js';

/** A half-open time range `[start, end)` expressed in Instants. */
export interface Interval {
  readonly start: Instant;
  readonly end: Instant;
}

export const interval = (start: Instant, end: Instant): Interval => ({ start, end });

export const durationMs = (i: Interval): number => Math.max(0, i.end - i.start);
export const durationMinutes = (i: Interval): number => toMinutes(durationMs(i));
export const isEmpty = (i: Interval): boolean => i.end <= i.start;

export const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;

/** True when `outer` fully contains `inner`. */
export const contains = (outer: Interval, inner: Interval): boolean =>
  outer.start <= inner.start && inner.end <= outer.end;

export const containsInstant = (i: Interval, t: Instant): boolean => t >= i.start && t < i.end;

export function intersect(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

export const sortIntervals = (intervals: readonly Interval[]): Interval[] =>
  [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);

/** Merge overlapping and adjacent intervals into a normalised, sorted list. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = sortIntervals(intervals.filter((i) => !isEmpty(i)));
  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.start <= last.end) {
      if (current.end > last.end)
        merged[merged.length - 1] = { start: last.start, end: current.end };
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

/** Remove `cuts` from `base`, returning the remaining pieces. */
export function subtractIntervals(
  base: readonly Interval[],
  cuts: readonly Interval[],
): Interval[] {
  const normalisedCuts = mergeIntervals(cuts);
  let result = mergeIntervals(base);
  for (const cut of normalisedCuts) {
    const next: Interval[] = [];
    for (const piece of result) {
      if (!overlaps(piece, cut)) {
        next.push(piece);
        continue;
      }
      if (piece.start < cut.start) next.push({ start: piece.start, end: cut.start });
      if (cut.end < piece.end) next.push({ start: cut.end, end: piece.end });
    }
    result = next;
  }
  return result;
}

/** Intersection of two interval sets. */
export function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  const result: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const l = left[i]!;
    const r = right[j]!;
    const piece = intersect(l, r);
    if (piece) result.push(piece);
    if (l.end < r.end) i += 1;
    else j += 1;
  }
  return result;
}

export function clamp(i: Interval, bounds: Interval): Interval | null {
  return intersect(i, bounds);
}

export const totalMinutes = (intervals: readonly Interval[]): number =>
  intervals.reduce((sum, i) => sum + durationMinutes(i), 0);

export const formatInterval = (i: Interval): string =>
  `${instantToISO(i.start)}/${instantToISO(i.end)}`;

/** A time range with an attached label, used for blocked periods and windows. */
export interface NamedInterval extends Interval {
  readonly label?: string;
}
