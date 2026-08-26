import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  llm: { provider: string; model: string };
  onSend: (text: string) => void;
  /** The assistant is composing a reply; shown as a typing indicator. */
  thinking?: boolean;
  /** Rendered as a close button in the header when the panel is a dock. */
  onClose?: () => void;
}

const EXAMPLES = [
  'Schedule my algorithms assignment',
  'What deadlines are at risk?',
  'Find me two hours tomorrow morning for research',
  'Move my work around tomorrow so I can leave by 4pm',
  'Why is my Friday so full?',
];

export function ChatPanel({ messages, busy, llm, onSend, thinking, onClose }: Props) {
  const [text, setText] = useState('');
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tail.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length, thinking]);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (text.trim().length === 0) return;
    onSend(text.trim());
    setText('');
  };

  return (
    <section className="panel chat">
      <div className="panel-head">
        <h2>Assistant</h2>
        <span className="spacer" />
        <span className="badge llm-badge" title="Scheduling never depends on an LLM">
          {llm.provider === 'none' ? 'rule parser' : `${llm.provider}/${llm.model}`}
        </span>
        {onClose && (
          <button className="icon small ghost" onClick={onClose} aria-label="Close assistant">
            <Icon name="close" size={15} />
          </button>
        )}
      </div>

      <div className="messages">
        {messages.length === 0 && (
          <div className="examples">
            <span className="examples-label">Try one of these</span>
            {EXAMPLES.map((example) => (
              <button key={example} onClick={() => onSend(example)} disabled={busy}>
                {example}
              </button>
            ))}
          </div>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`message ${message.role}`}>
            <div className="bubble">{message.content}</div>
          </div>
        ))}

        {thinking && (
          <div className="message assistant">
            <div className="bubble thinking" role="status" aria-label="The assistant is thinking">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        )}
        <div ref={tail} />
      </div>

      <form onSubmit={submit}>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Schedule, move or explain something..."
          aria-label="Command"
          disabled={busy}
        />
        <button type="submit" className="primary icon" disabled={busy} aria-label="Send">
          <Icon name="send" />
        </button>
      </form>
    </section>
  );
}
