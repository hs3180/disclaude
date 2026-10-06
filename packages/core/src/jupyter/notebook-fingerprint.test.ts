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
});
