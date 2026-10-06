import { describe, expect, it } from 'vitest';
import { notebookSnapshotHash } from './notebook-fingerprint.js';

describe('Notebook content identity across native serializers', () => {
  const notebook = {
    metadata: { unknown: { keep: true, nested: 3 } },
    nbformat: 4,
    cells: [
      { id: 'human', source: 'My conclusion.', metadata: { note: 'retain' } },
      { id: 'code', source: 'value = 3', outputs: [{ text: '3\n', output_type: 'stream' }] },
    ],
  };

  it('retains the same fingerprint after Contents reorders nested object keys', () => {
    const contents = {
      cells: [
        { metadata: { note: 'retain' }, source: 'My conclusion.', id: 'human' },
        { outputs: [{ output_type: 'stream', text: '3\n' }], source: 'value = 3', id: 'code' },
      ],
      nbformat: 4,
      metadata: { unknown: { nested: 3, keep: true } },
    };
    expect(notebookSnapshotHash(contents)).toBe(notebookSnapshotHash(notebook));
  });

  it('distinguishes edited human content, outputs, unknown metadata and cell order', () => {
    for (const change of [
      (copy: typeof notebook) => {
        copy.cells[0].source = 'Edited conclusion.';
      },
      (copy: typeof notebook) => {
        const output = copy.cells[1].outputs?.[0];
        if (output) {
          output.text = '4\n';
        }
      },
      (copy: typeof notebook) => {
        copy.metadata.unknown.keep = false;
      },
      (copy: typeof notebook) => {
        copy.cells.reverse();
      },
    ]) {
      const copy = structuredClone(notebook);
      change(copy);
      expect(notebookSnapshotHash(copy)).not.toBe(notebookSnapshotHash(notebook));
    }
  });

  const live = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { custom: { trusted: false } },
    cells: [
      {
        id: 'human',
        cell_type: 'markdown',
        source: 'Human note.\n![plot](attachment:plot.svg)',
        metadata: { trusted: false },
        attachments: { 'plot.svg': { 'image/svg+xml': '<svg>\n</svg>' } },
      },
      {
        id: 'code',
        cell_type: 'code',
        source: 'value = 3\nprint(value)',
        metadata: { custom: { trusted: false } },
        outputs: [
          { output_type: 'stream', name: 'stdout', text: '3\nDone\n' },
          {
            output_type: 'display_data',
            metadata: { custom: ['keep', 'separate'] },
            data: {
              'text/plain': 'Table\n3',
              'text/html': '<table>\n</table>',
              'image/svg+xml': '<svg>\n</svg>',
              'image/png': 'YWJjZA==',
              'application/json': ['a', 'b'],
              'application/vnd.custom+json': ['a', 'b'],
            },
          },
        ],
      },
    ],
  };

  it('matches native saved line arrays and transient code-cell trust without mutating input', () => {
    const saved = {
      ...live,
      cells: [
        {
          ...live.cells[0],
          source: ['Human note.\n', '![plot](attachment:plot.svg)'],
          attachments: { 'plot.svg': { 'image/svg+xml': ['<svg>\n', '</svg>'] } },
        },
        {
          ...live.cells[1],
          source: ['value = 3\n', 'print(value)'],
          metadata: { ...live.cells[1].metadata, trusted: false },
          outputs: [
            { output_type: 'stream', name: 'stdout', text: ['3\n', 'Done\n'] },
            {
              ...live.cells[1].outputs![1],
              data: {
                'text/plain': ['Table\n', '3'],
                'text/html': ['<table>\n', '</table>'],
                'image/svg+xml': ['<svg>\n', '</svg>'],
                'image/png': ['YWJj', 'ZA=='],
                'application/json': ['a', 'b'],
                'application/vnd.custom+json': ['a', 'b'],
              },
            },
          ],
        },
      ],
    };
    const original = structuredClone(saved);
    expect(notebookSnapshotHash(saved)).toBe(notebookSnapshotHash(live));
    saved.cells[1].metadata.trusted = true;
    expect(notebookSnapshotHash(saved)).toBe(notebookSnapshotHash(live));
    saved.cells[1].metadata.trusted = false;
    expect(saved).toEqual(original);
    expect(live.cells[1].metadata).not.toHaveProperty('trusted');
  });

  it.each([
    ['human trust metadata', '/cells/0/metadata/trusted', true],
    ['nested trust metadata', '/cells/1/metadata/custom/trusted', true],
    ['JSON MIME arrays', '/cells/1/outputs/1/data/application~1json', 'ab'],
    ['custom MIME arrays', '/cells/1/outputs/1/data/application~1vnd.custom+json', 'ab'],
    ['attachment content', '/cells/0/attachments/plot.svg/image~1svg+xml', '<svg>changed</svg>'],
    ['output metadata', '/cells/1/outputs/1/metadata/custom', 'keepseparate'],
    ['nonboolean code trust', '/cells/1/metadata/trusted', 'custom value'],
  ])('retains changes to %s', (_name, pointer, value) => {
    const copy = structuredClone(live);
    const keys = pointer
      .split('/')
      .slice(1)
      .map((key) => key.replaceAll('~1', '/'));
    let parent: Record<string, unknown> = copy;
    for (const key of keys.slice(0, -1)) {
      parent = parent[key] as Record<string, unknown>;
    }
    parent[keys.at(-1)!] = value;
    expect(notebookSnapshotHash(copy)).not.toBe(notebookSnapshotHash(live));
  });
});
