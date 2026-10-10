import { describe, expect, it } from 'vitest';
import { parseAgentMarkdown, parseInline, safeHref } from './agentMarkdown';

describe('safeHref', () => {
  it('accepts http(s) and www, and rejects other schemes and credentials', () => {
    expect(safeHref('https://worldissuetracker.com/b/1')).toBe('https://worldissuetracker.com/b/1');
    expect(safeHref('www.example.com')).toBe('https://www.example.com/');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://user:pass@example.com')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });
});

describe('parseInline', () => {
  it('reads bold, italic, code and links, leaving snake_case and lone stars alone', () => {
    expect(parseInline('**Done.** See `oc_send` and *this*')).toEqual([
      { t: 'bold', c: [{ t: 'text', v: 'Done.' }] }, { t: 'text', v: ' See ' }, { t: 'code', v: 'oc_send' },
      { t: 'text', v: ' and ' }, { t: 'italic', c: [{ t: 'text', v: 'this' }] },
    ]);
    expect(parseInline('a snake_case_name and 2 * 3 * 4')).toEqual([{ t: 'text', v: 'a snake_case_name and 2 * 3 * 4' }]);
  });

  it('keeps sentence punctuation outside bare URLs', () => {
    expect(parseInline('Open https://example.com/a.')).toEqual([
      { t: 'text', v: 'Open ' }, { t: 'link', c: [{ t: 'text', v: 'https://example.com/a' }], href: 'https://example.com/a' }, { t: 'text', v: '.' },
    ]);
  });

  it('renders a labelled link, and an unsafe one as plain text', () => {
    expect(parseInline('[Board](https://wit.example/b)')).toEqual([{ t: 'link', c: [{ t: 'text', v: 'Board' }], href: 'https://wit.example/b' }]);
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ t: 'text', v: '[x](javascript:alert(1))' }]);
  });
});

describe('parseAgentMarkdown', () => {
  it('splits paragraphs, headings, lists, quotes and fenced code', () => {
    const blocks = parseAgentMarkdown('## Summary\nTwo things:\n\n1. First\n2. **Second**\n- a\n- b\n> quoted\n```\nnpm ci\n```\nDone');
    expect(blocks.map(b => b.t)).toEqual(['heading', 'p', 'list', 'list', 'quote', 'code', 'p']);
    expect(blocks[2]).toMatchObject({ t: 'list', ordered: true, start: 1 });
    expect((blocks[2] as any).items).toHaveLength(2);
    expect((blocks[3] as any).items).toHaveLength(2);
    expect(blocks[5]).toEqual({ t: 'code', v: 'npm ci' });
  });

  it('keeps plain text unchanged', () => {
    expect(parseAgentMarkdown('Hello there\nsecond line')).toEqual([{ t: 'p', c: [{ t: 'text', v: 'Hello there\nsecond line' }] }]);
  });
});
