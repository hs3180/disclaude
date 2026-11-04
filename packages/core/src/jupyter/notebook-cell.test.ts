import { YNotebook } from '@jupyter/ydoc';
import { applyUpdate, encodeStateAsUpdate } from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { insertNotebookCell } from './notebook-cell.js';

describe('Notebook cell insertion (#5317)', () => {
  it('inserts and edits 20 cells without premature-access warnings, preserving peer updates', () => {
    const notebook = new YNotebook();
    const peer = new YNotebook();
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    try {
      for (let index = 0; index < 20; index++) {
        insertNotebookCell(notebook, index, {
          id: `cell-${index}`,
          cell_type: index % 2 ? 'markdown' : 'code',
          source: `initial ${index}`,
        });
        const cell = notebook.cells[index];
        expect(cell.ymodel.doc).toBe(notebook.ydoc);
        const changed = vi.fn();
        cell.changed.connect(changed);
        cell.source = `edited ${index}`;
        expect(changed).toHaveBeenCalled();
        applyUpdate(peer.ydoc, encodeStateAsUpdate(notebook.ydoc));
        expect(peer.cells[index].toJSON()).toEqual(cell.toJSON());
      }
      expect(peer.cells.map((cell) => cell.id)).toEqual(notebook.cells.map((cell) => cell.id));
      expect(notebook.dirty).toBe(true);
      expect(notebook.cells[0].toJSON()).toMatchObject({
        outputs: [],
        execution_count: null,
        metadata: { jupyter: { source_hidden: true } },
      });
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
      notebook.dispose();
      peer.dispose();
    }
  });

  it('defaults code cells to jupyter.source_hidden while leaving markdown cells visible (#5615)', () => {
    const notebook = new YNotebook();
    const peer = new YNotebook();
    const metadata = (doc: YNotebook, index: number): unknown =>
      (doc.getCell(index) as unknown as { toJSON: () => { metadata: unknown } }).toJSON().metadata;
    try {
      insertNotebookCell(notebook, 0, { id: 'code', cell_type: 'code', source: 'print(1)' });
      insertNotebookCell(notebook, 1, { id: 'prose', cell_type: 'markdown', source: 'Read me.' });
      expect(metadata(notebook, 0)).toEqual({ jupyter: { source_hidden: true } });
      expect(metadata(notebook, 1)).toEqual({});
      // The nbformat export of the whole Notebook carries the default too.
      expect(notebook.toJSON().cells.map((cell) => cell.metadata)).toEqual([
        { jupyter: { source_hidden: true } },
        {},
      ]);
      applyUpdate(peer.ydoc, encodeStateAsUpdate(notebook.ydoc));
      expect(peer.toJSON().cells.map((cell) => cell.metadata)).toEqual([
        { jupyter: { source_hidden: true } },
        {},
      ]);
      // Editing the source never rewrites or drops the metadata default.
      (notebook.getCell(0) as unknown as { source: string }).source = 'print(2)';
      expect(metadata(notebook, 0)).toEqual({ jupyter: { source_hidden: true } });
    } finally {
      notebook.dispose();
      peer.dispose();
    }
  });

  it('keeps insertion order, undo/redo and real failures observable', () => {
    const notebook = new YNotebook();
    try {
      insertNotebookCell(notebook, 0, { id: 'tail', cell_type: 'code', source: 'tail' });
      notebook.undoManager.stopCapturing();
      insertNotebookCell(notebook, 0, { id: 'head', cell_type: 'markdown', source: 'head' });
      expect(notebook.cells.map((cell) => cell.id)).toEqual(['head', 'tail']);
      notebook.undo();
      expect(notebook.cells.map((cell) => cell.id)).toEqual(['tail']);
      notebook.redo();
      expect(notebook.cells.map((cell) => cell.id)).toEqual(['head', 'tail']);
      expect(() =>
        insertNotebookCell(notebook, 3, { id: 'bad', cell_type: 'code', source: '' })
      ).toThrow('Notebook cell insertion index is out of range');
      expect(notebook.cells).toHaveLength(2);
    } finally {
      notebook.dispose();
    }
  });
});
