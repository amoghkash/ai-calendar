import { useEffect, useState } from 'react';
import type { PendingDeletion } from '../api';
import { Icon } from './Icon';

interface Props {
  pending: readonly PendingDeletion[];
  onUndo: (token: string) => void;
  /** Called once nothing is left to undo, so the poll can stop. */
  onEmpty: () => void;
  busy: boolean;
}

/**
 * The only place a deletion can be taken back.
 *
 * Deliberately not something the assistant can do: it deletes on an
 * interpreted instruction, so the person who might have meant a different
 * event is the one who gets to stop it. The countdown is the real remaining
 * time, read from when the deletion is actually due, so the button never
 * outlives what it can do.
 */
export function DeletionToast({ pending, onUndo, onEmpty, busy }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (pending.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [pending.length]);

  const live = pending.filter((item) => item.deletesAt > now);
  useEffect(() => {
    if (pending.length > 0 && live.length === 0) onEmpty();
  }, [pending.length, live.length, onEmpty]);

  if (live.length === 0) return null;

  return (
    <div className="deletion-toasts" role="status" aria-live="polite">
      {live.map((item) => {
        const seconds = Math.max(0, Math.ceil((item.deletesAt - now) / 1000));
        return (
          <div key={item.token} className="deletion-toast">
            <Icon name="trash" size={15} />
            <span className="deletion-title">
              Deleted <strong>{item.title}</strong>
            </span>
            <span className="deletion-countdown">{seconds}s</span>
            <button type="button" onClick={() => onUndo(item.token)} disabled={busy}>
              Undo
            </button>
          </div>
        );
      })}
    </div>
  );
}
