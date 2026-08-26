import type { SchedulingPlan, TaskRisk } from '@calendar-agent/core';
import { RISK_ORDER, describeInterval, formatMinutes, round } from '@calendar-agent/core';
import type { LLMProvider } from '../llm/types.js';
import { buildExplanationSystemPrompt } from '../prompts/system.js';

/**
 * Structured facts about a plan. The deterministic renderer below is always
 * available; an LLM, when configured, only rephrases these same facts.
 */
export interface PlanFacts {
  readonly timezone: string;
  readonly blocks: readonly {
    readonly task: string;
    readonly when: string;
    readonly minutes: number;
    readonly origin: string;
    readonly reason: string;
  }[];
  readonly unscheduled: readonly { readonly task: string; readonly reason: string }[];
  readonly risks: readonly {
    readonly task: string;
    readonly level: string;
    readonly why: string;
  }[];
  readonly changes: {
    readonly added: number;
    readonly moved: number;
    readonly removed: number;
    readonly unchanged: number;
  };
  readonly quality: readonly {
    readonly metric: string;
    readonly value: number;
    readonly why: string;
  }[];
}

export function collectPlanFacts(plan: SchedulingPlan): PlanFacts {
  return {
    timezone: plan.timezone,
    blocks: plan.blocks.map((block) => ({
      task: block.taskId,
      when: describeInterval(block, plan.timezone),
      minutes: block.minutes,
      origin: block.origin,
      reason: block.reason.message,
    })),
    unscheduled: plan.unscheduled.map((entry) => ({
      task: entry.title,
      reason: entry.reason.message,
    })),
    risks: plan.risks.map((risk) => ({
      task: risk.title,
      level: risk.level,
      why: risk.explanation,
    })),
    changes: {
      added: plan.diff.summary.addedCount,
      moved: plan.diff.summary.movedCount,
      removed: plan.diff.summary.removedCount,
      unchanged: plan.diff.summary.unchangedCount,
    },
    quality: plan.quality.metrics.map((metric) => ({
      metric: metric.label,
      value: metric.value,
      why: metric.explanation,
    })),
  };
}

/** Deterministic, LLM-free explanation of a plan. */
export function renderPlanExplanation(
  plan: SchedulingPlan,
  titles?: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [];
  const name = (taskId: string): string => titles?.get(taskId) ?? taskId;

  if (plan.blocks.length === 0) {
    lines.push('Nothing is scheduled in this window.');
  } else {
    lines.push(
      `Planned ${plan.blocks.length} block(s) totalling ${formatMinutes(
        plan.blocks.reduce((sum, block) => sum + block.minutes, 0),
      )}:`,
    );
    for (const block of plan.blocks) {
      lines.push(
        `  ${describeInterval(block, plan.timezone)}  ${name(block.taskId)} (${block.origin}) - ${block.reason.message}`,
      );
    }
  }

  if (plan.unscheduled.length > 0) {
    lines.push('', 'Could not be scheduled:');
    for (const entry of plan.unscheduled) {
      lines.push(`  ${entry.title}: ${entry.reason.message}`);
    }
  }

  const notable = [...plan.risks]
    .filter((risk) => risk.level !== 'SAFE')
    .sort((a, b) => RISK_ORDER[b.level] - RISK_ORDER[a.level]);
  if (notable.length > 0) {
    lines.push('', 'Risks:');
    for (const risk of notable) lines.push(`  [${risk.level}] ${risk.explanation}`);
  }

  lines.push(
    '',
    `Schedule quality ${round(plan.quality.overall * 100)}%: ${plan.quality.metrics
      .map((metric) => `${metric.label} ${round(metric.value * 100)}%`)
      .join(', ')}.`,
  );
  return lines.join('\n');
}

export function renderRiskSummary(risks: readonly TaskRisk[]): string {
  if (risks.length === 0) return 'No open tasks to assess.';
  const notable = [...risks]
    .filter((risk) => risk.level !== 'SAFE')
    .sort((a, b) => RISK_ORDER[b.level] - RISK_ORDER[a.level]);
  if (notable.length === 0) return `All ${risks.length} open task(s) are on track.`;
  return notable.map((risk) => `[${risk.level}] ${risk.explanation}`).join('\n');
}

export interface ExplainOptions {
  readonly llm?: LLMProvider;
  readonly question?: string;
  readonly timezone: string;
}

/**
 * Answer a "why" question about a plan. Without an LLM the deterministic
 * rendering is returned unchanged, so the feature degrades rather than breaks.
 */
export async function explainPlan(
  plan: SchedulingPlan,
  options: ExplainOptions,
  titles?: ReadonlyMap<string, string>,
): Promise<string> {
  const deterministic = renderPlanExplanation(plan, titles);
  if (!options.llm) return deterministic;

  const facts = collectPlanFacts(plan);
  const response = await options.llm.generate({
    system: buildExplanationSystemPrompt(options.timezone),
    messages: [
      {
        role: 'user',
        content: [
          options.question ? `Question: ${options.question}` : 'Explain this schedule.',
          '',
          'Structured facts (JSON):',
          JSON.stringify(facts, null, 2),
        ].join('\n'),
      },
    ],
  });
  return response.text.trim().length > 0 ? response.text.trim() : deterministic;
}
