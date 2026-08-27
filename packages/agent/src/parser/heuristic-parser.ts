import type { AgentCommand } from '../commands/schema.js';
import { safeParseAgentPlan } from '../commands/schema.js';
import type { CommandParser, ParseRequest, ParseResult } from './types.js';
import {
  instantOnDay,
  parseClockTime,
  parseDayRange,
  parseDeadline,
  parseDurationMinutes,
  parseNamedWindow,
} from './natural-time.js';
import { instantToISO } from '@calendar-agent/core';

/**
 * Rule-based parser used when no LLM is configured (and as a cheap fast path
 * before calling one). It covers the common phrasings; anything it does not
 * recognise returns no commands so the caller can fall back or ask.
 */
export class HeuristicCommandParser implements CommandParser {
  readonly name = 'heuristic';

  async parse(request: ParseRequest): Promise<ParseResult> {
    const result = this.match(request);
    const validation = safeParseAgentPlan({ commands: result.commands });
    if (!validation.ok) {
      return { commands: [], source: 'heuristic', confidence: 0, notes: validation.issues };
    }
    return { ...result, commands: validation.plan.commands, source: 'heuristic' };
  }

  private match(request: ParseRequest): Omit<ParseResult, 'source'> {
    const text = request.text.trim();
    const lower = text.toLowerCase();
    const iso = (instant: number): string => instantToISO(instant);

    // --- risks -------------------------------------------------------------
    if (/\b(at risk|risks?|deadlines? .*risk|behind|slipping)\b/.test(lower)) {
      return { commands: [{ type: 'list_risks' }], confidence: 0.9, intent: 'List at-risk work' };
    }

    // --- explanations ------------------------------------------------------
    if (/^why\b/.test(lower) || /\bexplain\b/.test(lower)) {
      const range = parseDayRange(lower, request.now, request.timezone);
      return {
        commands: [
          {
            type: 'explain_schedule',
            question: text,
            ...(range ? { rangeStart: iso(range.start), rangeEnd: iso(range.end) } : {}),
          },
        ],
        confidence: 0.8,
        intent: 'Explain a scheduling decision',
      };
    }

    // --- "free up" / "leave by" --------------------------------------------
    const leaveBy = /\b(leave|finish|stop|be done|wrap up)\b[^.]*?\b(by|at)\b/.test(lower)
      ? parseClockTime(lower)
      : undefined;
    if (leaveBy) {
      const range = parseDayRange(lower, request.now, request.timezone) ?? {
        start: request.now,
        end: request.now + 86_400_000,
        label: 'today',
      };
      return {
        commands: [
          {
            type: 'reschedule',
            rangeStart: iso(range.start),
            rangeEnd: iso(range.end),
            mustEndBy: iso(instantOnDay(range, leaveBy, request.timezone)),
            reason: text,
          },
        ],
        confidence: 0.85,
        intent: `Finish everything on ${range.label} by the requested time`,
      };
    }

    if (/\b(free|clear|keep .* open|block off|no meetings)\b/.test(lower)) {
      const range = parseDayRange(lower, request.now, request.timezone);
      if (range) {
        const window = parseNamedWindow(lower);
        const start = window ? instantOnDay(range, window.start, request.timezone) : range.start;
        const end = window ? instantOnDay(range, window.end, request.timezone) : range.end;
        return {
          commands: [{ type: 'block_time', title: text, start: iso(start), end: iso(end) }],
          confidence: 0.8,
          intent: `Keep ${range.label}${window ? ` ${window.label}` : ''} free`,
        };
      }
    }

    // --- a stated commitment goes on the calendar ---------------------------
    // "I have a meeting tomorrow at 12:30" is a fact about the user's day, not
    // a request to see it. Checked before the listing rule below, which used to
    // swallow any sentence containing a day word.
    const clock = parseClockTime(lower);
    const looksLikeCommitment =
      /\b(meeting|appointment|call|lunch|dinner|breakfast|coffee|interview|class|lecture|standup|stand-up|sync|1:1|one on one|catch ?up|drinks|party|flight|train)\b/.test(
        lower,
      );
    const statesCommitment =
      /\b(i have|i've got|i got|there(?:'s| is)|add .* to (?:my )?calendar|put .* on (?:my )?calendar|schedule a|book a)\b/.test(
        lower,
      );
    if (clock && (looksLikeCommitment || statesCommitment) && !isQuestion(lower)) {
      const range = parseDayRange(lower, request.now, request.timezone) ?? {
        start: request.now,
        end: request.now + 86_400_000,
        label: 'today',
      };
      let start = instantOnDay(range, clock, request.timezone);
      // "standup at 9am" said in the afternoon means tomorrow morning.
      if (start <= request.now && !/\b(today|tonight)\b/.test(lower)) {
        start += 86_400_000;
      }
      const title = extractEventTitle(text);
      const durationMinutes = parseDurationMinutes(lower) ?? 60;
      return {
        commands: [
          {
            type: 'create_event',
            title,
            start: iso(start),
            end: iso(start + durationMinutes * 60_000),
          },
        ],
        confidence: 0.8,
        intent: `Add "${title}" to the calendar`,
      };
    }

    // --- arranging something with a person ----------------------------------
    // Deliberately after the commitment rule above: "lunch with Sarah at 1pm"
    // states a time and belongs on the calendar, whereas "lunch with Sarah" has
    // no time yet and is a message that needs sending.
    const social =
      /\b(lunch|dinner|breakfast|brunch|coffee|drinks|a drink|a walk|catch ?up|a chat)\b/.exec(
        lower,
      );
    // Trailing words must be capitalised to join the name, so "sarah tomorrow"
    // yields "sarah" while "Sarah Chen" stays whole.
    const withWhom = /\bwith\s+([A-Za-z][\w'\u2019-]*(?:\s+[A-Z][\w'\u2019-]*)*)/.exec(text);
    if (social && withWhom && !clock) {
      const person = withWhom[1]!.trim();
      const qualifier = /\b(this week|next week|this weekend|sometime)\b/.exec(lower)?.[1];
      const activity = qualifier ? `${social[1]!} ${qualifier}` : social[1]!;
      // "lunch with Viraj tomorrow" names a day. Dropping it is what offers
      // Saturday to somebody who asked about Thursday.
      const when = parseDayRange(lower, request.now, request.timezone);
      return {
        commands: [
          {
            type: 'schedule_with_person',
            person,
            activity,
            ...(when ? { rangeStart: iso(when.start), rangeEnd: iso(when.end) } : {}),
          },
        ],
        confidence: 0.75,
        intent: `Arrange ${activity} with ${person}${when ? ` ${when.label}` : ''}`,
      };
    }

    // --- create a task ------------------------------------------------------
    // Checked before find_time: "I need to finish X, it takes 8 hours" is a
    // new task, while "give me 2 hours for X" is a request for a slot.
    const duration = parseDurationMinutes(lower);
    if (
      /\b(i need to|i have to|remind me to|add (a )?task|new task|todo)\b/.test(lower) &&
      duration !== undefined
    ) {
      const deadline = parseDeadline(lower, request.now, request.timezone);
      const title = extractPurpose(text) ?? text;
      const command: AgentCommand = {
        type: 'create_task',
        title,
        estimatedMinutes: duration,
        ...(deadline === undefined ? {} : { deadline: iso(deadline) }),
      };
      return {
        commands: [command, { type: 'schedule' }],
        confidence: 0.7,
        intent: `Create "${title}" and schedule it`,
      };
    }

    // --- find time ---------------------------------------------------------
    if (duration && /\b(find|give me|book|reserve|carve out|set aside|need)\b/.test(lower)) {
      const range = parseDayRange(lower, request.now, request.timezone);
      const window = parseNamedWindow(lower);
      const purpose = extractPurpose(text) ?? 'Focus time';
      return {
        commands: [
          {
            type: 'find_time',
            purpose,
            durationMinutes: duration,
            ...(range ? { rangeStart: iso(range.start), rangeEnd: iso(range.end) } : {}),
            ...(window
              ? {
                  preferredWindow: {
                    start: formatTime(window.start),
                    end: formatTime(window.end),
                  },
                }
              : {}),
          },
        ],
        confidence: 0.85,
        intent: `Find ${duration} minutes for ${purpose}`,
      };
    }

    // --- schedule an existing task ----------------------------------------
    if (/\b(schedule|plan|work on|fit in)\b/.test(lower)) {
      const matches = matchTasks(request, lower);
      if (matches.length > 0) {
        return {
          commands: [{ type: 'schedule', taskRefs: matches }],
          confidence: 0.85,
          intent: 'Schedule the referenced task(s)',
        };
      }
      // "schedule my week" with no recognised task: plan everything.
      if (/\b(everything|my week|my day|all my tasks|my tasks)\b/.test(lower)) {
        return { commands: [{ type: 'schedule' }], confidence: 0.7, intent: 'Plan all open work' };
      }
    }

    // --- listing ------------------------------------------------------------
    // Only when the user is actually *asking* what is on. A bare day word is
    // not a request: "I have a meeting tomorrow" is a statement.
    const asksToSee =
      /^(what|what's|whats|show|list|how does|how is|anything|any )/.test(lower) ||
      /\b(agenda|my schedule|my calendar|what's on|whats on|look like)\b/.test(lower) ||
      /^(today|tomorrow|tonight|this week|next week)[\s?.!]*$/.test(lower);
    if (asksToSee) {
      const range = parseDayRange(lower, request.now, request.timezone);
      return {
        commands: [
          {
            type: 'list_schedule',
            ...(range ? { rangeStart: iso(range.start), rangeEnd: iso(range.end) } : {}),
          },
        ],
        confidence: range ? 0.75 : 0.5,
        intent: 'Show the schedule',
      };
    }

    if (/\b(tasks?|todos?)\b/.test(lower)) {
      return { commands: [{ type: 'list_tasks' }], confidence: 0.6, intent: 'List tasks' };
    }

    return {
      commands: [],
      confidence: 0,
      notes: ['No rule matched this request.'],
    };
  }
}

const isQuestion = (text: string): boolean =>
  text.trim().endsWith('?') ||
  /^(what|when|where|why|how|is|are|do|does|can|could|should)\b/.test(text);

/** Turn "I have a meeting tomorrow at 12:30" into "Meeting". */
function extractEventTitle(text: string): string {
  let cleaned = text
    .replace(
      /^\s*(i\s+have|i've\s+got|i\s+got|there(?:'s| is)|add|put|schedule|book)\s+(an?\s+)?/i,
      '',
    )
    .replace(/\b(to|on)\s+(my\s+)?calendar\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Times and day words trail the subject: "meeting tomorrow at 1230pm".
  // Stripped repeatedly because several can stack up.
  const trailing =
    /\s*\b(?:at\s+\d{1,4}(?::\d{2})?\s*(?:am|pm)?|from\s+\d.*|on\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:mon|tues|wednes|thurs|fri|satur|sun)day|tom+or+ow|today|tonight|next\s+\w+|this\s+\w+|for\s+\d+\s*(?:h|hours?|m|min|minutes?))\s*$/i;
  for (let i = 0; i < 6 && trailing.test(cleaned); i += 1) {
    cleaned = cleaned.replace(trailing, '').trim();
  }
  cleaned = cleaned.replace(/[\s,.:;-]+$/, '').trim();
  if (cleaned.length < 2) return 'Event';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function formatTime(time: { hour: number; minute: number }): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

/** Pull the "... for X" / "... on X" phrase out of a request. */
function extractPurpose(text: string): string | undefined {
  const match = /\b(?:for|on|to)\s+(?:my\s+|the\s+)?([^.?!]+)/i.exec(text);
  if (!match?.[1]) return undefined;
  let cleaned = match[1].replace(/\s+/g, ' ').trim();
  const trailing =
    /\s*\b(tom+or+ow|today|tonight|this week|next week|next \w+day|morning|afternoon|evening|by .*)$/i;
  // Several time words can stack up ("research tomorrow morning").
  for (let i = 0; i < 4 && trailing.test(cleaned); i += 1) {
    cleaned = cleaned.replace(trailing, '').trim();
  }
  return cleaned.length > 1 ? cleaned : undefined;
}

/** Resolve task references by matching words from the request against titles. */
function matchTasks(request: ParseRequest, lower: string): string[] {
  const matches: string[] = [];
  for (const task of request.context.tasks) {
    const title = task.title.toLowerCase();
    if (lower.includes(title)) {
      matches.push(task.id);
      continue;
    }
    const words = title.split(/\s+/).filter((word) => word.length > 4);
    if (words.length > 0 && words.some((word) => lower.includes(word))) matches.push(task.id);
  }
  return matches;
}
