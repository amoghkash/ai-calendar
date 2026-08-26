import { describe, expect, it } from 'vitest';
import { handlesMatch, isEmailHandle, normalizeHandle } from './handles.js';

describe('handle normalisation', () => {
  it('turns a locally written number into E.164 for the configured region', () => {
    expect(normalizeHandle('(415) 555-1212', 'US')).toEqual({
      kind: 'phone',
      normalized: '+14155551212',
    });
  });

  it('keeps an explicit country code', () => {
    expect(normalizeHandle('+44 20 7946 0958', 'US').normalized).toBe('+442079460958');
  });

  it('does not double a country code already present', () => {
    expect(normalizeHandle('1-415-555-1212', 'US').normalized).toBe('+14155551212');
  });

  it('lowercases email handles', () => {
    expect(normalizeHandle('  Sarah@Example.COM ', 'US')).toEqual({
      kind: 'email',
      normalized: 'sarah@example.com',
    });
  });

  it('matches the same person written two ways', () => {
    expect(handlesMatch('(415) 555-1212', '+1 415 555 1212', 'US')).toBe(true);
    expect(handlesMatch('(415) 555-1212', '+1 415 555 9999', 'US')).toBe(false);
  });

  it('passes through a handle that is neither a number nor an email', () => {
    expect(normalizeHandle('chat123', 'US').normalized).toBe('chat123');
  });

  it('recognises emails', () => {
    expect(isEmailHandle('a@b.com')).toBe(true);
    expect(isEmailHandle('+14155551212')).toBe(false);
  });
});
