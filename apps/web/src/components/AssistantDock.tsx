import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from './ChatPanel';
import { ChatPanel } from './ChatPanel';
import { Icon } from './Icon';

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  /** A chat turn is in flight, as opposed to any other mutation. */
  thinking: boolean;
  llm: { provider: string; model: string };
  onSend: (text: string) => void;
  /** Held by the app so Escape can be arbitrated against other dismissables. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The assistant lives in a dock rather than a permanent rail: scheduling never
 * needs it, so it stays out of the way until it is asked for. The launcher
 * keeps a message count so a reply that arrives while it is shut is not lost.
 */
export function AssistantDock({
  messages,
  busy,
  thinking,
  llm,
  onSend,
  open,
  onOpenChange,
}: Props) {
  const [seen, setSeen] = useState(0);
  const launcher = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) setSeen(messages.length);
  }, [open, messages.length]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onOpenChange(false);
        launcher.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const unread = Math.max(0, messages.length - seen);

  return (
    <div className="assistant-dock">
      {open && (
        <div className="assistant-panel" role="dialog" aria-label="Assistant">
          <ChatPanel
            messages={messages}
            busy={busy}
            thinking={thinking}
            llm={llm}
            onSend={onSend}
            onClose={() => onOpenChange(false)}
          />
        </div>
      )}

      <button
        ref={launcher}
        className={`assistant-launcher ${open ? 'active' : ''} ${thinking ? 'thinking' : ''}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        title={open ? 'Hide the assistant' : 'Ask the assistant to schedule, move or explain'}
      >
        <Icon name={open ? 'close' : 'sparkle'} size={16} />
        {open ? 'Close' : 'Talk to your assistant'}
        {!open && unread > 0 && <span className="tab-badge">{unread}</span>}
      </button>
    </div>
  );
}
