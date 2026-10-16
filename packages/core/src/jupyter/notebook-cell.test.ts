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
        metadata: {},
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
