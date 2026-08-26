import { describe, expect, it } from 'vitest';
import { METADATA_MANAGED } from './calendar.js';
import { classifyEvent } from './classification.js';

const base = {
  title: 'Something',
  attendees: [],
  isOrganizer: true,
  isAllDay: false,
};

describe('classifyEvent', () => {
  it('classifies agent-created blocks as MOVABLE', () => {
    const result = classifyEvent({ ...base, metadata: { [METADATA_MANAGED]: 'true' } });
    expect(result.classification).toBe('MOVABLE');
    expect(result.isMovable).toBe(true);
  });

  it('classifies events with other attendees as FIXED', () => {
    const result = classifyEvent({
      ...base,
      title: 'Team meeting',
      attendees: [{ email: 'me@example.com', self: true }, { email: 'other@example.com' }],
    });
    expect(result.classification).toBe('FIXED');
  });

  it('falls back to UNKNOWN, which is never moved', () => {
    const result = classifyEvent({ ...base, title: 'Lunch' });
    expect(result.classification).toBe('UNKNOWN');
    expect(result.isMovable).toBe(false);
    expect(result.isProtected).toBe(false);
  });

  it('applies user rules before heuristics', () => {
    const result = classifyEvent({ ...base, title: 'Doctor appointment' }, [
      { id: 'doctor', classification: 'PROTECTED', titlePattern: 'doctor|dentist' },
    ]);
    expect(result.classification).toBe('PROTECTED');
    expect(result.isProtected).toBe(true);
    expect(result.ruleId).toBe('doctor');
  });

  it('lets one pair of rules float a solo lunch and pin a shared one', () => {
    // The pattern the settings panel is built around: order matters, and the
    // narrower rule has to come first.
    const rules = [
      {
        id: 'lunch-with-someone',
        classification: 'FIXED' as const,
        titlePattern: 'lunch',
        hasOtherAttendees: true,
      },
      {
        id: 'lunch-solo',
        classification: 'MOVABLE' as const,
        titlePattern: 'lunch',
        hasOtherAttendees: false,
      },
    ];

    const solo = classifyEvent({ ...base, title: 'Lunch' }, rules);
    expect(solo.classification).toBe('MOVABLE');
    expect(solo.ruleId).toBe('lunch-solo');

    const shared = classifyEvent(
      {
        ...base,
        title: 'Lunch with Sam',
        attendees: [{ email: 'me@example.com', self: true }, { email: 'sam@example.com' }],
      },
      rules,
    );
    expect(shared.classification).toBe('FIXED');
    expect(shared.ruleId).toBe('lunch-with-someone');
  });

  it('matches rules on attendees and calendar', () => {
    const rules = [
      { id: 'personal-cal', classification: 'MOVABLE' as const, calendarId: 'personal' },
    ];
    expect(classifyEvent({ ...base, calendarId: 'personal' }, rules).classification).toBe(
      'MOVABLE',
    );
    expect(classifyEvent({ ...base, calendarId: 'work' }, rules).classification).toBe('UNKNOWN');
  });

  it('ignores an invalid regex instead of throwing', () => {
    const result = classifyEvent({ ...base }, [
      { id: 'bad', classification: 'PROTECTED', titlePattern: '([' },
    ]);
    expect(result.classification).toBe('UNKNOWN');
  });

  it('treats a linked person as the attendee the calendar never got', () => {
    // Without the link this is a solo block: UNKNOWN, which the default policy
    // lets the agent propose moving. Lunch agreed over text is not movable.
    const solo = classifyEvent({ ...base, title: 'Lunch' });
    expect(solo.classification).toBe('UNKNOWN');

    const linked = classifyEvent({ ...base, title: 'Lunch', linkedPeople: ['+14155551212'] });
    expect(linked.classification).toBe('FIXED');
    expect(linked.isMovable).toBe(false);
    expect(linked.explanation).toMatch(/someone you know/);
  });

  it('does not let an empty link list change anything', () => {
    expect(classifyEvent({ ...base, title: 'Lunch', linkedPeople: [] }).classification).toBe(
      'UNKNOWN',
    );
  });

  it('still lets the agent move its own task blocks when linked', () => {
    const result = classifyEvent({
      ...base,
      metadata: { [METADATA_MANAGED]: 'true' },
      linkedPeople: ['+14155551212'],
    });
    expect(result.classification).toBe('MOVABLE');
  });
});
