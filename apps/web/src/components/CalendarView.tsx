import { useEffect, useRef, useState } from 'react';
import type { AppState, Calendar, CalendarEvent, ScheduleBlock, TaskRisk } from '../api';
import type { EditorTarget } from './EntryEditor';
import { guestsOf, meetingUrl, rsvpSummary } from '../event';
import { dayHead, dayKey, minutesFromMidnight, timeLabel, weekdayOf } from '../time';
import { Icon } from './Icon';

const HOUR_HEIGHT = 52;
const DAY_MS = 86_400_000;
const GUTTER_WIDTH = 56;
const SNAP_MINUTES = 15;
const DEFAULT_NEW_EVENT_MINUTES = 60;
/** Below this height an entry puts its title and time on one line. */
const COMPACT_HEIGHT = 34;
/** Below this height there is no room for the location/guests line. */
const DETAIL_HEIGHT = 62;

interface Props {
  state: AppState;
  calendars: Calendar[];
  daysToShow: number;
  startInstant: number;
  proposedBlocks?: { id: string; taskId: string; start: number; end: number }[];
  riskByTask: Map<string, TaskRisk>;
  taskTitles: Map<string, string>;
  onOpen: (target: EditorTarget) => void;
  onMoveBlock: (id: string, start: number, end: number) => void;
  onMoveEvent: (id: string, start: number, end: number) => void;
}

type EntryKind = 'block' | 'event';

/**
 * One pointer gesture at a time. All three speak minutes-from-local-midnight
 * rather than pixels, so the maths stays honest across a DST boundary.
 */
type Gesture =
  | {
      kind: 'create';
      dayIndex: number;
      anchorMinutes: number;
      currentMinutes: number;
    }
  | {
      kind: 'move';
      target: EntryKind;
      id: string;
      start: number;
      end: number;
      dayIndex: number;
      originX: number;
      originY: number;
      deltaMinutes: number;
      deltaDays: number;
      moved: boolean;
    }
  | {
      kind: 'resize';
      target: EntryKind;
      id: string;
      edge: 'start' | 'end';
      startMinutes: number;
      endMinutes: number;
      currentMinutes: number;
      moved: boolean;
    };

/**
 * Day/week grid.
 *
 * Empty space: drag to draw a time range, or click for a default-length event.
 * Entries: drag the body to move, drag either edge to change the duration,
 * click to open the editor.
 */
export function CalendarView({
  state,
  calendars,
  daysToShow,
  startInstant,
  proposedBlocks,
  riskByTask,
  taskTitles,
  onOpen,
  onMoveBlock,
  onMoveEvent,
}: Props) {
  const timezone = state.timezone;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);

  const dayStarts = Array.from({ length: daysToShow }, (_, index) =>
    dayStartFor(startInstant + index * DAY_MS, timezone),
  );
  // The grid always shows the full day; entries that cross midnight are
  // clipped and continue into the next day's column (see `place` below).
  const firstHour = 0;
  const lastHour = 24;
  const calendarById = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  const colorById = new Map(state.categories.map((category) => [category.id, category.color]));

  /** Category colour, falling back to the calendar's own colour. */
  const eventColor = (event: CalendarEvent): string | undefined =>
    colorById.get(state.categoryByEvent[event.id] ?? '') ??
    calendarById.get(event.calendarId)?.color;
  const blockColor = (block: ScheduleBlock): string | undefined =>
    colorById.get(state.categoryByBlock[block.id] ?? '');

  // The grid covers every hour an entry touches, which can mean the small
  // hours. Open it on the working day instead of on an empty 03:00.
  useEffect(() => {
    if (!gesture) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setGesture(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gesture]);

  const dayStartHour = workdayStartHour(state);
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = Math.max(0, (dayStartHour - firstHour - 0.25) * HOUR_HEIGHT);
  }, [dayStartHour, firstHour, daysToShow]);

  const columnWidth = (): number => {
    const width = bodyRef.current?.getBoundingClientRect().width ?? 0;
    return Math.max(1, (width - GUTTER_WIDTH) / daysToShow);
  };

  /** Pointer position as snapped minutes past local midnight. */
  const minutesAtY = (clientY: number): number => {
    const bounds = bodyRef.current?.getBoundingClientRect();
    if (!bounds) return firstHour * 60;
    const raw = ((clientY - bounds.top) / HOUR_HEIGHT + firstHour) * 60;
    const snapped = Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES;
    return Math.min(Math.max(snapped, firstHour * 60), lastHour * 60);
  };

  const placeMinutes = (
    fromMinutes: number,
    toMinutes: number,
  ): { top: number; height: number } => ({
    top: (fromMinutes / 60 - firstHour) * HOUR_HEIGHT,
    height: Math.max(16, ((toMinutes - fromMinutes) / 60) * HOUR_HEIGHT),
  });

  /** The range a create gesture currently describes, in minutes. */
  const createRange = (current: Extract<Gesture, { kind: 'create' }>): [number, number] => {
    const from = Math.min(current.anchorMinutes, current.currentMinutes);
    const to = Math.max(current.anchorMinutes, current.currentMinutes);
    // A press without a drag still means "make me an event here".
    return to - from < SNAP_MINUTES ? [from, from + DEFAULT_NEW_EVENT_MINUTES] : [from, to];
  };

  /** The range a resize gesture currently describes, in minutes. */
  const resizeRange = (current: Extract<Gesture, { kind: 'resize' }>): [number, number] =>
    current.edge === 'start'
      ? [Math.min(current.currentMinutes, current.endMinutes - SNAP_MINUTES), current.endMinutes]
      : [
          current.startMinutes,
          Math.max(current.currentMinutes, current.startMinutes + SNAP_MINUTES),
        ];

  // --- gesture handlers ----------------------------------------------------

  const capture = (event: React.PointerEvent): void => {
    // Throws if the pointer was released between the event firing and this
    // handler running, which must not take the gesture down with it.
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      /* the gesture still works, it just is not captured */
    }
  };
  const release = (event: React.PointerEvent): void => {
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
  };

  const beginCreate = (event: React.PointerEvent, dayIndex: number): void => {
    // Only the empty background starts a "new event" interaction.
    if (event.target !== event.currentTarget) return;
    // Touch keeps its default behaviour so the grid can still be scrolled; a
    // tap without movement still lands on the create path below.
    if (event.pointerType !== 'touch') event.preventDefault();
    capture(event);
    const minutes = minutesAtY(event.clientY);
    setGesture({ kind: 'create', dayIndex, anchorMinutes: minutes, currentMinutes: minutes });
  };

  const beginMove = (
    event: React.PointerEvent,
    target: EntryKind,
    id: string,
    start: number,
    end: number,
    dayIndex: number,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    capture(event);
    setGesture({
      kind: 'move',
      target,
      id,
      start,
      end,
      dayIndex,
      originX: event.clientX,
      originY: event.clientY,
      deltaMinutes: 0,
      deltaDays: 0,
      moved: false,
    });
  };

  const beginResize = (
    event: React.PointerEvent,
    target: EntryKind,
    id: string,
    edge: 'start' | 'end',
    start: number,
    end: number,
  ): void => {
    event.preventDefault();
    // The handle sits inside the entry, which would otherwise start a move.
    event.stopPropagation();
    capture(event);
    const startMinutes = minutesFromMidnight(start, timezone);
    const endMinutes = minutesFromMidnight(end, timezone);
    setGesture({
      kind: 'resize',
      target,
      id,
      edge,
      startMinutes,
      endMinutes,
      currentMinutes: edge === 'start' ? startMinutes : endMinutes,
      moved: false,
    });
  };

  const onPointerMove = (event: React.PointerEvent): void => {
    if (!gesture) return;

    if (gesture.kind === 'create') {
      const minutes = minutesAtY(event.clientY);
      if (minutes === gesture.currentMinutes) return;
      setGesture({ ...gesture, currentMinutes: minutes });
      return;
    }

    if (gesture.kind === 'resize') {
      const minutes = minutesAtY(event.clientY);
      if (minutes === gesture.currentMinutes) return;
      setGesture({ ...gesture, currentMinutes: minutes, moved: true });
      return;
    }

    const rawMinutes = ((event.clientY - gesture.originY) / HOUR_HEIGHT) * 60;
    const deltaMinutes = Math.round(rawMinutes / SNAP_MINUTES) * SNAP_MINUTES;
    const deltaDays = clampDays(
      Math.round((event.clientX - gesture.originX) / columnWidth()),
      gesture.dayIndex,
      daysToShow,
    );
    if (deltaMinutes === gesture.deltaMinutes && deltaDays === gesture.deltaDays) return;
    setGesture({
      ...gesture,
      deltaMinutes,
      deltaDays,
      moved: gesture.moved || deltaMinutes !== 0 || deltaDays !== 0,
    });
  };

  const endCreate = (event: React.PointerEvent, dayStart: number): void => {
    if (gesture?.kind !== 'create') return;
    release(event);
    const [from, to] = createRange(gesture);
    setGesture(null);
    onOpen({
      kind: 'create',
      start: atLocalMinutes(dayStart, from, timezone),
      end: atLocalMinutes(dayStart, to, timezone),
    });
  };

  /**
   * Moving someone else's meeting is consequential, so it is confirmed in the
   * editor (where attendees can be notified) rather than applied silently.
   */
  const commitEntry = (target: EntryKind, id: string, start: number, end: number): void => {
    if (target === 'block') {
      onMoveBlock(id, start, end);
      return;
    }
    const moving = state.events.find((entry) => entry.id === id);
    if (!moving) return;
    if (moving.attendees.filter((attendee) => !attendee.self).length > 0) {
      onOpen({ kind: 'event', event: { ...moving, start, end } });
      return;
    }
    onMoveEvent(id, start, end);
  };

  const endMove = (event: React.PointerEvent, editorTarget: EditorTarget): void => {
    if (gesture?.kind !== 'move') return;
    release(event);
    const current = gesture;
    setGesture(null);

    // A drag that never moved is a click: open the editor instead.
    if (!current.moved) {
      onOpen(editorTarget);
      return;
    }

    const dayStart = dayStarts[current.dayIndex + current.deltaDays];
    if (dayStart === undefined) return;
    const minutes = minutesFromMidnight(current.start, timezone) + current.deltaMinutes;
    const newStart = atLocalMinutes(dayStart, minutes, timezone);
    commitEntry(current.target, current.id, newStart, newStart + (current.end - current.start));
  };

  const endResize = (event: React.PointerEvent, dayStart: number): void => {
    if (gesture?.kind !== 'resize') return;
    release(event);
    const current = gesture;
    setGesture(null);
    if (!current.moved) return;
    const [from, to] = resizeRange(current);
    commitEntry(
      current.target,
      current.id,
      atLocalMinutes(dayStart, from, timezone),
      atLocalMinutes(dayStart, to, timezone),
    );
  };

  const cancelGesture = (event: React.PointerEvent): void => {
    release(event);
    setGesture(null);
  };

  const moveOffset = (target: EntryKind, id: string): string | undefined => {
    if (gesture?.kind !== 'move' || gesture.target !== target || gesture.id !== id)
      return undefined;
    if (!gesture.moved) return undefined;
    const y = (gesture.deltaMinutes / 60) * HOUR_HEIGHT;
    const x = gesture.deltaDays * columnWidth();
    return `translate(${x}px, ${y}px)`;
  };

  /** While an edge is being dragged the entry is drawn at its pending size. */
  const resizeGeometry = (
    target: EntryKind,
    id: string,
  ): { top: number; height: number } | undefined => {
    if (gesture?.kind !== 'resize' || gesture.target !== target || gesture.id !== id) {
      return undefined;
    }
    const [from, to] = resizeRange(gesture);
    return placeMinutes(from, to);
  };

  const resizeHandles = (
    target: EntryKind,
    id: string,
    start: number,
    end: number,
    dayStart: number,
  ) =>
    (['start', 'end'] as const).map((edge) => (
      <span
        key={edge}
        className={`resize-handle ${edge}`}
        aria-hidden="true"
        onPointerDown={(pointer) => beginResize(pointer, target, id, edge, start, end)}
        onPointerMove={onPointerMove}
        onPointerUp={(pointer) => endResize(pointer, dayStart)}
        onPointerCancel={cancelGesture}
      />
    ));

  return (
    <div className="calendar" ref={scrollRef}>
      <div className="calendar-head">
        <div className="gutter" />
        {dayStarts.map((instant) => {
          const head = dayHead(instant, timezone);
          const isToday = dayKey(instant, timezone) === dayKey(state.now, timezone);
          return (
            <div key={instant} className={`calendar-day-head ${isToday ? 'today' : ''}`}>
              <span className="dow">{head.weekday}</span>
              <span className="dom">{head.day}</span>
            </div>
          );
        })}
      </div>

      <div
        className={`calendar-body ${gesture ? 'gesturing' : ''}`}
        ref={bodyRef}
        style={{ height: (lastHour - firstHour) * HOUR_HEIGHT }}
      >
        <div className="gutter">
          {Array.from({ length: lastHour - firstHour }, (_, index) => (
            <div key={index} className="hour-label" style={{ height: HOUR_HEIGHT }}>
              {hourLabel(firstHour + index)}
            </div>
          ))}
        </div>

        {dayStarts.map((dayStart, dayIndex) => {
          const key = dayKey(dayStart, timezone);
          const weekday = weekdayOf(dayStart, timezone);
          const inDay = (start: number, end: number): boolean =>
            dayKey(start, timezone) === key || dayKey(end - 1, timezone) === key;

          const events = state.events.filter(
            (event) => !event.isAllDay && inDay(event.start, event.end),
          );
          const blocks = state.blocks.filter((block) => inDay(block.start, block.end));
          const proposals = (proposedBlocks ?? []).filter((block) => inDay(block.start, block.end));

          // Clipped to this column's own midnight-to-midnight span, so an
          // entry that crosses midnight is cut off here and picked up again
          // at the top of the next day's column (it is a member of both,
          // per `inDay` above).
          const place = (start: number, end: number) => {
            const from = Math.max(start, dayStart);
            const to = Math.min(end, dayStart + DAY_MS);
            return {
              top: ((from - dayStart) / 3_600_000 - firstHour) * HOUR_HEIGHT,
              height: Math.max(16, ((to - from) / 3_600_000) * HOUR_HEIGHT),
            };
          };

          return (
            <div
              className="calendar-day"
              key={dayStart}
              onPointerDown={(event) => beginCreate(event, dayIndex)}
              onPointerMove={onPointerMove}
              onPointerUp={(event) => endCreate(event, dayStart)}
              onPointerCancel={cancelGesture}
            >
              {(state.preferences.workingHours[weekday] ?? []).map((window, index) => (
                <div
                  key={`w${index}`}
                  className="band working"
                  style={bandStyle(window, firstHour)}
                />
              ))}
              {state.preferences.deepWork.enabled &&
                (state.preferences.deepWork.schedule[weekday] ?? []).map((window, index) => (
                  <div
                    key={`d${index}`}
                    className="band deep"
                    style={bandStyle(window, firstHour)}
                  />
                ))}

              {Array.from({ length: lastHour - firstHour }, (_, index) => (
                <div key={index} className="hour-line" style={{ top: index * HOUR_HEIGHT }} />
              ))}

              {events.map((event: CalendarEvent, index) => {
                const calendar = calendarById.get(event.calendarId);
                const draggable =
                  calendar?.isWritable === true && event.recurrenceKind !== 'series_master';
                const { top, height } = place(event.start, event.end);
                return (
                  <div
                    key={event.id}
                    className={`entry event ${event.classification.toLowerCase()} ${draggable ? 'draggable' : ''} ${height < COMPACT_HEIGHT ? 'compact' : ''}`}
                    style={{
                      top,
                      height,
                      animationDelay: stagger(index),
                      transform: moveOffset('event', event.id),
                      ...resizeGeometry('event', event.id),
                      ...tint(eventColor(event)),
                    }}
                    title={eventTooltip(event, timezone, draggable)}
                    onPointerDown={(pointer) =>
                      draggable
                        ? beginMove(pointer, 'event', event.id, event.start, event.end, dayIndex)
                        : undefined
                    }
                    onPointerMove={onPointerMove}
                    onPointerUp={(pointer) =>
                      draggable
                        ? endMove(pointer, { kind: 'event', event })
                        : onOpen({ kind: 'event', event })
                    }
                    onPointerCancel={cancelGesture}
                  >
                    <span className="entry-title">{event.title}</span>
                    <span className="entry-time">{timeLabel(event.start, timezone)}</span>
                    {height >= DETAIL_HEIGHT && <EntryMeta event={event} />}
                    {draggable &&
                      resizeHandles('event', event.id, event.start, event.end, dayStart)}
                  </div>
                );
              })}

              {blocks.map((block: ScheduleBlock & { title: string }, index) => {
                const risk = riskByTask.get(block.taskId);
                const { top, height } = place(block.start, block.end);
                return (
                  <div
                    key={block.id}
                    className={`entry block draggable ${risk && risk.level !== 'SAFE' ? risk.level.toLowerCase() : ''} ${block.pinned ? 'pinned' : ''} ${height < COMPACT_HEIGHT ? 'compact' : ''}`}
                    style={{
                      top,
                      height,
                      animationDelay: stagger(index),
                      transform: moveOffset('block', block.id),
                      ...resizeGeometry('block', block.id),
                      ...tint(blockColor(block)),
                    }}
                    title={`${block.title}\n${timeLabel(block.start, timezone)}-${timeLabel(block.end, timezone)}${block.pinned ? '\nPinned' : ''}\nDrag to move, drag an edge to resize, click to edit`}
                    onPointerDown={(pointer) =>
                      beginMove(pointer, 'block', block.id, block.start, block.end, dayIndex)
                    }
                    onPointerMove={onPointerMove}
                    onPointerUp={(pointer) => endMove(pointer, { kind: 'block', block })}
                    onPointerCancel={cancelGesture}
                  >
                    <span className="entry-title">{block.title}</span>
                    <span className="entry-time">{timeLabel(block.start, timezone)}</span>
                    {resizeHandles('block', block.id, block.start, block.end, dayStart)}
                  </div>
                );
              })}

              {proposals.map((block, index) => {
                const { top, height } = place(block.start, block.end);
                return (
                  <div
                    key={`p${block.id}`}
                    className={`entry proposal ${height < COMPACT_HEIGHT ? 'compact' : ''}`}
                    style={{ top, height, animationDelay: stagger(index) }}
                    title="Proposed change - approve it to apply"
                  >
                    <span className="entry-title">
                      {taskTitles.get(block.taskId) ?? 'Proposed'}
                    </span>
                    <span className="entry-time">{timeLabel(block.start, timezone)}</span>
                  </div>
                );
              })}

              {gesture?.kind === 'create' && gesture.dayIndex === dayIndex && (
                <Draft
                  range={createRange(gesture)}
                  place={placeMinutes}
                  conflicts={overlaps(createRange(gesture), dayStart, events, blocks, timezone)}
                />
              )}

              {dayKey(state.now, timezone) === key && (
                <div
                  className="now-line"
                  style={{
                    top: (minutesFromMidnight(state.now, timezone) / 60 - firstHour) * HOUR_HEIGHT,
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A short, capped ramp so a batch of new entries lands in sequence instead of
 * all at once. Capped because a full day of blocks should not take a second.
 */
const STAGGER_STEP_MS = 30;
const STAGGER_MAX_STEPS = 8;
const stagger = (index: number): string =>
  `${Math.min(index, STAGGER_MAX_STEPS) * STAGGER_STEP_MS}ms`;

/**
 * Everything the grid can tell you about an event without opening it. Kept to
 * one line: an entry is a couple of centimetres tall, and the editor is a click
 * away for the rest.
 */
function EntryMeta({ event }: { event: CalendarEvent }) {
  const guests = guestsOf(event);
  const online = meetingUrl(event) !== undefined;
  if (!event.location && guests.length === 0 && !online) return null;
  return (
    <span className="entry-meta">
      {event.location && (
        <span className="entry-meta-item">
          <Icon name="map-pin" size={11} />
          {event.location}
        </span>
      )}
      {online && !event.location && (
        <span className="entry-meta-item">
          <Icon name="link" size={11} />
          Online
        </span>
      )}
      {guests.length > 0 && (
        <span className="entry-meta-item">
          <Icon name="users" size={11} />
          {guests.length}
        </span>
      )}
    </span>
  );
}

/** The hover text for an event: the detail the entry itself has no room for. */
function eventTooltip(event: CalendarEvent, timezone: string, draggable: boolean): string {
  const lines = [
    event.title,
    `${timeLabel(event.start, timezone)}-${timeLabel(event.end, timezone)}`,
  ];
  if (event.location) lines.push(`At ${event.location}`);
  const rsvp = rsvpSummary(event);
  if (rsvp) lines.push(rsvp);
  if (event.transparency === 'transparent') lines.push('Shown as free');
  lines.push(event.classification);
  lines.push(draggable ? 'Drag to move, drag an edge to resize, click to edit' : 'Read-only');
  return lines.join('\n');
}

const clockLabel = (minutes: number): string => {
  const total = ((minutes % 1440) + 1440) % 1440;
  return hourLabel(total / 60, total % 60);
};

/** Gutter/draft hour label, e.g. `8 AM`, `12 PM`, or `1:30 PM` when minutes are given. */
function hourLabel(hour: number, minute = 0): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const twelveHour = Math.floor(hour) % 12 === 0 ? 12 : Math.floor(hour) % 12;
  return minute === 0
    ? `${twelveHour} ${period}`
    : `${twelveHour}:${String(minute).padStart(2, '0')} ${period}`;
}

/** The range being drawn, shown as it will be created. */
function Draft({
  range,
  place,
  conflicts,
}: {
  range: [number, number];
  place: (from: number, to: number) => { top: number; height: number };
  conflicts: boolean;
}) {
  const [from, to] = range;
  const { top, height } = place(from, to);
  return (
    <div
      className={`entry draft ${conflicts ? 'conflict' : ''} ${height < COMPACT_HEIGHT ? 'compact' : ''}`}
      style={{ top, height }}
    >
      <span className="entry-title">{conflicts ? 'Overlaps something' : 'New event'}</span>
      <span className="entry-time">{`${clockLabel(from)} - ${clockLabel(to)}`}</span>
    </div>
  );
}

/** Whether a drafted range lands on top of anything already on that day. */
function overlaps(
  range: [number, number],
  dayStart: number,
  events: readonly { start: number; end: number }[],
  blocks: readonly { start: number; end: number }[],
  timezone: string,
): boolean {
  const from = atLocalMinutes(dayStart, range[0], timezone);
  const to = atLocalMinutes(dayStart, range[1], timezone);
  const hit = (entry: { start: number; end: number }): boolean =>
    entry.start < to && entry.end > from;
  return events.some(hit) || blocks.some(hit);
}

/**
 * Category colour applied as a translucent fill with a solid left edge, so a
 * user-chosen colour stays legible against the dark grid whatever they pick.
 */
function tint(color: string | undefined): React.CSSProperties {
  if (!color) return {};
  return {
    background: `color-mix(in srgb, ${color} 55%, transparent)`,
    borderLeft: `3px solid ${color}`,
  };
}

function bandStyle(
  window: { start: { hour: number; minute: number }; end: { hour: number; minute: number } },
  firstHour: number,
): React.CSSProperties {
  const top = (window.start.hour + window.start.minute / 60 - firstHour) * HOUR_HEIGHT;
  const height =
    (window.end.hour - window.start.hour + (window.end.minute - window.start.minute) / 60) *
    HOUR_HEIGHT;
  return { top, height };
}

function dayStartFor(instant: number, timezone: string): number {
  const minutes = minutesFromMidnight(instant, timezone);
  return instant - minutes * 60_000 - (instant % 60_000);
}

/**
 * Instant at `minutes` past local midnight. Adding milliseconds is not enough:
 * on a DST day the offset changes mid-day, so the result is checked and
 * corrected once.
 */
function atLocalMinutes(dayStart: number, minutes: number, timezone: string): number {
  const candidate = dayStart + minutes * 60_000;
  const actual = minutesFromMidnight(candidate, timezone);
  return actual === minutes ? candidate : candidate + (minutes - actual) * 60_000;
}

function clampDays(delta: number, dayIndex: number, daysToShow: number): number {
  return Math.max(-dayIndex, Math.min(delta, daysToShow - 1 - dayIndex));
}

/** Earliest hour any working-hours window starts, used as the default scroll. */
function workdayStartHour(state: AppState): number {
  let earliest = 24;
  for (const windows of Object.values(state.preferences.workingHours)) {
    for (const window of windows ?? []) earliest = Math.min(earliest, window.start.hour);
  }
  return earliest === 24 ? 8 : earliest;
}

