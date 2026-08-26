import { describe, expect, it } from 'vitest';
import type { DirectoryContact } from './messaging.js';
import { extractCandidateNames, resolveName, resolveNamesInTitle } from './name-match.js';

const contact = (id: string, displayName: string, handles = 1): DirectoryContact => ({
  id,
  displayName,
  handles: Array.from({ length: handles }, (_, index) => ({
    kind: 'phone' as const,
    value: `(415) 555-000${index}`,
    normalized: `+1415555000${index}`,
  })),
});

const BOOK = [
  contact('1', 'Sarah Chen'),
  contact('2', 'Sarah Jones'),
  contact('3', 'Mike Okafor'),
  contact('4', 'Priya Raman'),
  contact('5', 'Blue Bottle Coffee'),
];

const names = (title: string): string[] =>
  extractCandidateNames(title).map((candidate) => candidate.text);

describe('extracting names from an event title', () => {
  it('drops the activity and the connector', () => {
    expect(names('Lunch with Sarah')).toEqual(['Sarah']);
  });

  it('handles the shorthand people actually type', () => {
    expect(names('coffee w/ sarah')).toEqual(['sarah']);
    expect(names('Dinner w/ Priya')).toEqual(['Priya']);
  });

  it('splits several people apart', () => {
    expect(names('coffee w/ sarah + mike')).toEqual(['sarah', 'mike']);
    expect(names('Dinner with Sarah Chen and Mike')).toEqual(['Sarah Chen', 'Mike']);
    expect(names('Lunch: Priya, Mike')).toEqual(['Priya', 'Mike']);
  });

  it('keeps a full name together', () => {
    expect(names('Lunch with Sarah Chen')).toEqual(['Sarah Chen']);
  });

  it('strips a possessive', () => {
    expect(names("Lunch @ Sarah's")).toEqual(['Sarah']);
  });

  it('ignores times and counters', () => {
    expect(names('Sarah 1:1')).toEqual(['Sarah']);
    expect(names('30m sync with Mike')).toEqual(['Mike']);
  });

  it('stops a name at the next stopword', () => {
    expect(names('Lunch with Sarah re budget')).toEqual(['Sarah', 'budget']);
  });

  it('leaves an email address alone', () => {
    expect(names('Lunch with sarah@example.com')).toEqual([]);
  });

  it('produces nothing for a title with no people in it', () => {
    expect(names('Lunch')).toEqual([]);
    expect(names('Deep work')).toEqual(['Deep work']);
  });

  it('does not repeat the same name twice', () => {
    expect(names('Sarah and Sarah')).toEqual(['Sarah']);
  });
});

describe('resolving a name against the address book', () => {
  const resolve = (title: string) => resolveNamesInTitle(title, BOOK);

  it('picks the one contact whose full name matches', () => {
    const [result] = resolve('Lunch with Sarah Chen');
    expect(result?.kind).toBe('unique');
    expect(result?.kind === 'unique' && result.match.contact.id).toBe('1');
    expect(result?.kind === 'unique' && result.match.reason).toBe('exact_full_name');
  });

  it('asks rather than guessing when a first name is shared', () => {
    const [result] = resolve('Lunch with Sarah');
    expect(result?.kind).toBe('ambiguous');
    expect(result?.kind === 'ambiguous' && result.matches.map((m) => m.contact.id)).toEqual([
      '1',
      '2',
    ]);
  });

  it('resolves a unique first name outright', () => {
    const [result] = resolve('Coffee with Priya');
    expect(result?.kind).toBe('unique');
    expect(result?.kind === 'unique' && result.match.contact.id).toBe('4');
  });

  it('matches on a surname', () => {
    const [result] = resolve('Lunch with Okafor');
    expect(result?.kind === 'unique' && result.match.reason).toBe('exact_other_name');
  });

  it('prefers a full-name match over a first-name collision', () => {
    // "Sarah Chen" beats plain "Sarah", so a shared first name is not a tie.
    const [result] = resolve('Sarah Chen');
    expect(result?.kind).toBe('unique');
  });

  it('finds nobody for a place', () => {
    const results = resolve('Lunch at Blue Bottle');
    expect(results.every((result) => result.kind !== 'unique')).toBe(true);
  });

  it('refuses to match a fragment shorter than three characters', () => {
    expect(resolveName({ text: 'Sa', normalized: 'sa' }, BOOK).kind).toBe('none');
  });

  it('matches a prefix of a real name', () => {
    const result = resolveName({ text: 'Pri', normalized: 'pri' }, BOOK);
    expect(result.kind === 'unique' && result.match.reason).toBe('prefix');
  });

  it('will not suggest a contact there is no way to message', () => {
    const unreachable = [{ id: '9', displayName: 'Priya Raman', handles: [] }];
    expect(resolveName({ text: 'Priya', normalized: 'priya' }, unreachable).kind).toBe('none');
  });

  it('resolves each person in a two-person title', () => {
    const results = resolve('Dinner with Priya and Mike');
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.kind === 'unique')).toBe(true);
  });

  it('returns none for an unknown name rather than a weak guess', () => {
    expect(resolve('Lunch with Jordan')[0]?.kind).toBe('none');
  });
});
