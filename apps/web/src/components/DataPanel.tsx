import { useState } from 'react';
import type { DataStats } from '../api';
import { Icon } from './Icon';

interface Props {
  stats: DataStats | null;
  busy: boolean;
  onRefresh: () => void;
  onPrune: (days: number, dryRun: boolean) => void;
  onReset: (scopes: string[], confirm: boolean) => void;
  lastResult: string | null;
}

const RESET_SCOPES = [
  { id: 'events', label: 'Calendar events' },
  { id: 'blocks', label: 'Scheduled blocks' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'categories', label: 'Categories' },
  { id: 'calendars', label: 'Calendars' },
  { id: 'accounts', label: 'Connected accounts' },
  { id: 'conversations', label: 'Chat history' },
  { id: 'changeSets', label: 'Proposal history' },
];

/**
 * Counts are keyed by storage name. Stat tiles are narrow, so the labels are
 * short on purpose; anything unmapped falls back to de-camel-casing.
 */
const COUNT_LABELS: Record<string, string> = {
  events: 'Events',
  blocks: 'Blocks',
  tasks: 'Tasks',
  categories: 'Categories',
  calendars: 'Calendars',
  accounts: 'Accounts',
  conversations: 'Chats',
  changeSets: 'Proposals',
  syncStates: 'Sync',
};

const countLabel = (key: string): string => {
  const mapped = COUNT_LABELS[key];
  if (mapped) return mapped;
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** One sentence rather than a pile of fragments, so it reads as prose. */
function staleSummary(stats: DataStats): string[] {
  const parts: string[] = [];
  if (stats.staleBlocks > 0) parts.push(`${stats.staleBlocks} block(s) whose task is gone`);
  if (stats.orphanedEvents > 0) {
    parts.push(`${stats.orphanedEvents} event(s) from a calendar that no longer exists`);
  }
  if (stats.detachedBlocks > 0) parts.push(`${stats.detachedBlocks} detached block(s)`);
  if (stats.orphanedSyncRecords > 0) {
    parts.push(`${stats.orphanedSyncRecords} stale sync cursor(s)`);
  }
  return parts;
}

/**
 * Stored-data housekeeping. Everything destructive simulates first and needs a
 * typed confirmation, because none of it can be undone.
 */
export function DataPanel({ stats, busy, onRefresh, onPrune, onReset, lastResult }: Props) {
  const [days, setDays] = useState('90');
  const [scopes, setScopes] = useState<string[]>([]);
  const [confirmText, setConfirmText] = useState('');
  const [showReset, setShowReset] = useState(false);

  const stale = stats ? staleSummary(stats) : [];

  const toggle = (id: string): void =>
    setScopes((current) =>
      current.includes(id) ? current.filter((scope) => scope !== id) : [...current, id],
    );

  return (
    <section className="panel data">
      <div className="panel-head">
        <h2>Stored data</h2>
        <span className="spacer" />
        <button className="small" onClick={onRefresh} disabled={busy}>
          <Icon name="sync" size={14} />
          Refresh
        </button>
      </div>

      {stats === null ? (
        <p className="empty">Refresh to inspect what this app has stored.</p>
      ) : (
        <>
          <div className="data-counts">
            {Object.entries(stats.counts).map(([name, count]) => (
              <span className="data-count" key={name}>
                <strong>{count}</strong>
                {countLabel(name)}
              </span>
            ))}
          </div>

          {stale.length > 0 ? (
            <p className="warn">
              <Icon name="alert" size={15} />
              <span>{stale.join(', ')}.</span>
            </p>
          ) : (
            <p className="note ok">
              <Icon name="check" size={15} />
              <span>Nothing stale.</span>
            </p>
          )}
        </>
      )}

      <div className="data-action">
        <label className="field">
          <span>Keep history for</span>
          <span className="suffix-field">
            <input
              type="number"
              min="1"
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
            <span className="suffix">days</span>
          </span>
        </label>
        <div className="button-row">
          <button className="small" onClick={() => onPrune(Number(days), true)} disabled={busy}>
            Preview prune
          </button>
          <button className="small" onClick={() => onPrune(Number(days), false)} disabled={busy}>
            Prune
          </button>
        </div>
      </div>

      <div className="data-action">
        <button
          className={showReset ? 'small' : 'small danger'}
          onClick={() => setShowReset((value) => !value)}
          disabled={busy}
        >
          {showReset ? 'Cancel' : 'Delete stored data...'}
        </button>

        {showReset && (
          <div className="reset-box">
            <p className="warn">
              <Icon name="alert" size={15} />
              <span>
                This cannot be undone. Calendar events are only removed from this app&apos;s copy -
                your Google calendar is not touched.
              </span>
            </p>

            <div className="scope-list">
              {RESET_SCOPES.map((scope) => (
                <label key={scope.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope.id)}
                    onChange={() => toggle(scope.id)}
                  />
                  {scope.label}
                </label>
              ))}
            </div>

            <button
              className="small"
              onClick={() => onReset(scopes, false)}
              disabled={busy || scopes.length === 0}
            >
              Preview
            </button>

            <label className="field">
              <span>
                Type <code>DELETE</code> to confirm
              </span>
              <input
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                aria-label="Type DELETE to confirm"
                placeholder="DELETE"
              />
            </label>

            <button
              className="danger"
              disabled={busy || scopes.length === 0 || confirmText !== 'DELETE'}
              onClick={() => {
                onReset(scopes, true);
                setConfirmText('');
                setShowReset(false);
                setScopes([]);
              }}
            >
              <Icon name="trash" size={15} />
              Delete permanently
            </button>
          </div>
        )}
      </div>

      {lastResult && <pre className="data-result">{lastResult}</pre>}
    </section>
  );
}
