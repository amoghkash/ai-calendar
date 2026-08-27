/**
 * A very small Markdown subset, parsed into a tree.
 *
 * Parsing is kept apart from rendering for two reasons. It can be tested as a
 * pure function, and the renderer builds React elements from this tree rather
 * than HTML - so assistant output, which relays contact names and message text
 * from outside the app, can never inject markup.
 *
 * Only what the assistant actually writes is supported: emphasis, code spans,
 * links, bullet and numbered lists, and paragraphs. Anything unrecognised
 * survives as literal text rather than disappearing.
 */

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'em'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string };

export type Block =
  | { readonly kind: 'paragraph'; readonly lines: readonly (readonly Inline[])[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
/** Leading hashes are dropped; the assistant is asked not to use headings. */
const HEADING = /^\s*#{1,6}\s+(.*)$/;

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  let paragraph: Inline[][] = [];
  let list: { ordered: boolean; items: Inline[][] } | undefined;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', lines: paragraph });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
      list = undefined;
    }
  };

  for (const line of lines) {
    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = numbered !== null;
      const content = (bullet?.[1] ?? numbered?.[1]) ?? '';
      // A change of list kind starts a new list rather than mixing them.
      if (list && list.ordered !== ordered) flushList();
      list = list ?? { ordered, items: [] };
      list.items.push(parseInline(content));
      continue;
    }

    flushList();
    const heading = HEADING.exec(line);
    // Render a heading as its own emphasised line rather than a bigger one:
    // these bubbles are small, and a display-size heading in one looks broken.
    paragraph.push(heading ? [{ kind: 'strong', text: heading[1] ?? '' }] : parseInline(line));
  }

  flushParagraph();
  flushList();
  return blocks;
}

/**
 * Code spans are matched first so their contents are never re-read as
 * emphasis, and `**` before `*` so bold does not get taken apart into two
 * italics.
 */
const INLINE =
  /(`[^`\n]+`)|(\[[^\]\n]*\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;

  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) break;

    if (match.index > 0) out.push({ kind: 'text', text: rest.slice(0, match.index) });
    const token = match[0];

    if (token.startsWith('`')) {
      out.push({ kind: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](');
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      // Only ordinary web links become links; anything else stays as text, so
      // a javascript: or data: URL cannot be produced from model output.
      out.push(
        /^https?:\/\//i.test(href)
          ? { kind: 'link', text: label.length > 0 ? label : href, href }
          : { kind: 'text', text: token },
      );
    } else if (token.startsWith('**')) {
      out.push({ kind: 'strong', text: token.slice(2, -2) });
    } else {
      out.push({ kind: 'em', text: token.slice(1, -1) });
    }

    rest = rest.slice(match.index + token.length);
  }

  if (rest.length > 0) out.push({ kind: 'text', text: rest });
  return out;
}
