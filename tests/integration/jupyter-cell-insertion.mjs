// Owned in-memory Notebook regression; no Jupyter server or kernel is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { insertNotebookCell } from '../../packages/core/dist/jupyter/notebook-cell.js';
const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const { YNotebook } = await import(require.resolve('@jupyter/ydoc'));
const notebook = new YNotebook();
try {
  for (let index = 0; index < 20; index++) {
    insertNotebookCell(notebook, index, {
      id: `owned-${index}`, cell_type: index % 2 ? 'markdown' : 'code', source: `initial ${index}`,
    });
    notebook.cells[index].source = `edited ${index}`;
    assert.equal(notebook.cells[index].source, `edited ${index}`);
  }
  assert.equal(notebook.cells.length, 20);
  assert.throws(() => insertNotebookCell(notebook, 21, {
    id: 'invalid-index', cell_type: 'code', source: '',
  }), /insertion index is out of range/);
  console.log(JSON.stringify({ passed: true, inserted: 20, edited: 20,
    actualErrorObserved: true, remoteRequests: 0, productAcceptance: false }));
} finally { notebook.dispose(); }
