import type { PlanResult } from '../api';
import { rangeLabel } from '../time';
import { Icon } from './Icon';

interface Props {
  /** Null while nothing is proposed; the panel keeps its place either way. */
  proposal: PlanResult | null;
  timezone: string;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}

/** Diff rows arrive in sequence rather than all at once. */
const stagger = (index: number): string => `${Math.min(index, 10) * 35}ms`;

/** Entries the user has to decide about, used for the rail's tab badge. */
export function proposalItemCount(proposal: PlanResult | null): number {
  if (!proposal) return 0;
  const { diff, unscheduled } = proposal.plan;
  return diff.added.length + diff.moved.length + diff.removed.length + unscheduled.length;
}

/**
 * Structured before/after view of a proposed schedule change, with the reason
 * the scheduler recorded for each entry.
 */
export function ProposalPanel({ proposal, timezone, busy, onApprove, onReject }: Props) {
  if (!proposal) {
    return (
      <section className="panel proposal-panel">
        <div className="panel-head">
          <h2>Proposed changes</h2>
        </div>
        <p className="empty">
          Nothing proposed yet. Use <strong>Plan everything</strong> to see what the scheduler would
          change - nothing is written to your calendar until you approve it.
        </p>
      </section>
    );
  }

  const { plan, changeSet } = proposal;
  const changeCount = plan.diff.added.length + plan.diff.moved.length + plan.diff.removed.length;
  const nothingToDo = changeCount === 0;

  return (
    <section className="panel proposal-panel">
      <div className="panel-head">
        <h2>Proposed changes</h2>
        <span className="spacer" />
        {!nothingToDo && <span className="badge count">{changeCount}</span>}
      </div>

      {nothingToDo && plan.unscheduled.length === 0 && (
        <p className="empty">No changes needed - the current schedule works.</p>
      )}

      <ul className="diff">
        {plan.diff.added.map((entry, index) => (
          <li key={entry.blockId} className="added" style={{ animationDelay: stagger(index) }}>
            <span className="sigil" aria-label="added">
              +
            </span>
            <div>
              <div className="entry-name">{entry.taskTitle}</div>
              <div className="when">
                {rangeLabel(entry.after!.start, entry.after!.end, timezone)}
              </div>
              <div className="why">{entry.reason.message}</div>
            </div>
          </li>
        ))}
        {plan.diff.moved.map((entry, index) => (
          <li
            key={entry.blockId}
            className="moved"
            style={{ animationDelay: stagger(plan.diff.added.length + index) }}
          >
            <span className="sigil" aria-label="moved">
              ~
            </span>
            <div>
              <div className="entry-name">{entry.taskTitle}</div>
              <div className="when">
                {rangeLabel(entry.before!.start, entry.before!.end, timezone)}
                {' -> '}
                {rangeLabel(entry.after!.start, entry.after!.end, timezone)}
              </div>
              <div className="why">{entry.reason.message}</div>
            </div>
          </li>
        ))}
        {plan.diff.removed.map((entry) => (
          <li key={entry.blockId} className="removed">
            <span className="sigil" aria-label="removed">
              -
            </span>
            <div>
              <div className="entry-name">{entry.taskTitle}</div>
              <div className="when">
                {rangeLabel(entry.before!.start, entry.before!.end, timezone)}
              </div>
              <div className="why">{entry.reason.message}</div>
            </div>
          </li>
        ))}
        {plan.unscheduled.map((entry) => (
          <li key={entry.taskId} className="impossible">
            <span className="sigil" aria-label="cannot be scheduled">
              !
            </span>
            <div>
              <div className="entry-name">{entry.title}</div>
              <div className="why">{entry.reason.message}</div>
            </div>
          </li>
        ))}
      </ul>

      <div className="quality">
        <div className="headline">
          <span className="score">{Math.round(plan.quality.overall * 100)}%</span>
          <span className="caption">schedule quality</span>
        </div>
        <div className="metrics">
          {plan.quality.metrics.map((metric) => (
            <div className="metric" key={metric.key} title={metric.explanation}>
              <span>{metric.label}</span>
              <span className="meter">
                <i style={{ width: `${Math.round(metric.value * 100)}%` }} />
              </span>
              <span className="value">{Math.round(metric.value * 100)}%</span>
            </div>
          ))}
        </div>
      </div>

      <p className="summary">{changeSet.summary}</p>
      {changeSet.blocked.length > 0 && (
        <ul className="blocked">
          {changeSet.blocked.map((entry) => (
            <li key={entry.mutation.id}>
              {entry.mutation.label} - {entry.reason.message}
            </li>
          ))}
        </ul>
      )}

      <div className="actions">
        <button className="primary" onClick={onApprove} disabled={busy || nothingToDo}>
          <Icon name="check" size={15} />
          Approve
        </button>
        <button onClick={onReject} disabled={busy}>
          Discard
        </button>
      </div>
    </section>
  );
}
