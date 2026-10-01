/**
 * Tests for the deterministic `## Sources` citation card for #5193.
 *
 * The narrow contract: only a strictly formatted trailing `## Sources` section
 * is converted; every deviation must yield null so delivery falls back to the
 * legacy plain-text path — never a broken card, duplicate, or lost reply.
 */

import { describe, it, expect } from 'vitest';
import { extractCitations, buildCitationCard, type CitationSource } from './citation-card.js';

const VALID_ANSWER = [
  'Per the docs, streaming cards use Card Kit [1].',
  '',
  'Truncation is head-tail [2].',
  '',
  '## Sources',
  '1. [Card Kit guide](https://example.com/docs/cardkit)',
  '   > Cards are created via POST /cardkit/v1/cards.',
  '2. [Truncation notes](https://example.org/truncation)',
].join('\n');

describe('extractCitations', () => {
  it('parses a conforming trailing section with body, links, and an excerpt', () => {
    const result = extractCitations(VALID_ANSWER);
    expect(result).not.toBeNull();
    expect(result?.body).toBe(
      'Per the docs, streaming cards use Card Kit [1].\n\nTruncation is head-tail [2].'
    );
    expect(result?.sources).toHaveLength(2);
    expect(result?.sources[0]).toEqual({
      number: 1,
      title: 'Card Kit guide',
      url: 'https://example.com/docs/cardkit',
      excerpt: 'Cards are created via POST /cardkit/v1/cards.',
    });
    expect(result?.sources[1]).toEqual({
      number: 2,
      title: 'Truncation notes',
      url: 'https://example.org/truncation',
    });
  });

  it('handles CJK titles, quotes, and multi-line excerpts without breaking', () => {
    const text = [
      '结论见 [1]。',
      '',
      '## Sources',
      '1. [中文标题「引用」测试](https://example.cn/页面?q=1&r=2)',
      '   > 摘录第一行，含 "双引号" 与 \\ 反斜杠。',
      '   > 摘录第二行。',
      "2. [It's a title](https://example.io/a)",
    ].join('\n');
    const result = extractCitations(text);
    expect(result).not.toBeNull();
    expect(result?.sources[0]?.title).toBe('中文标题「引用」测试');
    expect(result?.sources[0]?.excerpt).toBe(
      '摘录第一行，含 "双引号" 与 \\ 反斜杠。\n摘录第二行。'
    );
    expect(result?.sources[1]?.title).toBe("It's a title");
  });

  it('accepts blank lines between entries and trailing whitespace', () => {
    const text = [
      'Body [1].',
      '',
      '## Sources',
      '',
      '1. [A](https://a.example)',
      '',
      '2. [B](https://b.example)',
      '',
    ].join('\n');
    const result = extractCitations(text);
    expect(result?.sources).toHaveLength(2);
  });

  it('returns null when there is no Sources section', () => {
    expect(extractCitations('Just an answer with a [1] marker.')).toBeNull();
  });

  it('returns null for an empty or malformed section (contract break → legacy path)', () => {
    expect(extractCitations('Body [1].\n\n## Sources\n')).toBeNull();
    expect(extractCitations('Body [1].\n\n## Sources\nnot-a-list-entry')).toBeNull();
    expect(extractCitations('Body [1].\n\n## Sources\n1. bare text without link')).toBeNull();
    expect(
      extractCitations('Body [1].\n\n## Sources\n1. [ftp link](ftp://example.com)')
    ).toBeNull();
  });

  it('returns null when content follows the section', () => {
    const text = [
      'Body [1].',
      '## Sources',
      '1. [A](https://a.example)',
      'Extra prose after the section must reject the whole conversion.',
    ].join('\n');
    expect(extractCitations(text)).toBeNull();
  });

  it('uses the last header and keeps an earlier mid-answer header in the body', () => {
    const text = [
      'Earlier mention of ## Sources stays body text.',
      '## Sources',
      '1. [A](https://a.example)',
      '2. [B](https://b.example)',
    ].join('\n');
    const result = extractCitations(text);
    expect(result?.body).toContain('## Sources');
    expect(result?.sources).toHaveLength(2);
  });

  it('returns null on duplicate entry numbers', () => {
    const text = [
      'Body [1].',
      '## Sources',
      '1. [A](https://a.example)',
      '1. [B](https://b.example)',
    ].join('\n');
    expect(extractCitations(text)).toBeNull();
  });

  it('returns null for zero marker numbers and empty titles', () => {
    expect(extractCitations('Body [0].\n## Sources\n0. [A](https://a.example)')).toBeNull();
    expect(extractCitations('Body [1].\n## Sources\n1. [   ](https://a.example)')).toBeNull();
    expect(
      extractCitations('Body [1].\n## Sources\n1. [A](https://user:pass@a.example)')
    ).toBeNull();
  });

  it('returns null when the body is empty', () => {
    expect(extractCitations('## Sources\n1. [A](https://a.example)')).toBeNull();
  });

  it('tolerates non-sequential but unique numbers to preserve marker alignment', () => {
    const text = [
      'Body [2] and [5].',
      '## Sources',
      '2. [A](https://a.example)',
      '5. [B](https://b.example)',
    ].join('\n');
    const result = extractCitations(text);
    expect(result?.sources.map((s) => s.number)).toEqual([2, 5]);
  });
});

describe('buildCitationCard', () => {
  const sources: CitationSource[] = [
    {
      number: 1,
      title: 'Card Kit guide',
      url: 'https://example.com/docs/cardkit',
      excerpt: 'Line one.\nLine two.',
    },
    { number: 2, title: 'Truncation notes', url: 'https://example.org/truncation' },
  ];

  it('renders body, divider, and a single Sources block in one card', () => {
    const card = buildCitationCard('Answer body [1].', sources) as {
      config: { wide_screen_mode: boolean };
      elements: Array<{ tag: string; content?: string }>;
    };
    expect(card.config.wide_screen_mode).toBe(true);
    expect(card.elements).toHaveLength(3);
    expect(card.elements[0]).toEqual({ tag: 'markdown', content: 'Answer body [1].' });
    expect(card.elements[1]).toEqual({ tag: 'hr' });
    expect(card.elements[2]?.content).toBe(
      '**Sources**\n' +
        '[1] [Card Kit guide](https://example.com/docs/cardkit)\n' +
        '> Line one.\n> Line two.\n' +
        '[2] [Truncation notes](https://example.org/truncation)'
    );
  });

  it('JSON-serializes deterministically regardless of quotes, CJK, or newlines in excerpts', () => {
    const card = buildCitationCard('正文 [1]。', [
      {
        number: 1,
        title: '含 "引号" 的标题',
        url: 'https://example.cn/x',
        excerpt: '多行\n摘录',
      },
    ]);
    // The send boundary runs JSON.stringify on this card; round-trip must be
    // lossless and the content must keep its exact markdown shape.
    const parsed = JSON.parse(JSON.stringify(card)) as {
      elements: Array<{ tag: string; content: string }>;
    };
    expect(parsed.elements[2].content).toBe(
      '**Sources**\n[1] [含 "引号" 的标题](https://example.cn/x)\n> 多行\n> 摘录'
    );
  });

  it('escapes markdown link delimiters in source titles', () => {
    const card = buildCitationCard('Answer [1].', [
      { number: 1, title: 'A [nested] title', url: 'https://example.com' },
    ]) as { elements: Array<{ tag: string; content?: string }> };

    expect(card.elements[2]?.content).toContain('[1] [A \\[nested\\] title](https://example.com)');
  });
});
