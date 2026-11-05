import { Array as YArray, Map as YMap, Text as YText } from 'yjs';
/**
 * Insert a new, unexecuted cell through the shared Notebook schema.
 *
 * Code cells default to `jupyter.source_hidden: true` (#5615): delivered
 * analysis Notebooks read as reports first, with the code as expandable
 * evidence (JupyterLab hide-input). Markdown cells stay visible. The flag is
 * only an initial default — later human/agent edits of cell metadata are
 * never rewritten, and existing cells are left untouched.
 */
export function insertNotebookCell(notebook, index, cell) {
    const cells = notebook.ydoc.getArray('cells');
    if (!Number.isSafeInteger(index) || index < 0 || index > cells.length) {
        throw new RangeError('Notebook cell insertion index is out of range');
    }
    const model = new YMap([
        ['id', cell.id],
        ['cell_type', cell.cell_type],
        ['source', new YText(cell.source)],
        [
            'metadata',
            cell.cell_type === 'code'
                ? new YMap([['jupyter', new YMap([['source_hidden', true]])]])
                : new YMap(),
        ],
        ...(cell.cell_type === 'code'
            ? [
                ['outputs', new YArray()],
                ['execution_count', null],
            ]
            : []),
    ]);
    // @jupyter/ydoc 4.1.1 insertCell constructs a cell model before its Yjs
    // types are attached, then reads them during initialization. Attach the
    // complete cell first; YNotebook's observer creates the official model
    // after integration, preserving collaboration, signals and undo tracking.
    notebook.transact(() => cells.insert(index, [model]));
    notebook.dirty = true;
}
