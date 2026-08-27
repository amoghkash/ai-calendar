import { useCallback, useEffect, useRef, useState } from 'react';
import type { Outreach, OutreachState, OutreachStatus } from '../api';
import { api } from '../api';
import { dateLabel, dayKey, rangeLabel, relativeDay, timeLabel } from '../time';
import { Icon } from './Icon';

interface Props {
  timezone: string;
  busy: boolean;
  /** Booking an accepted time writes to the calendar, so the grid must re-read. */
  onChanged: () => void;
}

const STATE_LABEL: Record<OutreachState, string> = {
  draft: 'not sent',
  sent: 'waiting on them',
  needs_you: 'needs you',
  agreed: 'agreed',
  booked: 'booked',
  declined: 'declined',
  expired: 'expired',
  cancelled: 'cancelled',
};

/** Still in play, and so still shown as a card. */
const isOpen = (state: OutreachState): boolean =>
  state === 'draft' || state === 'sent' || state === 'needs_you' || state === 'agreed';

/**
 * What happened, worth keeping on screen: it was booked, they said no, or it
 * ran out of time.
 *
 * `cancelled` is deliberately absent. Discarding something is not an outcome of
 * a conversation, it is a decision not to have one - leaving it listed makes
 * the button look like it did nothing.
 */
const isOutcome = (state: OutreachState): boolean =>
  state === 'booked' || state === 'declined' || state === 'expired';

/**
 * Everything the assistant has offered to arrange, and where each one stands.
 *
 * This exists because a draft that only appears in a chat bubble is a draft you
 * cannot act on twice. Sending still happens in Messages, by hand - the panel's
 * job is to make the text easy to take, and to be the place you find out that
 * somebody answered.
 */
export function OutboxPanel({ timezone, busy, onChanged }: Props) {
  const [items, setItems] = useState<Outreach[]>([]);
  const [status, setStatus] = useState<OutreachStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const messageRefs = useRef(new Map<string, HTMLParagraphElement>());

  const load = useCallback(async () => {
    const [list, next] = await Promise.all([api.outreach(), api.outreachStatus()]);
    setItems(list.outreach);
    setStatus(next);
  }, []);

  useEffect(() => {
    let live = true;
    load()
      .catch((cause: unknown) => {
        if (live) setError(describe(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [load]);

  const act = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    setPending(id);
    setError(null);
    try {
      await action();
      await load();
      onChanged();
    } catch (cause: unknown) {
      setError(describe(cause));
    } finally {
      setPending(null);
    }
  };

  /**
   * Getting the text out is this panel's whole job, so a clipboard that refuses
   * must not be a dead end. Browsers deny `writeText` for reasons the page
   * cannot see - an unfocused frame, a permission policy - and the answer is to
   * select the message so the reader can copy it themselves.
   */
  const copy = (item: Outreach): void => {
    const succeeded = (): void => {
      setError(null);
      setCopied(item.id);
      setTimeout(() => setCopied(null), 2000);
    };
    const selectInstead = (): void => {
      const element = messageRefs.current.get(item.id);
      if (element) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setError('The clipboard is unavailable. The message is selected - press Cmd+C.');
    };

    if (typeof navigator.clipboard?.writeText !== 'function') {
      selectInstead();
      return;
    }
    void navigator.clipboard.writeText(item.message).then(succeeded, selectInstead);
  };

  const open = items.filter((item) => isOpen(item.state));
  const closed = items.filter((item) => isOutcome(item.state));

  return (
    <section className="panel outbox">
      <div className="panel-head">
        <h2>Outbox</h2>
        <span className="spacer" />
        {open.length > 0 && <span className="badge count">{open.length}</span>}
      </div>

      {loading && <p className="empty">Loading...</p>}

      {!loading && open.length === 0 && closed.length === 0 && (
        <p className="empty">
          Nothing to send. Ask the assistant to arrange something - &ldquo;lunch with Sam
          tomorrow&rdquo;.
        </p>
      )}

      {open.map((item) => (
        <article key={item.id} className={`outreach ${item.state}`}>
          <div className="outreach-head">
            <span className="outreach-who">{item.displayName}</span>
            <span className={`badge outreach-state ${item.state}`}>{STATE_LABEL[item.state]}</span>
          </div>

          <p
            className="outreach-message"
            ref={(element) => {
              if (element) messageRefs.current.set(item.id, element);
              else messageRefs.current.delete(item.id);
            }}
          >
            {item.message}
          </p>

          <p className="outreach-times">{describeTimes(item.proposedSlots, timezone)}</p>

          {item.note && (
            <p className="note">
              <Icon name="alert" size={15} />
              <span>{item.note}</span>
            </p>
          )}

          <div className="outreach-actions">
            {item.state === 'draft' && (
              <>
                <button type="button" className="copy" onClick={() => copy(item)} disabled={busy}>
                  <Icon name="text" size={15} />
                  {copied === item.id ? 'Copied' : 'Copy'}
                </button>
                {status?.canSend ? (
                  // The one press in the whole negotiation: it picks the person.
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || pending === item.id}
                    onClick={() => void act(item.id, () => api.sendOutreach(item.id))}
                    title={`Send this to ${item.displayName} now`}
                  >
                    <Icon name="send" size={15} />
                    Send
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || pending === item.id}
                    onClick={() => void act(item.id, () => api.markOutreachSent(item.id))}
                    title="Record that you have sent it; replies are watched from here"
                  >
                    I sent it
                  </button>
                )}
              </>
            )}

            {(item.state === 'sent' || item.state === 'needs_you') && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setReplyFor(replyFor === item.id ? null : item.id);
                  setReplyText('');
                }}
              >
                <Icon name="send" size={15} />
                Paste their reply
              </button>
            )}

            <button
              type="button"
              className="danger push"
              disabled={busy || pending === item.id}
              onClick={() => void act(item.id, () => api.cancelOutreach(item.id))}
            >
              Discard
            </button>
          </div>

          {replyFor === item.id && (
            <div className="outreach-reply">
              <input
                type="text"
                value={replyText}
                onChange={(event) => setReplyText(event.target.value)}
                placeholder="What they said back"
                disabled={busy}
              />
              <button
                type="button"
                className="primary"
                disabled={busy || replyText.trim().length === 0}
                onClick={() =>
                  void act(item.id, async () => {
                    await api.recordOutreachReply(item.id, replyText);
                    setReplyFor(null);
                    setReplyText('');
                  })
                }
              >
                Read it
              </button>
            </div>
          )}
        </article>
      ))}

      {closed.length > 0 && (
        <ul className="outreach-history">
          {closed.map((item) => (
            <li key={item.id}>
              <span className="outreach-who">{item.displayName}</span>
              <span className="outreach-history-state">{STATE_LABEL[item.state]}</span>
              <span className="outreach-history-when">
                {item.agreedSlot
                  ? relativeDay(item.agreedSlot.start, Date.now(), timezone)
                  : relativeDay(item.updatedAt, Date.now(), timezone)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {status && !status.poller.running && open.some((item) => item.state === 'sent') && (
        <p className="note">
          <Icon name="alert" size={15} />
          <span>
            Nothing is watching for replies. Start the server with messaging enabled, or paste
            replies in by hand.
          </span>
        </p>
      )}

      {status?.poller.running && (
        <p className="outbox-foot">
          Watching for replies every {status.poller.intervalMinutes} min.
          {status.canSend
            ? ' Once sent, it answers and books on its own.'
            : ' Send from Messages, then press "I sent it".'}
        </p>
      )}

      {error && (
        <p className="warn error">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}

/** The date once when every option shares it, mirroring the message itself. */
function describeTimes(
  slots: readonly { start: number; end: number }[],
  timezone: string,
): string {
  if (slots.length === 0) return '';
  const days = new Set(slots.map((slot) => dayKey(slot.start, timezone)));
  if (days.size > 1) {
    return slots.map((slot) => rangeLabel(slot.start, slot.end, timezone)).join(' · ');
  }
  const clocks = slots.map(
    (slot) => `${timeLabel(slot.start, timezone)}-${timeLabel(slot.end, timezone)}`,
  );
  return `${dateLabel(slots[0]!.start, timezone)} · ${clocks.join(' · ')}`;
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
