import { describe, expect, it } from 'vitest';
import {
  contains,
  intersect,
  intersectIntervals,
  mergeIntervals,
  overlaps,
  subtractIntervals,
  totalMinutes,
} from './interval.js';

const i = (start: number, end: number) => ({ start, end });

describe('interval algebra', () => {
  it('merges overlapping and adjacent intervals', () => {
    expect(mergeIntervals([i(0, 10), i(10, 20), i(30, 40), i(5, 8)])).toEqual([
      i(0, 20),
      i(30, 40),
    ]);
  });

  it('drops empty intervals when merging', () => {
    expect(mergeIntervals([i(5, 5), i(0, 10)])).toEqual([i(0, 10)]);
  });

  it('subtracts cuts, splitting the base where needed', () => {
    expect(subtractIntervals([i(0, 100)], [i(20, 30), i(50, 60)])).toEqual([
      i(0, 20),
      i(30, 50),
      i(60, 100),
    ]);
  });

  it('returns nothing when the cut covers the base', () => {
    expect(subtractIntervals([i(10, 20)], [i(0, 100)])).toEqual([]);
  });

  it('handles cuts that touch the boundary exactly', () => {
    expect(subtractIntervals([i(0, 10)], [i(10, 20)])).toEqual([i(0, 10)]);
    expect(subtractIntervals([i(0, 10)], [i(0, 5)])).toEqual([i(5, 10)]);
  });

  it('intersects interval sets', () => {
    expect(intersectIntervals([i(0, 50), i(60, 100)], [i(40, 70)])).toEqual([i(40, 50), i(60, 70)]);
  });

  it('treats intervals as half-open', () => {
    expect(overlaps(i(0, 10), i(10, 20))).toBe(false);
    expect(intersect(i(0, 10), i(10, 20))).toBeNull();
    expect(contains(i(0, 10), i(0, 10))).toBe(true);
  });

  it('sums durations in minutes', () => {
    expect(totalMinutes([i(0, 60_000), i(0, 30_000)])).toBe(1.5);
  });
});
