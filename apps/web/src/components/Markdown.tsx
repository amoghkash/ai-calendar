import type { Inline } from '../markdown';
import { parseMarkdown } from '../markdown';

/**
 * Renders the parsed tree as React elements.
 *
 * Never `dangerouslySetInnerHTML`: assistant replies carry contact names and
 * message text that originated outside this application, and the only way to
 * be sure none of it is markup is never to treat it as markup.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <>
      {blocks.map((block, index) =>
        block.kind === 'list' ? (
          block.ordered ? (
            <ol key={index} className="md-list">
              {block.items.map((item, i) => (
                <li key={i}>{inlines(item)}</li>
              ))}
            </ol>
          ) : (
            <ul key={index} className="md-list">
              {block.items.map((item, i) => (
                <li key={i}>{inlines(item)}</li>
              ))}
            </ul>
          )
        ) : (
          <p key={index} className="md-p">
            {block.lines.map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {inlines(line)}
              </span>
            ))}
          </p>
        ),
      )}
    </>
  );
}

function inlines(parts: readonly Inline[]) {
  return parts.map((part, index) => {
    switch (part.kind) {
      case 'strong':
        return <strong key={index}>{part.text}</strong>;
      case 'em':
        return <em key={index}>{part.text}</em>;
      case 'code':
        return (
          <code key={index} className="md-code">
            {part.text}
          </code>
        );
      case 'link':
        return (
          <a key={index} href={part.href} target="_blank" rel="noreferrer noopener">
            {part.text}
          </a>
        );
      default:
        return <span key={index}>{part.text}</span>;
    }
  });
}
