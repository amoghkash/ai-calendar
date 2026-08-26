import type {
  ChangeSet,
  DiffEntry,
  FreeWindow,
  ScheduleBlock,
  SchedulingPlan,
  Task,
  TaskRisk,
} from '@calendar-agent/core';
import {
  RISK_ORDER,
  describeInstant,
  describeInterval,
  formatMinutes,
  round,
} from '@calendar-agent/core';

const ESC = String.fromCharCode(27);
const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

const wrap =
  (code: string) =>
  (text: string): string =>
    useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const magenta = wrap('35');

export const RISK_COLOR: Record<string, (text: string) => string> = {
  SAFE: green,
  AT_RISK: yellow,
  CRITICAL: red,
  IMPOSSIBLE: red,
};

const ANSI_PATTERN = new RegExp(`${ESC}\\[\\d+m`, 'g');
const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, '');

/** Ids are UUIDs; the first segment is enough to identify one interactively. */
export const shortId = (id: string): string => {
  const withoutPrefix = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
  return withoutPrefix.slice(0, 8);
};

export function table(rows: readonly (readonly string[])[], headers?: readonly string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  if (all.length === 0) return '';
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, stripAnsi(cell).length);
    });
  }
  const render = (row: readonly string[]): string =>
    row
      .map(
        (cell, index) =>
          cell + ' '.repeat(Math.max(0, (widths[index] ?? 0) - stripAnsi(cell).length)),
      )
      .join('  ')
      .trimEnd();
  const lines = headers ? [bold(render(headers))] : [];
  for (const row of rows) lines.push(render(row));
  return lines.join('\n');
}

export function formatTasks(
  tasks: readonly Task[],
  timezone: string,
  risks?: readonly TaskRisk[],
): string {
  if (tasks.length === 0) {
    return dim(
      'No tasks yet. Add one with: calendar-agent tasks add "Finish report" --duration 2h',
    );
  }
  const riskByTask = new Map((risks ?? []).map((risk) => [risk.taskId, risk]));
  const rows = tasks.map((task) => {
    const risk = riskByTask.get(task.id);
    const remaining = Math.max(0, task.estimatedMinutes - task.completedMinutes);
    return [
      shortId(task.id),
      task.title,
      task.priority,
      task.deadline === undefined ? dim('-') : describeInstant(task.deadline, timezone),
      formatMinutes(remaining),
      risk ? (RISK_COLOR[risk.level] ?? ((text: string) => text))(risk.level) : dim('-'),
      task.status,
    ];
  });
  return table(rows, ['ID', 'TASK', 'PRIORITY', 'DEADLINE', 'REMAINING', 'RISK', 'STATUS']);
}

export function formatRisks(risks: readonly TaskRisk[]): string {
  const notable = [...risks]
    .filter((risk) => risk.level !== 'SAFE')
    .sort((a, b) => RISK_ORDER[b.level] - RISK_ORDER[a.level]);
  if (risks.length === 0) return dim('No open tasks to assess.');
  if (notable.length === 0) return green(`All ${risks.length} open task(s) are on track.`);
  return notable
    .map((risk) => `${(RISK_COLOR[risk.level] ?? bold)(`[${risk.level}]`)} ${risk.explanation}`)
    .join('\n');
}

export function formatAgenda(
  agenda: {
    readonly events: readonly {
      title: string;
      start: number;
      end: number;
      classification: string;
    }[];
    readonly blocks: readonly (ScheduleBlock & { title: string })[];
  },
  timezone: string,
): string {
  const rows = [
    ...agenda.events.map((event) => ({
      start: event.start,
      cells: [
        describeInterval(event, timezone),
        event.title,
        dim(event.classification.toLowerCase()),
      ],
    })),
    ...agenda.blocks.map((block) => ({
      start: block.start,
      cells: [describeInterval(block, timezone), blue(block.title), dim('task block')],
    })),
  ].sort((a, b) => a.start - b.start);
  if (rows.length === 0) return dim('Nothing scheduled.');
  return table(rows.map((row) => row.cells));
}

/** Simulation output: `+` added, `~` moved, `-` removed, `!` cannot be done. */
export function formatPlan(
  plan: SchedulingPlan,
  changeSet: ChangeSet,
  titles: ReadonlyMap<string, string>,
  options: { readonly applied?: boolean } = {},
): string {
  const lines: string[] = [bold('PROPOSED CHANGES'), ''];
  const label = (entry: DiffEntry): string =>
    entry.taskTitle || titles.get(entry.taskId) || entry.taskId;

  if (plan.diff.added.length + plan.diff.moved.length + plan.diff.removed.length === 0) {
    lines.push(dim('No changes needed; the current schedule already satisfies every constraint.'));
  }
  for (const entry of plan.diff.added) {
    lines.push(`${green(`+ ${describeInterval(entry.after!, plan.timezone)}`)}  ${label(entry)}`);
    lines.push(dim(`    ${entry.reason.message}`));
  }
  for (const entry of plan.diff.moved) {
    lines.push(
      `${yellow(
        `~ ${describeInterval(entry.before!, plan.timezone)} -> ${describeInterval(entry.after!, plan.timezone)}`,
      )}  ${label(entry)}`,
    );
    lines.push(dim(`    ${entry.reason.message}`));
  }
  for (const entry of plan.diff.removed) {
    lines.push(`${red(`- ${describeInterval(entry.before!, plan.timezone)}`)}  ${label(entry)}`);
    lines.push(dim(`    ${entry.reason.message}`));
  }
  for (const entry of plan.unscheduled) {
    lines.push(red(`! ${entry.title}`));
    lines.push(dim(`    ${entry.reason.message}`));
  }

  const notable = plan.risks.filter((risk) => risk.level !== 'SAFE');
  if (notable.length > 0) {
    lines.push('', bold('RISKS'));
    for (const risk of notable) {
      lines.push(`${(RISK_COLOR[risk.level] ?? bold)(`[${risk.level}]`)} ${risk.explanation}`);
    }
  }

  lines.push(
    '',
    dim(
      `Schedule quality ${round(plan.quality.overall * 100)}% - ${plan.quality.metrics
        .map((metric) => `${metric.label} ${round(metric.value * 100)}%`)
        .join(', ')}`,
    ),
    changeSet.summary,
  );

  if (options.applied) {
    lines.push(green('Changes applied to your calendar.'));
  } else {
    lines.push(dim('No calendar changes were made.'));
    if (changeSet.pending.length > 0 || changeSet.autoApply.length > 0) {
      lines.push(`Apply with: ${bold(`calendar-agent approve ${changeSet.id}`)}`);
    }
  }
  return lines.join('\n');
}

export function formatSlots(slots: readonly FreeWindow[], timezone: string): string {
  if (slots.length === 0) return dim('No free window of that length was found.');
  return table(
    slots.map((slot) => [
      describeInterval(slot, timezone),
      formatMinutes((slot.end - slot.start) / 60_000),
      slot.deepWork ? magenta('deep work') : '',
    ]),
  );
}

export function formatExplanation(
  plan: SchedulingPlan,
  titles: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [bold('SCHEDULING TRACE'), ''];
  for (const step of plan.trace.steps) {
    lines.push(`${dim(step.step.padEnd(12))} ${step.message}`);
  }
  lines.push('', bold('TASK RANKING'));
  for (const score of plan.trace.scores) {
    lines.push(`${score.total.toFixed(2)}  ${titles.get(score.taskId) ?? score.title}`);
    for (const component of score.components) {
      lines.push(
        dim(
          `        ${component.key.padEnd(16)} ${component.contribution.toFixed(2)}  ${component.explanation}`,
        ),
      );
    }
  }
  return lines.join('\n');
}
