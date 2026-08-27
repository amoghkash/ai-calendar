import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('inline markdown', () => {
  it('reads bold, italic and code', () => {
    expect(parseInline('a **b** c *d* e `f`')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', text: 'b' },
      { kind: 'text', text: ' c ' },
      { kind: 'em', text: 'd' },
      { kind: 'text', text: ' e ' },
      { kind: 'code', text: 'f' },
    ]);
  });

  it('does not take bold apart into two italics', () => {
    expect(parseInline('**12:30 PM**')).toEqual([{ kind: 'strong', text: '12:30 PM' }]);
  });

  it('leaves emphasis inside code alone', () => {
    expect(parseInline('`a * b * c`')).toEqual([{ kind: 'code', text: 'a * b * c' }]);
  });

  it('reads underscore italics', () => {
    expect(parseInline('_soon_')).toEqual([{ kind: 'em', text: 'soon' }]);
  });

  it('leaves plain text alone', () => {
    expect(parseInline('nothing to see')).toEqual([{ kind: 'text', text: 'nothing to see' }]);
  });

  it('leaves an unmatched marker as literal text', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ kind: 'text', text: '2 * 3 = 6' }]);
  });

  it('links only ordinary web URLs', () => {
    expect(parseInline('[docs](https://example.com)')).toEqual([
      { kind: 'link', text: 'docs', href: 'https://example.com' },
    ]);
  });

  it('refuses to turn a script URL into a link', () => {
    // Assistant output relays text from outside the app; a link whose scheme it
    // chooses is a link worth not making. What matters is that no link token is
    // produced and no text is lost - not how the leftovers are tokenised.
    for (const input of [
      '[click](javascript:alert(1))',
      '[x](data:text/html,hi)',
      '[y](vbscript:msgbox)',
      '[z](file:///etc/passwd)',
    ]) {
      const parts = parseInline(input);
      expect(parts.some((part) => part.kind === 'link')).toBe(false);
      expect(parts.map((part) => part.text).join('')).toBe(input);
    }
  });

  it('still links ordinary URLs that contain brackets in the label', () => {
    expect(parseInline('see [the docs](https://example.com/a_b)')).toContainEqual({
      kind: 'link',
      text: 'the docs',
      href: 'https://example.com/a_b',
    });
  });
});

describe('block markdown', () => {
  it('splits paragraphs on blank lines', () => {
    const blocks = parseMarkdown('one\n\ntwo');
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.kind === 'paragraph')).toBe(true);
  });

  it('keeps consecutive lines together as one paragraph', () => {
    const blocks = parseMarkdown('one\ntwo');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind === 'paragraph' && blocks[0].lines).toHaveLength(2);
  });

  it('reads a bullet list', () => {
    const blocks = parseMarkdown('- first\n- second');
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: false });
    expect(blocks[0]?.kind === 'list' && blocks[0].items).toHaveLength(2);
  });

  it('reads a numbered list', () => {
    const blocks = parseMarkdown('1. first\n2. second');
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true });
  });

  it('does not mix a bullet list into a numbered one', () => {
    const blocks = parseMarkdown('- a\n1. b');
    expect(blocks).toHaveLength(2);
  });

  it('renders emphasis inside list items', () => {
    const blocks = parseMarkdown('- **12:30 PM** — busy');
    expect(blocks[0]?.kind === 'list' && blocks[0].items[0]?.[0]).toEqual({
      kind: 'strong',
      text: '12:30 PM',
    });
  });

  it('turns a heading into an emphasised line, not a bigger one', () => {
    // The bubbles are small; a display-size heading in one looks broken.
    const blocks = parseMarkdown('## Tomorrow');
    expect(blocks[0]?.kind === 'paragraph' && blocks[0].lines[0]).toEqual([
      { kind: 'strong', text: 'Tomorrow' },
    ]);
  });

  it('handles an actual assistant reply', () => {
    const blocks = parseMarkdown(
      'Tomorrow you have two blocks:\n\n- **12:30 PM – 1:45 PM** — marked "Busy"\n- **5:00 PM – 8:00 PM** — marked "Busy"\n\nOtherwise the day looks open.',
    );
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'list', 'paragraph']);
  });

  it('produces nothing for empty input', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n  ')).toEqual([]);
  });
});
